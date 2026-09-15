import assert from "node:assert/strict";
import test from "node:test";
import { SystemdWatchdog } from "../src/core/watchdog.js";

test("SystemdWatchdog isAvailable returns false when NOTIFY_SOCKET is missing", () => {
  const watchdog = new SystemdWatchdog({ notifySocket: undefined });
  assert.equal(watchdog.isAvailable(), false);
});

test("SystemdWatchdog isAvailable returns true when NOTIFY_SOCKET is present", () => {
  const watchdog = new SystemdWatchdog({ notifySocket: "/run/systemd/notify" });
  assert.equal(watchdog.isAvailable(), true);
});

test("notifyReady gracefully returns false when NOTIFY_SOCKET is absent", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const watchdog = new SystemdWatchdog({
    notifySocket: undefined,
    execFn: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }
  });

  const result = await watchdog.notifyReady();
  assert.equal(result, false);
  assert.equal(calls.length, 0);
});

test("notifyReady dispatches systemd-notify --ready when NOTIFY_SOCKET is configured", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const watchdog = new SystemdWatchdog({
    notifySocket: "/run/systemd/notify",
    systemdNotifyPath: "/usr/bin/systemd-notify",
    execFn: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }
  });

  const result = await watchdog.notifyReady();
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/systemd-notify");
  assert.deepEqual(calls[0].args, ["--no-block", `--pid=${process.pid}`, "--ready"]);
});

test("notifyWatchdog dispatches systemd-notify WATCHDOG=1 heartbeat", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const watchdog = new SystemdWatchdog({
    notifySocket: "/run/systemd/notify",
    systemdNotifyPath: "/usr/bin/systemd-notify",
    execFn: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }
  });

  const result = await watchdog.notifyWatchdog();
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/systemd-notify");
  assert.deepEqual(calls[0].args, ["--no-block", `--pid=${process.pid}`, "WATCHDOG=1"]);
});

test("startWatchdog emits periodic heartbeats and stopWatchdog terminates timer", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const watchdog = new SystemdWatchdog({
    notifySocket: "/run/systemd/notify",
    execFn: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }
  });

  watchdog.startWatchdog(20); // 20ms interval for test
  await new Promise((resolve) => setTimeout(resolve, 120));
  watchdog.stopWatchdog();

  const countAfterStop = calls.length;
  assert.ok(countAfterStop >= 2, `Expected at least 2 heartbeats, got ${countAfterStop}`);

  // Wait another interval and ensure no further calls are made
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, countAfterStop);
});
