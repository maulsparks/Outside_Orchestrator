/**
 * ExeDev VM Bootstrap & Inside Orchestrator Setup Script Generator (Milestone v0.3)
 * Creates cloud-init bash scripts for disposable Tier 2 execution sandboxes.
 * Enforces zero-credential leakage: host provisioning keys are NEVER included.
 */

import zlib from "node:zlib";

export interface BootstrapConfig {
  vmName: string;
  tailscaleAuthKey: string;
  repoCloneUrl?: string;
  parentSha?: string;
  insideOrchestratorPort?: number;
}

/**
 * Builds the Node.js Inside Orchestrator daemon script.
 */
export function buildInsideOrchestratorDaemonCode(port: number = 8787): string {
  return `
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let currentDelegation = null;
let runStatus = "ready";
let fixLoopCount = 0;
let maxFixLoops = 3;
let lastFixError = null;
const fixLoopHistory = [];
const traceEvents = [];
let changedFiles = [];
const startTime = new Date().toISOString();

function addTraceEvent(type, payload) {
  const event = {
    sequence: traceEvents.length + 1,
    type,
    timestamp: new Date().toISOString(),
    payload
  };
  traceEvents.push(event);
  return event;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  
  // Health probe
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      status: 'ok', 
      role: 'Inside_Orchestrator', 
      vm_status: runStatus,
      start_time: startTime
    }));
  }

  // Delegation receiver (single-phase isolated with bounded correction loops)
  if (req.method === 'POST' && url.pathname === '/delegate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        currentDelegation = JSON.parse(body);
        maxFixLoops = typeof currentDelegation.max_fix_loops === 'number' ? currentDelegation.max_fix_loops : 3;
        fixLoopCount = 0;
        lastFixError = null;
        runStatus = "in_progress";
        addTraceEvent("delegation_received", {
          run_id: currentDelegation.run_id,
          phase: currentDelegation.phase,
          attempt: currentDelegation.attempt,
          parent_sha: currentDelegation.parent_sha,
          allowed_paths: currentDelegation.allowed_paths,
          user_prompt: currentDelegation.user_prompt || null,
          max_fix_loops: maxFixLoops
        });

        // Materialize human user prompt into sandbox working tree
        if (currentDelegation.user_prompt) {
          try {
            fs.writeFileSync('/tmp/sandbox-repo/user_prompt.md', currentDelegation.user_prompt);
            const handoffDir = '/tmp/sandbox-repo/context_handoff';
            fs.mkdirSync(handoffDir, { recursive: true });
            fs.writeFileSync(path.join(handoffDir, 'user_prompt.md'), currentDelegation.user_prompt);
          } catch (pErr) {
            // Ignore non-fatal handoff write error
          }
        }

        // Deterministic Code-First Test Gate (kind="code" / zero LLM inference tokens)
        if (currentDelegation.execution_kind === "code") {
          const targetPath = (currentDelegation.allowed_paths && currentDelegation.allowed_paths[0])
            ? currentDelegation.allowed_paths[0].replace(/\\/\\*.*$/, '')
            : 'output';
          const outputDir = path.join('/tmp/sandbox-repo', targetPath);
          const cmd = currentDelegation.deterministic_command || "echo 'Deterministic code gate passed'";
          const cmdStart = Date.now();

          addTraceEvent("deterministic_command_started", {
            command: cmd,
            phase: currentDelegation.phase
          });

          try {
            let stdout = "";
            try {
              stdout = execSync(cmd, {
                cwd: '/tmp/sandbox-repo',
                timeout: 30000,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
              });
            } catch (fallbackErr) {
              // If cwd doesn't exist yet, execute from process.cwd() or simulate pass
              stdout = execSync(cmd, { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            }

            const durationMs = Date.now() - cmdStart;
            const stdoutHash = crypto.createHash('sha256').update(stdout || '', 'utf8').digest('hex');

            fs.mkdirSync(outputDir, { recursive: true });
            const artifactFile = path.join(outputDir, 'phase_result.json');
            fs.writeFileSync(artifactFile, JSON.stringify({
              status: "success",
              phase: currentDelegation.phase,
              execution_kind: "code",
              command: cmd,
              exit_code: 0,
              stdout_sha256: stdoutHash,
              duration_ms: durationMs,
              timestamp: new Date().toISOString()
            }, null, 2));

            changedFiles = [path.join(targetPath, 'phase_result.json').replace(/\\\\/g, '/')];
            runStatus = "completed";

            addTraceEvent("deterministic_command_completed", {
              phase: currentDelegation.phase,
              command: cmd,
              exit_code: 0,
              stdout_sha256: stdoutHash,
              duration_ms: durationMs
            });

            addTraceEvent("phase_completed", {
              phase: currentDelegation.phase,
              declared_changed_files: changedFiles,
              exit_code: 0,
              execution_kind: "code"
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ accepted: true, status: runStatus, execution_kind: "code" }));
          } catch (cmdErr) {
            const durationMs = Date.now() - cmdStart;
            const exitCode = typeof cmdErr.status === 'number' ? cmdErr.status : 1;
            const stderr = (cmdErr.stderr || cmdErr.message || '').toString();

            fs.mkdirSync(outputDir, { recursive: true });
            const artifactFile = path.join(outputDir, 'phase_result.json');
            fs.writeFileSync(artifactFile, JSON.stringify({
              status: "failed",
              phase: currentDelegation.phase,
              execution_kind: "code",
              command: cmd,
              exit_code: exitCode,
              error: stderr,
              duration_ms: durationMs,
              timestamp: new Date().toISOString()
            }, null, 2));

            changedFiles = [path.join(targetPath, 'phase_result.json').replace(/\\\\/g, '/')];
            runStatus = "failed";

            addTraceEvent("deterministic_command_completed", {
              phase: currentDelegation.phase,
              command: cmd,
              exit_code: exitCode,
              error: stderr,
              duration_ms: durationMs
            });

            addTraceEvent("phase_failed", {
              phase: currentDelegation.phase,
              exit_code: exitCode,
              error: stderr,
              execution_kind: "code"
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ accepted: true, status: runStatus, execution_kind: "code" }));
          }
        }

        // Bounded correction loop execution (MAX_FIX_LOOPS for kind="agent")
        const targetPath = (currentDelegation.allowed_paths && currentDelegation.allowed_paths[0])
          ? currentDelegation.allowed_paths[0].replace(/\\/\\*.*$/, '')
          : 'output';
        const outputDir = path.join('/tmp/sandbox-repo', targetPath);

        let loopSuccess = false;
        while (fixLoopCount < maxFixLoops && !loopSuccess) {
          fixLoopCount++;
          addTraceEvent("fix_loop_started", {
            loop: fixLoopCount,
            max_loops: maxFixLoops,
            phase: currentDelegation.phase
          });

          try {
            const policy = currentDelegation.command_policy_id;
            if (policy === "fail_first_loop" && fixLoopCount === 1) {
              throw new Error("Simulated test/linter failure on attempt 1");
            } else if (policy === "always_fail") {
              throw new Error("Simulated persistent failure on attempt " + fixLoopCount);
            }

            fs.mkdirSync(outputDir, { recursive: true });
            const artifactFile = path.join(outputDir, 'phase_result.json');
            fs.writeFileSync(artifactFile, JSON.stringify({
              status: "success",
              phase: currentDelegation.phase,
              fix_loops_executed: fixLoopCount,
              user_prompt: currentDelegation.user_prompt || null,
              timestamp: new Date().toISOString()
            }, null, 2));
            changedFiles = [path.join(targetPath, 'phase_result.json').replace(/\\\\/g, '/')];

            loopSuccess = true;
            runStatus = "completed";

            addTraceEvent("fix_loop_passed", {
              loop: fixLoopCount,
              max_loops: maxFixLoops,
              phase: currentDelegation.phase
            });

            addTraceEvent("phase_completed", {
              phase: currentDelegation.phase,
              declared_changed_files: changedFiles,
              fix_loops_executed: fixLoopCount,
              exit_code: 0
            });
          } catch (err) {
            lastFixError = err.message;
            fixLoopHistory.push({
              loop: fixLoopCount,
              error: err.message,
              timestamp: new Date().toISOString()
            });

            addTraceEvent("fix_loop_attempt_failed", {
              loop: fixLoopCount,
              max_loops: maxFixLoops,
              error: err.message
            });

            if (fixLoopCount < maxFixLoops) {
              runStatus = "correcting";
              try {
                const handoffDir = '/tmp/sandbox-repo/context_handoff';
                fs.mkdirSync(handoffDir, { recursive: true });
                fs.writeFileSync(path.join(handoffDir, 'last_fix_error.txt'), "Loop " + fixLoopCount + " failed: " + err.message);
              } catch (_) {}
            } else {
              runStatus = "failed";
              addTraceEvent("fix_loops_exhausted", {
                total_attempts: fixLoopCount,
                max_loops: maxFixLoops,
                final_error: err.message
              });
              addTraceEvent("phase_failed", {
                phase: currentDelegation.phase,
                exit_code: 1,
                error: err.message
              });
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, status: runStatus, fix_loops_executed: fixLoopCount }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Status query (includes correction loop telemetry)
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      status: runStatus, 
      trace_count: traceEvents.length,
      fix_loop: fixLoopCount,
      max_fix_loops: maxFixLoops,
      last_error: lastFixError,
      current_phase: currentDelegation ? currentDelegation.phase : null
    }));
  }

  // Trace manifest SHA256 (for Warden integrity recalculation)
  if (req.method === 'GET' && url.pathname === '/trace/manifest.sha256') {
    const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join('\\n');
    const hash = crypto.createHash('sha256').update(traceJsonl, 'utf8').digest('hex');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(hash);
  }

  // Trace manifest details
  if (req.method === 'GET' && url.pathname === '/trace/manifest') {
    const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join('\\n');
    const hash = crypto.createHash('sha256').update(traceJsonl, 'utf8').digest('hex');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      manifest_sha256: hash,
      event_count: traceEvents.length,
      declared_changed_files: changedFiles,
      fix_loops_executed: fixLoopCount
    }));
  }

  // Trace events JSONL stream
  if (req.method === 'GET' && url.pathname === '/trace/events') {
    const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join('\\n');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    return res.end(traceJsonl);
  }

  // Final advisory result package
  if (req.method === 'GET' && url.pathname === '/trace/package') {
    const traceJsonl = traceEvents.map(e => JSON.stringify(e)).join('\\n');
    const hash = crypto.createHash('sha256').update(traceJsonl, 'utf8').digest('hex');
    const pkg = {
      run_id: currentDelegation ? currentDelegation.run_id : "unknown",
      phase: currentDelegation ? currentDelegation.phase : "unknown",
      trace_manifest_sha256: hash,
      declared_changed_files: changedFiles,
      fix_loops_executed: fixLoopCount,
      max_fix_loops: maxFixLoops,
      fix_loop_history: fixLoopHistory,
      traces: traceEvents,
      summary: "Advisory execution package emitted by Inside Orchestrator"
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(pkg));
  }

  // Stop sentinel
  if (req.method === 'POST' && url.pathname === '/stop') {
    runStatus = "stopped";
    addTraceEvent("stop_signal_received", { timestamp: new Date().toISOString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stopped: true }));
    setTimeout(() => { process.exit(0); }, 300);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const port = ${port};
server.listen(port, '0.0.0.0', () => {
  console.log(\`Inside Orchestrator listening on 0.0.0.0:\${port}\`);
});
`.trim();
}

/**
 * Builds the complete bash setup script to be executed on first boot of the exe.dev VM.
 */
export function buildBootstrapScript(config: BootstrapConfig): string {
  const port = config.insideOrchestratorPort ?? 8787;

  return `#!/usr/bin/env bash
set -euo pipefail
exec > /tmp/bootstrap.log 2>&1
echo "=== Bootstrap started at $(date -u) ==="

# 1. Enable and start Tailscale daemon
echo "Starting Tailscale..."
sudo systemctl enable --now tailscaled 2>/dev/null || sudo service tailscaled start 2>/dev/null || true
sleep 3

# 2. Authenticate Tailscale as ephemeral sandbox node
echo "Authenticating Tailscale..."
sudo tailscale up --authkey="${config.tailscaleAuthKey}" --hostname="${config.vmName}" --accept-routes=false --accept-dns=false || true

# 3. Deploy Inside Orchestrator daemon (Python 3)
echo "Deploying Inside Orchestrator daemon..."
mkdir -p /home/exedev/inside-orchestrator
cat << 'PYEOF' > /home/exedev/inside-orchestrator/server.py
import http.server
import json
import hashlib
import os
import sys
import time
import subprocess
from urllib.parse import urlparse

PORT = ${port}
RUN_STATUS = "ready"
CURRENT_DELEGATION = None
FIX_LOOP_COUNT = 0
MAX_FIX_LOOPS = 3
LAST_FIX_ERROR = None
FIX_LOOP_HISTORY = []
TRACE_EVENTS = []
CHANGED_FILES = []
START_TIME = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def add_trace(event_type, payload):
    evt = {
        "sequence": len(TRACE_EVENTS) + 1,
        "type": event_type,
        "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        "payload": payload
    }
    TRACE_EVENTS.append(evt)
    return evt

def get_trace_jsonl():
    return "\\n".join(json.dumps(e, separators=(',', ':')) for e in TRACE_EVENTS)

def compute_manifest_sha256():
    return hashlib.sha256(get_trace_jsonl().encode('utf-8')).hexdigest()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write("%s - - [%s] %s\\n" % (self.client_address[0], self.log_date_time_string(), format % args))
        sys.stderr.flush()

    def send_json(self, status_code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        global RUN_STATUS
        url = urlparse(self.path)
        if url.path == '/health':
            self.send_json(200, {
                "status": "ok",
                "role": "Inside_Orchestrator",
                "vm_status": RUN_STATUS,
                "start_time": START_TIME
            })
        elif url.path == '/status':
            self.send_json(200, {
                "status": RUN_STATUS,
                "trace_count": len(TRACE_EVENTS),
                "fix_loop": FIX_LOOP_COUNT,
                "max_fix_loops": MAX_FIX_LOOPS,
                "last_error": LAST_FIX_ERROR,
                "current_phase": CURRENT_DELEGATION.get("phase") if CURRENT_DELEGATION else None
            })
        elif url.path == '/trace/manifest.sha256':
            manifest_hash = compute_manifest_sha256().encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(manifest_hash)))
            self.end_headers()
            self.wfile.write(manifest_hash)
        elif url.path == '/trace/manifest':
            self.send_json(200, {
                "manifest_sha256": compute_manifest_sha256(),
                "event_count": len(TRACE_EVENTS),
                "declared_changed_files": CHANGED_FILES,
                "fix_loops_executed": FIX_LOOP_COUNT
            })
        elif url.path == '/trace/events':
            trace_jsonl = get_trace_jsonl().encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Content-Length', str(len(trace_jsonl)))
            self.end_headers()
            self.wfile.write(trace_jsonl)
        elif url.path == '/trace/package':
            manifest_hash = compute_manifest_sha256()
            pkg = {
                "run_id": CURRENT_DELEGATION.get("run_id", "unknown") if CURRENT_DELEGATION else "unknown",
                "phase": CURRENT_DELEGATION.get("phase", "unknown") if CURRENT_DELEGATION else "unknown",
                "trace_manifest_sha256": manifest_hash,
                "declared_changed_files": CHANGED_FILES,
                "fix_loops_executed": FIX_LOOP_COUNT,
                "max_fix_loops": MAX_FIX_LOOPS,
                "fix_loop_history": FIX_LOOP_HISTORY,
                "traces": TRACE_EVENTS,
                "summary": "Advisory execution package emitted by Inside Orchestrator"
            }
            self.send_json(200, pkg)
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        global RUN_STATUS, CURRENT_DELEGATION, CHANGED_FILES, FIX_LOOP_COUNT, MAX_FIX_LOOPS, LAST_FIX_ERROR
        url = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if url.path == '/delegate':
            try:
                CURRENT_DELEGATION = json.loads(body.decode('utf-8'))
                MAX_FIX_LOOPS = CURRENT_DELEGATION.get("max_fix_loops", 3)
                FIX_LOOP_COUNT = 0
                LAST_FIX_ERROR = None
                RUN_STATUS = "in_progress"
                add_trace("delegation_received", {
                    "run_id": CURRENT_DELEGATION.get("run_id"),
                    "phase": CURRENT_DELEGATION.get("phase"),
                    "attempt": CURRENT_DELEGATION.get("attempt"),
                    "parent_sha": CURRENT_DELEGATION.get("parent_sha"),
                    "allowed_paths": CURRENT_DELEGATION.get("allowed_paths"),
                    "user_prompt": CURRENT_DELEGATION.get("user_prompt"),
                    "max_fix_loops": MAX_FIX_LOOPS
                })

                # Materialize human user prompt into sandbox working tree
                user_prompt = CURRENT_DELEGATION.get("user_prompt")
                if user_prompt:
                    try:
                        with open('/tmp/sandbox-repo/user_prompt.md', 'w') as f:
                            f.write(user_prompt)
                        handoff_dir = '/tmp/sandbox-repo/context_handoff'
                        os.makedirs(handoff_dir, exist_ok=True)
                        with open(os.path.join(handoff_dir, 'user_prompt.md'), 'w') as f:
                            f.write(user_prompt)
                    except Exception:
                        pass

                allowed_paths = CURRENT_DELEGATION.get("allowed_paths", ["output/**"])
                target_path = allowed_paths[0].replace("/**", "").replace("/*", "") if allowed_paths else "output"
                output_dir = os.path.join("/tmp/sandbox-repo", target_path)

                # Deterministic Code-First Test Gate (kind="code" / zero LLM inference tokens)
                if CURRENT_DELEGATION.get("execution_kind") == "code":
                    cmd = CURRENT_DELEGATION.get("deterministic_command") or "echo 'Deterministic code gate passed'"
                    cmd_start = time.time()
                    add_trace("deterministic_command_started", {
                        "command": cmd,
                        "phase": CURRENT_DELEGATION.get("phase")
                    })

                    try:
                        work_dir = "/tmp/sandbox-repo" if os.path.exists("/tmp/sandbox-repo") else None
                        res = subprocess.run(
                            cmd,
                            shell=True,
                            cwd=work_dir,
                            capture_output=True,
                            text=True,
                            timeout=30
                        )
                        duration_ms = int((time.time() - cmd_start) * 1000)
                        stdout_hash = hashlib.sha256((res.stdout or "").encode('utf-8')).hexdigest()

                        os.makedirs(output_dir, exist_ok=True)
                        artifact_file = os.path.join(output_dir, "phase_result.json")
                        with open(artifact_file, "w") as f:
                            json.dump({
                                "status": "success" if res.returncode == 0 else "failed",
                                "phase": CURRENT_DELEGATION.get("phase"),
                                "execution_kind": "code",
                                "command": cmd,
                                "exit_code": res.returncode,
                                "stdout_sha256": stdout_hash,
                                "duration_ms": duration_ms,
                                "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                            }, f, indent=2)

                        CHANGED_FILES = [f"{target_path}/phase_result.json"]
                        RUN_STATUS = "completed" if res.returncode == 0 else "failed"

                        add_trace("deterministic_command_completed", {
                            "phase": CURRENT_DELEGATION.get("phase"),
                            "command": cmd,
                            "exit_code": res.returncode,
                            "stdout_sha256": stdout_hash,
                            "duration_ms": duration_ms
                        })

                        if res.returncode == 0:
                            add_trace("phase_completed", {
                                "phase": CURRENT_DELEGATION.get("phase"),
                                "declared_changed_files": CHANGED_FILES,
                                "exit_code": 0,
                                "execution_kind": "code"
                            })
                        else:
                            add_trace("phase_failed", {
                                "phase": CURRENT_DELEGATION.get("phase"),
                                "exit_code": res.returncode,
                                "error": res.stderr or "Non-zero exit code",
                                "execution_kind": "code"
                            })

                        self.send_json(200, {"accepted": True, "status": RUN_STATUS, "execution_kind": "code"})
                        return
                    except Exception as cmd_err:
                        duration_ms = int((time.time() - cmd_start) * 1000)
                        os.makedirs(output_dir, exist_ok=True)
                        artifact_file = os.path.join(output_dir, "phase_result.json")
                        with open(artifact_file, "w") as f:
                            json.dump({
                                "status": "failed",
                                "phase": CURRENT_DELEGATION.get("phase"),
                                "execution_kind": "code",
                                "command": cmd,
                                "exit_code": 1,
                                "error": str(cmd_err),
                                "duration_ms": duration_ms,
                                "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                            }, f, indent=2)
                        CHANGED_FILES = [f"{target_path}/phase_result.json"]
                        RUN_STATUS = "failed"
                        add_trace("phase_failed", {
                            "phase": CURRENT_DELEGATION.get("phase"),
                            "exit_code": 1,
                            "error": str(cmd_err),
                            "execution_kind": "code"
                        })
                        self.send_json(200, {"accepted": True, "status": RUN_STATUS, "execution_kind": "code"})
                        return

                loop_success = False
                while FIX_LOOP_COUNT < MAX_FIX_LOOPS and not loop_success:
                    FIX_LOOP_COUNT += 1
                    add_trace("fix_loop_started", {
                        "loop": FIX_LOOP_COUNT,
                        "max_loops": MAX_FIX_LOOPS,
                        "phase": CURRENT_DELEGATION.get("phase")
                    })

                    try:
                        policy = CURRENT_DELEGATION.get("command_policy_id")
                        if policy == "fail_first_loop" and FIX_LOOP_COUNT == 1:
                            raise RuntimeError("Simulated test/linter failure on attempt 1")
                        elif policy == "always_fail":
                            raise RuntimeError(f"Simulated persistent failure on attempt {FIX_LOOP_COUNT}")

                        os.makedirs(output_dir, exist_ok=True)
                        artifact_file = os.path.join(output_dir, "phase_result.json")
                        with open(artifact_file, "w") as f:
                            json.dump({
                                "status": "success",
                                "phase": CURRENT_DELEGATION.get("phase"),
                                "fix_loops_executed": FIX_LOOP_COUNT,
                                "user_prompt": user_prompt,
                                "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                            }, f, indent=2)

                        CHANGED_FILES = [f"{target_path}/phase_result.json"]
                        loop_success = True
                        RUN_STATUS = "completed"

                        add_trace("fix_loop_passed", {
                            "loop": FIX_LOOP_COUNT,
                            "max_loops": MAX_FIX_LOOPS,
                            "phase": CURRENT_DELEGATION.get("phase")
                        })
                        add_trace("phase_completed", {
                            "phase": CURRENT_DELEGATION.get("phase"),
                            "declared_changed_files": CHANGED_FILES,
                            "fix_loops_executed": FIX_LOOP_COUNT,
                            "exit_code": 0
                        })
                    except Exception as err:
                        LAST_FIX_ERROR = str(err)
                        FIX_LOOP_HISTORY.append({
                            "loop": FIX_LOOP_COUNT,
                            "error": str(err),
                            "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                        })
                        add_trace("fix_loop_attempt_failed", {
                            "loop": FIX_LOOP_COUNT,
                            "max_loops": MAX_FIX_LOOPS,
                            "error": str(err)
                        })

                        if FIX_LOOP_COUNT < MAX_FIX_LOOPS:
                            RUN_STATUS = "correcting"
                            try:
                                handoff_dir = '/tmp/sandbox-repo/context_handoff'
                                os.makedirs(handoff_dir, exist_ok=True)
                                with open(os.path.join(handoff_dir, 'last_fix_error.txt'), 'w') as f:
                                    f.write(f"Loop {FIX_LOOP_COUNT} failed: {err}")
                            except Exception:
                                pass
                        else:
                            RUN_STATUS = "failed"
                            add_trace("fix_loops_exhausted", {
                                "total_attempts": FIX_LOOP_COUNT,
                                "max_loops": MAX_FIX_LOOPS,
                                "final_error": str(err)
                            })
                            add_trace("phase_failed", {
                                "phase": CURRENT_DELEGATION.get("phase"),
                                "exit_code": 1,
                                "error": str(err)
                            })

                self.send_json(200, {"accepted": True, "status": RUN_STATUS, "fix_loops_executed": FIX_LOOP_COUNT})
            except Exception as e:
                self.send_json(400, {"error": str(e)})

        elif url.path == '/stop':
            RUN_STATUS = "stopped"
            add_trace("stop_signal_received", {"timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
            self.send_json(200, {"stopped": True})
            def exit_soon():
                time.sleep(0.3)
                os._exit(0)
            import threading
            threading.Thread(target=exit_soon).start()
        else:
            self.send_json(404, {"error": "not_found"})

http.server.ThreadingHTTPServer.allow_reuse_address = True
server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
server.serve_forever()
PYEOF
chmod +x /home/exedev/inside-orchestrator/server.py

# 4. Install and launch Inside Orchestrator as dedicated systemd service
echo "Installing inside-orchestrator.service..."
cat << 'UNIT' | sudo tee /etc/systemd/system/inside-orchestrator.service > /dev/null
[Unit]
Description=Inside Orchestrator Daemon
After=network.target tailscaled.service

[Service]
Type=simple
User=exedev
WorkingDirectory=/home/exedev/inside-orchestrator
ExecStart=/usr/bin/python3 -u /home/exedev/inside-orchestrator/server.py
Restart=on-failure
RestartSec=2
StandardOutput=append:/tmp/inside-orchestrator.log
StandardError=append:/tmp/inside-orchestrator.log

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now inside-orchestrator.service
sleep 1
sudo systemctl is-active inside-orchestrator.service || true
echo "=== Bootstrap finished at $(date -u) ==="
`;
}


/**
 * Compresses setup script with gzip and encodes in base64.
 * Keeps the payload under 3 KiB (exe.dev limit is 10 KiB).
 */
export function formatSetupScriptForExeDev(script: string): string {
  const gzipped = zlib.gzipSync(Buffer.from(script, "utf8"));
  const b64 = gzipped.toString("base64");
  return `echo ${b64} | base64 -d | gzip -dc | bash`;
}


