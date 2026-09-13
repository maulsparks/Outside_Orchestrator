import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunStateStore, RunStateMachine, FactoryRunRecord } from "../src/core/stateMachine.js";

function makeRun(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-001",
    tenant_id: "tenant-001",
    request_id: "req-001",
    idempotency_key: "idem-001",
    parent_git_sha: "a".repeat(40),
    policy_version: "v1.0.0",
    phase: "created",
    state_version: 1,
    budget: { max_cost_cents: 100 },
    envelope: {},
    ...overrides
  };
}

test("canTransition validates phase transitions against policy rules", () => {
  const store = new InMemoryRunStateStore();
  const sm = new RunStateMachine(store);

  assert.equal(sm.canTransition("created", "provisioning"), true);
  assert.equal(sm.canTransition("created", "in_progress"), false); // cannot jump
  assert.equal(sm.canTransition("provisioning", "delegated"), true);
  assert.equal(sm.canTransition("delegated", "in_progress"), true);
  assert.equal(sm.canTransition("in_progress", "evaluating"), true);
  assert.equal(sm.canTransition("evaluating", "terminal"), true);
  assert.equal(sm.canTransition("terminal", "clean_terminated"), true);

  // Quarantine is valid from active phases
  assert.equal(sm.canTransition("in_progress", "quarantined"), true);
  assert.equal(sm.canTransition("evaluating", "quarantined"), true);

  // Terminal states cannot transition anywhere
  assert.equal(sm.canTransition("clean_terminated", "created"), false);
  assert.equal(sm.canTransition("quarantined", "created"), false);
});

test("transition executes CAS and records outbox event", async () => {
  const store = new InMemoryRunStateStore();
  store.setRun(makeRun());
  const sm = new RunStateMachine(store);

  const result = await sm.transition({
    runId: "run-001",
    tenantId: "tenant-001",
    expectedPhase: "created",
    expectedStateVersion: 1,
    targetPhase: "provisioning",
    fencingToken: 1,
    eventType: "phase_advanced",
    eventPayload: { to: "provisioning" }
  });

  assert.equal(result.previousPhase, "created");
  assert.equal(result.newPhase, "provisioning");
  assert.equal(result.previousStateVersion, 1);
  assert.equal(result.newStateVersion, 2);

  const updated = await store.getRun("run-001");
  assert.equal(updated?.phase, "provisioning");
  assert.equal(updated?.state_version, 2);

  const events = store.getEvents("run-001");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "phase_advanced");
  assert.equal(events[0].sequence, 2);
});

test("transition rejects mismatched expectedPhase", async () => {
  const store = new InMemoryRunStateStore();
  store.setRun(makeRun({ phase: "created" }));
  const sm = new RunStateMachine(store);

  await assert.rejects(
    async () =>
      sm.transition({
        runId: "run-001",
        tenantId: "tenant-001",
        expectedPhase: "provisioning", // mismatch
        expectedStateVersion: 1,
        targetPhase: "delegated",
        fencingToken: 1
      }),
    { message: /PhaseConflictError/ }
  );
});

test("transition rejects mismatched expectedStateVersion", async () => {
  const store = new InMemoryRunStateStore();
  store.setRun(makeRun({ state_version: 3 }));
  const sm = new RunStateMachine(store);

  await assert.rejects(
    async () =>
      sm.transition({
        runId: "run-001",
        tenantId: "tenant-001",
        expectedPhase: "created",
        expectedStateVersion: 2, // stale version
        targetPhase: "provisioning",
        fencingToken: 1
      }),
    { message: /VersionConflictError/ }
  );
});

test("transition rejects illegal phase jumps", async () => {
  const store = new InMemoryRunStateStore();
  store.setRun(makeRun({ phase: "created" }));
  const sm = new RunStateMachine(store);

  await assert.rejects(
    async () =>
      sm.transition({
        runId: "run-001",
        tenantId: "tenant-001",
        expectedPhase: "created",
        expectedStateVersion: 1,
        targetPhase: "terminal", // illegal skip
        fencingToken: 1
      }),
    { message: /IllegalTransitionError/ }
  );
});

test("transition rejects mismatched tenantId", async () => {
  const store = new InMemoryRunStateStore();
  store.setRun(makeRun({ tenant_id: "tenant-001" }));
  const sm = new RunStateMachine(store);

  await assert.rejects(
    async () =>
      sm.transition({
        runId: "run-001",
        tenantId: "tenant-other",
        expectedPhase: "created",
        expectedStateVersion: 1,
        targetPhase: "provisioning",
        fencingToken: 1
      }),
    { message: /TenantMismatchError/ }
  );
});
