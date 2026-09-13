# Disaster Recovery & Cold-Start Runbook

## Objective

Guarantee that the Tier 1 Edge/Control Plane and Outside Orchestrator can be completely reconstructed from Infrastructure-as-Code and durable Tier 3 state within the 30-minute Recovery Time Objective (RTO), with a Recovery Point Objective (RPO) of zero uncommitted state transitions.

Governed by:
- **Outside Orchestrator Role Contract v2 §3** (Recovery boundary)
- **Outside Orchestrator Role Contract v2 §5.1** (State synchronization protocol)
- **Outside Orchestrator Role Contract v2 §8** (Failure, retry, and recovery behavior)
- **Outside Orchestrator Role Contract v2 §10** (Acceptance Criteria 2 & 12)

---

## Recovery Metrics

| Metric | Target | Guarantees |
|---|---|---|
| **Recovery Time Objective (RTO)** | `< 30 minutes` | Host provisioning, service boot, and in-flight run reconciliation |
| **Recovery Point Objective (RPO)** | `0 lost state` | All committed phase transitions exist durably in Tier 3 Supabase |
| **Fencing Guarantee** | Monotonic increment | Stale/partitioned orchestrator instances immediately locked out |
| **Sandbox Cleanup** | 100% deprovisioned | Orphaned Tailscale nodes and exe.dev VMs identified and destroyed |

---

## Architecture & Failure Behavior (Contract §8)

When the Outside Orchestrator restarts, crashes, or is provisioned onto a fresh host:

1. **Resume ONLY from committed durable state**:
   - The orchestrator reloads run and phase state directly from Tier 3 Supabase (`factory_runs`).
   - In-memory variables, uncommitted callbacks, or local caches from the previous instance are discarded.
2. **Reacquire Leases with Monotonic Fencing**:
   - For every in-flight run (`provisioning`, `delegated`, `in_progress`, `evaluating`), the orchestrator reacquires the lease in `leases`.
   - The fencing token is monotonically incremented (`fencing_token = existing.fencing_token + 1`), permanently fencing out the crashed process from making further state transitions.
3. **Quarantine Interrupted Runs**:
   - In-flight runs that were interrupted mid-execution are transitioned to `quarantined` with reason `orchestrator_restart_recovery`.
   - Work is never blindly replayed into a potentially compromised or dirty execution tree.
4. **Discover & Destroy Orphaned Sandboxes**:
   - The orchestrator queries Tailscale (`GET /api/v2/tailnet/{tailnet}/devices`) and exe.dev (`POST /exec` `ls`).
   - Any nodes matching `sbx-{run_id}*` are expired/deauthorized and deleted.
5. **Record Cryptographic Evidence**:
   - A signed `orchestrator_recovery_observed` boundary event is appended to `evidence_ledger` using the host Warden Ed25519 key.

---

## Cold-Start Reconstruction Procedure

To reconstruct the Tier 1 Edge/Control Plane from scratch on a new or rebuilt host:

### 1. Base OS & Dependencies
```bash
# Update and install runtime dependencies
apt-get update && apt-get install -y git curl nodejs npm
npm install -g npm@latest
```

### 2. Tailscale Node Enrollment
```bash
# Install Tailscale and connect host as edge-control-prod
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey="<EPHEMERAL_AUTH_KEY>" --ssh
```

### 3. Clone Repository & Build
```bash
git clone https://github.com/maulsparks/Outside_Orchestrator.git /opt/outside-orchestrator
cd /opt/outside-orchestrator
npm ci
npm run build
```

### 4. Configure Environment & Warden Key
Ensure `/etc/outside-orchestrator.env` contains:
```env
PORT=3000
HOST=127.0.0.1
HOSTNAME=srv719637
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
TAILSCALE_CLIENT_ID=<client-id>
TAILSCALE_CLIENT_SECRET=<client-secret>
TAILSCALE_TAILNET=<tailnet-name>
EXEDEV_API_KEY=<exedev-api-token>
WARDEN_KEY_PATH=/etc/outside-orchestrator/warden.key
WARDEN_PUBLIC_KEY_PATH=/etc/outside-orchestrator/warden.pub
```

Verify Warden keys exist and permissions are locked down:
```bash
chmod 600 /etc/outside-orchestrator/warden.key
chmod 644 /etc/outside-orchestrator/warden.pub
```

### 5. Systemd Service Deployment
Ensure `/etc/systemd/system/outside-orchestrator.service` is installed:
```ini
[Unit]
Description=Outside Orchestrator Edge/Control Plane Daemon
After=network.target tailscaled.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/outside-orchestrator
EnvironmentFile=/etc/outside-orchestrator.env
ExecStart=/usr/bin/node dist/src/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable outside-orchestrator
systemctl start outside-orchestrator
```

---

## Operational Verification & Rehearsal

### 1. Automated Rehearsal Suite
Run the automated disaster recovery rehearsal script to verify all 6 gates:
```bash
node --env-file=/etc/outside-orchestrator.env dist/scripts/disaster-recovery-rehearsal.js
# Or via npm script
npm run rehearse:dr
```

### 2. Control Plane Status Probing
Check orchestrator recovery readiness and in-flight count:
```bash
curl -s http://127.0.0.1:3000/v1/recovery/status | jq .
```
Expected output:
```json
{
  "status": "ready",
  "in_flight_count": 0,
  "in_flight_run_ids": [],
  "target_rto_minutes": 30,
  "governing_contract": "Outside Orchestrator Role Contract v2 §8",
  "timestamp": "2026-09-13T..."
}
```

### 3. Manual Reconciliation Trigger
Trigger an explicit scan and reconciliation of in-flight runs:
```bash
curl -s -X POST http://127.0.0.1:3000/v1/recovery/reconcile | jq .
```
