#!/usr/bin/env node
/**
 * Outside Orchestrator — Live E2E Sandbox Runner CLI (Milestone 18)
 * Dispatches a live disposable exe.dev VM sandbox, executes task, pulls traces,
 * verifies ERG, performs 13-step teardown, and publishes a live GitHub PR.
 *
 * Usage:
 *   node dist/scripts/run-live-sandbox-e2e.js [options]
 * Options:
 *   --host <url>           Orchestrator URL (default: http://127.0.0.1:3000)
 *   --prompt <text>        Human user prompt / task description
 *   --tenant <id>          Tenant ID (default: tenant-live-production)
 *   --paths <paths>        Allowed paths comma-separated (default: output/**)
 *   --kind <agent|code>    Execution kind (default: code)
 *   --cmd <command>        Deterministic command (default: echo ...)
 *   --ttl <seconds>        Sandbox wall-clock TTL in seconds (default: 300)
 *   --branch <branch>      Target branch for PR (default: main)
 */

import crypto from "node:crypto";

const args = process.argv.slice(2);
function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const host = getArg("--host", process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const prompt = getArg("--prompt", "Implement automated milestone 18 live sandbox execution and publish GitHub pull request");
const tenantId = getArg("--tenant", "tenant-live-production");
const allowedPaths = getArg("--paths", "output/**").split(",").map((p) => p.trim());
const executionKind = getArg("--kind", "code") as "agent" | "code";
const deterministicCommand = getArg(
  "--cmd",
  "mkdir -p output && echo '{\"status\":\"success\",\"milestone\":18,\"executed_at\":\"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'\"}' > output/phase_result.json"
);
const ttlSeconds = parseInt(getArg("--ttl", "300"), 10);
const targetBranch = getArg("--branch", "main");

async function main() {
  console.log("=================================================================");
  console.log("Outside Orchestrator — Live End-to-End Sandbox Runner (M18)");
  console.log("=================================================================");
  console.log(`Target Host:       ${host}`);
  console.log(`Tenant ID:         ${tenantId}`);
  console.log(`Execution Kind:    ${executionKind}`);
  console.log(`Prompt:            ${prompt}`);
  console.log(`Allowed Paths:     ${allowedPaths.join(", ")}`);
  console.log(`Target Branch:     ${targetBranch}`);
  console.log(`Command:           ${deterministicCommand}`);
  console.log(`TTL:               ${ttlSeconds}s`);
  console.log("=================================================================\n");

  // 1. Health check
  console.log("[1/4] Checking Outside Orchestrator health...");
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

  // 2. Dispatch Live E2E Run
  console.log("[2/4] Dispatching Live End-to-End Sandbox Execution...");
  console.log("  → Provisioning ephemeral exe.dev VM with tag:factory-sandbox");
  console.log("  → Ephemerally enrolling into Tailscale");
  console.log("  → Validating node posture and Inside Orchestrator health");
  console.log("  → Delivering delegation envelope & executing task in sandbox");
  console.log("  → Pulling advisory traces & verifying manifest SHA256");
  console.log("  → Reconciling tree effects with ERG (zero undeclared touches)");
  console.log("  → Executing 13-step teardown attesting CLEAN_TERMINATED");
  console.log("  → Signing cryptographic Ed25519 HarvestAttestation");
  console.log("  → Creating feature branch & publishing GitHub Pull Request...\n");

  const startTime = Date.now();
  const runRes = await fetch(`${host}/v1/runs/live-e2e`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      tenant_id: tenantId,
      allowed_paths: allowedPaths,
      execution_kind: executionKind,
      deterministic_command: deterministicCommand,
      target_branch: targetBranch,
      ttl_seconds: ttlSeconds,
      auto_harvest: true
    })
  });

  if (!runRes.ok) {
    const errorText = await runRes.text();
    console.error(`✖ Live E2E Run failed (${runRes.status}):`, errorText);
    process.exit(1);
  }

  const result = (await runRes.json()) as any;
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("-----------------------------------------------------------------");
  console.log(`✔ LIVE END-TO-END SANDBOX EXECUTION & HARVEST COMPLETED (${elapsedSec}s)`);
  console.log("-----------------------------------------------------------------");
  console.log(`Run ID:            ${result.runId}`);
  console.log(`Status:            ${result.status}`);
  console.log(`Clean Terminated:  ${result.cleanTerminated}`);
  console.log(`Feature Branch:    ${result.branch}`);
  console.log(`PR Number:         #${result.prNumber ?? "N/A"}`);
  console.log(`PR URL:            ${result.prUrl ?? "N/A"}`);
  console.log(`PR Status:         ${result.prStatus}`);
  if (result.prError) {
    console.log(`PR Warning:        ${result.prError}`);
  }
  if (result.attestation) {
    console.log(`Signer Identity:   ${result.attestation.signer_identity}`);
    console.log(`Accepted Tree SHA: ${result.attestation.accepted_tree_sha}`);
    console.log(`Signature:         ${result.attestation.signature.substring(0, 32)}...`);
    console.log(`Verified At:       ${result.attestation.signature_verified_at}`);
  }
  console.log("-----------------------------------------------------------------\n");

  if (result.prUrl) {
    console.log(`🔗 Open Live GitHub Pull Request: ${result.prUrl}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
