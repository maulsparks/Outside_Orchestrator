import fs from "node:fs";
import http from "node:http";
import { TailscaleClient } from "../src/adapters/tailscale/client.js";
import { TailscalePruner } from "../src/core/tailscalePruner.js";
import { getAdminClient } from "../src/adapters/supabase/client.js";
import { SupabaseRunStateStore } from "../src/adapters/supabase/runsRepo.js";
import { LeaseManager, SupabaseLeaseStorage } from "../src/core/leaseManager.js";
import { EvidenceLedger, SupabaseEvidenceStore } from "../src/warden/ledger.js";

// Load /etc/outside-orchestrator.env if present on Hostinger host
const ENV_PATH = "/etc/outside-orchestrator.env";
if (fs.existsSync(ENV_PATH)) {
  try {
    const lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[Config] Failed to load ${ENV_PATH}:`, err.message);
  }
}

async function probeControlPlane(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${host}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const showStatus = args.includes("--status");
  
  let host = "http://127.0.0.1:3000";
  const hostIdx = args.indexOf("--host");
  if (hostIdx !== -1 && args[hostIdx + 1]) {
    host = args[hostIdx + 1];
  }

  let maxAgeMinutes = 60;
  const ageIdx = args.indexOf("--max-age-minutes");
  if (ageIdx !== -1 && args[ageIdx + 1]) {
    maxAgeMinutes = parseInt(args[ageIdx + 1], 10);
  }

  console.log("=================================================================");
  console.log("Outside Orchestrator — Automated Tailscale Device & Key Pruner");
  console.log("=================================================================");
  console.log(`Target Host:       ${host}`);
  console.log(`Dry-Run Mode:      ${dryRun ? "YES (Inspection Only)" : "NO (Live Deauthorization & Deletion)"}`);
  console.log(`Max Age Cutoff:    ${maxAgeMinutes} minutes`);
  console.log("=================================================================\n");

  const isHostUp = await probeControlPlane(host);

  if (showStatus) {
    if (isHostUp) {
      console.log(`Querying pruner status from ${host}/v1/tailscale/prune/status...`);
      const res = await fetch(`${host}/v1/tailscale/prune/status`);
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.error(`Control plane at ${host} is unreachable.`);
      process.exit(1);
    }
    return;
  }

  // Strategy A: Call REST API if local Control Plane is running
  if (isHostUp) {
    console.log(`[1/3] Triggering prune cycle via Control Plane API (${host}/v1/tailscale/prune)...`);
    const res = await fetch(`${host}/v1/tailscale/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry_run: dryRun,
        max_age_minutes: maxAgeMinutes
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`✖ Prune request failed (${res.status}):`, errText);
      process.exit(1);
    }

    const data = await res.json();
    printPruneResults(data);
    return;
  }

  // Strategy B: In-Process Fallback if control plane process is stopped
  console.log("[1/3] Control Plane HTTP server offline; executing in-process pruner...");
  const tailscaleClient = new TailscaleClient();

  let runStore: SupabaseRunStateStore | undefined;
  let leaseManager: LeaseManager | undefined;
  let evidenceLedger: EvidenceLedger | undefined;

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const adminClient = getAdminClient();
      runStore = new SupabaseRunStateStore(adminClient);
      const leaseStorage = new SupabaseLeaseStorage(adminClient);
      leaseManager = new LeaseManager(leaseStorage, process.env.HOSTNAME || "srv719637");
      
      let privateKeyPem = "";
      if (process.env.WARDEN_KEY_PATH && fs.existsSync(process.env.WARDEN_KEY_PATH)) {
        privateKeyPem = fs.readFileSync(process.env.WARDEN_KEY_PATH, "utf8");
      }
      if (privateKeyPem) {
        const evidenceStore = new SupabaseEvidenceStore(adminClient);
        evidenceLedger = new EvidenceLedger(evidenceStore, privateKeyPem);
      }
    } catch (err: any) {
      console.warn("Warning: Could not initialize Supabase stores for state cross-reference:", err.message);
    }
  }

  const pruner = new TailscalePruner({
    tailscaleClient,
    runStore,
    leaseManager,
    evidenceLedger,
    maxAgeMs: maxAgeMinutes * 60 * 1000,
    dryRun
  });

  console.log("[2/3] Scanning Tailnet inventory for stale ephemeral nodes and keys...");
  const result = await pruner.pruneStaleNodesAndKeys();
  printPruneResults(result);
}

function printPruneResults(data: any) {
  console.log("\n-----------------------------------------------------------------");
  console.log("PRUNING CYCLE SUMMARY");
  console.log("-----------------------------------------------------------------");
  console.log(`Execution Duration:    ${data.durationMs}ms`);
  console.log(`Total Devices Scanned: ${data.totalScannedDevices}`);
  console.log(`Eligible Sandboxes:    ${data.eligibleSandboxNodes}`);
  console.log(`Protected Skipped:     ${data.protectedNodesSkipped}`);
  console.log(`Active Retained:       ${data.activeNodesRetained}`);
  console.log(`Stale Nodes Pruned:    ${data.nodesPruned?.length || 0}`);
  console.log(`Auth Keys Pruned:      ${data.keysPruned?.length || 0}`);
  console.log("-----------------------------------------------------------------");

  if (data.nodesPruned && data.nodesPruned.length > 0) {
    console.log("\nPRUNED NODES:");
    for (const node of data.nodesPruned) {
      const statusStr = data.dryRun
        ? "[PLAN] Would deauthorize & delete"
        : `[DONE] Deauthorized: ${node.deauthorized}, Deleted: ${node.deleted}, Absence Verified: ${node.absenceVerified}`;
      console.log(` - ${node.hostname} (${node.deviceId})`);
      console.log(`   Reason:   ${node.reason}`);
      console.log(`   Status:   ${statusStr}`);
    }
  } else {
    console.log("\n✔ No stale sandbox nodes found.");
  }

  if (data.keysPruned && data.keysPruned.length > 0) {
    console.log("\nPRUNED AUTH KEYS:");
    for (const key of data.keysPruned) {
      console.log(` - Key ID: ${key.keyId} (${key.reason})`);
    }
  }

  if (data.errors && data.errors.length > 0) {
    console.log("\n✖ ERRORS ENCOUNTERED:");
    for (const err of data.errors) {
      console.error(` - ${err}`);
    }
  }

  console.log("=================================================================");
  console.log("✔ Tailscale cleanup completed successfully.");
  console.log("=================================================================\n");
}

main().catch((err) => {
  console.error("Fatal error during Tailscale pruning:", err);
  process.exit(1);
});
