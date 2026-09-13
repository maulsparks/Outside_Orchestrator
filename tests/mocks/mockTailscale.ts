import crypto from "node:crypto";
import { TailscaleDevice } from "../../src/adapters/tailscale/client.js";

/**
 * Mock Tailscale Control-Plane API Harness (ISSUE-17)
 * Simulates OAuth token negotiation, ACL validation with ETag, auth-key minting,
 * device posture querying, deauthorization, and deletion.
 */
export class MockTailscaleHarness {
  public aclPolicy = JSON.stringify({
    tagOwners: { "tag:factory-sandbox": ["autogroup:admin"] },
    acls: [{ action: "accept", src: ["tag:edge-control-prod"], dst: ["tag:factory-sandbox:8787"] }]
  });
  public activeEtag = 'W/"etag-rev-001"';
  public shouldFailAuth = false;
  public devices = new Map<string, TailscaleDevice>();

  constructor() {
    this.resetDevices();
  }

  resetDevices(): void {
    this.devices.clear();
    this.devices.set("node-sandbox-1", {
      id: "node-sandbox-1",
      name: "sbx-test-vm",
      hostname: "sbx-test-vm",
      addresses: ["100.81.98.150"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false,
      advertisedRoutes: [],
      exitNode: false
    });
  }

  getPolicySha256(): string {
    return crypto.createHash("sha256").update(this.aclPolicy, "utf8").digest("hex");
  }

  createFetch(): typeof fetch {
    return async (url, init) => {
      const urlStr = url.toString();

      // 1. OAuth token endpoint
      if (urlStr.includes("/api/v2/oauth/token")) {
        if (this.shouldFailAuth) {
          return new Response("Invalid client credentials", { status: 401 });
        }
        return new Response(
          JSON.stringify({ access_token: "mock-tailscale-token-abc", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // 2. ACL policy endpoint
      if (urlStr.includes("/acl")) {
        return new Response(this.aclPolicy, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "ETag": this.activeEtag
          }
        });
      }

      // 3. Auth keys endpoint
      if (urlStr.includes("/keys") && init?.method === "POST") {
        const body = JSON.parse(String(init.body || "{}")) as {
          capabilities?: { devices?: { create?: { tags?: string[]; ephemeral?: boolean } } };
          expirySeconds?: number;
        };

        const tags = body.capabilities?.devices?.create?.tags ?? [];
        if (tags.some((t) => ["tag:edge-control-prod", "tag:deployment-controller", "tag:private-compute-prod"].includes(t))) {
          return new Response("Forbidden tag requested for sandbox key", { status: 403 });
        }

        const keyId = `tskey-auth-${Date.now()}`;
        return new Response(
          JSON.stringify({
            key: keyId,
            id: keyId,
            expires: new Date(Date.now() + (body.expirySeconds ?? 3600) * 1000).toISOString()
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // 4. Tailnet devices listing endpoint
      if (urlStr.endsWith("/devices") || urlStr.includes("/devices?")) {
        return new Response(JSON.stringify({ devices: Array.from(this.devices.values()) }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 5. Device expire / deauthorize endpoint
      if (urlStr.includes("/expire") && init?.method === "POST") {
        const match = urlStr.match(/\/device\/([^/]+)\/expire/);
        const deviceId = match ? match[1] : "";
        const dev = this.devices.get(deviceId);
        if (dev) {
          dev.authorized = false;
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }

      // 5. Device query / delete endpoint
      const deviceMatch = urlStr.match(/\/device\/([^/]+)$/);
      if (deviceMatch) {
        const deviceId = deviceMatch[1];
        if (init?.method === "DELETE") {
          this.devices.delete(deviceId);
          return new Response(JSON.stringify({}), { status: 200 });
        }
        const dev = this.devices.get(deviceId);
        if (!dev) {
          return new Response("Device not found", { status: 404 });
        }
        return new Response(JSON.stringify(dev), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Not Found", { status: 404 });
    };
  }
}
