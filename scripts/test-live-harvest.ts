#!/usr/bin/env node
/**
 * Live End-to-End Harvest Verification Script (Contract §4, §6.8, §9 & §10 AC 10)
 * Sets up a clean_terminated run with valid multi-gate evidence, runs the Harvest CLI,
 * and validates the resulting HarvestAttestation in Tier 3 evidence_ledger.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { getAdminClient } from "../src/adapters/supabase/client.js";
import { SupabaseRunStateStore } from "../src/adapters/supabase/runsRepo.js";
import { SupabasePhaseEnvelopeStore } from "../src/core/dispatcher.js";
import { EvidenceLedger, SupabaseEvidenceStore } from "../src/warden/ledger.js";
import { signHarvest } from "../src/core/harvest.js";

async function main() {
  console.log("=================================================================");
  console.log("Outside Orchestrator — Live E2E Harvest Verification");
  console.log("=================================================================\n");

  const adminClient = getAdminClient();
  const runStore = new SupabaseRunStateStore(adminClient);
  const phaseStore = new SupabasePhaseEnvelopeStore(adminClient);
  const evidenceStore = new SupabaseEvidenceStore(adminClient);

  const wardenKeyPath = process.env.WARDEN_KEY_PATH || "/var/lib/warden/keys/warden_private_key.pem";
  let privateKeyPem = "";
  if (fs.existsSync(wardenKeyPath)) {
    privateKeyPem = fs.readFileSync(wardenKeyPath, "utf8");
  } else {
    // Generate ephemeral key for testing
    const kp = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    privateKeyPem = kp.privateKey;
  }

  const ledger = new EvidenceLedger(evidenceStore, privateKeyPem, "warden-srv719637-2026");

  const testRunId = crypto.randomUUID();
  const tenantId = "tenant-e2e-harvest";
  const parentGitSha = "1659044bb77f5022dc779bfca62074e64f895c12";
  const acceptedTreeSha = "d903424ff435013098dc08e1762e841261314981";
  const envelopeHash = crypto.createHash("sha256").update(`envelope-${testRunId}`).digest("hex");
  const policyVersion = "v2.0";

  console.log(`[1/5] Creating test run '${testRunId}' in phase 'clean_terminated'...`);
  await runStore.createRun({
    id: testRunId,
    tenant_id: tenantId,
    request_id: `req-${testRunId}`,
    idempotency_key: `idem-${testRunId}`,
    parent_git_sha: parentGitSha,
    policy_version: policyVersion,
    phase: "clean_terminated",
    state_version: 10,
    budget: { max_cost_cents: 1000 },
    envelope: { task_envelope_hash: envelopeHash }
  });
  console.log("✔ Run record created in Supabase 'factory_runs'");

  console.log("[2/5] Recording completed phase envelopes in Supabase...");
  await phaseStore.recordPhaseEnvelope({
    runId: testRunId,
    tenantId,
    phase: "build",
    attempt: 1,
    inputs: { task: "compile" },
    envelopeHash: "hash-env-build"
  });
  await phaseStore.recordPhaseOutputs({
    runId: testRunId,
    phase: "build",
    attempt: 1,
    outputs: {
      status: "completed",
      declared_changed_files: ["src/core/harvest.ts", "src/server.ts"],
      output_tree_sha: acceptedTreeSha,
      clean_terminated: true
    }
  });
  console.log("✔ Phase outputs recorded with accepted tree SHA");

  console.log("[3/5] Recording verified multi-gate boundary evidence in evidence_ledger...");
  await ledger.recordEvent({
    tenantId,
    requestId: `req-${testRunId}`,
    runId: testRunId,
    sandboxId: `sbx-${testRunId}`,
    policyVersion,
    eventType: "advisory_output_collected",
    source: { role: "Outside_Orchestrator", host: "srv719637" },
    observation: { trace_manifest_sha256: "manifest-sha256-verified" }
  });

  await ledger.recordEvent({
    tenantId,
    requestId: `req-${testRunId}`,
    runId: testRunId,
    sandboxId: `sbx-${testRunId}`,
    policyVersion,
    eventType: "erg_result",
    source: { role: "Outside_Orchestrator", host: "srv719637" },
    observation: {
      erg_result: { passed: true, unauthorizedTouches: [] }
    }
  });

  await ledger.recordEvent({
    tenantId,
    requestId: `req-${testRunId}`,
    runId: testRunId,
    sandboxId: `sbx-${testRunId}`,
    policyVersion,
    eventType: "test_result",
    source: { role: "Outside_Orchestrator", host: "srv719637" },
    observation: {
      test_gate_result: { passed: true, exitCode: 0 }
    }
  });

  await ledger.recordEvent({
    tenantId,
    requestId: `req-${testRunId}`,
    runId: testRunId,
    sandboxId: `sbx-${testRunId}`,
    policyVersion,
    eventType: "teardown_probe_passed",
    source: { role: "Outside_Orchestrator", host: "srv719637" },
    observation: {
      terminal_state: "CLEAN_TERMINATED",
      clean_terminated: true
    }
  });
  console.log("✔ Boundary evidence chain recorded & signed with Warden Ed25519 key");

  console.log("[4/5] Testing Proposal API (GET /v1/runs/:runId/harvest/proposal)...");
  const host = process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3000";
  const propRes = await fetch(`${host}/v1/runs/${testRunId}/harvest/proposal`);
  if (!propRes.ok) {
    throw new Error(`Proposal API failed with HTTP ${propRes.status}: ${await propRes.text()}`);
  }
  const proposal = (await propRes.json()) as any;
  console.log(`✔ Proposal Ready: ${proposal.readyForHarvest}`);
  console.log(`✔ Accepted Tree SHA: ${proposal.acceptedTreeSha}`);
  console.log(`✔ Canonical Message: ${proposal.canonicalMessage}`);

  if (!proposal.readyForHarvest) {
    throw new Error(`Proposal was not ready for harvest: ${proposal.blockingReasons.join(", ")}`);
  }

  console.log("[5/5] Submitting Cryptographic Harvest Authorization (POST /v1/runs/:runId/harvest)...");
  const signerIdentity = "human:principal-reviewer@outside-factory.internal";
  const signature = signHarvest(
    {
      runId: proposal.runId,
      treeSha: proposal.acceptedTreeSha,
      envelopeHash: proposal.taskEnvelopeHash,
      policyVersion: proposal.policyVersion
    },
    privateKeyPem
  );

  const harvestRes = await fetch(`${host}/v1/runs/${testRunId}/harvest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selected_arm_id: "default",
      signature,
      signer_identity: signerIdentity,
      teardown_evidence_id: proposal.teardownEvidenceId,
      target_branch: "main",
      commit_message: `E2E Live Harvest for run ${testRunId}`
    })
  });

  if (!harvestRes.ok) {
    throw new Error(`Harvest API failed with HTTP ${harvestRes.status}: ${await harvestRes.text()}`);
  }

  const result = (await harvestRes.json()) as any;
  console.log("-----------------------------------------------------------------");
  console.log("✔ LIVE HARVEST AUTHORIZATION & MERGE CONFIRMED");
  console.log("-----------------------------------------------------------------");
  console.log(`Authorized:        ${result.authorized}`);
  console.log(`Attestation Run:   ${result.attestation.run_id}`);
  console.log(`Signer:            ${result.attestation.signer_identity}`);
  console.log(`Accepted Tree SHA: ${result.attestation.accepted_tree_sha}`);
  console.log(`Verified At:       ${result.attestation.signature_verified_at}`);
  console.log(`Canonical Git Ref: ${result.git_ref}`);
  console.log(`Commit SHA:        ${result.commit_sha}`);
  console.log("-----------------------------------------------------------------\n");

  // Verify in Supabase evidence_ledger
  console.log("Verifying immutable HarvestAttestation in Supabase evidence_ledger...");
  const records = await evidenceStore.getAllForRun(testRunId);
  const commitEvent = records.find(
    (r) => (r.payload as any)?.observation?.harvest_committed === true
  );
  if (!commitEvent) {
    throw new Error("Missing harvest_committed event in durable evidence_ledger!");
  }
  console.log(`✔ Found signed evidence record in Tier 3 (event_hash: ${commitEvent.event_hash.substring(0, 16)}...)`);
  console.log("✔ ALL LIVE E2E HARVEST ACCEPTANCE CRITERIA SATISFIED!\n");
}

main().catch((err) => {
  console.error("✖ Live E2E Harvest Verification Failed:", err);
  process.exit(1);
});
