import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { collectAndVerifyAdvisoryOutput, AdvisoryOutputPackage } from "../src/warden/collector.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";

function getTestKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

test("collectAndVerifyAdvisoryOutput pulls, verifies manifest SHA256, and writes signed evidence", async () => {
  const { privateKeyPem } = getTestKeys();
  const store = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(store, privateKeyPem, "key-test-1");

  const traceJsonl = '{"seq":1,"msg":"phase start"}\n{"seq":2,"msg":"phase end"}\n';
  const validManifestSha = crypto.createHash("sha256").update(traceJsonl, "utf8").digest("hex");

  const pkg: AdvisoryOutputPackage = {
    runId: "run-001",
    tenantId: "tenant-001",
    phase: "build",
    phaseAttempt: 1,
    sandboxId: "sbx-001",
    traceManifestSha256: validManifestSha,
    traceJsonl,
    declaredChangedFiles: ["src/index.ts", "package.json"],
    resultStatus: "completed"
  };

  const result = await collectAndVerifyAdvisoryOutput({
    runId: "run-001",
    tenantId: "tenant-001",
    requestId: "req-001",
    sandboxId: "sbx-001",
    policyVersion: "v1.0.0",
    ledger,
    fetchPackage: async () => pkg
  });

  assert.equal(result.verified, true);
  assert.equal(result.computedManifestSha256, validManifestSha);
  assert.deepEqual(result.declaredChangedFiles, ["src/index.ts", "package.json"]);
  assert.equal(result.resultStatus, "completed");

  const stored = await store.getAllForRun("run-001");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].payload.event_type, "advisory_output_collected");
});

test("collectAndVerifyAdvisoryOutput throws on manifest SHA256 mismatch", async () => {
  const { privateKeyPem } = getTestKeys();
  const store = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(store, privateKeyPem, "key-test-1");

  const traceJsonl = '{"seq":1,"msg":"phase start"}\n';
  const tamperedManifestSha = "f".repeat(64);

  const pkg: AdvisoryOutputPackage = {
    runId: "run-001",
    tenantId: "tenant-001",
    phase: "build",
    phaseAttempt: 1,
    sandboxId: "sbx-001",
    traceManifestSha256: tamperedManifestSha,
    traceJsonl,
    declaredChangedFiles: ["src/index.ts"],
    resultStatus: "completed"
  };

  await assert.rejects(
    async () =>
      collectAndVerifyAdvisoryOutput({
        runId: "run-001",
        tenantId: "tenant-001",
        requestId: "req-001",
        sandboxId: "sbx-001",
        policyVersion: "v1.0.0",
        ledger,
        fetchPackage: async () => pkg
      }),
    { message: /ManifestVerificationError/ }
  );
});
