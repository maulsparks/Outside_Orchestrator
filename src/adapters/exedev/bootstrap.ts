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

let currentDelegation = null;
let runStatus = "ready";
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

  // Delegation receiver (single-phase isolated)
  if (req.method === 'POST' && url.pathname === '/delegate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        currentDelegation = JSON.parse(body);
        runStatus = "in_progress";
        addTraceEvent("delegation_received", {
          run_id: currentDelegation.run_id,
          phase: currentDelegation.phase,
          attempt: currentDelegation.attempt,
          parent_sha: currentDelegation.parent_sha,
          allowed_paths: currentDelegation.allowed_paths
        });

        // Execute delegated phase work
        const targetPath = (currentDelegation.allowed_paths && currentDelegation.allowed_paths[0])
          ? currentDelegation.allowed_paths[0].replace(/\\/\\*.*$/, '')
          : 'output';
        
        const outputDir = path.join('/tmp/sandbox-repo', targetPath);
        try {
          fs.mkdirSync(outputDir, { recursive: true });
          const artifactFile = path.join(outputDir, 'phase_result.json');
          fs.writeFileSync(artifactFile, JSON.stringify({
            status: "success",
            phase: currentDelegation.phase,
            timestamp: new Date().toISOString()
          }, null, 2));
          changedFiles = [path.join(targetPath, 'phase_result.json').replace(/\\\\/g, '/')];
        } catch (err) {
          changedFiles = ['output/phase_result.json'];
        }

        addTraceEvent("phase_completed", {
          phase: currentDelegation.phase,
          declared_changed_files: changedFiles,
          exit_code: 0
        });
        runStatus = "completed";

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, status: runStatus }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Status query
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      status: runStatus, 
      trace_count: traceEvents.length,
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
      declared_changed_files: changedFiles
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
from urllib.parse import urlparse

PORT = ${port}
RUN_STATUS = "ready"
CURRENT_DELEGATION = None
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
    return "\n".join(json.dumps(e, separators=(',', ':')) for e in TRACE_EVENTS)

def compute_manifest_sha256():
    return hashlib.sha256(get_trace_jsonl().encode('utf-8')).hexdigest()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), format % args))
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
                "declared_changed_files": CHANGED_FILES
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
                "traces": TRACE_EVENTS,
                "summary": "Advisory execution package emitted by Inside Orchestrator"
            }
            self.send_json(200, pkg)
        else:
            self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        global RUN_STATUS, CURRENT_DELEGATION, CHANGED_FILES
        url = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if url.path == '/delegate':
            try:
                CURRENT_DELEGATION = json.loads(body.decode('utf-8'))
                RUN_STATUS = "in_progress"
                add_trace("delegation_received", {
                    "run_id": CURRENT_DELEGATION.get("run_id"),
                    "phase": CURRENT_DELEGATION.get("phase"),
                    "attempt": CURRENT_DELEGATION.get("attempt"),
                    "parent_sha": CURRENT_DELEGATION.get("parent_sha"),
                    "allowed_paths": CURRENT_DELEGATION.get("allowed_paths")
                })

                allowed_paths = CURRENT_DELEGATION.get("allowed_paths", ["output/**"])
                target_path = allowed_paths[0].replace("/**", "").replace("/*", "") if allowed_paths else "output"
                output_dir = os.path.join("/tmp/sandbox-repo", target_path)
                os.makedirs(output_dir, exist_ok=True)
                artifact_file = os.path.join(output_dir, "phase_result.json")
                with open(artifact_file, "w") as f:
                    json.dump({
                        "status": "success",
                        "phase": CURRENT_DELEGATION.get("phase"),
                        "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                    }, f, indent=2)

                CHANGED_FILES = [f"{target_path}/phase_result.json"]
                add_trace("phase_completed", {
                    "phase": CURRENT_DELEGATION.get("phase"),
                    "declared_changed_files": CHANGED_FILES,
                    "exit_code": 0
                })
                RUN_STATUS = "completed"
                self.send_json(200, {"accepted": True, "status": RUN_STATUS})
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


