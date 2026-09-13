import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryLeaseStorage, LeaseManager } from "../src/core/leaseManager.js";

test("acquireLease starts with fencingToken = 1 and increments on re-acquisition", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  const lease1 = await manager.acquireLease("run-1", "tenant-1", 10000);
  assert.equal(lease1.fencingToken, 1);
  assert.ok(lease1.expiresAt.getTime() > Date.now());

  // Re-acquire by same worker
  const lease2 = await manager.acquireLease("run-1", "tenant-1", 10000);
  assert.equal(lease2.fencingToken, 2);

  // Re-acquire again
  const lease3 = await manager.acquireLease("run-1", "tenant-1", 10000);
  assert.equal(lease3.fencingToken, 3);
});

test("acquireLease throws ConflictError if held by another active worker", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager1 = new LeaseManager(storage, "worker-1");
  const manager2 = new LeaseManager(storage, "worker-2");

  await manager1.acquireLease("run-1", "tenant-1", 10000);

  await assert.rejects(
    async () => manager2.acquireLease("run-1", "tenant-1", 10000),
    { message: /LeaseConflictError/ }
  );
});

test("renewLease succeeds with matching token and extends expiry", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  const initial = await manager.acquireLease("run-1", "tenant-1", 5000);
  const renewed = await manager.renewLease("run-1", initial.fencingToken, 20000);

  assert.equal(renewed.fencingToken, initial.fencingToken);
  assert.ok(renewed.expiresAt.getTime() > initial.expiresAt.getTime());
});

test("renewLease rejects stale fencing tokens", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  await manager.acquireLease("run-1", "tenant-1", 5000);
  const current = await manager.acquireLease("run-1", "tenant-1", 5000); // token is now 2

  await assert.rejects(
    async () => manager.renewLease("run-1", 1, 10000), // using stale token 1
    { message: /StaleFencingTokenError/ }
  );
});

test("renewLease rejects expired leases", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  const lease = await manager.acquireLease("run-1", "tenant-1", -1000); // already expired

  await assert.rejects(
    async () => manager.renewLease("run-1", lease.fencingToken, 10000),
    { message: /ExpiredLeaseError/ }
  );
});

test("releaseLease expires the lease immediately", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  const lease = await manager.acquireLease("run-1", "tenant-1", 10000);
  await manager.releaseLease("run-1", lease.fencingToken);

  const stored = await storage.getLease("run-1");
  assert.ok(stored !== null);
  assert.ok(stored.expiresAt.getTime() <= Date.now());
});

test("startLivenessWatchdog triggers onSilentSandbox when heartbeat window expires", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  let triggered = false;
  let lastActivity = Date.now() - 500; // 500ms ago

  const watchdog = manager.startLivenessWatchdog("run-1", {
    heartbeatWindowMs: 200,
    checkIntervalMs: 50,
    getExternalActivityTimestamp: () => lastActivity,
    onSilentSandbox: () => {
      triggered = true;
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  watchdog.stop();

  assert.equal(triggered, true);
  assert.equal(watchdog.isTriggered(), true);
});

test("startLivenessWatchdog does not trigger if activity is fresh", async () => {
  const storage = new InMemoryLeaseStorage();
  const manager = new LeaseManager(storage, "worker-1");

  let triggered = false;
  const startTime = Date.now();

  const watchdog = manager.startLivenessWatchdog("run-1", {
    heartbeatWindowMs: 1000,
    checkIntervalMs: 50,
    getExternalActivityTimestamp: () => Date.now(), // always fresh
    onSilentSandbox: () => {
      triggered = true;
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  watchdog.stop();

  assert.equal(triggered, false);
  assert.equal(watchdog.isTriggered(), false);
});
