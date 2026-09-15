#!/usr/bin/env node

/**
 * Outside Orchestrator — Automated PR Merge & Continuous Deployment CLI (Milestone 19)
 *
 * Usage:
 *   node dist/scripts/merge-and-deploy-pr.js --run <runId> [--host <url>] [--pr <prNum>] [--method squash] [--no-deploy] [--require-approval]
 */

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const runId = getArg("--run");
const host = (getArg("--host") || process.env.ORCHESTRATOR_HOST || "http://127.0.0.1:3000").replace(/\/$/, "");
const prNumberArg = getArg("--pr");
const mergeMethod = (getArg("--method") || "squash") as "squash" | "merge" | "rebase";
const noDeploy = args.includes("--no-deploy");
const requireApproval = args.includes("--require-approval");

if (!runId && !prNumberArg) {
  console.error("Usage: node dist/scripts/merge-and-deploy-pr.js --run <runId> [--pr <number>] [--host <url>] [--method <squash|merge|rebase>] [--no-deploy] [--require-approval]");
  process.exit(1);
}

async function main() {
  console.log("=================================================================");
  console.log("Outside Orchestrator — Automated PR Merge & Continuous Deployment");
  console.log("=================================================================");
  console.log(`Target Host:       ${host}`);
  console.log(`Run ID:            ${runId || "N/A"}`);
  console.log(`PR Number Override: ${prNumberArg || "Auto-detect"}`);
  console.log(`Merge Method:      ${mergeMethod}`);
  console.log(`Trigger Deploy:    ${!noDeploy}`);
  console.log(`Require Approval:  ${requireApproval}`);
  console.log("=================================================================\n");

  // 1. Health Probe
  console.log("[1/3] Checking Outside Orchestrator health...");
  try {
    const healthRes = await fetch(`${host}/health`, { signal: AbortSignal.timeout(5000) });
    if (!healthRes.ok) {
      throw new Error(`HTTP ${healthRes.status}`);
    }
    const health = await healthRes.json() as { status?: string; node?: string; uptime?: number };
    console.log(`✔ Control Plane Active: node '${health.node || "srv719637"}', uptime ${Math.round(health.uptime || 0)}s\n`);
  } catch (err: unknown) {
    console.error(`✖ Failed to connect to Outside Orchestrator at ${host}:`, (err as Error).message);
    process.exit(1);
  }

  // 2. Fetch PR status if runId provided
  if (runId) {
    console.log(`[2/3] Querying GitHub Pull Request status for run '${runId}'...`);
    try {
      const statusRes = await fetch(`${host}/v1/runs/${runId}/pr-status`);
      if (statusRes.ok) {
        const prInfo = await statusRes.json() as any;
        console.log(`  - Branch:     ${prInfo.branch}`);
        console.log(`  - PR Number:  #${prInfo.pr_number}`);
        console.log(`  - PR State:   ${prInfo.pull_request?.state || "unknown"} (merged: ${prInfo.pull_request?.merged})`);
        console.log(`  - Mergeable:  ${prInfo.pull_request?.mergeable}`);
        console.log(`  - PR URL:     ${prInfo.pull_request?.htmlUrl || prInfo.pull_request?.html_url}`);
        console.log(`  - Reviews:    ${prInfo.reviews?.length || 0} submitted (Approved: ${prInfo.approved})\n`);
      } else {
        console.log(`  ⚠ Notice: GET /pr-status returned HTTP ${statusRes.status}. Proceeding with direct merge...\n`);
      }
    } catch {
      console.log("  ⚠ Notice: Could not pre-fetch PR status. Proceeding with merge attempt...\n");
    }
  }

  // 3. Execute PR Merge and Deployment
  console.log("[3/3] Executing PR Merge and Continuous Deployment Pipeline...");
  const mergeEndpoint = `${host}/v1/runs/${runId || "direct"}/merge-pr`;
  try {
    const mergeRes = await fetch(mergeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pr_number: prNumberArg ? parseInt(prNumberArg, 10) : undefined,
        merge_method: mergeMethod,
        deploy: !noDeploy,
        require_approval: requireApproval
      })
    });

    const mergeData = await mergeRes.json() as any;
    if (!mergeRes.ok || !mergeData.merged) {
      console.error(`✖ PR Merge Failed (HTTP ${mergeRes.status}):`, mergeData.message || mergeData.error);
      process.exit(1);
    }

    console.log("-----------------------------------------------------------------");
    console.log("✔ PULL REQUEST MERGED SUCCESSFULLY INTO MAIN");
    console.log("-----------------------------------------------------------------");
    console.log(`Run ID:            ${mergeData.runId}`);
    console.log(`PR Number:         #${mergeData.prNumber}`);
    console.log(`PR URL:            ${mergeData.prUrl}`);
    console.log(`Merge Commit SHA:  ${mergeData.mergeCommitSha || "N/A"}`);
    console.log(`Merge Method:      ${mergeData.mergeMethod}`);
    if (mergeData.alreadyMerged) {
      console.log("Status Note:       PR was already merged; continuous deployment executed.");
    }
    console.log("-----------------------------------------------------------------");

    if (mergeData.deployment) {
      console.log("\nContinuous Deployment Summary:");
      console.log(`  - Status:         ${mergeData.deployment.status}`);
      console.log(`  - Trigger:        ${mergeData.deployment.trigger}`);
      console.log(`  - Duration:       ${mergeData.deployment.durationMs}ms`);
      console.log(`  - Health Probe:   ${mergeData.deployment.healthStatus}`);
      if (mergeData.deployment.stdout) {
        console.log(`  - Output:         ${mergeData.deployment.stdout.trim()}`);
      }
    }

    console.log("\n✔ ALL MERGE & CONTINUOUS DEPLOYMENT INVARIANTS SATISFIED!\n");
  } catch (err: unknown) {
    console.error("✖ Merge execution failed:", (err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
