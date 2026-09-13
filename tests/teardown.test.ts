import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { TeardownEngine, StaleCallbackRejector, TerminalStateError } from "../src/core/teardownEngine.js";
import { RunStateMachine, InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { LeaseManager, InMemoryLeaseStorage } from "../src/core/leaseManager.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";
import { TailscaleClient, TailscaleDevice } from "../src/adapters/tailscale/client.js";
import { ExeDevClient, ExeDevVmStatus } from "../src/adapters/exedev/client.js";
import { probeFormerSandboxEndpoints } from "../src/warden/networkProber.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRunRecord(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-td-001",
    tenant_id: "tenant-td-001",
    request_id: "req-td-001",
    idempotency_key: "idem-td-001",
    parent_git_sha: "c".repeat(40),
    policy_version: "v1.0.0",
    phase: "terminal",
    state_version: 3,
    budget: { max_cost_cents: 100 },
    envelope: {},
    ...overrides
  };
}

test("probeFormerSandboxEndpoints detects closed/unreachable ports", async () => {
  // Using a mock socket connector simulating closed ports
  const mockConnector = async (_host: string, _port: number) => {
    return { reachable: false, code: "ECONNREFUSED", error: "Connection refused" };
  };

  const summary = await probeFormerSandboxEndpoints("100.81.98.99", [4501, 8787, 22], 100, mockConnector);
  assert.equal(summary.allUnreachable, true);
  assert.equal(summary.probes.length, 3);
  assert.equal(summary.probes[0].reachable, false);
});

test("probeFormerSandboxEndpoints fails if any port is still reachable", async () => {
  const mockConnector = async (_host: string, port: number) => {
    if (port === 4501) {
      return { reachable: true }; // preview port leaked!
    }
    return { reachable: false, code: "ECONNREFUSED" };
  };

  const summary = await probeFormerSandboxEndpoints("100.81.98.99", [4501, 8787, 22], 100, mockConnector);
  assert.equal(summary.allUnreachable, false);
  const openPort = summary.probes.find((p) => p.port === 4501);
  assert.equal(openPort?.reachable, true);
});

test("StaleCallbackRejector registers terminal run and throws TerminalStateError", () => {
  const rejector = new StaleCallbackRejector();
  assert.equal(rejector.isTerminal("run-001"), false);
  rejector.assertNotTerminal("run-001");

  rejector.markTerminal("run-001");
  assert.equal(rejector.isTerminal("run-001"), true);
  assert.throws(
    () => rejector.assertNotTerminal("run-001"),
    (err: unknown) => {
      assert(err instanceof TerminalStateError);
      assert.match((err as Error).message, /Run 'run-001' is in terminal\/teardown state/);
      return true;
    }
  );
});

test("TeardownEngine executes clean 13-step teardown and attests CLEAN_TERMINATED", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const runStore = new InMemoryRunStateStore();
  const runRecord = makeRunRecord({ phase: "terminal", state_version: 3 });
  runStore.setRun(runRecord);
  const stateMachine = new RunStateMachine(runStore);

  const leaseStore = new InMemoryLeaseStorage();
  await leaseStore.upsertLease({
    runId: "run-td-001",
    tenantId: "tenant-td-001",
    holderId: "worker-1",
    fencingToken: 1,
    expiresAt: new Date(Date.now() + 60000)
  });
  const leaseManager = new LeaseManager(leaseStore);

  const evidenceStore = new InMemoryEvidenceStore();
  const evidenceLedger = new EvidenceLedger(evidenceStore, privateKey, "test-warden-key");
  const rejector = new StaleCallbackRejector();

  // Mock Tailscale client
  let deauthorizedNodeId: string | null = null;
  let deletedDeviceId: string | null = null;
  const mockTailscaleFetch: typeof fetch = async (url, init) => {
    const urlStr = url.toString();
    if (urlStr.includes("/device/node-123/expire")) {
      deauthorizedNodeId = "node-123";
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (urlStr.includes("/device/node-123") && init?.method === "DELETE") {
      deletedDeviceId = "node-123";
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (urlStr.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const tailscaleClient = new TailscaleClient({
    clientId: "dummy",
    clientSecret: "dummy",
    fetchFn: mockTailscaleFetch
  });

  // Mock ExeDev client
  let destroyedVmName: string | null = null;
  const mockExeDevFetch: typeof fetch = async (_url, init) => {
    const body = String(init?.body || "");
    if (body.startsWith("rm sbx-run-td-001")) {
      destroyedVmName = "sbx-run-td-001";
      return new Response("VM deleted", { status: 200 });
    }
    if (body.startsWith("status")) {
      return new Response("status: terminated", { status: 200 });
    }
    return new Response("OK", { status: 200 });
  };
  const exedevClient = new ExeDevClient({
    apiKey: "test-key",
    fetchFn: mockExeDevFetch
  });

  const mockProber = async (ip: string) => {
    return {
      targetIp: ip,
      allUnreachable: true,
      probes: [
        { port: 4501, reachable: false },
        { port: 8787, reachable: false },
        { port: 22, reachable: false }
      ]
    };
  };

  const engine = new TeardownEngine({
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient,
    evidenceLedger,
    staleCallbackRejector: rejector,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    keyId: "test-warden-key",
    networkProber: mockProber
  });

  const result = await engine.executeTeardown({
    runId: "run-td-001",
    tenantId: "tenant-td-001",
    requestId: "req-td-001",
    sandboxId: "sbx-001",
    exeVmId: "sbx-run-td-001",
    tailscaleNodeId: "node-123",
    tailscaleIp: "100.81.98.99",
    policyVersion: "v1.0.0",
    fencingToken: 1,
    expectedStateVersion: 3,
    currentPhase: "terminal"
  });

  assert.equal(result.cleanTerminated, true);
  assert.equal(result.finalPhase, "clean_terminated");
  assert.equal(result.attestation.terminal_state, "CLEAN_TERMINATED");
  assert.equal(result.attestation.credentials_revoked, true);
  assert.equal(result.attestation.tailscale_absent_or_deauthorized, true);
  assert.equal(result.attestation.exe_vm_absent_or_provider_terminal, true);
  assert.equal(result.attestation.post_teardown_probes_passed, true);
  assert.equal(result.evaluation.passed, true);

  // Assert external steps verified
  assert.equal(deauthorizedNodeId, "node-123");
  assert.equal(deletedDeviceId, "node-123");
  assert.equal(destroyedVmName, "sbx-run-td-001");
  assert.equal(rejector.isTerminal("run-td-001"), true);

  // Assert state machine reached clean_terminated
  const finalRun = await runStore.getRun("run-td-001");
  assert.equal(finalRun?.phase, "clean_terminated");
  assert.equal(finalRun?.state_version, 4);

  // Assert lease was released (expired)
  const lease = await leaseStore.getLease("run-td-001");
  assert(lease !== null);
  assert(lease.expiresAt.getTime() <= Date.now());
});

test("TeardownEngine transitions to quarantined if active network probe fails", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const runStore = new InMemoryRunStateStore();
  const runRecord = makeRunRecord({ phase: "terminal", state_version: 5 });
  runStore.setRun(runRecord);
  const stateMachine = new RunStateMachine(runStore);

  const leaseStore = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStore);
  const evidenceStore = new InMemoryEvidenceStore();
  const evidenceLedger = new EvidenceLedger(evidenceStore, privateKey, "test-warden-key");
  const rejector = new StaleCallbackRejector();

  const mockTailscaleFetch: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  const tailscaleClient = new TailscaleClient({ clientId: "d", clientSecret: "d", fetchFn: mockTailscaleFetch });
  const mockExeDevFetch: typeof fetch = async () => new Response("OK", { status: 200 });
  const exedevClient = new ExeDevClient({ apiKey: "key", fetchFn: mockExeDevFetch });

  // Port 4501 is still reachable (probe fails)
  const leakingProber = async (ip: string) => ({
    targetIp: ip,
    allUnreachable: false,
    probes: [
      { port: 4501, reachable: true },
      { port: 8787, reachable: false },
      { port: 22, reachable: false }
    ]
  });

  const engine = new TeardownEngine({
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient,
    evidenceLedger,
    staleCallbackRejector: rejector,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    networkProber: leakingProber
  });

  const result = await engine.executeTeardown({
    runId: "run-td-001",
    tenantId: "tenant-td-001",
    requestId: "req-td-001",
    sandboxId: "sbx-001",
    exeVmId: "sbx-run-td-001",
    tailscaleNodeId: "node-123",
    tailscaleIp: "100.81.98.99",
    policyVersion: "v1.0.0",
    fencingToken: 1,
    expectedStateVersion: 5,
    currentPhase: "terminal"
  });

  assert.equal(result.cleanTerminated, false);
  assert.equal(result.finalPhase, "quarantined");
  assert.equal(result.attestation.terminal_state, "TEARDOWN_FAILED");
  assert.equal(result.evaluation.passed, false);
  assert(result.evaluation.violations.some((v) => v.includes("Predicate 5 Failed") || v.includes("Predicate 9 Failed")));

  const finalRun = await runStore.getRun("run-td-001");
  assert.equal(finalRun?.phase, "quarantined");
});
