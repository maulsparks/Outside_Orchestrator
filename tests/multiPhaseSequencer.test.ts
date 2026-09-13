import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { MultiPhaseSequencer } from "../src/core/multiPhaseSequencer.js";
import { LiveDispatcher } from "../src/core/liveDispatcher.js";
import { ExeDevClient } from "../src/adapters/exedev/client.js";
import { TailscaleClient } from "../src/adapters/tailscale/client.js";
import { MockExeDevHarness } from "./mocks/mockExeDev.js";
import { MockTailscaleHarness } from "./mocks/mockTailscale.js";
import { RunStateMachine, InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { LeaseManager, InMemoryLeaseStorage } from "../src/core/leaseManager.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";
import { TeardownEngine, StaleCallbackRejector } from "../src/core/teardownEngine.js";
import { InMemoryPhaseEnvelopeStore } from "../src/core/dispatcher.js";
import type { Phase as FactoryExecutionPhase } from "../contracts/interfaces.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

test("MultiPhaseSequencer executes 3-phase sequence (plan -> build -> test) with tree SHA propagation", async (t) => {
  // 1. Setup in-process mock Inside Orchestrator
  let delegatedPhases: string[] = [];
  let stopCount = 0;
  let shouldFailBuild = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", role: "Inside_Orchestrator" }));
    }

    if (url.pathname === "/delegate" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const payload = JSON.parse(body);
        delegatedPhases.push(payload.phase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
      return;
    }

    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const currentPhase = delegatedPhases[delegatedPhases.length - 1];
      if (shouldFailBuild && currentPhase === "build") {
        return res.end(JSON.stringify({ status: "failed", error: "CompileError" }));
      }
      return res.end(JSON.stringify({ status: "completed", trace_count: 2 }));
    }

    if (url.pathname === "/trace/package") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const currentPhase = delegatedPhases[delegatedPhases.length - 1];
      const traceEvents = [
        { sequence: 1, event: "delegation_received", phase: currentPhase },
        { sequence: 2, event: "phase_completed", phase: currentPhase }
      ];
      const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join("\n");
      const manifestSha256 = crypto.createHash("sha256").update(traceJsonl, "utf8").digest("hex");

      return res.end(JSON.stringify({
        trace_manifest_sha256: manifestSha256,
        declared_changed_files: [`src/${currentPhase}_output.ts`]
      }));
    }

    if (url.pathname === "/trace/events") {
      const currentPhase = delegatedPhases[delegatedPhases.length - 1];
      const traceEvents = [
        { sequence: 1, event: "delegation_received", phase: currentPhase },
        { sequence: 2, event: "phase_completed", phase: currentPhase }
      ];
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      return res.end(traceEvents.map(e => JSON.stringify(e)).join("\n"));
    }

    if (url.pathname === "/stop" && req.method === "POST") {
      stopCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ stopped: true }));
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const mockIp = `127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  // 2. Setup mock harnesses
  const mockExeDev = new MockExeDevHarness();
  const mockTailscale = new MockTailscaleHarness();

  const runId = "multi-phase-001";
  const tenantId = "tenant-mp-01";
  const initialParentSha = "1111111111111111111111111111111111111111";

  // Seed mock Tailscale devices for each expected phase sandbox name
  const phases: FactoryExecutionPhase[] = ["plan", "build", "test"];
  for (const p of phases) {
    const vmName = `sbx-${runId}-${p}`;
    mockTailscale.devices.set(`ts-${p}`, {
      id: `ts-${p}`,
      name: `${vmName}.tailscale.net`,
      hostname: vmName,
      addresses: [mockIp],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false,
      advertisedRoutes: [],
      exitNode: false,
      expires: new Date(Date.now() + 3600000).toISOString()
    });
  }

  const exedevClient = new ExeDevClient({
    apiKey: "mock-key",
    fetchFn: mockExeDev.createFetch()
  });

  const tailscaleClient = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mockTailscale.createFetch()
  });

  const stateStore = new InMemoryRunStateStore();
  const run: FactoryRunRecord = {
    id: runId,
    tenant_id: tenantId,
    request_id: `req_${runId}`,
    phase: "created",
    state_version: 1,
    parent_git_sha: initialParentSha,
    policy_version: "v2.0",
    budget: { max_cost_cents: 500 },
    envelope: {},
    idempotency_key: `idem-${runId}`
  };
  stateStore.setRun(run);

  const stateMachine = new RunStateMachine(stateStore);
  const leaseStorage = new InMemoryLeaseStorage();
  const leaseManager = new LeaseManager(leaseStorage, "mp-test-runner");
  await leaseManager.acquireLease(tenantId, runId, 600000);

  const { privateKey: privateKeyPem, publicKey: publicKeyPem } = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const evidenceLedger = new EvidenceLedger(evidenceStore, privateKeyPem);
  const staleRejector = new StaleCallbackRejector();

  const teardownEngine = new TeardownEngine({
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient,
    evidenceLedger,
    staleCallbackRejector: staleRejector,
    privateKeyPem,
    publicKeyPem,
    networkProber: async (ip: string) => ({
      targetIp: ip,
      allUnreachable: true,
      probes: []
    })
  });

  const phaseEnvelopeStore = new InMemoryPhaseEnvelopeStore();

  const liveDispatcher = new LiveDispatcher(
    exedevClient,
    tailscaleClient,
    leaseManager,
    evidenceLedger,
    teardownEngine,
    stateMachine,
    phaseEnvelopeStore
  );

  const sequencer = new MultiPhaseSequencer(
    liveDispatcher,
    stateMachine,
    stateStore,
    evidenceLedger,
    phaseEnvelopeStore
  );

  // 3. Execute 3-phase sequence
  const result = await sequencer.executeSequence({
    run,
    phases,
    allowedPaths: ["src/**"],
    pollIntervalMs: 50,
    maxWaitBootMs: 2000
  });

  // 4. Assertions
  assert.equal(result.status, "completed");
  assert.equal(result.completedPhases.length, 3);
  assert.deepEqual(result.completedPhases, ["plan", "build", "test"]);
  assert.equal(result.finalPhase, "test");
  assert.notEqual(result.finalTreeSha, initialParentSha);

  // Assert Inside Orchestrator received all 3 phases in order
  assert.deepEqual(delegatedPhases, ["plan", "build", "test"]);
  // Assert stop sentinel was sent for each phase teardown
  assert.equal(stopCount, 3);

  // Assert PhaseEnvelopeStore has 3 envelopes with completed status
  const recordedEnvelopes = await phaseEnvelopeStore.listPhaseEnvelopes(runId);
  assert.equal(recordedEnvelopes.length, 3);
  assert.equal(recordedEnvelopes[0].phase, "plan");
  assert.equal(recordedEnvelopes[0].outputs?.status, "completed");
  assert.equal(recordedEnvelopes[1].phase, "build");
  assert.equal(recordedEnvelopes[1].outputs?.status, "completed");
  assert.equal(recordedEnvelopes[2].phase, "test");
  assert.equal(recordedEnvelopes[2].outputs?.status, "completed");

  // Assert tree propagation: phase 2 parent_git_sha matches phase 1 output_tree_sha
  assert.equal(
    recordedEnvelopes[1].inputs.parent_git_sha,
    recordedEnvelopes[0].outputs?.output_tree_sha
  );
  // Assert phase 3 parent_git_sha matches phase 2 output_tree_sha
  assert.equal(
    recordedEnvelopes[2].inputs.parent_git_sha,
    recordedEnvelopes[1].outputs?.output_tree_sha
  );

  // Assert final state in store is clean_terminated
  const finalRun = await stateStore.getRun(runId);
  assert.equal(finalRun?.phase, "clean_terminated");
});

test("MultiPhaseSequencer stops immediately and records failure if a phase fails", async (t) => {
  let delegatedPhases: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }

    if (url.pathname === "/delegate" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        const payload = JSON.parse(body);
        delegatedPhases.push(payload.phase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
      return;
    }

    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const currentPhase = delegatedPhases[delegatedPhases.length - 1];
      if (currentPhase === "build") {
        return res.end(JSON.stringify({ status: "failed", error: "CompilationFailed" }));
      }
      return res.end(JSON.stringify({ status: "completed" }));
    }

    if (url.pathname === "/trace/package") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const traceEvents = [{ sequence: 1, event: "phase_completed" }];
      const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join("\n");
      const manifestSha256 = crypto.createHash("sha256").update(traceJsonl, "utf8").digest("hex");
      return res.end(JSON.stringify({
        trace_manifest_sha256: manifestSha256,
        declared_changed_files: ["src/plan.ts"]
      }));
    }

    if (url.pathname === "/trace/events") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      return res.end(JSON.stringify({ sequence: 1, event: "phase_completed" }));
    }

    if (url.pathname === "/stop" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ stopped: true }));
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const mockIp = `127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  const mockExeDev = new MockExeDevHarness();
  const mockTailscale = new MockTailscaleHarness();

  const runId = "multi-phase-fail-001";
  const tenantId = "tenant-mp-02";

  for (const p of ["plan", "build", "test"]) {
    const vmName = `sbx-${runId}-${p}`;
    mockTailscale.devices.set(`ts-${p}`, {
      id: `ts-${p}`,
      name: `${vmName}.tailscale.net`,
      hostname: vmName,
      addresses: [mockIp],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false,
      advertisedRoutes: [],
      exitNode: false,
      expires: new Date(Date.now() + 3600000).toISOString()
    });
  }

  const exedevClient = new ExeDevClient({ apiKey: "mock-key", fetchFn: mockExeDev.createFetch() });
  const tailscaleClient = new TailscaleClient({ clientId: "mock-id", clientSecret: "mock-secret", fetchFn: mockTailscale.createFetch() });
  const stateStore = new InMemoryRunStateStore();
  const run: FactoryRunRecord = {
    id: runId,
    tenant_id: tenantId,
    request_id: `req_${runId}`,
    phase: "created",
    state_version: 1,
    parent_git_sha: "0000000000000000000000000000000000000000",
    policy_version: "v2.0",
    budget: { max_cost_cents: 500 },
    envelope: {},
    idempotency_key: `idem-${runId}`
  };
  stateStore.setRun(run);

  const stateMachine = new RunStateMachine(stateStore);
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "mp-fail-runner");
  await leaseManager.acquireLease(tenantId, runId, 600000);

  const { privateKey: privateKeyPem, publicKey: publicKeyPem } = generateEd25519KeyPair();
  const evidenceLedger = new EvidenceLedger(new InMemoryEvidenceStore(), privateKeyPem);
  const teardownEngine = new TeardownEngine({
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient,
    evidenceLedger,
    staleCallbackRejector: new StaleCallbackRejector(),
    privateKeyPem,
    publicKeyPem,
    networkProber: async (ip: string) => ({ targetIp: ip, allUnreachable: true, probes: [] })
  });

  const phaseEnvelopeStore = new InMemoryPhaseEnvelopeStore();
  const liveDispatcher = new LiveDispatcher(
    exedevClient,
    tailscaleClient,
    leaseManager,
    evidenceLedger,
    teardownEngine,
    stateMachine,
    phaseEnvelopeStore
  );

  const sequencer = new MultiPhaseSequencer(
    liveDispatcher,
    stateMachine,
    stateStore,
    evidenceLedger,
    phaseEnvelopeStore
  );

  // Execute sequence: plan succeeds, build fails
  const result = await sequencer.executeSequence({
    run,
    phases: ["plan", "build", "test"],
    allowedPaths: ["src/**"],
    pollIntervalMs: 50,
    maxWaitBootMs: 2000
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failedPhase, "build");
  assert.deepEqual(result.completedPhases, ["plan"]);
  // test phase must NEVER have been delegated
  assert.equal(delegatedPhases.includes("test"), false);
  assert.deepEqual(delegatedPhases, ["plan", "build"]);
});
