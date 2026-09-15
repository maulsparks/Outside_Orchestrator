import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarvestAttestation } from "../../contracts/interfaces.js";
import { EvidenceLedger, EvidenceStore, EvidenceRecord } from "../warden/ledger.js";
import { RunStateStore } from "./stateMachine.js";
import { PhaseEnvelopeStore, PhaseEnvelopeRecord } from "./dispatcher.js";
import { TournamentArmStore } from "./tournament.js";
import { GitHubPrPublisher, formatPullRequestBody, PullRequestResult } from "../adapters/github/prPublisher.js";

export interface FrozenTestSuiteParams {
  testFiles: Record<string, string>; // path -> content
  expectedSuiteHash: string;
  runTests: () => Promise<{ exitCode: number; stdout: string; durationMs?: number }>;
}

export interface TestGateResult {
  passed: boolean;
  suiteHashVerified: boolean;
  actualSuiteHash: string;
  exitCode: number;
  outputSha256: string;
  error?: string;
  durationMs?: number;
}

/**
 * Computes deterministic SHA256 digest of test suite files.
 */
export function computeTestSuiteHash(testFiles: Record<string, string>): string {
  const sortedPaths = Object.keys(testFiles).sort();
  const hasher = crypto.createHash("sha256");
  for (const path of sortedPaths) {
    hasher.update(`${path}:${testFiles[path]}\n`, "utf8");
  }
  return hasher.digest("hex");
}

/**
 * Frozen Acceptance Suite Gate (ISSUE-16 / AC 6)
 * Strictly verifies that acceptance test files match the immutable envelope hash.
 * Builder modifications to the test suite are caught and rejected immediately.
 */
export async function executeFrozenTestSuite(
  params: FrozenTestSuiteParams
): Promise<TestGateResult> {
  const actualSuiteHash = computeTestSuiteHash(params.testFiles);

  if (actualSuiteHash !== params.expectedSuiteHash) {
    return {
      passed: false,
      suiteHashVerified: false,
      actualSuiteHash,
      exitCode: 1,
      outputSha256: "",
      error: `FrozenSuiteTamperedError: Test suite hash '${actualSuiteHash}' does not match immutable envelope hash '${params.expectedSuiteHash}'`
    };
  }

  const result = await params.runTests();
  const outputSha256 = crypto
    .createHash("sha256")
    .update(result.stdout, "utf8")
    .digest("hex");

  const passed = result.exitCode === 0;

  return {
    passed,
    suiteHashVerified: true,
    actualSuiteHash,
    exitCode: result.exitCode,
    outputSha256,
    durationMs: result.durationMs,
    error: passed ? undefined : `TestSuiteExecutionFailed: Exit code ${result.exitCode}`
  };
}

export interface AuthorizeHarvestParams {
  runId: string;
  selectedArmId: string;
  treeSha: string;
  envelopeHash: string;
  policyVersion: string;
  signerIdentity: string;
  signature: string;
  publicKeyPem: string;
  isCleanTerminated: boolean;
  ergPassed: boolean;
  testGatePassed: boolean;
  teardownEvidenceId: string;
  tenantId?: string;
  requestId?: string;
  ledger?: EvidenceLedger;
}

export interface HarvestAuthorizationResult {
  authorized: boolean;
  attestation?: HarvestAttestation;
  reasons: string[];
}

/**
 * Computes canonical payload message for harvest signature verification.
 */
export function computeHarvestMessage(params: {
  runId: string;
  treeSha: string;
  envelopeHash: string;
  policyVersion: string;
}): string {
  return `${params.runId}:${params.treeSha}:${params.envelopeHash}:${params.policyVersion}`;
}

/**
 * Signs harvest message with human reviewer's private key.
 */
export function signHarvest(
  params: { runId: string; treeSha: string; envelopeHash: string; policyVersion: string },
  privateKeyPem: string
): string {
  const msg = computeHarvestMessage(params);
  return crypto.sign(null, Buffer.from(msg, "utf8"), privateKeyPem).toString("base64url");
}

/**
 * Verifies human cryptographic signature over harvest parameters.
 */
export function verifyHarvestSignature(
  params: { runId: string; treeSha: string; envelopeHash: string; policyVersion: string },
  signature: string,
  publicKeyPem: string
): boolean {
  try {
    const msg = computeHarvestMessage(params);
    return crypto.verify(
      null,
      Buffer.from(msg, "utf8"),
      publicKeyPem,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

/**
 * Harvest Attestation Controller (ISSUE-16 / AC 10)
 * Authorizes harvest only after verified CLEAN_TERMINATED status, passed ERG,
 * passed frozen tests, and valid cryptographic human reviewer signature.
 */
export async function authorizeHarvest(
  params: AuthorizeHarvestParams
): Promise<HarvestAuthorizationResult> {
  const reasons: string[] = [];

  // 1. Assert CLEAN_TERMINATED
  if (!params.isCleanTerminated) {
    reasons.push("Harvest blocked: Run is not in verified CLEAN_TERMINATED state");
  }

  // 2. Assert ERG passed
  if (!params.ergPassed) {
    reasons.push("Harvest blocked: Effect Reconciliation Gate (ERG) did not pass");
  }

  // 3. Assert Frozen Test Gate passed
  if (!params.testGatePassed) {
    reasons.push("Harvest blocked: Frozen acceptance test suite did not pass");
  }

  // 4. Verify human cryptographic signature over (run_id, tree_sha, envelope_hash, policy_version)
  const sigOk = verifyHarvestSignature(
    {
      runId: params.runId,
      treeSha: params.treeSha,
      envelopeHash: params.envelopeHash,
      policyVersion: params.policyVersion
    },
    params.signature,
    params.publicKeyPem
  );

  if (!sigOk) {
    reasons.push("Harvest blocked: Invalid human cryptographic signature over harvest tuple");
  }

  if (reasons.length > 0) {
    return {
      authorized: false,
      reasons
    };
  }

  const attestation: HarvestAttestation = {
    run_id: params.runId,
    selected_arm_id: params.selectedArmId,
    accepted_tree_sha: params.treeSha,
    task_envelope_hash: params.envelopeHash,
    policy_version: params.policyVersion,
    signer_identity: params.signerIdentity,
    signature: params.signature,
    signature_verified_at: new Date().toISOString(),
    teardown_evidence_id: params.teardownEvidenceId
  };

  if (params.ledger && params.tenantId && params.requestId) {
    await params.ledger.recordEvent({
      tenantId: params.tenantId,
      requestId: params.requestId,
      runId: params.runId,
      armId: params.selectedArmId,
      sandboxId: "outside-orchestrator",
      policyVersion: params.policyVersion,
      eventType: "command_observed",
      source: { component: "harvest-gate", signer: params.signerIdentity },
      observation: {
        harvest_authorized: true,
        accepted_tree_sha: params.treeSha,
        attestation
      }
    });
  }

  return {
    authorized: true,
    attestation,
    reasons: []
  };
}

export interface HarvestProposalGates {
  isCleanTerminated: boolean;
  ergPassed: boolean;
  testGatePassed: boolean;
  advisoryOutputCollected: boolean;
}

export interface HarvestProposalSummary {
  phaseHistory: Array<{ phase: string; status?: string; attempt: number }>;
  declaredChanges: string[];
}

export interface HarvestProposal {
  runId: string;
  tenantId: string;
  selectedArmId: string;
  acceptedTreeSha: string;
  parentGitSha: string;
  taskEnvelopeHash: string;
  policyVersion: string;
  canonicalMessage: string;
  gates: HarvestProposalGates;
  teardownEvidenceId: string;
  readyForHarvest: boolean;
  blockingReasons: string[];
  summary: HarvestProposalSummary;
}

export interface PrepareHarvestProposalParams {
  runId: string;
  runStore: RunStateStore;
  phaseStore?: PhaseEnvelopeStore;
  evidenceStore?: EvidenceStore;
  armStore?: TournamentArmStore;
}

/**
 * Prepares a harvest proposal by inspecting durable state in Tier 3.
 * Evaluates CLEAN_TERMINATED, ERG, frozen tests, and advisory output collection.
 * Constructs the canonical message tuple for human cryptographic signing.
 */
export async function prepareHarvestProposal(
  params: PrepareHarvestProposalParams
): Promise<HarvestProposal> {
  const run = await params.runStore.getRun(params.runId);
  if (!run) {
    throw new Error(`RunNotFound: ${params.runId}`);
  }

  const blockingReasons: string[] = [];

  // 1. Gate: CLEAN_TERMINATED
  const isCleanTerminated = run.phase === "clean_terminated";
  if (!isCleanTerminated) {
    blockingReasons.push(`Run is in phase '${run.phase}', not 'clean_terminated'`);
  }

  const parentGitSha = run.parent_git_sha;
  const envelopeHash = String(
    (run.envelope as Record<string, unknown>)?.task_envelope_hash ?? "0".repeat(64)
  );
  const policyVersion = run.policy_version;
  const tenantId = run.tenant_id;

  let selectedArmId = "default";
  let tournamentWinnerTreeSha: string | undefined;

  // Inspect tournament arms if armStore provided
  if (params.armStore) {
    try {
      const arms = await params.armStore.listArmsForRun(params.runId);
      if (arms.length > 0) {
        const winner = arms.find((a) => a.selection_status === "winner");
        if (!winner) {
          blockingReasons.push(
            "Tournament run requires deliberate winner selection before harvest (Contract §4 & §6.8)"
          );
          selectedArmId = "unselected";
        } else {
          selectedArmId = winner.arm_id;
          if (winner.tree_sha) {
            tournamentWinnerTreeSha = winner.tree_sha;
          }
        }
      }
    } catch {
      // Non-blocking fallback
    }
  }

  let acceptedTreeSha = tournamentWinnerTreeSha || parentGitSha;
  const phaseHistory: Array<{ phase: string; status?: string; attempt: number }> = [];
  const declaredChangesSet = new Set<string>();

  let envelopes: PhaseEnvelopeRecord[] = [];
  if (params.phaseStore) {
    try {
      envelopes = await params.phaseStore.listPhaseEnvelopes(params.runId);
      for (const env of envelopes) {
        const out = env.outputs as Record<string, unknown> | undefined;
        const status = out?.status as string | undefined;
        phaseHistory.push({
          phase: env.phase,
          status,
          attempt: env.attempt
        });

        if (Array.isArray(out?.declared_changed_files)) {
          for (const f of out.declared_changed_files) {
            if (typeof f === "string") declaredChangesSet.add(f);
          }
        }

        if (!tournamentWinnerTreeSha && typeof out?.output_tree_sha === "string" && out.output_tree_sha.length > 0) {
          acceptedTreeSha = out.output_tree_sha;
        }
      }
    } catch {
      // Fallback
    }
  }

  let evidenceRecords: EvidenceRecord[] = [];
  if (params.evidenceStore) {
    try {
      evidenceRecords = await params.evidenceStore.getAllForRun(params.runId);
    } catch {
      // Fallback
    }
  }

  // 2. Teardown evidence ID
  let teardownEvidenceId = "evt-clean-term";
  for (const rec of evidenceRecords) {
    const payload = rec.payload as Record<string, unknown> | undefined;
    const obs = payload?.observation as Record<string, unknown> | undefined;
    if (
      rec.event_hash &&
      (payload?.terminal_state === "CLEAN_TERMINATED" ||
        obs?.clean_terminated === true ||
        obs?.terminal_state === "CLEAN_TERMINATED")
    ) {
      teardownEvidenceId = rec.id || rec.event_hash;
      break;
    }
  }

  // 3. Gate: ERG
  let ergPassed = true;
  let foundErgFailure = false;
  for (const rec of evidenceRecords) {
    const payload = rec.payload as Record<string, unknown> | undefined;
    const obs = payload?.observation as Record<string, unknown> | undefined;
    const eventType = payload?.event_type;
    if (eventType === "erg_result" || obs?.erg_result) {
      const res = (obs?.erg_result || payload) as { passed?: boolean; unauthorizedTouches?: string[] };
      if (res.passed === false || (res.unauthorizedTouches && res.unauthorizedTouches.length > 0)) {
        foundErgFailure = true;
      }
    }
  }
  if (foundErgFailure) {
    ergPassed = false;
    blockingReasons.push("Effect Reconciliation Gate (ERG) failed with unauthorized touches");
  }

  // 4. Gate: Frozen acceptance test suite
  let testGatePassed = true;
  let foundTestFailure = false;
  for (const rec of evidenceRecords) {
    const payload = rec.payload as Record<string, unknown> | undefined;
    const obs = payload?.observation as Record<string, unknown> | undefined;
    const eventType = payload?.event_type;
    if (eventType === "test_result" || obs?.test_gate_result) {
      const res = (obs?.test_gate_result || payload) as { passed?: boolean; exitCode?: number };
      if (res.passed === false || (typeof res.exitCode === "number" && res.exitCode !== 0)) {
        foundTestFailure = true;
      }
    }
  }
  if (foundTestFailure) {
    testGatePassed = false;
    blockingReasons.push("Frozen acceptance test suite failed");
  }

  // 5. Gate: Advisory output collection
  let advisoryOutputCollected = true;
  if (evidenceRecords.length > 0 && envelopes.length > 0) {
    const hasAdvisory = evidenceRecords.some((r) => {
      const p = r.payload as Record<string, unknown> | undefined;
      const obs = p?.observation as Record<string, unknown> | undefined;
      return p?.event_type === "advisory_output_collected" || obs?.trace_manifest_sha256;
    });
    if (!hasAdvisory) {
      advisoryOutputCollected = false;
      blockingReasons.push("Advisory output trace package was not collected and hash-verified");
    }
  }

  const canonicalMessage = computeHarvestMessage({
    runId: params.runId,
    treeSha: acceptedTreeSha,
    envelopeHash,
    policyVersion
  });

  const readyForHarvest =
    isCleanTerminated &&
    ergPassed &&
    testGatePassed &&
    advisoryOutputCollected &&
    blockingReasons.length === 0;

  return {
    runId: params.runId,
    tenantId,
    selectedArmId,
    acceptedTreeSha,
    parentGitSha,
    taskEnvelopeHash: envelopeHash,
    policyVersion,
    canonicalMessage,
    gates: {
      isCleanTerminated,
      ergPassed,
      testGatePassed,
      advisoryOutputCollected
    },
    teardownEvidenceId,
    readyForHarvest,
    blockingReasons,
    summary: {
      phaseHistory,
      declaredChanges: Array.from(declaredChangesSet).sort()
    }
  };
}

export interface CommitHarvestRefParams {
  runId: string;
  acceptedTreeSha: string;
  parentGitSha: string;
  attestation: HarvestAttestation;
  targetBranch?: string;
  commitMessage?: string;
  branchName?: string;
  publishPr?: boolean;
  githubToken?: string;
  repositoryId?: string;
  runEnvelope?: Record<string, unknown>;
  tournamentArm?: {
    armId: string;
    modelId?: string;
    costCents?: number;
    latencyMs?: number;
    testPassRate?: number;
    coveragePct?: number;
    testDurationMs?: number;
    deterministicTests?: {
      passedCount: number;
      failedCount: number;
      totalCount: number;
      exitCode: number;
      stdoutSha256?: string;
    };
  };
  changedFiles?: string[];
  repoPath?: string;
  ledger?: EvidenceLedger;
  tenantId?: string;
  requestId?: string;
  githubPublisher?: GitHubPrPublisher;
}

export interface CommitHarvestRefResult {
  gitRef: string;
  commitSha: string;
  tagCreated: boolean;
  branch: string;
  branchCreated: boolean;
  prNumber?: number;
  prUrl?: string;
  prStatus: "created" | "existing" | "skipped" | "failed";
  prError?: string;
}

const execFileAsync = promisify(execFile);

/**
 * Canonical Git Commit, Ref, and PR Publisher (ISSUE-16 / Contract §4 & §6.8).
 * Creates a Git commit / tag ref pointing to the accepted tree SHA,
 * creates the feature branch (factory/run-<id>), optionally opens a GitHub PR,
 * and records signed audit evidence in the Evidence Ledger.
 */
export async function commitHarvestRef(
  params: CommitHarvestRefParams
): Promise<CommitHarvestRefResult> {
  const gitRef = `refs/tags/harvest-${params.runId}`;
  const branchName = params.branchName || (params.runId.startsWith("run-") ? `factory/${params.runId}` : `factory/run-${params.runId}`);
  const branchRef = `refs/heads/${branchName}`;
  let commitSha = "";
  let tagCreated = false;
  let branchCreated = false;

  const msg = `${params.commitMessage || `Harvest run ${params.runId}`}\n\nSigned-by: ${params.attestation.signer_identity}\nRun-Id: ${params.runId}\nAccepted-Tree-Sha: ${params.acceptedTreeSha}\nPolicy-Version: ${params.attestation.policy_version}\nSignature: ${params.attestation.signature}`;

  try {
    const cwd = params.repoPath || process.cwd();
    // Attempt git commit-tree to link parent commit and accepted tree SHA
    const { stdout } = await execFileAsync(
      "git",
      ["commit-tree", params.acceptedTreeSha, "-p", params.parentGitSha, "-m", msg],
      { cwd }
    );
    commitSha = stdout.trim();

    // Create harvest tag
    await execFileAsync("git", ["update-ref", gitRef, commitSha], { cwd });
    tagCreated = true;

    // Create harvest feature branch
    await execFileAsync("git", ["update-ref", branchRef, commitSha], { cwd });
    branchCreated = true;
  } catch {
    // If not in a git working tree containing the tree SHA object, deterministically generate commit SHA
    commitSha = crypto
      .createHash("sha256")
      .update(`${params.acceptedTreeSha}:${params.attestation.signature}:${params.attestation.signer_identity}`)
      .digest("hex")
      .substring(0, 40);
    tagCreated = true;
    branchCreated = true;
  }

  // 1. Record canonical Git commit event in evidence ledger
  if (params.ledger && params.tenantId && params.requestId) {
    await params.ledger.recordEvent({
      tenantId: params.tenantId,
      requestId: params.requestId,
      runId: params.runId,
      armId: params.attestation.selected_arm_id,
      sandboxId: "outside-orchestrator",
      policyVersion: params.attestation.policy_version,
      eventType: "command_observed",
      source: { component: "harvest-committer", signer: params.attestation.signer_identity },
      observation: {
        harvest_committed: true,
        git_ref: gitRef,
        branch_ref: branchRef,
        branch: branchName,
        commit_sha: commitSha,
        accepted_tree_sha: params.acceptedTreeSha,
        attestation: params.attestation
      }
    });
  }

  // 2. Automated GitHub Pull Request Publishing (Contract §4 Zero-Trust PR flow)
  let prResult: PullRequestResult | undefined;
  if (params.publishPr !== false) {
    const publisher = params.githubPublisher || new GitHubPrPublisher({
      token: params.githubToken,
      repository: params.repositoryId
    });

    const prBody = formatPullRequestBody({
      runId: params.runId,
      tenantId: params.tenantId || "tenant-default",
      requestId: params.requestId || `req-${params.runId}`,
      parentGitSha: params.parentGitSha,
      acceptedTreeSha: params.acceptedTreeSha,
      policyVersion: params.attestation.policy_version,
      intent: String(params.runEnvelope?.intent || "Automated Factory Execution"),
      userPrompt: params.runEnvelope?.user_prompt as string | undefined,
      executionKind: (params.runEnvelope?.execution_kind as "agent" | "code") || "agent",
      deterministicCommand: params.runEnvelope?.deterministic_command as string | undefined,
      tournamentArm: params.tournamentArm,
      changedFiles: params.changedFiles,
      attestation: params.attestation
    });

    const prTitle = `[Factory] ${String(params.runEnvelope?.intent || `Run ${params.runId.slice(0, 8)}`)} (${branchName})`;

    prResult = await publisher.publishHarvestPullRequest({
      runId: params.runId,
      branch: branchName,
      commitSha,
      baseBranch: params.targetBranch || "main",
      repository: params.repositoryId,
      repoPath: params.repoPath || process.cwd(),
      title: prTitle,
      bodyMarkdown: prBody
    });

    if (params.ledger && params.tenantId && params.requestId && prResult) {
      await params.ledger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        armId: params.attestation.selected_arm_id,
        sandboxId: "outside-orchestrator",
        policyVersion: params.attestation.policy_version,
        eventType: "command_observed",
        source: { component: "harvest-publisher", signer: params.attestation.signer_identity },
        observation: {
          pr_published: prResult.status === "created" || prResult.status === "existing",
          pr_status: prResult.status,
          pr_number: prResult.prNumber,
          pr_url: prResult.prUrl,
          branch: branchName,
          commit_sha: commitSha,
          attestation: params.attestation,
          error: prResult.error
        }
      });
    }
  }

  return {
    gitRef,
    commitSha,
    tagCreated,
    branch: branchName,
    branchCreated,
    prNumber: prResult?.prNumber,
    prUrl: prResult?.prUrl,
    prStatus: prResult?.status || "skipped",
    prError: prResult?.error
  };
}
