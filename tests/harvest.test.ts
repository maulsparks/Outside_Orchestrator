import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import {
  computeTestSuiteHash,
  executeFrozenTestSuite,
  signHarvest,
  verifyHarvestSignature,
  authorizeHarvest
} from "../src/core/harvest.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

test("executeFrozenTestSuite passes when test files match immutable hash and suite passes", async () => {
  const testFiles = {
    "tests/acceptance.test.ts": "test('math', () => assert.equal(1+1, 2));",
    "tests/helper.ts": "export const MAGIC = 42;"
  };

  const expectedSuiteHash = computeTestSuiteHash(testFiles);

  const result = await executeFrozenTestSuite({
    testFiles,
    expectedSuiteHash,
    runTests: async () => ({ exitCode: 0, stdout: "All tests passed", durationMs: 45 })
  });

  assert.equal(result.passed, true);
  assert.equal(result.suiteHashVerified, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
});

test("executeFrozenTestSuite rejects runs where builder tampers with acceptance test files (AC 6)", async () => {
  const originalTestFiles = {
    "tests/acceptance.test.ts": "test('strict requirement', () => assert.equal(processResult(), true));"
  };
  const expectedSuiteHash = computeTestSuiteHash(originalTestFiles);

  // Builder tampers with the test suite to artificially pass
  const tamperedFiles = {
    "tests/acceptance.test.ts": "test('tampered requirement', () => assert.equal(true, true));"
  };

  const result = await executeFrozenTestSuite({
    testFiles: tamperedFiles,
    expectedSuiteHash,
    runTests: async () => ({ exitCode: 0, stdout: "All tests passed" })
  });

  assert.equal(result.passed, false);
  assert.equal(result.suiteHashVerified, false);
  assert.match(result.error ?? "", /FrozenSuiteTamperedError/);
});

test("executeFrozenTestSuite fails when tests fail with non-zero exit code", async () => {
  const testFiles = { "tests/foo.test.ts": "test('fails', () => assert.fail());" };
  const expectedSuiteHash = computeTestSuiteHash(testFiles);

  const result = await executeFrozenTestSuite({
    testFiles,
    expectedSuiteHash,
    runTests: async () => ({ exitCode: 1, stdout: "1 test failed" })
  });

  assert.equal(result.passed, false);
  assert.equal(result.suiteHashVerified, true);
  assert.equal(result.exitCode, 1);
});

test("authorizeHarvest authorizes harvest with valid human cryptographic signature and clean teardown (AC 10)", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-key");

  const harvestParams = {
    runId: "run-hv-001",
    selectedArmId: "arm-a",
    treeSha: "b".repeat(40),
    envelopeHash: "c".repeat(64),
    policyVersion: "v1.0.0"
  };

  const humanSignature = signHarvest(
    {
      runId: harvestParams.runId,
      treeSha: harvestParams.treeSha,
      envelopeHash: harvestParams.envelopeHash,
      policyVersion: harvestParams.policyVersion
    },
    privateKey
  );

  const result = await authorizeHarvest({
    ...harvestParams,
    signerIdentity: "human:reviewer@platform.internal",
    signature: humanSignature,
    publicKeyPem: publicKey,
    isCleanTerminated: true,
    ergPassed: true,
    testGatePassed: true,
    teardownEvidenceId: "evt_teardown_123",
    tenantId: "tenant-hv-001",
    requestId: "req-hv-001",
    ledger
  });

  assert.equal(result.authorized, true);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.attestation?.run_id, "run-hv-001");
  assert.equal(result.attestation?.accepted_tree_sha, "b".repeat(40));
  assert.equal(result.attestation?.signer_identity, "human:reviewer@platform.internal");

  // Verify signed event was recorded in evidence ledger
  const records = await evidenceStore.getAllForRun("run-hv-001");
  assert.equal(records.length, 1);
  const obs = (records[0].payload as { observation?: { harvest_authorized?: boolean } }).observation;
  assert.equal(obs?.harvest_authorized, true);
});

test("authorizeHarvest strictly blocks harvest if teardown is not CLEAN_TERMINATED (AC 10, AC 17)", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();

  const harvestParams = {
    runId: "run-hv-002",
    selectedArmId: "arm-a",
    treeSha: "b".repeat(40),
    envelopeHash: "c".repeat(64),
    policyVersion: "v1.0.0"
  };

  const sig = signHarvest(harvestParams, privateKey);

  const result = await authorizeHarvest({
    ...harvestParams,
    signerIdentity: "human:reviewer@platform.internal",
    signature: sig,
    publicKeyPem: publicKey,
    isCleanTerminated: false, // NOT clean terminated
    ergPassed: true,
    testGatePassed: true,
    teardownEvidenceId: "evt_teardown_fail"
  });

  assert.equal(result.authorized, false);
  assert(result.reasons.some((r) => r.includes("CLEAN_TERMINATED")));
});

test("authorizeHarvest rejects forged or invalid human signatures", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const { privateKey: otherPrivateKey } = generateEd25519KeyPair();

  const harvestParams = {
    runId: "run-hv-003",
    selectedArmId: "arm-a",
    treeSha: "b".repeat(40),
    envelopeHash: "c".repeat(64),
    policyVersion: "v1.0.0"
  };

  // Signed by unauthorized key
  const invalidSig = signHarvest(harvestParams, otherPrivateKey);

  const result = await authorizeHarvest({
    ...harvestParams,
    signerIdentity: "human:reviewer@platform.internal",
    signature: invalidSig,
    publicKeyPem: publicKey, // does not match otherPrivateKey
    isCleanTerminated: true,
    ergPassed: true,
    testGatePassed: true,
    teardownEvidenceId: "evt_teardown_123"
  });

  assert.equal(result.authorized, false);
  assert(result.reasons.some((r) => r.includes("signature")));
});
