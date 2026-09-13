import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { RecoveryEngine, RecoveredRunReport } from "../src/core/recoveryEngine.js";
import { RunStateMachine, InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { LeaseManager, InMemoryLeaseStorage } from "../src/core/leaseManager.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";
import { TailscaleClient } from "../src/adapters/tailscale/client.js";
import { ExeDevClient } from "../src/adapters/exedev/client.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRun(id: string, phase = "in_progress", stateVersion = 2): FactoryRunRecord {
  return {
    id,
    tenant_id: "tenant-rec-001",
    request_id: `req-${id}`,
    idempotency_key: `idem-${id}`,
    parent_git_sha: "c".repeat(40),
    policy_version: "v2.0",
    phase: phase as any,
    state_version: stateVersion,
    budget: { max_cost_cents: 100 },
    envelope: {
      intent: "Testing recovery engine",
      acceptance_criteria: ["Pass recovery test"]
    }
  };
}

test("findInFlightRuns returns only non-terminal, non-quarantined runs", async () => {
  const runStore = new InMemoryRunStateStore();
  const stateMachine = new RunStateMachine(runStore);
  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore, "test-host");

  runStore.setRun(makeRun("run-created", "created", 1));
  runStore.setRun(makeRun("run-prov", "provisioning", 2));
  runStore.setRun(makeRun("run-inprog", "in_progress", 3));
  runStore.setRun(makeRun("run-term", "terminal", 4));
  runStore.setRun(makeRun("run-quar", "quarantined", 5));

  const engine = new RecoveryEngine({
    runStore,
    stateMachine,
    leaseManager
  });

  const inFlight = await engine.findInFlightRuns();
  assert.equal(inFlight.length, 3);
  const ids = inFlight.map((r) => r.id);
  assert(ids.includes("run-created"));
  assert(ids.includes("run-prov"));
  assert(ids.includes("run-inprog"));
  assert(!ids.includes("run-term"));
  assert(!ids.includes("run-quar"));
});

test("recoverRun reacquires lease with incremented fencing token and quarantines interrupted in-flight run", async () => {
  const runStore = new InMemoryRunStateStore();
  const runRecord = makeRun("run-inprog-1", "in_progress", 2);
  runStore.setRun(runRecord);

  const stateMachine = new RunStateMachine(runStore);
  const leaseStore = new InMemoryLeaseStorage();
  await leaseStore.upsertLease({
    runId: "run-inprog-1",
    tenantId: "tenant-rec-001",
    holderId: "old-crashed-orchestrator",
    fencingToken: 5,
    expiresAt: new Date(Date.now() + 60000)
  });
  const leaseManager = new LeaseManager(leaseStore, "new-orchestrator");

  const { privateKey } = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const evidenceLedger = new EvidenceLedger(evidenceStore, privateKey, "test-warden-key");

  const engine = new RecoveryEngine({
    runStore,
    stateMachine,
    leaseManager,
    evidenceLedger
  });

  const report = await engine.recoverRun(runRecord);

  assert.equal(report.runId, "run-inprog-1");
  assert.equal(report.status, "quarantined");
  assert.equal(report.previousPhase, "in_progress");
  assert.equal(report.newPhase, "quarantined");
  // Fencing token incremented from 5 to 6
  assert.equal(report.newFencingToken, 6);
  assert.equal(report.previousStateVersion, 2);
  assert.equal(report.newStateVersion, 3);

  // Verify updated in-memory store
  const updatedRun = await runStore.getRun("run-inprog-1");
  assert.equal(updatedRun?.phase, "quarantined");
  assert.equal(updatedRun?.state_version, 3);

  // Verify signed evidence recorded in ledger
  const events = await evidenceStore.getAllForRun("run-inprog-1");
  const recoveryEvent = events.find(
    (e: any) => (e.payload?.observation as any)?.action === "orchestrator_recovery_observed"
  );
  assert(recoveryEvent, "Expected orchestrator_recovery_observed evidence event");
  assert.equal((recoveryEvent.payload.observation as any).fencing_token, 6);
  assert.equal((recoveryEvent.payload.observation as any).previous_phase, "in_progress");
});

test("recoverRun discovers and cleans up orphaned Tailscale and ExeDev sandbox resources", async () => {
  const runStore = new InMemoryRunStateStore();
  const runRecord = makeRun("run-orphan-test", "delegated", 2);
  runStore.setRun(runRecord);

  const stateMachine = new RunStateMachine(runStore);
  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore, "new-orchestrator");

  // Mock Tailscale client with orphaned device
  let deauthorizedId: string | null = null;
  let deletedDeviceId: string | null = null;
  const mockTailscaleFetch: typeof fetch = async (url, init) => {
    const urlStr = url.toString();
    if (urlStr.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), { status: 200 });
    }
    if (urlStr.includes("/tailnet/") && urlStr.includes("/devices") && (!init?.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({
          devices: [
            {
              id: "ts-orphan-node",
              name: "sbx-run-orphan-test.example.ts.net",
              hostname: "sbx-run-orphan-test",
              addresses: ["100.81.98.88"],
              tags: ["tag:factory-sandbox"]
            }
          ]
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/device/ts-orphan-node/expire")) {
      deauthorizedId = "ts-orphan-node";
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (urlStr.includes("/device/ts-orphan-node") && init?.method === "DELETE") {
      deletedDeviceId = "ts-orphan-node";
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const tailscaleClient = new TailscaleClient({
    clientId: "dummy",
    clientSecret: "dummy",
    tailnet: "example.com",
    fetchFn: mockTailscaleFetch
  });

  // Mock ExeDev client with orphaned VM
  let deletedVmName: string | null = null;
  const mockExeDevFetch: typeof fetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    if (body === "ls") {
      return new Response("sbx-run-orphan-test\nother-vm\n", { status: 200 });
    }
    if (body.startsWith("rm sbx-run-orphan-test")) {
      deletedVmName = "sbx-run-orphan-test";
      return new Response("OK", { status: 200 });
    }
    return new Response("OK", { status: 200 });
  };

  const exedevClient = new ExeDevClient({
    apiKey: "dummy-key",
    fetchFn: mockExeDevFetch
  });

  const engine = new RecoveryEngine({
    runStore,
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient
  });

  const report = await engine.recoverRun(runRecord);

  assert.equal(report.orphanedSandboxCleaned, true);
  assert.equal(deauthorizedId, "ts-orphan-node");
  assert.equal(deletedDeviceId, "ts-orphan-node");
  assert.equal(deletedVmName, "sbx-run-orphan-test");
});

test("recoverAllInFlightRuns processes multiple runs and aggregates reports correctly", async () => {
  const runStore = new InMemoryRunStateStore();
  runStore.setRun(makeRun("run-a", "provisioning", 1));
  runStore.setRun(makeRun("run-b", "evaluating", 3));
  runStore.setRun(makeRun("run-c", "terminal", 4));

  const stateMachine = new RunStateMachine(runStore);
  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore, "recovery-host");

  const engine = new RecoveryEngine({
    runStore,
    stateMachine,
    leaseManager
  });

  const summary = await engine.recoverAllInFlightRuns();

  assert.equal(summary.reports.length, 2);
  assert.equal(summary.quarantinedCount, 2);
  assert.equal(summary.errorCount, 0);
  assert(summary.timestamp);

  const rA = summary.reports.find((r) => r.runId === "run-a");
  const rB = summary.reports.find((r) => r.runId === "run-b");
  assert.equal(rA?.status, "quarantined");
  assert.equal(rB?.status, "quarantined");
});
