import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { canonicalizeJson } from "../src/warden/canonicalizer.js";
import {
  computeEventHash,
  computePayloadSha256,
  createSignedBoundaryEvent,
  signBoundaryEvent,
  verifyBoundaryEvent
} from "../src/warden/signer.js";

test("canonicalizeJson produces deterministic output regardless of key order", () => {
  const payload1 = {
    z_key: "last",
    a_key: "first",
    nested: { d: 4, b: 2, c: 3 }
  };

  const payload2 = {
    a_key: "first",
    nested: { c: 3, d: 4, b: 2 },
    z_key: "last"
  };

  const c1 = canonicalizeJson(payload1);
  const c2 = canonicalizeJson(payload2);

  assert.equal(c1, c2);
  assert.equal(c1, '{"a_key":"first","nested":{"b":2,"c":3,"d":4},"z_key":"last"}');
});

test("canonicalizeJson handles -0 as 0 and rejects non-finite numbers", () => {
  assert.equal(canonicalizeJson({ zero: -0 }), '{"zero":0}');
  assert.throws(() => canonicalizeJson({ val: NaN }), { message: /RFC 8785 Error/ });
  assert.throws(() => canonicalizeJson({ val: Infinity }), { message: /RFC 8785 Error/ });
});

test("Ed25519 signer produces verifiable signatures over domain-separated event hash", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const eventInput = {
    eventId: "evt-001",
    sequence: 1,
    eventType: "tailscale_node_verified",
    tenantId: "tenant-001",
    requestId: "req-001",
    runId: "run-001",
    sandboxId: "sbx-001",
    policyVersion: "v1.0.0",
    observedAt: "2026-09-12T00:00:00.000Z",
    source: { kind: "tailscale_api" },
    observation: { active: true, tag: "tag:factory-sandbox" },
    previousEventHash: "0".repeat(64)
  };

  const signed = createSignedBoundaryEvent(eventInput, privateKeyPem, "key-test-01");

  assert.ok(signed.payloadSha256.length === 64);
  assert.ok(signed.eventHash.length === 64);
  assert.ok(signed.signature.length > 0);
  assert.equal(signed.signingKeyId, "key-test-01");
  assert.equal(signed.signatureAlgorithm, "Ed25519");

  // Verify valid signature
  const valid = verifyBoundaryEvent(signed.eventHash, signed.signature, publicKeyPem);
  assert.equal(valid, true);

  // Tampered event hash fails
  const tamperedHash = signed.eventHash.slice(0, -1) + (signed.eventHash.endsWith("0") ? "1" : "0");
  const tamperedValid = verifyBoundaryEvent(tamperedHash, signed.signature, publicKeyPem);
  assert.equal(tamperedValid, false);

  // Wrong public key fails
  const otherKeys = crypto.generateKeyPairSync("ed25519");
  const otherPublicKeyPem = otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const wrongKeyValid = verifyBoundaryEvent(signed.eventHash, signed.signature, otherPublicKeyPem);
  assert.equal(wrongKeyValid, false);
});
