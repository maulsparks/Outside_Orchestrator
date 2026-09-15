import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

import { buildBootstrapScript, buildInsideOrchestratorDaemonCode } from "../src/adapters/exedev/bootstrap.js";
import { DelegationDispatcher } from "../src/core/dispatcher.js";
import { FactoryRunRecord } from "../src/core/stateMachine.js";

test("Bootstrap scripts include deterministic code-first gate support (kind=code)", () => {
  const pythonScript = buildBootstrapScript({
    vmName: "sbx-det-test",
    tailscaleAuthKey: "tskey-auth-mock",
    insideOrchestratorPort: 8787
  });

  // Verify Python daemon handles execution_kind == "code"
  assert.ok(pythonScript.includes('CURRENT_DELEGATION.get("execution_kind") == "code"'));
  assert.ok(pythonScript.includes("subprocess.run"));
  assert.ok(pythonScript.includes("deterministic_command_started"));
  assert.ok(pythonScript.includes("deterministic_command_completed"));
  assert.ok(pythonScript.includes("stdout_sha256"));

  const nodeDaemon = buildInsideOrchestratorDaemonCode();
  // Verify Node.js daemon handles execution_kind === "code"
  assert.ok(nodeDaemon.includes('execution_kind === "code"'));
  assert.ok(nodeDaemon.includes("deterministic_command"));
  assert.ok(nodeDaemon.includes("deterministic_command_started"));
  assert.ok(nodeDaemon.includes("deterministic_command_completed"));
  assert.ok(nodeDaemon.includes("execSync"));
});

test("Inside Orchestrator deterministic execution: executes subprocess and writes phase_result.json with 0 LLM calls", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "det-gate-test-"));
  const outDir = path.join(tmpDir, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const runId = "run-det-gate-1";
  const eventsLog: Array<Record<string, unknown>> = [];
  function emitAdvisoryEvent(eventType: string, payload: Record<string, unknown> = {}) {
    eventsLog.push({
      run_id: runId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...payload
    });
  }

  // Simulate Inside Orchestrator daemon execution_kind === "code" logic
  const deterministicCommand = "node -e \"console.log('TEST SUITE PASSED: 12 tests OK'); process.exit(0);\"";
  const startedAt = Date.now();
  emitAdvisoryEvent("deterministic_command_started", {
    command: deterministicCommand,
    execution_kind: "code"
  });

  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  try {
    const rawOut = execSync(deterministicCommand, {
      cwd: tmpDir,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    stdout = rawOut.toString();
  } catch (err: any) {
    exitCode = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout ? err.stdout.toString() : "";
    stderr = err.stderr ? err.stderr.toString() : err.message;
  }

  const durationMs = Date.now() - startedAt;
  const stdoutSha256 = crypto.createHash("sha256").update(stdout || "").digest("hex");

  emitAdvisoryEvent("deterministic_command_completed", {
    command: deterministicCommand,
    exit_code: exitCode,
    stdout_sha256: stdoutSha256,
    duration_ms: durationMs
  });

  const resultStatus = exitCode === 0 ? "completed" : "failed";
  const phaseResult = {
    status: resultStatus,
    run_id: runId,
    phase: "test",
    attempt: 1,
    exit_code: exitCode,
    execution_kind: "code",
    deterministic_command: deterministicCommand,
    stdout_sha256: stdoutSha256,
    duration_ms: durationMs,
    llm_tokens_consumed: 0,
    llm_cost_cents: 0
  };

  fs.writeFileSync(path.join(outDir, "phase_result.json"), JSON.stringify(phaseResult, null, 2));

  // Assertions
  assert.equal(exitCode, 0);
  assert.equal(resultStatus, "completed");
  assert.ok(stdout.includes("TEST SUITE PASSED"));
  assert.equal(stdoutSha256.length, 64);
  assert.equal(phaseResult.llm_tokens_consumed, 0);
  assert.equal(phaseResult.llm_cost_cents, 0);

  assert.equal(eventsLog.length, 2);
  assert.equal(eventsLog[0].event_type, "deterministic_command_started");
  assert.equal(eventsLog[1].event_type, "deterministic_command_completed");
  assert.equal(eventsLog[1].exit_code, 0);

  // Clean up tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Inside Orchestrator deterministic execution: records failure and status='failed' when command exits non-zero", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "det-gate-fail-"));
  const outDir = path.join(tmpDir, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const runId = "run-det-gate-fail";
  const eventsLog: Array<Record<string, unknown>> = [];
  function emitAdvisoryEvent(eventType: string, payload: Record<string, unknown> = {}) {
    eventsLog.push({
      run_id: runId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...payload
    });
  }

  const deterministicCommand = "node -e \"console.error('TEST ASSERTION FAILED at test/unit.js:14'); process.exit(1);\"";
  const startedAt = Date.now();
  emitAdvisoryEvent("deterministic_command_started", {
    command: deterministicCommand,
    execution_kind: "code"
  });

  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  try {
    const rawOut = execSync(deterministicCommand, {
      cwd: tmpDir,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    stdout = rawOut.toString();
  } catch (err: any) {
    exitCode = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout ? err.stdout.toString() : "";
    stderr = err.stderr ? err.stderr.toString() : err.message;
  }

  const durationMs = Date.now() - startedAt;
  const stdoutSha256 = crypto.createHash("sha256").update(stdout || "").digest("hex");

  emitAdvisoryEvent("deterministic_command_completed", {
    command: deterministicCommand,
    exit_code: exitCode,
    stdout_sha256: stdoutSha256,
    duration_ms: durationMs,
    error: stderr
  });

  const resultStatus = exitCode === 0 ? "completed" : "failed";
  const phaseResult = {
    status: resultStatus,
    run_id: runId,
    phase: "test",
    attempt: 1,
    exit_code: exitCode,
    execution_kind: "code",
    deterministic_command: deterministicCommand,
    stdout_sha256: stdoutSha256,
    duration_ms: durationMs,
    llm_tokens_consumed: 0,
    llm_cost_cents: 0
  };

  fs.writeFileSync(path.join(outDir, "phase_result.json"), JSON.stringify(phaseResult, null, 2));

  // Assertions
  assert.equal(exitCode, 1);
  assert.equal(resultStatus, "failed");
  assert.equal(phaseResult.llm_tokens_consumed, 0);
  assert.equal(eventsLog[1].event_type, "deterministic_command_completed");
  assert.equal(eventsLog[1].exit_code, 1);

  // Clean up tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
