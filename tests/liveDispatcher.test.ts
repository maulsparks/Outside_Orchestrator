import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { LiveDispatcher } from "../src/core/liveDispatcher.js";
import { ExeDevClient } from "../src/adapters/exedev/client.js";
import { TailscaleClient } from "../src/adapters/tailscale/client.js";
import { MockExeDevHarness } from "./mocks/mockExeDev.js";
import { MockTailscaleHarness } from "./mocks/mockTailscale.js";
import { RunStateMachine, InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { LeaseManager, InMemoryLeaseStorage } from "../src/core/leaseManager.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";
import { TeardownEngine, StaleCallbackRejector } from "../src/core/teardownEngine.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

test("LiveDispatcher executes complete lifecycle with mock sandbox and clean teardown", async (t) => {
  // 1. Setup in-process mock Inside Orchestrator on local ephemeral port
  let receivedDelegation: any = null;
  let stopReceived = false;
  const traceEvents = [
    { sequence: 1, event: "delegation_received", timestamp: new Date().toISOString() },
    { sequence: 2, event: "phase_completed", timestamp: new Date().toISOString() }
  ];
  const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join("\n");
  const manifestSha256 = crypto.createHash("sha256").update(traceJsonl, "utf8").digest("hex");

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
        receivedDelegation = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
      return;
    }

    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "completed", trace_count: traceEvents.length }));
    }

    if (url.pathname === "/trace/package") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        trace_manifest_sha256: manifestSha256,
        declared_changed_files: ["src/app.ts"]
      }));
    }

    if (url.pathname === "/trace/events") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      return res.end(traceJsonl);
    }

    if (url.pathname === "/stop" && req.method === "POST") {
      stopReceived = true;
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

  // 2. Setup mock control-plane dependencies
  const mockExeDev = new MockExeDevHarness();
  const mockTailscale = new MockTailscaleHarness();

  const runId = "test-live-001";
  const vmName = `sbx-${runId}`;

  // Seed mock tailscale device to match the VM name and return our mockIp
  mockTailscale.devices.set("ts-dev-001", {
    id: "ts-dev-001",
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
    tenant_id: "tenant-001",
    request_id: `req_${runId}`,
    phase: "created",
    state_version: 1,
    parent_git_sha: "abc1234567890abcdef1234567890abcdef1234",
    policy_version: "v2.0",
    budget: { max_cost_cents: 500, current_cost_cents: 0 },
    envelope: {
      schema_version: "v1",
      allowed_paths: ["src/**"],
      immutable_paths: ["AGENTS.md"]
    },
    idempotency_key: "key-001",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  stateStore.setRun(run);

  const stateMachine = new RunStateMachine(stateStore);
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "srv-test");
  await leaseManager.acquireLease("tenant-001", runId, 60000);

  const { privateKey, publicKey } = generateEd25519KeyPair();
  const privateKeyPem = privateKey;
  const publicKeyPem = publicKey;
  const evidenceLedger = new EvidenceLedger(new InMemoryEvidenceStore(), privateKeyPem);
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

  const liveDispatcher = new LiveDispatcher(
    exedevClient,
    tailscaleClient,
    leaseManager,
    evidenceLedger,
    teardownEngine,
    stateMachine
  );

  // 3. Execute live run
  const result = await liveDispatcher.executeRun({
    run,
    phase: "build",
    allowedPaths: ["src/**"],
    pollIntervalMs: 50,
    maxWaitBootMs: 2000
  });

  // 4. Assertions
  assert.equal(result.status, "completed");
  assert.equal(result.cleanTerminated, true);
  assert.equal(receivedDelegation !== null, true);
  assert.equal(receivedDelegation.phase, "build");
  assert.equal(receivedDelegation.network_policy, "isolated");
  assert.equal(stopReceived, true);

  // VM must be destroyed via ExeDevClient.rm
  assert.equal(mockExeDev.hasVm(vmName), false);
  // Stale callback rejector must register run as terminal
  assert.equal(staleRejector.isTerminal(runId), true);
});
