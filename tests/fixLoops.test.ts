import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";
import { buildInsideOrchestratorDaemonCode } from "../src/adapters/exedev/bootstrap.js";

const cjsRequire = createRequire(import.meta.url);

async function spinUpMockDaemon(): Promise<{
  port: number;
  server: http.Server;
  close: () => Promise<void>;
}> {
  // We evaluate the generated Inside Orchestrator daemon code in a clean VM or dynamic function
  return new Promise((resolve, reject) => {
    // Pick an ephemeral port
    const testServer = http.createServer();
    testServer.listen(0, "127.0.0.1", () => {
      const address = testServer.address();
      if (!address || typeof address === "string") {
        testServer.close();
        return reject(new Error("Failed to get port"));
      }
      const port = address.port;
      testServer.close(() => {
        // Run the daemon code on this port
        const code = buildInsideOrchestratorDaemonCode(port);
        // Execute inside function wrapper
        const daemonFn = new Function("require", code);
        try {
          // The code starts server.listen(port, '0.0.0.0')
          daemonFn(cjsRequire);
          // Allow server a moment to start
          setTimeout(() => {
            resolve({
              port,
              server: testServer,
              close: async () => {
                try {
                  await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST" });
                } catch {
                  // Ignore if already stopped
                }
              }
            });
          }, 50);
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

test("Inside Orchestrator daemon executes successfully on loop 1 without retry", async () => {
  const daemon = await spinUpMockDaemon();
  try {
    const delivRes = await fetch(`http://127.0.0.1:${daemon.port}/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: "run-loop-clean",
        phase: "build",
        attempt: 1,
        allowed_paths: ["output/**"],
        max_fix_loops: 3,
        user_prompt: "Write clean code without failures"
      })
    });

    assert.equal(delivRes.status, 200);
    const delivData = (await delivRes.json()) as any;
    assert.equal(delivData.status, "completed");
    assert.equal(delivData.fix_loops_executed, 1);

    // Verify /status
    const statusRes = await fetch(`http://127.0.0.1:${daemon.port}/status`);
    const statusData = (await statusRes.json()) as any;
    assert.equal(statusData.status, "completed");
    assert.equal(statusData.fix_loop, 1);
    assert.equal(statusData.max_fix_loops, 3);
    assert.equal(statusData.last_error, null);

    // Verify /trace/package
    const pkgRes = await fetch(`http://127.0.0.1:${daemon.port}/trace/package`);
    const pkg = (await pkgRes.json()) as any;
    assert.equal(pkg.fix_loops_executed, 1);
    assert.equal(pkg.fix_loop_history.length, 0);

    const eventTypes = pkg.traces.map((t: any) => t.type);
    assert.ok(eventTypes.includes("fix_loop_started"));
    assert.ok(eventTypes.includes("fix_loop_passed"));
    assert.ok(eventTypes.includes("phase_completed"));
    assert.ok(!eventTypes.includes("fix_loop_attempt_failed"));
  } finally {
    await daemon.close();
  }
});

test("Inside Orchestrator daemon recovers on loop 2 after initial failure (bounded correction)", async () => {
  const daemon = await spinUpMockDaemon();
  try {
    const delivRes = await fetch(`http://127.0.0.1:${daemon.port}/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: "run-loop-retry",
        phase: "build",
        attempt: 1,
        allowed_paths: ["output/**"],
        max_fix_loops: 3,
        command_policy_id: "fail_first_loop",
        user_prompt: "Fix failing tests on second attempt"
      })
    });

    assert.equal(delivRes.status, 200);
    const delivData = (await delivRes.json()) as any;
    assert.equal(delivData.status, "completed");
    assert.equal(delivData.fix_loops_executed, 2);

    // Verify /trace/package contains diagnostic trace history
    const pkgRes = await fetch(`http://127.0.0.1:${daemon.port}/trace/package`);
    const pkg = (await pkgRes.json()) as any;
    assert.equal(pkg.fix_loops_executed, 2);
    assert.equal(pkg.fix_loop_history.length, 1);
    assert.equal(pkg.fix_loop_history[0].loop, 1);
    assert.ok(pkg.fix_loop_history[0].error.includes("Simulated test/linter failure on attempt 1"));

    const eventTypes = pkg.traces.map((t: any) => t.type);
    assert.ok(eventTypes.includes("fix_loop_attempt_failed"));
    assert.ok(eventTypes.includes("fix_loop_passed"));
    assert.ok(eventTypes.includes("phase_completed"));
    assert.ok(!eventTypes.includes("fix_loops_exhausted"));
  } finally {
    await daemon.close();
  }
});

test("Inside Orchestrator daemon halts and marks failed when max_fix_loops are exhausted", async () => {
  const daemon = await spinUpMockDaemon();
  try {
    const delivRes = await fetch(`http://127.0.0.1:${daemon.port}/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: "run-loop-exhausted",
        phase: "build",
        attempt: 1,
        allowed_paths: ["output/**"],
        max_fix_loops: 3,
        command_policy_id: "always_fail",
        user_prompt: "Persistent failure testing"
      })
    });

    assert.equal(delivRes.status, 200);
    const delivData = (await delivRes.json()) as any;
    assert.equal(delivData.status, "failed");
    assert.equal(delivData.fix_loops_executed, 3);

    // Verify /status
    const statusRes = await fetch(`http://127.0.0.1:${daemon.port}/status`);
    const statusData = (await statusRes.json()) as any;
    assert.equal(statusData.status, "failed");
    assert.equal(statusData.fix_loop, 3);
    assert.ok(statusData.last_error.includes("Simulated persistent failure"));

    // Verify /trace/package has full 3-loop history
    const pkgRes = await fetch(`http://127.0.0.1:${daemon.port}/trace/package`);
    const pkg = (await pkgRes.json()) as any;
    assert.equal(pkg.fix_loops_executed, 3);
    assert.equal(pkg.fix_loop_history.length, 3);

    const eventTypes = pkg.traces.map((t: any) => t.type);
    assert.ok(eventTypes.includes("fix_loops_exhausted"));
    assert.ok(eventTypes.includes("phase_failed"));
    assert.ok(!eventTypes.includes("fix_loop_passed"));
  } finally {
    await daemon.close();
  }
});
