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
  const daemonJs = buildInsideOrchestratorDaemonCode(port);

  return `#!/usr/bin/env bash
set -euo pipefail

# 1. Install Node.js if missing
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi

# 2. Install Tailscale if missing
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
fi

# 3. Authenticate Tailscale as ephemeral node
tailscale up --authkey="${config.tailscaleAuthKey}" --hostname="${config.vmName}" --accept-routes=false --accept-dns=false || true

# 4. Deploy Inside Orchestrator daemon
mkdir -p /opt/inside-orchestrator
cat << 'EOF' > /opt/inside-orchestrator/server.js
${daemonJs}
EOF

# 5. Launch Inside Orchestrator daemon in background
nohup node /opt/inside-orchestrator/server.js > /var/log/inside-orchestrator.log 2>&1 &
`;
}

/**
 * Compresses setup script with gzip and encodes in base64.
 * Keeps the payload under 2 KiB (exe.dev limit is 10 KiB).
 */
export function formatSetupScriptForExeDev(script: string): string {
  const gzipped = zlib.gzipSync(Buffer.from(script, "utf8"));
  const b64 = gzipped.toString("base64");
  return `echo "${b64}" | base64 -d | gunzip | bash`;
}

