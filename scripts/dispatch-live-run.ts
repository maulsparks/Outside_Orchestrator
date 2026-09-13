#!/usr/bin/env node
/**
 * Outside Orchestrator Live Run Dispatch CLI (Milestone v0.3)
 * Dispatches and monitors live factory execution sandboxes against the Tier 1 Edge/Control Plane.
 *
 * Usage:
 *   node dist/scripts/dispatch-live-run.js [options]
 * Options:
 *   --host <url>           Orchestrator URL (default: http://127.0.0.1:3000 or http://100.81.98.73)
 *   --tenant <id>          Tenant ID (default: tenant-live-01)
 *   --phases <phases>      Comma-separated phases: plan,build,test,review (default: build)
 *   --phase <phase>        Single phase shorthand: plan | build | test | review
 *   --parent-sha <sha>     Parent Git commit SHA (default: 3b25760...)
 *   --paths <paths>        Allowed paths comma-separated (default: src/**,output/**)
 *   --ttl <seconds>        Sandbox wall-clock TTL in seconds (default: 300)
 */

import crypto from "node:crypto";

const args = process.argv.slice(2);
function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const host = getArg("--host", process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const tenantId = getArg("--tenant", "tenant-live-01");
const rawPhases = getArg("--phases", getArg("--phase", "build"));
const phases = rawPhases.split(",").map(p => p.trim()) as any[];
const parentGitSha = getArg("--parent-sha", "3b2576026155a47f0132aa99fa78a43c045d92d5");
const allowedPaths = getArg("--paths", "src/**,output/**").split(",").map(p => p.trim());
const ttlSeconds = parseInt(getArg("--ttl", "300"), 10);
const idempotencyKey = `live-dispatch-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

async function main() {
  console.log("=================================================================");
  console.log("Outside Orchestrator — Live Sandbox Dispatch CLI (v0.3)");
  console.log("=================================================================");
  console.log(`Target Host:       ${host}`);
  console.log(`Tenant ID:         ${tenantId}`);
  console.log(`Phases:            ${phases.join(" -> ")}`);
  console.log(`Parent Git SHA:    ${parentGitSha}`);
  console.log(`Allowed Paths:     ${allowedPaths.join(", ")}`);
  console.log(`Idempotency Key:   ${idempotencyKey}`);
  console.log("=================================================================\n");

  // 1. Health check
  console.log("[1/3] Checking Orchestrator health...");
  try {
    const healthRes = await fetch(`${host}/health`);
    if (!healthRes.ok) {
      throw new Error(`Health probe returned ${healthRes.status}`);
    }
    const health = await healthRes.json();
    console.log(`✔ Control Plane Active: ${JSON.stringify(health)}\n`);
  } catch (err: any) {
    console.error(`✖ Control Plane unreachable: ${err.message}`);
    process.exit(1);
  }

  // 2. Intake Admission
  console.log("[2/3] Admitting run request...");
  const intakePayload = {
    tenantId,
    parentGitSha,
    idempotencyKey,
    repositoryId: "Outside_Orchestrator",
    intent: `Execute live [${phases.join(", ")}] phase(s) in Tier 2 exe.dev sandbox`,
    acceptanceCriteria: ["Phase execution produces valid results within declared paths"],
    policyVersion: "v2.0",
    agentsMdSha256: "sha256-default-agents-md",
    budgetCents: 500
  };

  const admitRes = await fetch(`${host}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intakePayload)
  });

  if (!admitRes.ok) {
    console.error(`✖ Admission failed (${admitRes.status}):`, await admitRes.text());
    process.exit(1);
  }

  const admitData = (await admitRes.json()) as any;
  const runId = admitData.run.id;
  console.log(`✔ Run admitted: ID = ${runId} (is_existing = ${admitData.is_existing})`);
  console.log(`✔ Tier 3 Lease Acquired: Token = ${admitData.lease.fencingToken}, Expires = ${admitData.lease.expiresAt}\n`);

  // 3. Dispatch Live Sandbox Execution
  console.log(`[3/3] Dispatching execution to Tier 2 exe.dev sandbox...`);
  console.log("  → Provisioning ephemeral VM with tag:factory-sandbox");
  console.log("  → Awaiting Tailscale enrollment and posture validation");
  console.log("  → Delivering single-phase isolated delegation envelope");
  console.log("  → Pulling advisory traces & running 13-step teardown...\n");

  const startTime = Date.now();
  const dispatchRes = await fetch(`${host}/v1/runs/${runId}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phases,
      allowed_paths: allowedPaths,
      ttl_seconds: ttlSeconds,
      async: true
    })
  });

  if (!dispatchRes.ok) {
    console.error(`✖ Dispatch failed (${dispatchRes.status}):`, await dispatchRes.text());
    process.exit(1);
  }

  console.log("✔ Dispatch accepted by Tier 1 control plane. Monitoring lifecycle...\n");

  let currentRun: any = null;
  let finalData: any = null;
  const pollStart = Date.now();
  while (Date.now() - pollStart < (ttlSeconds * phases.length + 120) * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const statusRes = await fetch(`${host}/v1/runs/${runId}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (statusRes.ok) {
        finalData = (await statusRes.json()) as any;
        currentRun = finalData.run;
        const envelopes = finalData.phase_envelopes || [];
        const envInfo = envelopes.length > 0
          ? `| Envelopes: ${envelopes.map((e: any) => `${e.phase}:${e.outputs?.status || "pending"}`).join(", ")}`
          : "";
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`\r  [${elapsed}s] Phase: ${currentRun.phase.padEnd(16)} | State Version: ${currentRun.state_version} ${envInfo}    `);

        const allCompleted = envelopes.length === phases.length && envelopes.every((e: any) => e.outputs?.status === "completed");
        const anyFailed = envelopes.some((e: any) => e.outputs?.status === "failed") || currentRun.phase === "quarantined";

        if ((allCompleted && currentRun.phase === "clean_terminated") || anyFailed) {
          console.log("\n");
          break;
        }
      } else {
        console.warn(`\n[Poll Warning] Server returned status ${statusRes.status}`);
      }
    } catch (err: any) {
      if (err.name !== "TimeoutError") {
        console.warn(`\n[Poll Warning] Network glitch: ${err.message}`);
      }
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("=================================================================");
  console.log(`Execution Finished in ${durationSec}s — Final State: ${currentRun?.phase?.toUpperCase()}`);
  console.log("=================================================================");
  console.log(`Run ID:              ${runId}`);
  console.log(`Final State Version: ${currentRun?.state_version}`);
  console.log(`Status:              ${currentRun?.phase === "clean_terminated" ? "CLEAN_TERMINATED (Passed)" : "QUARANTINED / FAILED"}`);
  if (finalData?.phase_envelopes?.length > 0) {
    console.log("Phase Envelopes Recorded in Tier 3:");
    for (const env of finalData.phase_envelopes) {
      console.log(`  - [${env.phase.padEnd(8)}] attempt=${env.attempt} status=${env.outputs?.status ?? "unknown"} outputTreeSha=${env.outputs?.output_tree_sha?.substring(0, 16) ?? "none"}...`);
    }
  }
  console.log("=================================================================\n");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
