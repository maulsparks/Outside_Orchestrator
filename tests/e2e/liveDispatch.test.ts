import test from "node:test";
import assert from "node:assert/strict";
import { ExeDevClient } from "../../src/adapters/exedev/client.js";
import { TailscaleClient } from "../../src/adapters/tailscale/client.js";
import { LiveDispatcher } from "../../src/core/liveDispatcher.js";
import { RunStateMachine, InMemoryRunStateStore, FactoryRunRecord } from "../../src/core/stateMachine.js";
import { LeaseManager, InMemoryLeaseStorage } from "../../src/core/leaseManager.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../../src/warden/ledger.js";
import { TeardownEngine, StaleCallbackRejector } from "../../src/core/teardownEngine.js";
import crypto from "node:crypto";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

test("E2E Live Sandbox Dispatch against exe.dev and Tailscale", {
  skip: !process.env.LIVE_E2E || !process.env.EXEDEV_API_KEY || !process.env.TAILSCALE_CLIENT_ID
}, async () => {
  const exedevClient = new ExeDevClient();
  const tailscaleClient = new TailscaleClient();

  const runId = `e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tenantId = "tenant-e2e-live";

  const stateStore = new InMemoryRunStateStore();
  const run: FactoryRunRecord = {
    id: runId,
    tenant_id: tenantId,
    request_id: `req_${runId}`,
    phase: "created",
    state_version: 1,
    parent_git_sha: "3b2576026155a47f0132aa99fa78a43c045d92d5",
    policy_version: "v2.0",
    budget: { max_cost_cents: 500, current_cost_cents: 0 },
    envelope: {
      schema_version: "v1",
      allowed_paths: ["src/**", "output/**"],
      immutable_paths: ["AGENTS.md"]
    },
    idempotency_key: `idemp-${runId}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  stateStore.setRun(run);

  const stateMachine = new RunStateMachine(stateStore);
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "e2e-test-runner");
  await leaseManager.acquireLease(tenantId, runId, 600000);

  const { privateKey, publicKey } = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const evidenceLedger = new EvidenceLedger(evidenceStore, privateKey);
  const staleRejector = new StaleCallbackRejector();

  const teardownEngine = new TeardownEngine({
    stateMachine,
    leaseManager,
    tailscaleClient,
    exedevClient,
    evidenceLedger,
    staleCallbackRejector: staleRejector,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey
  });

  const liveDispatcher = new LiveDispatcher(
    exedevClient,
    tailscaleClient,
    leaseManager,
    evidenceLedger,
    teardownEngine,
    stateMachine
  );

  const result = await liveDispatcher.executeRun({
    run,
    phase: "build",
    allowedPaths: ["src/**", "output/**"],
    ttlSeconds: 300
  });

  assert.equal(result.status, "completed");
  assert.equal(result.cleanTerminated, true);
  assert.equal(result.teardownResult.cleanTerminated, true);
  assert.equal(result.teardownResult.finalPhase, "clean_terminated");

  // Verify zero lingering VMs
  const vms = await exedevClient.listVms();
  const matchingVm = vms.find(v => v.raw.includes(`sbx-${runId}`));
  assert.equal(matchingVm, undefined);
});
