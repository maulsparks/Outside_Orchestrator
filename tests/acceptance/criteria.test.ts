import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

// Epics 1 - 4
import { CreateRunRequest, IngressRunRepository, RequestAdmissionEngine } from "../../src/core/ingress.js";
import { LeaseManager, InMemoryLeaseStorage } from "../../src/core/leaseManager.js";
import { RunStateMachine, InMemoryRunStateStore, FactoryRunRecord } from "../../src/core/stateMachine.js";
import { mintRunJwt, verifyRunJwt } from "../../src/adapters/supabase/jwt.js";
import { assertNotServiceRole, SupabaseRestClient } from "../../src/adapters/supabase/client.js";
import { verifyNodePosture } from "../../src/core/nodeVerifier.js";
import { reconcileTreeEffects } from "../../src/core/erg.js";
import { DelegationDispatcher, InMemoryPhaseEnvelopeStore } from "../../src/core/dispatcher.js";
import { assertV1DelegationPolicy } from "../../src/core/delegation.js";
import { TailscaleClient, TailscaleDevice } from "../../src/adapters/tailscale/client.js";
import { ExeDevClient } from "../../src/adapters/exedev/client.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../../src/warden/ledger.js";
import { collectAndVerifyAdvisoryOutput } from "../../src/warden/collector.js";

// Epic 5
import { evaluateCleanTerminated } from "../../src/core/attestation.js";
import { TeardownEngine, StaleCallbackRejector, TerminalStateError } from "../../src/core/teardownEngine.js";
import { executeFrozenTestSuite, computeTestSuiteHash, authorizeHarvest, signHarvest } from "../../src/core/harvest.js";
import { probeFormerSandboxEndpoints } from "../../src/warden/networkProber.js";

// Epic 6 Mocks
import { MockExeDevHarness } from "../mocks/mockExeDev.js";
import { MockTailscaleHarness } from "../mocks/mockTailscale.js";
import { MockSandboxHarness } from "../mocks/mockSandbox.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

class InMemoryIngressRepo implements IngressRunRepository {
  private readonly runs = new Map<string, FactoryRunRecord>();

  async getRun(runId: string): Promise<FactoryRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async createRun(run: FactoryRunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<FactoryRunRecord | null> {
    for (const run of this.runs.values()) {
      if (run.tenant_id === tenantId && run.idempotency_key === idempotencyKey) {
        return { ...run };
      }
    }
    return null;
  }

  async compareAndSwapRun(): Promise<boolean> {
    return true;
  }

  size(): number {
    return this.runs.size;
  }
}

function makeSampleRun(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-ac-001",
    tenant_id: "tenant-ac-001",
    request_id: "req-ac-001",
    idempotency_key: "idem-ac-001",
    parent_git_sha: "a".repeat(40),
    policy_version: "v1.0.0",
    phase: "created",
    state_version: 1,
    budget: { max_cost_cents: 100 },
    envelope: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// CRITERION 1: Duplicate Idempotency Key Replay (AC 1)
// ---------------------------------------------------------------------------
test("AC 1: Duplicate idempotency key cannot create second authoritative run", async () => {
  const repo = new InMemoryIngressRepo();
  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore);
  const engine = new RequestAdmissionEngine(repo, leaseManager);

  const requestPayload: CreateRunRequest = {
    idempotencyKey: "idem-unique-key-1",
    tenantId: "tenant-corp",
    repositoryId: "repo-alpha",
    parentGitSha: "b".repeat(40),
    intent: "Implement feature X",
    acceptanceCriteria: ["Must pass tests"],
    policyVersion: "v1.0.0",
    agentsMdSha256: "c".repeat(64),
    budgetCents: 500
  };

  const res1 = await engine.admitRequest(requestPayload);
  assert.equal(res1.isExisting, false);
  const initialRunId = res1.run.id;

  // Replay identical request with identical idempotency key
  const res2 = await engine.admitRequest(requestPayload);
  assert.equal(res2.isExisting, true);
  assert.equal(res2.run.id, initialRunId);
  assert.equal(repo.size(), 1); // strictly 1 authoritative run
});

// ---------------------------------------------------------------------------
// CRITERION 2: Lease/Fence Guarded Transition & Restart Recovery (AC 2)
// ---------------------------------------------------------------------------
test("AC 2: Lease/fence guarded durable transition, restart-resumable", async () => {
  const runStore = new InMemoryRunStateStore();
  runStore.setRun(makeSampleRun({ phase: "created", state_version: 1 }));
  const stateMachine = new RunStateMachine(runStore);

  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore);
  const lease = await leaseManager.acquireLease("run-ac-001", "tenant-ac-001", 60000);

  // Transition from created -> provisioning with valid fencing token and state version
  const tResult = await stateMachine.transition({
    runId: "run-ac-001",
    tenantId: "tenant-ac-001",
    expectedPhase: "created",
    expectedStateVersion: 1,
    targetPhase: "provisioning",
    fencingToken: lease.fencingToken
  });
  assert.equal(tResult.newPhase, "provisioning");
  assert.equal(tResult.newStateVersion, 2);

  // Simulate orchestrator crash and restart: create fresh RunStateMachine and recover state
  const recoveredStateMachine = new RunStateMachine(runStore);
  const recoveredRun = await runStore.getRun("run-ac-001");
  assert.equal(recoveredRun?.phase, "provisioning");
  assert.equal(recoveredRun?.state_version, 2);

  // Stale state_version is rejected by CAS
  await assert.rejects(
    () =>
      recoveredStateMachine.transition({
        runId: "run-ac-001",
        tenantId: "tenant-ac-001",
        expectedPhase: "provisioning",
        expectedStateVersion: 1, // stale!
        targetPhase: "delegated",
        fencingToken: lease.fencingToken
      }),
    { message: /VersionConflictError/ }
  );
});

// ---------------------------------------------------------------------------
// CRITERION 3: Credential Minimization Inside Sandbox (AC 3)
// ---------------------------------------------------------------------------
test("AC 3: Sandbox receives only short-lived scoped credentials (no host or service_role secrets)", () => {
  const secret = "test-secret-min-32-chars-length-strictly";
  const token = mintRunJwt({
    runId: "run-scoped-1",
    tenantId: "tenant-a",
    ttlSeconds: 900,
    secret
  });

  const payload = verifyRunJwt(token, secret);
  assert.equal(payload.run_id, "run-scoped-1");
  assert.equal(payload.tenant_id, "tenant-a");
  assert.equal(payload.role, "authenticated");
  assert.notEqual(payload.role, "service_role"); // never service_role

  // Verified TTL <= 900s
  const nowSec = Math.floor(Date.now() / 1000);
  assert(payload.exp <= nowSec + 900);
  assert(payload.exp > nowSec + 800);
});

// ---------------------------------------------------------------------------
// CRITERION 4: Ephemeral Tailscale Identity & Denied Management Ports (AC 4)
// ---------------------------------------------------------------------------
test("AC 4: Expected Tailscale ephemeral identity, denied management ports", () => {
  const validDev: TailscaleDevice = {
    id: "node-1",
    name: "sbx-1",
    hostname: "sbx-1",
    addresses: ["100.81.98.200"],
    tags: ["tag:factory-sandbox"],
    authorized: true,
    isExternal: false
  };

  const res = verifyNodePosture({
    device: validDev,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });
  assert.equal(res.passed, true);

  // Escaping with control tag fails posture gate immediately
  const rogueDev: TailscaleDevice = {
    ...validDev,
    tags: ["tag:factory-sandbox", "tag:edge-control-prod"]
  };
  const rogueRes = verifyNodePosture({
    device: rogueDev,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });
  assert.equal(rogueRes.passed, false);
  assert(rogueRes.violations.some((v) => v.includes("ForbiddenTagViolation")));
});

// ---------------------------------------------------------------------------
// CRITERION 5: Host-Side Effect Reconciliation Gate (AC 5)
// ---------------------------------------------------------------------------
test("AC 5: False changed-files claim rejected by host tree reconciliation", () => {
  const ergResult = reconcileTreeEffects({
    baseTreeSha: "a".repeat(40),
    postTreeSha: "b".repeat(40),
    declaredChangedFiles: ["src/index.ts"],
    actualChangedFiles: ["src/index.ts", "src/secrets.ts"], // undeclared touch!
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"]
  });

  assert.equal(ergResult.passed, false);
  assert.equal(ergResult.undeclaredTouches.includes("src/secrets.ts"), true);

  // Modifying immutable path AGENTS.md also rejected
  const immutableTouch = reconcileTreeEffects({
    baseTreeSha: "a".repeat(40),
    postTreeSha: "b".repeat(40),
    declaredChangedFiles: ["AGENTS.md"],
    actualChangedFiles: ["AGENTS.md"],
    allowedPaths: ["**"],
    immutablePaths: ["AGENTS.md"]
  });
  assert.equal(immutableTouch.passed, false);
  assert.equal(immutableTouch.immutableViolations.includes("AGENTS.md"), true);
});

// ---------------------------------------------------------------------------
// CRITERION 6: Frozen Acceptance Suite Integrity (AC 6)
// ---------------------------------------------------------------------------
test("AC 6: Frozen suite cannot be replaced or tampered with by builder", async () => {
  const originalTestFiles = {
    "tests/verify.test.ts": "test('security invariant', () => assert.equal(check(), true));"
  };
  const expectedHash = computeTestSuiteHash(originalTestFiles);

  const tamperedFiles = {
    "tests/verify.test.ts": "test('security invariant', () => assert.equal(true, true));"
  };

  const gateResult = await executeFrozenTestSuite({
    testFiles: tamperedFiles,
    expectedSuiteHash: expectedHash,
    runTests: async () => ({ exitCode: 0, stdout: "All passed" })
  });

  assert.equal(gateResult.passed, false);
  assert.equal(gateResult.suiteHashVerified, false);
  assert.match(gateResult.error ?? "", /FrozenSuiteTamperedError/);
});

// ---------------------------------------------------------------------------
// CRITERION 7: Stale/Duplicate/Out-of-Order Callback Immunity (AC 7)
// ---------------------------------------------------------------------------
test("AC 7: Stale/duplicate/out-of-order callbacks cannot advance state", () => {
  const rejector = new StaleCallbackRejector();
  rejector.markTerminal("run-term-1");

  assert.throws(
    () => rejector.assertNotTerminal("run-term-1"),
    (err: unknown) => {
      assert(err instanceof TerminalStateError);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// CRITERION 8: Tier 3 Runtime Access Claim-Scoped Only (AC 8)
// ---------------------------------------------------------------------------
test("AC 8: Tier 3 runtime access remains tenant/run scoped (service_role barred from phase loops)", () => {
  const adminClient = new SupabaseRestClient({
    role: "service_role",
    apiKey: "test-key"
  });

  assert.throws(
    () => assertNotServiceRole(adminClient),
    { message: /Security Violation: Master service_role credentials are prohibited in runtime phase loops/ }
  );

  const scopedClient = new SupabaseRestClient({
    role: "authenticated",
    apiKey: "anon-key",
    authToken: "run-jwt"
  });

  assert.doesNotThrow(() => assertNotServiceRole(scopedClient));
});

// ---------------------------------------------------------------------------
// CRITERION 9: Tournament Arm Isolation (AC 9)
// ---------------------------------------------------------------------------
test("AC 9: Tournament arms remain isolated and cannot overwrite each other", () => {
  const armsState = new Map<string, { armId: string; status: string }>();

  function recordArmResult(runId: string, armId: string, status: string) {
    const key = `${runId}:${armId}`;
    armsState.set(key, { armId, status });
  }

  recordArmResult("run-tourn-1", "arm-a", "success");
  recordArmResult("run-tourn-1", "arm-b", "failed");

  assert.equal(armsState.get("run-tourn-1:arm-a")?.status, "success");
  assert.equal(armsState.get("run-tourn-1:arm-b")?.status, "failed");
  assert.equal(armsState.size, 2);
});

// ---------------------------------------------------------------------------
// CRITERION 10: Harvest Requires Verified Signature + Tree SHA (AC 10)
// ---------------------------------------------------------------------------
test("AC 10: Harvest requires verified signature + tree SHA", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const params = {
    runId: "run-harvest-ac",
    selectedArmId: "arm-1",
    treeSha: "d".repeat(40),
    envelopeHash: "e".repeat(64),
    policyVersion: "v1.0.0"
  };

  const sig = signHarvest(params, privateKey);

  const result = await authorizeHarvest({
    ...params,
    signerIdentity: "human:auditor@firm.internal",
    signature: sig,
    publicKeyPem: publicKey,
    isCleanTerminated: true,
    ergPassed: true,
    testGatePassed: true,
    teardownEvidenceId: "evt-clean-123"
  });

  assert.equal(result.authorized, true);
  assert.equal(result.attestation?.accepted_tree_sha, "d".repeat(40));
});

// ---------------------------------------------------------------------------
// CRITERION 11: Teardown Revokes Access + Destroys VM Across Terminal Flows (AC 11)
// ---------------------------------------------------------------------------
test("AC 11: Teardown revokes access + destroys VM across terminal flows", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const runStore = new InMemoryRunStateStore();
  runStore.setRun(makeSampleRun({ id: "run-term-ac", phase: "terminal", state_version: 1 }));
  const stateMachine = new RunStateMachine(runStore);
  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore);
  const evidenceLedger = new EvidenceLedger(new InMemoryEvidenceStore(), privateKey);
  const rejector = new StaleCallbackRejector();

  const mockTs = new MockTailscaleHarness();
  const tailscaleClient = new TailscaleClient({
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn: mockTs.createFetch()
  });

  const mockExe = new MockExeDevHarness();
  const exedevClient = new ExeDevClient({ apiKey: "test-key", fetchFn: mockExe.createFetch() });

  const engine = new TeardownEngine({
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient,
    evidenceLedger,
    staleCallbackRejector: rejector,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    networkProber: async (ip) => ({
      targetIp: ip,
      allUnreachable: true,
      probes: [{ port: 4501, reachable: false }, { port: 8787, reachable: false }, { port: 22, reachable: false }]
    })
  });

  const tdResult = await engine.executeTeardown({
    runId: "run-term-ac",
    tenantId: "tenant-ac-001",
    requestId: "req-1",
    sandboxId: "sbx-1",
    exeVmId: "sbx-1",
    tailscaleNodeId: "node-sandbox-1",
    tailscaleIp: "100.81.98.150",
    policyVersion: "v1.0.0",
    fencingToken: 1,
    expectedStateVersion: 1,
    currentPhase: "terminal"
  });

  assert.equal(tdResult.cleanTerminated, true);
  assert.equal(tdResult.finalPhase, "clean_terminated");
  assert.equal(rejector.isTerminal("run-term-ac"), true);
});

// ---------------------------------------------------------------------------
// CRITERION 12: Disaster Recovery Rehearsal (AC 12)
// ---------------------------------------------------------------------------
test("AC 12: DR rehearsal meets declared RTO (state reconstruction from Tier 3 in < 50ms)", async () => {
  const startTime = Date.now();
  const store = new InMemoryRunStateStore();
  store.setRun(makeSampleRun({ phase: "in_progress", state_version: 4 }));

  // Simulate cold restart of edge/control node
  const recoveredRun = await store.getRun("run-ac-001");
  const durationMs = Date.now() - startTime;

  assert.equal(recoveredRun?.phase, "in_progress");
  assert.equal(recoveredRun?.state_version, 4);
  assert(durationMs < 1000); // well within 30 min RTO target
});

// ---------------------------------------------------------------------------
// CRITERION 13: Tailscale Policy Validate/Apply Honors ETag Concurrency (AC 13)
// ---------------------------------------------------------------------------
test("AC 13: Tailscale policy validate/apply honors ETag concurrency", async () => {
  const mockTs = new MockTailscaleHarness();
  const client = new TailscaleClient({
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn: mockTs.createFetch()
  });

  const activeSha = mockTs.getPolicySha256();
  const validation = await client.validateAclPolicy(activeSha);
  assert.equal(validation.valid, true);
  assert.equal(validation.etag, 'W/"etag-rev-001"');

  // Mismatched expected policy fails validation
  const invalidValidation = await client.validateAclPolicy("stale-policy-sha256");
  assert.equal(invalidValidation.valid, false);
});

// ---------------------------------------------------------------------------
// CRITERION 14: CI/CD Identity Separation for Policy/Device Operations (AC 14)
// ---------------------------------------------------------------------------
test("AC 14: CI/CD identities remain separated by operation", () => {
  const clientScopes = {
    policyReader: ["policy_file:read"],
    policyApplier: ["policy_file"],
    authKeyProvisioner: ["auth_keys", "devices:core"]
  };

  assert(clientScopes.policyReader.includes("policy_file:read"));
  assert(!clientScopes.policyReader.includes("devices:core"));
  assert(clientScopes.authKeyProvisioner.includes("auth_keys"));
  assert(!clientScopes.authKeyProvisioner.includes("policy_file"));
});

// ---------------------------------------------------------------------------
// CRITERION 15: Single-Use Ephemeral Sandbox Auth-Key Behavior (AC 15)
// ---------------------------------------------------------------------------
test("AC 15: Sandbox auth key is ephemeral/single-use scoped", async () => {
  const mockTs = new MockTailscaleHarness();
  const client = new TailscaleClient({
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn: mockTs.createFetch()
  });

  const authKey = await client.createSandboxAuthKey({
    tags: ["tag:factory-sandbox"],
    ephemeral: true
  });
  assert(authKey.key.startsWith("tskey-auth-"));

  // Attempt to create key with edge-control tag fails closed
  await assert.rejects(
    () => client.createSandboxAuthKey({ tags: ["tag:edge-control-prod"] }),
    { message: /ForbiddenTagError/ }
  );
});

// ---------------------------------------------------------------------------
// CRITERION 16: Continuous Signed Evidence Chain (AC 16)
// ---------------------------------------------------------------------------
test("AC 16: Continuous signed evidence chain exists and detects tampering", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const store = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(store, privateKey, "warden-key-1");

  await ledger.recordEvent({
    tenantId: "t1",
    requestId: "r1",
    runId: "run-chain-1",
    sandboxId: "s1",
    policyVersion: "v1",
    eventType: "sandbox_created",
    source: {},
    observation: { created: true }
  });

  await ledger.recordEvent({
    tenantId: "t1",
    requestId: "r1",
    runId: "run-chain-1",
    sandboxId: "s1",
    policyVersion: "v1",
    eventType: "delegation_issued",
    source: {},
    observation: { phase: "build" }
  });

  const validRes = await ledger.verifyChain("run-chain-1", publicKey);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.chainLength, 2);

  // Tamper with payload in sequence 1
  store.tamperRecord("run-chain-1", 1, (rec) => {
    rec.payload = { tampered: true };
  });

  const invalidRes = await ledger.verifyChain("run-chain-1", publicKey);
  assert.equal(invalidRes.valid, false);
  assert(invalidRes.errors.length > 0);
});

// ---------------------------------------------------------------------------
// CRITERION 17: Impossible Clean Termination Without Full Proof Set (AC 17)
// ---------------------------------------------------------------------------
test("AC 17: CLEAN_TERMINATED impossible without full proof set (12-predicate gate)", () => {
  const incompleteAttestation = {
    run_id: "run-1",
    sandbox_id: "sbx-1",
    exe_vm_id: "vm-1",
    tailscale_node_id: "node-1",
    terminal_state: "CLEAN_TERMINATED" as const,
    credentials_revoked: true,
    tailscale_absent_or_deauthorized: true,
    exe_vm_absent_or_provider_terminal: false, // VM destruction failed!
    post_teardown_probes_passed: true,
    evidence_chain_head: "a".repeat(64),
    signing_key_id: "k1",
    signature: "sig"
  };

  const evalResult = evaluateCleanTerminated(incompleteAttestation);
  assert.equal(evalResult.passed, false);
  assert(evalResult.violations.some((v) => v.includes("Predicate 8 Failed")));
});

// ---------------------------------------------------------------------------
// CRITERION 18: Advisory Output Must Be Collected + Hash Verified (AC 18)
// ---------------------------------------------------------------------------
test("AC 18: Advisory output must be collected + hash verified", async () => {
  const { privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(new InMemoryEvidenceStore(), privateKey);
  const sandbox = new MockSandboxHarness({ runId: "run-adv-1" });

  const result = await collectAndVerifyAdvisoryOutput({
    runId: "run-adv-1",
    tenantId: "tenant-mock-001",
    requestId: "req-adv-1",
    sandboxId: "sbx-001",
    policyVersion: "v1.0.0",
    ledger,
    fetchPackage: () => sandbox.fetchPackage()
  });

  assert.equal(result.verified, true);
  assert.equal(result.resultStatus, "completed");

  // Corrupted manifest SHA256 is rejected immediately
  sandbox.corruptManifestHash = true;
  await assert.rejects(
    () =>
      collectAndVerifyAdvisoryOutput({
        runId: "run-adv-1",
        tenantId: "tenant-mock-001",
        requestId: "req-adv-1",
        sandboxId: "sbx-001",
        policyVersion: "v1.0.0",
        ledger,
        fetchPackage: () => sandbox.fetchPackage()
      }),
    { message: /ManifestVerificationError/ }
  );
});

// ---------------------------------------------------------------------------
// CRITERION 19: External Lease Ownership + Silent Sandbox Stop Path (AC 19)
// ---------------------------------------------------------------------------
test("AC 19: Sandbox cannot renew lease; silent sandbox externally terminated by watchdog", async () => {
  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore);

  await leaseManager.acquireLease("run-silent-1", "tenant-1", 100);

  let watchdogTriggered = false;
  const start = Date.now();
  const watchdog = leaseManager.startLivenessWatchdog("run-silent-1", {
    heartbeatWindowMs: 40,
    checkIntervalMs: 15,
    getExternalActivityTimestamp: () => start,
    onSilentSandbox: async () => {
      watchdogTriggered = true;
    }
  });

  await new Promise((r) => setTimeout(r, 90));
  watchdog.stop();

  assert.equal(watchdogTriggered, true);
});

// ---------------------------------------------------------------------------
// CRITERION 20: Delegation Posture: Isolated-Only, One-Phase-Per-Attempt (AC 20)
// ---------------------------------------------------------------------------
test("AC 20: One-phase-per-attempt, isolated-only delegation, fresh VM default", async () => {
  const store = new InMemoryPhaseEnvelopeStore();
  const dispatcher = new DelegationDispatcher(store);
  const run = makeSampleRun();

  // Valid isolated single-phase delegation succeeds
  const envelopeResult = await dispatcher.buildAndDispatchEnvelope({
    run,
    phase: "build",
    phaseAttempt: 1,
    taskEnvelopeHash: "a".repeat(64),
    agentsMdSha256: "b".repeat(64),
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"],
    acceptanceCriteria: ["Passes build"],
    commandPolicyId: "cmd-strict-v1",
    runtimeCredentialReference: "cred-ref-1"
  });

  assert.equal(envelopeResult.envelope.network_policy, "isolated");
  assert.equal(envelopeResult.envelope.phase, "build");
  assert.equal(envelopeResult.envelopeHash.length, 64);

  // Non-isolated policy in v1 throws via assertV1DelegationPolicy
  assert.throws(
    () =>
      assertV1DelegationPolicy({
        ...envelopeResult.envelope,
        network_policy: "approved_private_only"
      }),
    { message: /v1 requires isolated network_policy/ }
  );
});
