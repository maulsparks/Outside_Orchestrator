import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";

function getTestKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

test("EvidenceLedger builds contiguous, hash-linked cryptographic chain", async () => {
  const { privateKeyPem, publicKeyPem } = getTestKeys();
  const store = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(store, privateKeyPem, "key-test-1");

  const evt1 = await ledger.recordEvent({
    tenantId: "tenant-1",
    requestId: "req-1",
    runId: "run-1",
    sandboxId: "sbx-1",
    policyVersion: "v1.0.0",
    eventType: "vm_provisioned",
    source: { provider: "exedev" },
    observation: { vmId: "vm-1" }
  });

  assert.equal(evt1.sequence, 1);
  assert.equal(evt1.previous_event_hash, "0".repeat(64));

  const evt2 = await ledger.recordEvent({
    tenantId: "tenant-1",
    requestId: "req-1",
    runId: "run-1",
    sandboxId: "sbx-1",
    policyVersion: "v1.0.0",
    eventType: "tailscale_enrolled",
    source: { provider: "tailscale" },
    observation: { nodeId: "node-1" }
  });

  assert.equal(evt2.sequence, 2);
  assert.equal(evt2.previous_event_hash, evt1.event_hash);

  const evt3 = await ledger.recordEvent({
    tenantId: "tenant-1",
    requestId: "req-1",
    runId: "run-1",
    sandboxId: "sbx-1",
    policyVersion: "v1.0.0",
    eventType: "phase_delegated",
    source: { provider: "warden" },
    observation: { phase: "build" }
  });

  assert.equal(evt3.sequence, 3);
  assert.equal(evt3.previous_event_hash, evt2.event_hash);

  const verification = await ledger.verifyChain("run-1", publicKeyPem);
  assert.equal(verification.valid, true);
  assert.equal(verification.errors.length, 0);
  assert.equal(verification.chainLength, 3);
  assert.equal(verification.chainHead, evt3.event_hash);
});

test("verifyChain detects tampered payload in ledger history", async () => {
  const { privateKeyPem, publicKeyPem } = getTestKeys();
  const store = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(store, privateKeyPem, "key-test-1");

  await ledger.recordEvent({
    tenantId: "tenant-1",
    requestId: "req-1",
    runId: "run-1",
    sandboxId: "sbx-1",
    policyVersion: "v1.0.0",
    eventType: "vm_provisioned",
    source: { provider: "exedev" },
    observation: { vmId: "vm-1" }
  });

  // Tamper with stored record directly
  store.tamperRecord("run-1", 1, (rec) => {
    rec.payload = { ...rec.payload, tampered: true };
  });

  const verification = await ledger.verifyChain("run-1", publicKeyPem);
  assert.equal(verification.valid, false);
  assert.ok(verification.errors.some((e) => e.includes("Payload hash mismatch")));
});

test("verifyChain detects broken hash chain link", async () => {
  const { privateKeyPem, publicKeyPem } = getTestKeys();
  const store = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(store, privateKeyPem, "key-test-1");

  await ledger.recordEvent({
    tenantId: "tenant-1",
    requestId: "req-1",
    runId: "run-1",
    sandboxId: "sbx-1",
    policyVersion: "v1.0.0",
    eventType: "vm_provisioned",
    source: { provider: "exedev" },
    observation: { vmId: "vm-1" }
  });

  await ledger.recordEvent({
    tenantId: "tenant-1",
    requestId: "req-1",
    runId: "run-1",
    sandboxId: "sbx-1",
    policyVersion: "v1.0.0",
    eventType: "tailscale_enrolled",
    source: { provider: "tailscale" },
    observation: { nodeId: "node-1" }
  });

  // Tamper with record 2's previous_event_hash
  store.tamperRecord("run-1", 2, (rec) => {
    rec.previous_event_hash = "f".repeat(64);
  });

  const verification = await ledger.verifyChain("run-1", publicKeyPem);
  assert.equal(verification.valid, false);
  assert.ok(verification.errors.some((e) => e.includes("Previous hash broken")));
});
