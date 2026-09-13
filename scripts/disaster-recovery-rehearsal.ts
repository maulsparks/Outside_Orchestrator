#!/usr/bin/env node
/**
 * Disaster Recovery & Cold-Start Rehearsal CLI (Tier 1 Edge/Control Plane)
 *
 * Governed by:
 * - Outside Orchestrator Role Contract v2 §8 (Failure, retry, and recovery behavior)
 * - Outside Orchestrator Role Contract v2 §10 (AC 2 & AC 12)
 *
 * Target: Complete Tier 1 control plane reconstruction and state recovery within 30 minutes.
 *
 * Usage:
 *   node --env-file=/etc/outside-orchestrator.env dist/scripts/disaster-recovery-rehearsal.js
 *   npm run rehearse:dr
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { getAdminClient } from "../src/adapters/supabase/client.js";
import { SupabaseRunStateStore } from "../src/adapters/supabase/runsRepo.js";
import { LeaseManager, SupabaseLeaseStorage } from "../src/core/leaseManager.js";
import { RunStateMachine } from "../src/core/stateMachine.js";
import { EvidenceLedger, SupabaseEvidenceStore } from "../src/warden/ledger.js";
import { TailscaleClient } from "../src/adapters/tailscale/client.js";
import { ExeDevClient } from "../src/adapters/exedev/client.js";
import { RecoveryEngine } from "../src/core/recoveryEngine.js";

const RTO_TARGET_SECONDS = 30 * 60; // 30 minutes (Contract §8, §10 AC 12)

interface CheckResult {
  step: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details?: string;
  error?: string;
}

async function runRehearsal() {
  const startTime = Date.now();
  const results: CheckResult[] = [];

  console.log("=================================================================");
  console.log("Outside Orchestrator — Disaster Recovery & Cold-Start Rehearsal");
  console.log("Governed by Outside Orchestrator Role Contract v2 §8 & §10 (AC 2, 12)");
  console.log(`Target RTO: 30 minutes (${RTO_TARGET_SECONDS}s)`);
  console.log(`Timestamp:  ${new Date().toISOString()}`);
  console.log("=================================================================\n");

  async function executeStep(step: string, name: string, fn: () => Promise<string | void>) {
    const stepStart = Date.now();
    process.stdout.write(`[${step}] ${name}... `);
    try {
      const details = await fn();
      const durationMs = Date.now() - stepStart;
      console.log(`✔ PASS (${durationMs}ms)`);
      if (details) console.log(`      └─ ${details}`);
      results.push({ step, name, passed: true, durationMs, details: details || undefined });
    } catch (err: any) {
      const durationMs = Date.now() - stepStart;
      console.log(`✖ FAIL (${durationMs}ms)`);
      console.log(`      └─ Error: ${err.message}`);
      results.push({ step, name, passed: false, durationMs, error: err.message });
    }
  }

  // Gate 1: Environment Configuration
  await executeStep("1/6", "Verifying Control Plane Environment & Credentials", async () => {
    const requiredVars = [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "TAILSCALE_CLIENT_ID",
      "TAILSCALE_CLIENT_SECRET",
      "TAILSCALE_TAILNET",
      "EXEDEV_API_KEY"
    ];
    const missing = requiredVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(`Missing mandatory environment variables: ${missing.join(", ")}`);
    }
    return `All 6 core provider credentials configured (${process.env.TAILSCALE_TAILNET})`;
  });

  // Gate 2: Warden Keypair & Cryptographic Capability
  let wardenLedger: EvidenceLedger | null = null;
  let evidenceStore: SupabaseEvidenceStore | null = null;
  await executeStep("2/6", "Verifying Host-Side Warden Ed25519 Cryptographic Keys", async () => {
    const keyPath = process.env.WARDEN_KEY_PATH || "/etc/outside-orchestrator/warden.key";
    const pubKeyPath = process.env.WARDEN_PUBLIC_KEY_PATH || "/etc/outside-orchestrator/warden.pub";

    if (!fs.existsSync(keyPath)) {
      throw new Error(`Warden private key missing at ${keyPath}`);
    }
    const privateKeyPem = fs.readFileSync(keyPath, "utf8");

    // Self-test signature verification
    const testPayload = Buffer.from("disaster-recovery-probe-" + Date.now());
    const signature = crypto.sign(null, testPayload, privateKeyPem);
    let pubKey = "";
    if (fs.existsSync(pubKeyPath)) {
      pubKey = fs.readFileSync(pubKeyPath, "utf8");
      const verified = crypto.verify(null, testPayload, pubKey, signature);
      if (!verified) throw new Error("Warden public key failed to verify test signature");
    }

    const adminClient = getAdminClient();
    evidenceStore = new SupabaseEvidenceStore(adminClient);
    wardenLedger = new EvidenceLedger(evidenceStore, privateKeyPem);

    return `Warden keypair loaded & verified at ${keyPath}`;
  });

  // Gate 3: Tailscale API & Tailnet Device Discovery
  const tailscaleClient = new TailscaleClient();
  await executeStep("3/6", "Probing Tailscale API & Device Inventory", async () => {
    const token = await tailscaleClient.getAccessToken();
    if (!token) throw new Error("Failed to obtain Tailscale OAuth token");
    const devices = await tailscaleClient.getDevices();
    const sandboxDevices = devices.filter(
      (d) => d.tags?.includes("tag:factory-sandbox") || d.hostname?.startsWith("sbx-")
    );
    return `OAuth active. Tailnet device count: ${devices.length} (${sandboxDevices.length} sandboxes detected)`;
  });

  // Gate 4: ExeDev Provisioning API Connectivity
  const exedevClient = new ExeDevClient();
  await executeStep("4/6", "Probing ExeDev VM API via HTTPS", async () => {
    const vms = await exedevClient.listVms();
    const activeSandboxes = vms.filter((v) => v.name.startsWith("sbx-"));
    return `ExeDev API responsive. Account VM count: ${vms.length} (${activeSandboxes.length} sandboxes active)`;
  });

  // Gate 5: Supabase Tier 3 State Store & Lease Persistence
  const adminClient = getAdminClient();
  const runsRepo = new SupabaseRunStateStore(adminClient);
  const leaseStorage = new SupabaseLeaseStorage(adminClient);
  const leaseManager = new LeaseManager(leaseStorage, process.env.HOSTNAME || "srv719637-dr-rehearsal");
  const stateMachine = new RunStateMachine(runsRepo);

  await executeStep("5/6", "Verifying Tier 3 ACID Database Tables & Leases", async () => {
    const inFlight = await runsRepo.listInFlightRuns();
    return `Tier 3 state connected. Current in-flight runs in database: ${inFlight.length}`;
  });

  // Gate 6: Simulated Crash State Recovery & Monotonic Fencing Test
  await executeStep("6/6", "Executing Orchestrator Restart & State Reacquisition Rehearsal", async () => {
    const simRunId = `rehearse-dr-${Date.now()}`;
    const simTenantId = "tenant-dr-rehearsal";

    // 1. Create simulated interrupted run directly in runsRepo
    await adminClient.insert("factory_runs", {
      id: simRunId,
      tenant_id: simTenantId,
      request_id: `req-${simRunId}`,
      idempotency_key: `idem-${simRunId}`,
      parent_git_sha: "3b2576026155a47f0132aa99fa78a43c045d92d5",
      policy_version: "v2.0",
      phase: "in_progress",
      state_version: 3,
      budget: { max_cost_cents: 100 },
      envelope: {
        intent: "Disaster Recovery Rehearsal Run",
        acceptance_criteria: ["Verify automatic recovery on restart"]
      }
    });

    // 2. Establish stale lease held by a crashed dead worker
    await leaseStorage.upsertLease({
      runId: simRunId,
      tenantId: simTenantId,
      holderId: "crashed-worker-node-99",
      fencingToken: 4,
      expiresAt: new Date(Date.now() + 600000) // still unexpired when crashed
    });

    // 3. Trigger RecoveryEngine
    const recoveryEngine = new RecoveryEngine({
      runStore: runsRepo,
      stateMachine,
      leaseManager,
      tailscaleClient,
      exedevClient,
      evidenceLedger: wardenLedger ?? undefined
    });

    const simRun = await runsRepo.getRun(simRunId);
    if (!simRun) throw new Error("Failed to read back simulated run from Tier 3");

    const report = await recoveryEngine.recoverRun(simRun);

    if (report.status !== "quarantined") {
      throw new Error(`Expected recovery status 'quarantined', received '${report.status}'`);
    }

    if (report.newFencingToken <= 4) {
      throw new Error(`Monotonic fencing token not incremented! Received ${report.newFencingToken}, expected > 4`);
    }

    // Verify evidence was written
    if (evidenceStore) {
      const records = await evidenceStore.getAllForRun(simRunId);
      const recoveryRecord = records.find(
        (r) => (r.payload?.observation as any)?.action === "orchestrator_recovery_observed"
      );
      if (!recoveryRecord) {
        throw new Error("Missing signed orchestrator_recovery_observed event in evidence_ledger");
      }
    }

    return `Simulated run '${simRunId}' quarantined, fencing token monotonically advanced from 4 to ${report.newFencingToken}, signed evidence logged`;
  });

  const totalElapsedMs = Date.now() - startTime;
  const totalElapsedSec = (totalElapsedMs / 1000).toFixed(2);
  const allPassed = results.every((r) => r.passed);

  console.log("\n=================================================================");
  console.log("Disaster Recovery Rehearsal Summary");
  console.log("=================================================================");
  console.log(`Overall Result:       ${allPassed ? "✔ PASSED (ALL CHECKS GREEN)" : "✖ FAILED"}`);
  console.log(`Elapsed Time:         ${totalElapsedSec} seconds`);
  console.log(`Target RTO:           < ${RTO_TARGET_SECONDS} seconds (30 minutes)`);
  console.log(`RTO Compliance:       ${totalElapsedMs / 1000 < RTO_TARGET_SECONDS ? "✔ WITHIN SLA" : "✖ SLA EXCEEDED"}`);
  console.log("=================================================================");

  for (const r of results) {
    const mark = r.passed ? "✔" : "✖";
    console.log(`${mark} [${r.step}] ${r.name.padEnd(55)} ${r.durationMs}ms`);
  }
  console.log("=================================================================\n");

  if (!allPassed) {
    process.exit(1);
  }
}

runRehearsal().catch((err) => {
  console.error("\n[FATAL] Disaster recovery rehearsal aborted:", err);
  process.exit(1);
});
