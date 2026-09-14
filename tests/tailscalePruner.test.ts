import assert from "node:assert/strict";
import test from "node:test";
import { TailscaleClient, TailscaleDevice, TailscaleKey } from "../src/adapters/tailscale/client.js";
import { TailscalePruner } from "../src/core/tailscalePruner.js";
import { InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";

function createMockTailscaleFetch(options: {
  devices: TailscaleDevice[];
  keys?: TailscaleKey[];
  onExpire?: (deviceId: string) => void;
  onDelete?: (deviceId: string) => void;
  onDeleteKey?: (keyId: string) => void;
}) {
  const devicesMap = new Map<string, TailscaleDevice>();
  for (const d of options.devices) {
    devicesMap.set(d.id, { ...d });
  }

  const keysMap = new Map<string, TailscaleKey>();
  for (const k of options.keys || []) {
    keysMap.set(k.id, { ...k });
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";

    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), { status: 200 });
    }

    if (url.endsWith("/devices") && method === "GET") {
      return new Response(JSON.stringify({ devices: Array.from(devicesMap.values()) }), { status: 200 });
    }

    if (url.includes("/device/") && url.endsWith("/expire") && method === "POST") {
      const parts = url.split("/");
      const deviceId = parts[parts.length - 2];
      const dev = devicesMap.get(deviceId);
      if (dev) {
        dev.authorized = false;
      }
      options.onExpire?.(deviceId);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    if (url.includes("/device/") && method === "DELETE") {
      const parts = url.split("/");
      const deviceId = parts[parts.length - 1];
      devicesMap.delete(deviceId);
      options.onDelete?.(deviceId);
      return new Response("", { status: 200 });
    }

    if (url.includes("/device/") && method === "GET") {
      const parts = url.split("/");
      const deviceId = parts[parts.length - 1];
      const dev = devicesMap.get(deviceId);
      if (dev) {
        return new Response(JSON.stringify(dev), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }

    if (url.endsWith("/keys") && method === "GET") {
      return new Response(JSON.stringify({ keys: Array.from(keysMap.values()) }), { status: 200 });
    }

    if (url.includes("/keys/") && method === "DELETE") {
      const parts = url.split("/");
      const keyId = parts[parts.length - 1];
      keysMap.delete(keyId);
      options.onDeleteKey?.(keyId);
      return new Response("", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  };

  return { fetchFn, devicesMap, keysMap };
}

test("TailscalePruner: Strict Safety Invariant protects persistent control and compute nodes", async () => {
  const expiredDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const mockDevices: TailscaleDevice[] = [
    {
      id: "node-edge-control",
      name: "srv719637",
      hostname: "srv719637",
      addresses: ["100.81.98.73"],
      tags: ["tag:edge-control-prod"],
      authorized: true,
      isExternal: false,
      expires: expiredDate
    },
    {
      id: "node-inference",
      name: "inference-do-01",
      hostname: "inference-do-01",
      addresses: ["100.81.98.80"],
      tags: ["tag:private-compute-prod"],
      authorized: true,
      isExternal: false,
      expires: expiredDate
    },
    {
      id: "node-exit",
      name: "exit-node-01",
      hostname: "exit-node-01",
      addresses: ["100.81.98.99"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false,
      exitNode: true,
      expires: expiredDate
    },
    {
      id: "node-human-admin",
      name: "michael-laptop",
      hostname: "michael-laptop",
      addresses: ["100.81.98.10"],
      tags: [],
      authorized: true,
      isExternal: false,
      expires: expiredDate
    }
  ];

  const expiredCalls: string[] = [];
  const deletedCalls: string[] = [];
  const mock = createMockTailscaleFetch({
    devices: mockDevices,
    onExpire: (id) => expiredCalls.push(id),
    onDelete: (id) => deletedCalls.push(id)
  });

  const client = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mock.fetchFn
  });

  const pruner = new TailscalePruner({
    tailscaleClient: client
  });

  const result = await pruner.pruneStaleNodesAndKeys();

  assert.equal(result.protectedNodesSkipped, 4);
  assert.equal(result.nodesPruned.length, 0);
  assert.equal(expiredCalls.length, 0, "No protected nodes must ever be deauthorized");
  assert.equal(deletedCalls.length, 0, "No protected nodes must ever be deleted");
});

test("TailscalePruner: Identifies and deletes stale sandbox nodes from terminal and orphaned runs", async () => {
  const terminalRunId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const activeRunId = "11111111-2222-3333-4444-555555555555";
  const orphanedRunId = "99999999-9999-9999-9999-999999999999";

  const runStore = new InMemoryRunStateStore();
  runStore.setRun({
    id: terminalRunId,
    tenant_id: "tenant-a",
    request_id: "req-1",
    idempotency_key: "idem-1",
    parent_git_sha: "0000000000000000000000000000000000000000",
    policy_version: "v2.0",
    phase: "clean_terminated",
    state_version: 5,
    budget: { max_cost_cents: 100 },
    envelope: {}
  });

  runStore.setRun({
    id: activeRunId,
    tenant_id: "tenant-a",
    request_id: "req-2",
    idempotency_key: "idem-2",
    parent_git_sha: "0000000000000000000000000000000000000000",
    policy_version: "v2.0",
    phase: "in_progress",
    state_version: 3,
    budget: { max_cost_cents: 100 },
    envelope: {}
  });

  const mockDevices: TailscaleDevice[] = [
    {
      id: "node-terminal",
      name: `sbx-${terminalRunId}-build`,
      hostname: `sbx-${terminalRunId}-build`,
      addresses: ["100.81.98.101"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false
    },
    {
      id: "node-orphaned",
      name: `sbx-${orphanedRunId}`,
      hostname: `sbx-${orphanedRunId}`,
      addresses: ["100.81.98.102"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false
    },
    {
      id: "node-active",
      name: `sbx-${activeRunId}-plan`,
      hostname: `sbx-${activeRunId}-plan`,
      addresses: ["100.81.98.103"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false
    }
  ];

  const expiredCalls: string[] = [];
  const deletedCalls: string[] = [];
  const mock = createMockTailscaleFetch({
    devices: mockDevices,
    onExpire: (id) => expiredCalls.push(id),
    onDelete: (id) => deletedCalls.push(id)
  });

  const client = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mock.fetchFn
  });

  const pruner = new TailscalePruner({
    tailscaleClient: client,
    runStore
  });

  const result = await pruner.pruneStaleNodesAndKeys();

  assert.equal(result.nodesPruned.length, 2);
  assert.equal(result.activeNodesRetained, 1);
  assert.ok(result.nodesPruned.some((n) => n.deviceId === "node-terminal" && n.absenceVerified));
  assert.ok(result.nodesPruned.some((n) => n.deviceId === "node-orphaned" && n.absenceVerified));

  assert.deepEqual(expiredCalls.sort(), ["node-orphaned", "node-terminal"]);
  assert.deepEqual(deletedCalls.sort(), ["node-orphaned", "node-terminal"]);
  assert.ok(!deletedCalls.includes("node-active"), "Active sandbox must be retained");
});

test("TailscalePruner: Deletes expired ephemeral auth keys", async () => {
  const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
  const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

  const mockKeys: TailscaleKey[] = [
    {
      id: "key-expired-sandbox",
      tags: ["tag:factory-sandbox"],
      expires: pastDate
    },
    {
      id: "key-active-sandbox",
      tags: ["tag:factory-sandbox"],
      expires: futureDate
    },
    {
      id: "key-edge-control",
      tags: ["tag:edge-control-prod"],
      expires: pastDate
    }
  ];

  const deletedKeys: string[] = [];
  const mock = createMockTailscaleFetch({
    devices: [],
    keys: mockKeys,
    onDeleteKey: (k) => deletedKeys.push(k)
  });

  const client = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mock.fetchFn
  });

  const pruner = new TailscalePruner({
    tailscaleClient: client
  });

  const result = await pruner.pruneStaleNodesAndKeys();

  assert.equal(result.keysPruned.length, 1);
  assert.equal(result.keysPruned[0].keyId, "key-expired-sandbox");
  assert.deepEqual(deletedKeys, ["key-expired-sandbox"]);
});

test("TailscalePruner: Dry Run plans cleanup without deauthorizing or deleting", async () => {
  const expiredDate = new Date(Date.now() - 3600 * 1000).toISOString();
  const mockDevices: TailscaleDevice[] = [
    {
      id: "node-stale-01",
      name: "sbx-untracked",
      hostname: "sbx-untracked",
      addresses: ["100.81.98.111"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false,
      expires: expiredDate
    }
  ];

  let deauthCalled = false;
  let deleteCalled = false;
  const mock = createMockTailscaleFetch({
    devices: mockDevices,
    onExpire: () => { deauthCalled = true; },
    onDelete: () => { deleteCalled = true; }
  });

  const client = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mock.fetchFn
  });

  const pruner = new TailscalePruner({
    tailscaleClient: client,
    dryRun: true
  });

  const result = await pruner.pruneStaleNodesAndKeys();

  assert.equal(result.dryRun, true);
  assert.equal(result.nodesPruned.length, 1);
  assert.equal(deauthCalled, false, "Deauth must not be called in dry-run");
  assert.equal(deleteCalled, false, "Delete must not be called in dry-run");
});

test("TailscalePruner: Daemon timer lifecycle and telemetry status", async () => {
  const mock = createMockTailscaleFetch({ devices: [] });
  const client = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mock.fetchFn
  });

  const pruner = new TailscalePruner({
    tailscaleClient: client,
    pruneIntervalMs: 50000
  });

  const status1 = pruner.getStatus();
  assert.equal(status1.daemonActive, false);

  pruner.startDaemon();
  const status2 = pruner.getStatus();
  assert.equal(status2.daemonActive, true);
  assert.equal(status2.pruneIntervalMs, 50000);

  pruner.stopDaemon();
  const status3 = pruner.getStatus();
  assert.equal(status3.daemonActive, false);
});

test("HTTP Server: POST /v1/tailscale/prune and GET /v1/tailscale/prune/status flow", async () => {
  const expiredDate = new Date(Date.now() - 3600 * 1000).toISOString();
  const mockDevices: TailscaleDevice[] = [
    {
      id: "node-http-stale",
      name: "sbx-http-test",
      hostname: "sbx-http-test",
      addresses: ["100.81.98.115"],
      tags: ["tag:factory-sandbox"],
      authorized: true,
      isExternal: false,
      expires: expiredDate
    }
  ];

  const mock = createMockTailscaleFetch({ devices: mockDevices });
  const client = new TailscaleClient({
    clientId: "mock-id",
    clientSecret: "mock-secret",
    fetchFn: mock.fetchFn
  });

  const pruner = new TailscalePruner({
    tailscaleClient: client
  });

  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/v1/tailscale/prune" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        const parsed = body ? JSON.parse(body) : {};
        const result = await pruner.pruneStaleNodesAndKeys({
          dryRun: parsed.dry_run ?? parsed.dryRun,
          maxAgeMs: parsed.max_age_minutes ? parsed.max_age_minutes * 60 * 1000 : undefined
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (pathname === "/v1/tailscale/prune/status" && req.method === "GET") {
      const status = pruner.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Check initial status
    const statusRes = await fetch(`${baseUrl}/v1/tailscale/prune/status`);
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as any;
    assert.equal(statusData.totalCyclesExecuted, 0);

    // 2. Trigger prune via POST
    const pruneRes = await fetch(`${baseUrl}/v1/tailscale/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: false })
    });
    assert.equal(pruneRes.status, 200);
    const pruneData = (await pruneRes.json()) as any;
    assert.equal(pruneData.nodesPruned.length, 1);
    assert.equal(pruneData.nodesPruned[0].deviceId, "node-http-stale");
    assert.equal(pruneData.nodesPruned[0].absenceVerified, true);

    // 3. Check updated status
    const statusRes2 = await fetch(`${baseUrl}/v1/tailscale/prune/status`);
    const statusData2 = (await statusRes2.json()) as any;
    assert.equal(statusData2.totalCyclesExecuted, 1);
    assert.equal(statusData2.totalNodesPrunedAllTime, 1);
  } finally {
    server.close();
  }
});
