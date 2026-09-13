#!/usr/bin/env node
/**
 * Outside Orchestrator Harvest & Repository Merge CLI (Contract §4, §6.8, §9 & §10 AC 10)
 * Evaluates multi-gate readiness, verifies tree SHA & envelope integrity,
 * signs the canonical harvest tuple, and commits the accepted tree ref.
 *
 * Usage:
 *   node dist/scripts/harvest-run.js --run <runId> [options]
 * Options:
 *   --host <url>           Orchestrator URL (default: http://127.0.0.1:3000 or http://100.81.98.73)
 *   --run <id>             Factory run ID to harvest (required)
 *   --key <path>           Path to Ed25519 private key PEM (default: WARDEN_KEY_PATH or generated)
 *   --signer <id>          Signer identity (default: human:operator@platform.internal)
 *   --arm <id>             Selected arm ID (default: default)
 *   --branch <branch>      Target repository branch (default: main)
 *   --dry-run              Inspect proposal and verify gates without signing or submitting
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { signHarvest } from "../src/core/harvest.js";

const args = process.argv.slice(2);
function getArg(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}
const hasFlag = (flag: string): boolean => args.includes(flag);

const host = getArg("--host", process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const runId = getArg("--run", "");
const keyPath = getArg("--key", process.env.WARDEN_KEY_PATH || "");
const signerId = getArg("--signer", "human:operator@platform.internal");
const armId = getArg("--arm", "default");
const targetBranch = getArg("--branch", "main");
const dryRun = hasFlag("--dry-run");

async function main() {
  console.log("=================================================================");
  console.log("Outside Orchestrator — Automated Harvest & Merge CLI (v0.3)");
  console.log("=================================================================");
  console.log(`Target Host:       ${host}`);
  console.log(`Run ID:            ${runId || "(not specified)"}`);
  console.log(`Signer Identity:   ${signerId}`);
  console.log(`Selected Arm:      ${armId}`);
  console.log(`Target Branch:     ${targetBranch}`);
  console.log(`Mode:              ${dryRun ? "DRY-RUN (inspection only)" : "LIVE AUTHORIZE & MERGE"}`);
  console.log("=================================================================\n");

  if (!runId) {
    console.error("✖ Error: Missing required --run <runId> parameter.");
    console.log("Usage: node dist/scripts/harvest-run.js --run <runId> [--dry-run] [--key <path>]");
    process.exit(1);
  }

  // 1. Health check
  console.log("[1/4] Checking Control Plane health...");
  try {
    const healthRes = await fetch(`${host}/health`);
    if (!healthRes.ok) {
      throw new Error(`Health probe returned HTTP ${healthRes.status}`);
    }
    const health = (await healthRes.json()) as Record<string, unknown>;
    console.log(`✔ Control Plane Active (status: ${health.status}, uptime: ${health.uptime}s)\n`);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`✖ Control Plane unreachable: ${error.message}`);
    process.exit(1);
  }

  // 2. Fetch Harvest Proposal
  console.log(`[2/4] Fetching harvest proposal for run '${runId}'...`);
  let proposal: any = null;
  try {
    const propRes = await fetch(`${host}/v1/runs/${runId}/harvest/proposal`);
    if (!propRes.ok) {
      const errText = await propRes.text();
      throw new Error(`HTTP ${propRes.status}: ${errText}`);
    }
    proposal = await propRes.json();
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`✖ Failed to retrieve harvest proposal: ${error.message}`);
    process.exit(1);
  }

  console.log("-----------------------------------------------------------------");
  console.log("HARVEST PROPOSAL SUMMARY");
  console.log("-----------------------------------------------------------------");
  console.log(`Tenant ID:         ${proposal.tenantId}`);
  console.log(`Policy Version:    ${proposal.policyVersion}`);
  console.log(`Parent Git SHA:    ${proposal.parentGitSha}`);
  console.log(`Accepted Tree SHA: ${proposal.acceptedTreeSha}`);
  console.log(`Task Envelope:     ${proposal.taskEnvelopeHash.substring(0, 16)}...`);
  console.log(`Phase History:     ${proposal.summary.phaseHistory.map((p: any) => `${p.phase}(${p.status || "ok"})`).join(" -> ")}`);
  console.log(`Declared Changes:  ${proposal.summary.declaredChanges.length > 0 ? proposal.summary.declaredChanges.join(", ") : "(none)"}`);
  console.log("-----------------------------------------------------------------");
  console.log("MULTI-GATE VERIFICATION STATUS");
  console.log("-----------------------------------------------------------------");
  console.log(`[${proposal.gates.isCleanTerminated ? "✔" : "✖"}] CLEAN_TERMINATED state`);
  console.log(`[${proposal.gates.ergPassed ? "✔" : "✖"}] Effect Reconciliation Gate (zero undeclared touches)`);
  console.log(`[${proposal.gates.testGatePassed ? "✔" : "✖"}] Frozen Acceptance Tests (exit code 0, hash verified)`);
  console.log(`[${proposal.gates.advisoryOutputCollected ? "✔" : "✖"}] Advisory Output Collected & Hash Verified`);
  console.log("-----------------------------------------------------------------");
  console.log(`Canonical Tuple:   ${proposal.canonicalMessage}`);
  console.log(`Ready for Harvest: ${proposal.readyForHarvest ? "YES ✔" : "NO ✖"}`);
  console.log("-----------------------------------------------------------------\n");

  if (!proposal.readyForHarvest) {
    console.error("✖ Run cannot be harvested due to blocking reasons:");
    for (const reason of proposal.blockingReasons) {
      console.error(`  - ${reason}`);
    }
    process.exit(1);
  }

  if (dryRun) {
    console.log("✔ [DRY-RUN] All gates verified! Run is ready for cryptographic harvest authorization.");
    console.log(`To authorize, re-run without --dry-run.`);
    process.exit(0);
  }

  // 3. Cryptographic Human Reviewer Signing
  console.log("[3/4] Cryptographically signing canonical harvest tuple...");
  let privateKeyPem = "";
  let publicKeyPem = "";

  if (keyPath && fs.existsSync(keyPath)) {
    privateKeyPem = fs.readFileSync(keyPath, "utf8");
    console.log(`✔ Loaded signing key from: ${keyPath}`);
  } else {
    // Generate an ephemeral Ed25519 keypair for operator session
    console.log("Notice: No private key specified via --key. Generating operator Ed25519 keypair...");
    const keyPair = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    privateKeyPem = keyPair.privateKey;
    publicKeyPem = keyPair.publicKey;
  }

  const signature = signHarvest(
    {
      runId: proposal.runId,
      treeSha: proposal.acceptedTreeSha,
      envelopeHash: proposal.taskEnvelopeHash,
      policyVersion: proposal.policyVersion
    },
    privateKeyPem
  );
  console.log(`✔ Generated Ed25519 signature: ${signature.substring(0, 32)}...\n`);

  // 4. Submit Harvest Authorization & Merge
  console.log("[4/4] Submitting harvest authorization to Outside Orchestrator...");
  try {
    const harvestRes = await fetch(`${host}/v1/runs/${runId}/harvest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selected_arm_id: armId,
        signature,
        signer_identity: signerId,
        public_key_pem: publicKeyPem || undefined,
        teardown_evidence_id: proposal.teardownEvidenceId,
        target_branch: targetBranch,
        commit_message: `Harvest run ${runId} (authorized by ${signerId})`
      })
    });

    const result = (await harvestRes.json()) as any;
    if (!harvestRes.ok || !result.authorized) {
      console.error(`✖ Harvest Authorization Rejected (HTTP ${harvestRes.status}):`);
      if (result.reasons) {
        for (const r of result.reasons) {
          console.error(`  - ${r}`);
        }
      }
      process.exit(1);
    }

    console.log("=================================================================");
    console.log("✔ HARVEST AUTHORIZED & COMMITTED SUCCESSFULLY");
    console.log("=================================================================");
    console.log(`Run ID:            ${result.attestation.run_id}`);
    console.log(`Accepted Tree SHA: ${result.attestation.accepted_tree_sha}`);
    console.log(`Signer Identity:   ${result.attestation.signer_identity}`);
    console.log(`Verified At:       ${result.attestation.signature_verified_at}`);
    console.log(`Canonical Git Ref: ${result.git_ref}`);
    console.log(`Commit SHA:        ${result.commit_sha}`);
    console.log("=================================================================\n");
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`✖ Failed to authorize harvest: ${error.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
