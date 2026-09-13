import assert from "node:assert/strict";
import test from "node:test";

import { mintRunJwt, verifyRunJwt } from "../src/adapters/supabase/jwt.js";
import { assertNotServiceRole, SupabaseRestClient } from "../src/adapters/supabase/client.js";

const TEST_SECRET = "test-secret-at-least-32-bytes-long-for-hmac-sha256-safety-ok";

test("mintRunJwt creates valid token with expected claims", () => {
  const token = mintRunJwt({
    runId: "run-123",
    tenantId: "tenant-abc",
    workspaceId: "ws-456",
    ttlSeconds: 600,
    secret: TEST_SECRET,
    projectRef: "sbauhlhgqxzwyxrqujsr"
  });

  assert.ok(typeof token === "string" && token.split(".").length === 3);

  const payload = verifyRunJwt(token, TEST_SECRET);
  assert.equal(payload.iss, "supabase");
  assert.equal(payload.ref, "sbauhlhgqxzwyxrqujsr");
  assert.equal(payload.role, "authenticated");
  assert.equal(payload.aud, "authenticated");
  assert.equal(payload.run_id, "run-123");
  assert.equal(payload.tenant_id, "tenant-abc");
  assert.equal(payload.workspace_id, "ws-456");
  assert.ok(payload.exp > payload.iat);
});

test("verifyRunJwt rejects tampered signature", () => {
  const token = mintRunJwt({
    runId: "run-123",
    tenantId: "tenant-abc",
    secret: TEST_SECRET
  });

  const [header, body] = token.split(".");
  const tamperedToken = `${header}.${body}.bad-signature`;

  assert.throws(() => verifyRunJwt(tamperedToken, TEST_SECRET), {
    message: "Invalid JWT signature"
  });
});

test("verifyRunJwt rejects expired token", () => {
  const token = mintRunJwt({
    runId: "run-123",
    tenantId: "tenant-abc",
    ttlSeconds: -10, // already expired
    secret: TEST_SECRET
  });

  assert.throws(() => verifyRunJwt(token, TEST_SECRET), {
    message: "JWT has expired"
  });
});

test("assertNotServiceRole throws for service_role client", () => {
  const client = new SupabaseRestClient({
    role: "service_role",
    apiKey: "test-key"
  });

  assert.throws(() => assertNotServiceRole(client), {
    message: /Security Violation: Master service_role credentials are prohibited in runtime phase loops/
  });
});

test("assertNotServiceRole succeeds for authenticated scoped client", () => {
  const client = new SupabaseRestClient({
    role: "authenticated",
    apiKey: "anon-key",
    authToken: "scoped-jwt"
  });

  assert.doesNotThrow(() => assertNotServiceRole(client));
});
