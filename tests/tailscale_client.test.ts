import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { TailscaleClient } from "../src/adapters/tailscale/client.js";

test("TailscaleClient exchanges OAuth credentials and caches access token", async () => {
  let oauthCallCount = 0;

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v2/oauth/token")) {
      oauthCallCount++;
      return new Response(
        JSON.stringify({ access_token: "tskey-mock-access-token", expires_in: 3600 }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  const client = new TailscaleClient({
    clientId: "mock-client-id",
    clientSecret: "tskey-client-mock-secret",
    fetchFn: mockFetch
  });

  const t1 = await client.getAccessToken();
  const t2 = await client.getAccessToken(); // cached

  assert.equal(t1, "tskey-mock-access-token");
  assert.equal(t2, "tskey-mock-access-token");
  assert.equal(oauthCallCount, 1);
});

test("TailscaleClient validateAclPolicy compares expected and actual policy SHA256", async () => {
  const policyJson = '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}';
  const policySha = crypto.createHash("sha256").update(policyJson, "utf8").digest("hex");

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    }
    if (url.includes("/acl")) {
      return new Response(policyJson, {
        status: 200,
        headers: { etag: '"etag-123"' }
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  const client = new TailscaleClient({
    clientId: "id",
    clientSecret: "secret",
    tailnet: "test.net",
    fetchFn: mockFetch
  });

  const check = await client.validateAclPolicy(policySha);
  assert.equal(check.valid, true);
  assert.equal(check.etag, '"etag-123"');

  const badCheck = await client.validateAclPolicy("wrong-sha");
  assert.equal(badCheck.valid, false);
});

test("TailscaleClient createSandboxAuthKey rejects control-plane tags", async () => {
  const client = new TailscaleClient({
    clientId: "id",
    clientSecret: "secret"
  });

  await assert.rejects(
    async () =>
      client.createSandboxAuthKey({
        tags: ["tag:factory-sandbox", "tag:edge-control-prod"]
      }),
    { message: /ForbiddenTagError/ }
  );

  await assert.rejects(
    async () =>
      client.createSandboxAuthKey({
        tags: ["tag:private-compute-prod"]
      }),
    { message: /ForbiddenTagError/ }
  );
});

test("TailscaleClient createSandboxAuthKey creates ephemeral single-use key", async () => {
  let createdPayload: Record<string, unknown> = {};

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    }
    if (url.includes("/keys")) {
      createdPayload = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ key: "tskey-auth-mock-single-use", id: "key-id-01" }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  const client = new TailscaleClient({
    clientId: "id",
    clientSecret: "secret",
    tailnet: "test.net",
    fetchFn: mockFetch
  });

  const keyResult = await client.createSandboxAuthKey({
    tags: ["tag:factory-sandbox"],
    ephemeral: true
  });

  assert.equal(keyResult.key, "tskey-auth-mock-single-use");
  assert.equal(keyResult.id, "key-id-01");

  const caps = createdPayload.capabilities as { devices: { create: { reusable: boolean; ephemeral: boolean; tags: string[] } } };
  assert.equal(caps.devices.create.reusable, false);
  assert.equal(caps.devices.create.ephemeral, true);
  assert.deepEqual(caps.devices.create.tags, ["tag:factory-sandbox"]);
});
