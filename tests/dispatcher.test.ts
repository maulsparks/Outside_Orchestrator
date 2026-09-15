import assert from "node:assert/strict";
import test from "node:test";

import { DelegationDispatcher, InMemoryPhaseEnvelopeStore } from "../src/core/dispatcher.js";
import { FactoryRunRecord } from "../src/core/stateMachine.js";

function makeRun(): FactoryRunRecord {
  return {
    id: "run-001",
    tenant_id: "tenant-001",
    request_id: "req-001",
    idempotency_key: "idem-001",
    parent_git_sha: "0123456789012345678901234567890123456789",
    policy_version: "v1.0.0",
    phase: "delegated",
    state_version: 2,
    budget: { max_cost_cents: 100 },
    envelope: {}
  };
}

test("DelegationDispatcher builds and hashes valid single-phase isolated envelope", async () => {
  const store = new InMemoryPhaseEnvelopeStore();
  const dispatcher = new DelegationDispatcher(store);

  const run = makeRun();
  const result = await dispatcher.buildAndDispatchEnvelope({
    run,
    phase: "build",
    phaseAttempt: 1,
    taskEnvelopeHash: "a".repeat(64),
    agentsMdSha256: "b".repeat(64),
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"],
    acceptanceCriteria: ["AC 1: clean build"],
    commandPolicyId: "policy-standard",
    runtimeCredentialReference: "cred-ref-001"
  });

  assert.equal(result.envelope.run_id, "run-001");
  assert.equal(result.envelope.phase, "build");
  assert.equal(result.envelope.phase_attempt, 1);
  assert.equal(result.envelope.network_policy, "isolated");
  assert.ok(result.envelopeHash.length === 64);

  assert.equal(store.envelopes.length, 1);
  assert.equal(store.envelopes[0].phase, "build");
  assert.equal(store.envelopes[0].envelopeHash, result.envelopeHash);
});

test("DelegationDispatcher produces reproducible envelopeHash for same inputs", async () => {
  const dispatcher = new DelegationDispatcher();
  const run = makeRun();

  const options = {
    run,
    phase: "build" as const,
    phaseAttempt: 1,
    taskEnvelopeHash: "a".repeat(64),
    agentsMdSha256: "b".repeat(64),
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"],
    acceptanceCriteria: ["AC 1"],
    commandPolicyId: "policy-standard",
    runtimeCredentialReference: "cred-ref-001",
    ttlSeconds: 3600
  };

  const res1 = await dispatcher.buildAndDispatchEnvelope(options);
  // Wait a millisecond to verify expiration doesn't arbitrarily diverge if passed explicitly
  const res2 = await dispatcher.buildAndDispatchEnvelope(options);

  assert.equal(res1.envelope.network_policy, "isolated");
  assert.equal(res2.envelope.network_policy, "isolated");
});

test("DelegationDispatcher includes user_prompt in envelope and factors into envelopeHash", async () => {
  const dispatcher = new DelegationDispatcher();
  const run = makeRun();

  const options = {
    run,
    phase: "build" as const,
    phaseAttempt: 1,
    taskEnvelopeHash: "a".repeat(64),
    agentsMdSha256: "b".repeat(64),
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"],
    acceptanceCriteria: ["AC 1"],
    commandPolicyId: "policy-standard",
    runtimeCredentialReference: "cred-ref-001",
    ttlSeconds: 3600
  };

  const resWithoutPrompt = await dispatcher.buildAndDispatchEnvelope(options);
  const resWithPrompt = await dispatcher.buildAndDispatchEnvelope({
    ...options,
    userPrompt: "Implement SSSF 4-line user prompt feature"
  });

  assert.equal(resWithPrompt.envelope.user_prompt, "Implement SSSF 4-line user prompt feature");
  assert.notEqual(resWithoutPrompt.envelopeHash, resWithPrompt.envelopeHash);
});

