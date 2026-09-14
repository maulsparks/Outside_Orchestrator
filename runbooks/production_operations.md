# Outside Orchestrator — Production Operations Runbook

**Version:** 1.0  
**Canonical Role:** Outside Orchestrator (Tier 1 Edge/Control Plane)  
**Production Host:** Hostinger VPS `srv719637.hstgr.cloud` (Tailscale IP `100.81.98.73`)  
**Governing Documents:** Outside Orchestrator Role Contract v2, Tier1_Edge_Control Skill  

---

## 1. System Architecture & Boundaries

The Outside Orchestrator operates the software factory from outside the untrusted execution sandbox:
```text
Tier 1: Edge / Control Plane (Hostinger VPS - srv719637.hstgr.cloud)
  ├── Outside Orchestrator HTTP Ingress (Port 3000)
  ├── Warden Boundary Evidence Ledger & Ed25519 Signer (/var/lib/warden)
  ├── Systemd Watchdog & Heartbeat Monitor (WatchdogSec=30s)
  └── Inference Broker & Token Budgeting Engine
        │
        ├── [Tailscale: tag:edge-control-prod -> tag:private-compute-prod:8000/11434]
        │     └── Tier 2: Persistent Model Inference Workers (vLLM / Ollama)
        │
        ├── [Tailscale: tag:edge-control-prod -> tag:factory-sandbox:8787]
        │     └── Tier 2: Disposable exe.dev Sandbox VMs (1 phase per sandbox)
        │
        └── [TLS / Claim-Scoped JWTs (15-min TTL)]
              └── Tier 3: Supabase State & Memory Plane (PostgreSQL, RLS)
```

---

## 2. Service Lifecycle & Systemd Governance

The orchestrator runs as a dedicated system service under the unprivileged `orchestrator` user.

### Service Commands
```bash
# Check service status and watchdog state
sudo systemctl status outside-orchestrator

# Restart the orchestrator service
sudo systemctl restart outside-orchestrator

# Stop the orchestrator gracefully (signals SIGTERM, stops watchdog heartbeats)
sudo systemctl stop outside-orchestrator

# Start the orchestrator service
sudo systemctl start outside-orchestrator

# Reload systemd unit definitions after config changes
sudo systemctl daemon-reload
```

### Systemd Watchdog & Linux Hardening Invariants
The service unit `/etc/systemd/system/outside-orchestrator.service` incorporates enterprise Linux security:
- `Type=notify`: Systemd waits for `SystemdWatchdog.notifyReady()` before marking the unit active.
- `WatchdogSec=30s`: The orchestrator emits a `WATCHDOG=1` heartbeat every 10 seconds. If an event loop freeze, deadlock, or unhandled crash blocks the process for >30 seconds, systemd automatically restarts the daemon.
- `ProtectSystem=strict`: The entire OS filesystem is mounted read-only to the process, except explicitly permitted paths (`/var/log/outside-orchestrator` and `/var/lib/warden`).
- `ProtectHome=true` & `PrivateTmp=true`: Isolates user directories and process temporary mounts.
- `NoNewPrivileges=true`: Disallows privilege escalation via suid binaries.

---

## 3. Log Management & Logrotate

### Live Log Streaming
```bash
# Stream logs via journald
journalctl -u outside-orchestrator -f --no-pager

# Tail the dedicated service log file
tail -f /var/log/outside-orchestrator/orchestrator.log
```

### Automated Log Rotation (`/etc/logrotate.d/outside-orchestrator`)
- Logs are rotated daily, compressed with gzip, and retained for 14 days.
- Uses `copytruncate` to allow continuous logging without process interruption.
- File permissions are locked to `0640 orchestrator orchestrator`.

To manually test or trigger log rotation:
```bash
# Dry-run validation
sudo logrotate -d /etc/logrotate.d/outside-orchestrator

# Force rotation execution
sudo logrotate -f /etc/logrotate.d/outside-orchestrator
```

---

## 4. Telemetry & Monitoring (`GET /metrics`)

The orchestrator exposes standard Prometheus text exposition metrics on `GET /metrics`. Authorized collectors carrying Tailscale identity `tag:monitoring` ingest these metrics on port 3000.

### Key Metrics to Monitor
| Metric | Type | Purpose / Threshold Alert |
|---|---|---|
| `orchestrator_up` | Gauge | `1` = Service healthy and accepting ingress. Alert if `0`. |
| `orchestrator_uptime_seconds` | Gauge | Monotonic uptime in seconds. Drops indicate restart. |
| `orchestrator_runs_active{phase}` | Gauge | Number of factory runs currently in-flight per phase. |
| `orchestrator_sandboxes_provisioned_total` vs `orchestrator_sandboxes_destroyed_total` | Counter | **Resource Leak Detector**: Values must equalize over time. Alert if delta grows monotonically. |
| `orchestrator_teardown_attestations_total{status="quarantined"}` | Counter | Alert on any non-zero rate of quarantined runs (indicates probe or deauth failure). |
| `orchestrator_recovery_runs_total{status="error"}` | Counter | Alert if cold-start disaster recovery encounters reconciliation errors. |

### Scraping Verification
```bash
curl -s http://127.0.0.1:3000/metrics | grep -E "^(orchestrator_up|orchestrator_runs)"
```

---

## 5. Human Review & Cryptographic Harvest Runbook

Per **Contract §4 & §6.8**, sandbox output is never merged automatically. Harvest requires verified proof and a human cryptographic signature over `(run_id, tree_sha, envelope_hash, policy_version)`.

### Step-by-Step Operator Harvest Procedure

#### Step 1: Inspect Harvest Proposal
```bash
node dist/scripts/harvest-run.js \
  --host http://127.0.0.1:3000 \
  --run <runId> \
  --dry-run
```
Verify the checklist:
- `[✔] CLEAN_TERMINATED state`: Run has completed 13-step teardown.
- `[✔] Effect Reconciliation Gate`: Zero undeclared file modifications.
- `[✔] Frozen Acceptance Tests`: Tests executed cleanly (exit code 0).
- `[✔] Advisory Output Collected`: Trace manifest pulled and hash verified.

#### Step 2: Cryptographically Authorize & Merge
```bash
node dist/scripts/harvest-run.js \
  --host http://127.0.0.1:3000 \
  --run <runId> \
  --key /var/lib/warden/keys/warden_private_key.pem \
  --signer human:chief-architect@firm.internal
```
The CLI:
1. Signs the canonical tuple with the reviewer's Ed25519 key.
2. Submits authorization to `POST /v1/runs/:runId/harvest`.
3. Creates the canonical Git tag `refs/tags/harvest-${runId}`.
4. Appends a signed `HarvestAttestation` event to the Tier 3 `evidence_ledger`.

---

## 6. Disaster Recovery & Emergency Procedures

### Automatic Startup Recovery (RTO < 30m SLA)
On boot or unexpected restart, the orchestrator's `RecoveryEngine` runs automatically:
1. Identifies all non-terminal in-flight runs in Tier 3 `factory_runs`.
2. Reacquires PostgreSQL leases with an incremented fencing token (rejecting stale workers).
3. Transitions interrupted runs to `quarantined`.
4. Reaps any orphaned Tailscale nodes (`tag:factory-sandbox`) and exe.dev VMs.

### Manual Emergency Rehearsal
To test or trigger emergency cold-start recovery manually:
```bash
cd /opt/outside-orchestrator
npm run rehearse:dr
```

---

## 7. CI/CD Policy-as-Code & Security Linting

Before deploying updates or committing changes to the Outside Orchestrator codebase, run the policy linter:
```bash
node dist/scripts/lint-policy.js
```
The linter validates:
1. **Zero Runtime Dependencies**: Strict assertion of 0 npm production packages.
2. **AGENTS.md Non-Authority**: Scans instructions for prompt injections or authority expansions.
3. **Tailscale Network Invariants**: Verifies strict isolated sandbox policy and absence of control tags on sandboxes.
