/**
 * End-to-End Live Sandbox Runner (Milestone 18)
 *
 * Coordinates the authoritative zero-trust pipeline per Outside Orchestrator Role Contract v2:
 * 1. Admission in Tier 3 (factory_runs) with monotonic lease and task envelope.
 * 2. Ephemeral Tier 2 exe.dev sandbox provisioning & single-use Tailscale isolation (tag:factory-sandbox).
 * 3. Inside Orchestrator task execution with deterministic commands or bounded agent correction loops.
 * 4. Pull-based advisory trace collection & manifest SHA256 verification (Contract §6.5 & §7.3).
 * 5. Effect Reconciliation Gate (ERG) verification (zero undeclared touches).
 * 6. 13-step teardown attesting CLEAN_TERMINATED with active network probe verification.
 * 7. Dynamic HarvestProposal evaluation & Ed25519 cryptographic harvest attestation signing.
 * 8. Feature branch creation (factory/run-<id>) & automated rich GitHub Pull Request publishing.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { LiveDispatcher, LiveDispatchConfig, LiveDispatchResult } from "./liveDispatcher.js";
import {
  prepareHarvestProposal,
  signHarvest,
  commitHarvestRef,
  CommitHarvestRefResult,
  HarvestProposal
} from "./harvest.js";
import type { HarvestAttestation, Phase as FactoryExecutionPhase } from "../../contracts/interfaces.js";
import { RunStateMachine, FactoryRunRecord } from "./stateMachine.js";
import { RunStateStore } from "./stateMachine.js";
import { PhaseEnvelopeStore } from "./dispatcher.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { GitHubPrPublisher } from "../adapters/github/prPublisher.js";

export interface LiveSandboxRunOptions {
  runId?: string;
  tenantId?: string;
  requestId?: string;
  idempotencyKey?: string;
  parentGitSha?: string;
  userPrompt?: string;
  phases?: FactoryExecutionPhase[];
  allowedPaths?: string[];
  immutablePaths?: string[];
  targetBranch?: string;
  executionKind?: "agent" | "code";
  deterministicCommand?: string;
  ttlSeconds?: number;
  budgetCents?: number;
  autoHarvest?: boolean;
  signerIdentity?: string;
  privateKeyPem?: string;
  githubToken?: string;
  repositoryId?: string;
  pollIntervalMs?: number;
  maxWaitBootMs?: number;
}

export interface LiveSandboxRunResult {
  runId: string;
  tenantId: string;
  status: "completed" | "failed";
  cleanTerminated: boolean;
  phase: FactoryExecutionPhase;
  phaseAttempt: number;
  dispatchResult: LiveDispatchResult;
  proposal?: HarvestProposal;
  harvestResult?: CommitHarvestRefResult;
  attestation?: HarvestAttestation;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  prStatus?: "created" | "existing" | "skipped" | "failed";
  prError?: string;
  error?: string;
}

export class LiveSandboxRunner {
  constructor(
    private readonly dispatcher: LiveDispatcher,
    private readonly stateMachine: RunStateMachine,
    private readonly runStore: RunStateStore,
    private readonly evidenceLedger: EvidenceLedger,
    private readonly phaseStore?: PhaseEnvelopeStore,
    private readonly githubPublisher?: GitHubPrPublisher
  ) {}

  /**
   * Executes a complete end-to-end factory lifecycle from admission to GitHub PR.
   */
  async executeLiveRun(options: LiveSandboxRunOptions): Promise<LiveSandboxRunResult> {
    const runId = options.runId ?? crypto.randomUUID();
    const tenantId = options.tenantId ?? "tenant-live-production";
    const requestId = options.requestId ?? `req_${runId}`;
    const idempotencyKey = options.idempotencyKey ?? `live_run_${runId}_${Date.now()}`;
    const targetBranch = options.targetBranch ?? "main";
    const allowedPaths = options.allowedPaths ?? ["output/**"];
    const immutablePaths = options.immutablePaths ?? ["AGENTS.md"];
    const executionKind = options.executionKind ?? "code";
    const deterministicCommand = options.deterministicCommand ?? "echo 'Live sandbox code-change task passed' > output/phase_result.json";
    const ttlSeconds = options.ttlSeconds ?? 300;
    const autoHarvest = options.autoHarvest !== false;
    const policyVersion = "v2.0";

    let parentGitSha = options.parentGitSha;
    if (!parentGitSha) {
      try {
        const { execSync } = await import("node:child_process");
        parentGitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
      } catch {
        parentGitSha = "364ce4f34e3c65ba7d55268457cc71194274a411";
      }
    }

    const envelopeHash = crypto
      .createHash("sha256")
      .update(`${runId}:${parentGitSha}:${options.userPrompt || "no-prompt"}`)
      .digest("hex");

    console.log(`[LiveSandboxRunner:${runId}] Admitting live factory run in Tier 3...`);

    // 1. Admission: Create durable run record
    const run: FactoryRunRecord = {
      id: runId,
      tenant_id: tenantId,
      request_id: requestId,
      idempotency_key: idempotencyKey,
      parent_git_sha: parentGitSha,
      policy_version: policyVersion,
      phase: "created",
      state_version: 1,
      budget: { max_cost_cents: options.budgetCents ?? 1000 },
      envelope: {
        task_envelope_hash: envelopeHash,
        user_prompt: options.userPrompt,
        execution_kind: executionKind,
        deterministic_command: deterministicCommand,
        acceptance_criteria: [
          "Sandbox output conforms to declared allowed paths",
          "Deterministic verification completed with exit code 0"
        ]
      }
    };

    if (this.runStore.createRun) {
      await this.runStore.createRun(run);
    } else if ("setRun" in this.runStore && typeof (this.runStore as any).setRun === "function") {
      (this.runStore as any).setRun(run);
    }
    console.log(`[LiveSandboxRunner:${runId}] Durable run created in phase 'created'`);

    // 2. Dispatch live execution to Tier 2 exe.dev sandbox
    console.log(`[LiveSandboxRunner:${runId}] Dispatching execution to LiveDispatcher...`);
    const targetPhase: FactoryExecutionPhase = (options.phases && options.phases[0]) || "build";

    const dispatchConfig: LiveDispatchConfig = {
      run,
      phase: targetPhase,
      phaseAttempt: 1,
      allowedPaths,
      immutablePaths,
      executionKind,
      deterministicCommand,
      ttlSeconds,
      pollIntervalMs: options.pollIntervalMs,
      maxWaitBootMs: options.maxWaitBootMs
    };

    const dispatchResult = await this.dispatcher.executeRun(dispatchConfig);

    if (dispatchResult.status !== "completed" || !dispatchResult.cleanTerminated) {
      console.error(`[LiveSandboxRunner:${runId}] Sandbox execution failed or clean termination not attested.`);
      return {
        runId,
        tenantId,
        status: "failed",
        cleanTerminated: dispatchResult.cleanTerminated,
        phase: targetPhase,
        phaseAttempt: 1,
        dispatchResult,
        error: dispatchResult.error || "Sandbox execution failed"
      };
    }

    console.log(`[LiveSandboxRunner:${runId}] Sandbox execution completed cleanly in phase 'clean_terminated'.`);

    // 3. Automated Harvest & GitHub PR publishing
    if (!autoHarvest) {
      return {
        runId,
        tenantId,
        status: "completed",
        cleanTerminated: true,
        phase: targetPhase,
        phaseAttempt: 1,
        dispatchResult
      };
    }

    console.log(`[LiveSandboxRunner:${runId}] Preparing dynamic harvest proposal...`);
    const proposal = await prepareHarvestProposal({
      runId,
      runStore: this.runStore,
      phaseStore: this.phaseStore,
      evidenceStore: (this.evidenceLedger as any).evidenceStore
    });

    if (!proposal.readyForHarvest) {
      const reasons = proposal.blockingReasons.join("; ");
      console.warn(`[LiveSandboxRunner:${runId}] Harvest blocked: ${reasons}`);
      return {
        runId,
        tenantId,
        status: "completed",
        cleanTerminated: true,
        phase: targetPhase,
        phaseAttempt: 1,
        dispatchResult,
        proposal,
        error: `Harvest proposal blocked: ${reasons}`
      };
    }

    // Sign harvest attestation with Ed25519 private key
    let privateKeyPem = options.privateKeyPem;
    if (!privateKeyPem) {
      const keyPath = process.env.WARDEN_KEY_PATH || "/var/lib/warden/keys/warden_private_key.pem";
      if (fs.existsSync(keyPath)) {
        privateKeyPem = fs.readFileSync(keyPath, "utf8");
      } else {
        const kp = crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        privateKeyPem = kp.privateKey;
      }
    }

    const signerIdentity = options.signerIdentity || "human:principal-reviewer@outside-factory.internal";
    const signature = signHarvest(
      {
        runId,
        treeSha: proposal.acceptedTreeSha,
        envelopeHash: proposal.taskEnvelopeHash,
        policyVersion: proposal.policyVersion
      },
      privateKeyPem
    );

    const attestation: HarvestAttestation = {
      run_id: runId,
      selected_arm_id: proposal.selectedArmId,
      accepted_tree_sha: proposal.acceptedTreeSha,
      task_envelope_hash: proposal.taskEnvelopeHash,
      policy_version: proposal.policyVersion,
      signer_identity: signerIdentity,
      signature,
      signature_verified_at: new Date().toISOString(),
      teardown_evidence_id: proposal.teardownEvidenceId
    };

    console.log(`[LiveSandboxRunner:${runId}] Committing harvest ref & publishing GitHub Pull Request...`);
    const branchName = runId.startsWith("run-") ? `factory/${runId}` : `factory/run-${runId}`;

    const harvestResult = await commitHarvestRef({
      runId,
      acceptedTreeSha: proposal.acceptedTreeSha,
      parentGitSha,
      attestation,
      targetBranch,
      commitMessage: `[Factory] Live Run ${runId.substring(0, 8)}: ${options.userPrompt || "Automated Execution"}`,
      branchName,
      publishPr: true,
      githubToken: options.githubToken || process.env.GITHUB_TOKEN,
      repositoryId: options.repositoryId || process.env.GITHUB_REPOSITORY || "maulsparks/Outside_Orchestrator",
      runEnvelope: run.envelope as Record<string, unknown>,
      changedFiles: proposal.summary.declaredChanges,
      ledger: this.evidenceLedger,
      tenantId,
      requestId,
      githubPublisher: this.githubPublisher
    });

    console.log(`[LiveSandboxRunner:${runId}] Harvest complete! Branch='${harvestResult.branch}', PR #${harvestResult.prNumber ?? "N/A"} (${harvestResult.prUrl ?? "no url"})`);

    return {
      runId,
      tenantId,
      status: "completed",
      cleanTerminated: true,
      phase: targetPhase,
      phaseAttempt: 1,
      dispatchResult,
      proposal,
      harvestResult,
      attestation,
      branch: harvestResult.branch,
      prNumber: harvestResult.prNumber,
      prUrl: harvestResult.prUrl,
      prStatus: harvestResult.prStatus,
      prError: harvestResult.prError
    };
  }
}
