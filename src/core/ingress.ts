import crypto from "node:crypto";
import { validateRequestShape } from "./intake.js";
import { LeaseManager } from "./leaseManager.js";
import { FactoryRunRecord, RunStateStore } from "./stateMachine.js";
import { PolicyIntegrityVerifier, computeAgentsMdSha256 } from "./policyIntegrity.js";

export interface CreateRunRequest {
  requestId?: string;
  idempotencyKey: string;
  tenantId: string;
  repositoryId: string;
  parentGitSha: string;
  intent: string;
  userPrompt?: string;
  maxFixLoops?: number;
  executionKind?: "agent" | "code";
  deterministicCommand?: string;
  acceptanceCriteria: string[];
  policyVersion: string;
  agentsMdSha256?: string;
  agentsMdContent?: string;
  budgetCents: number;
}

export interface IngressRunRepository extends RunStateStore {
  createRun(run: FactoryRunRecord): Promise<void>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<FactoryRunRecord | null>;
}

export interface AdmissionResult {
  isExisting: boolean;
  run: FactoryRunRecord;
  lease?: {
    fencingToken: number;
    expiresAt: Date;
  };
}

/**
 * Request Admission Engine (ISSUE-12 / AC 1)
 * Validates request schema, enforces idempotency keys, and initial lease acquisition.
 */
export class RequestAdmissionEngine {
  private readonly runsRepo: IngressRunRepository;
  private readonly leaseManager: LeaseManager;
  private readonly policyVerifier: PolicyIntegrityVerifier;

  constructor(runsRepo: IngressRunRepository, leaseManager: LeaseManager, policyVerifier?: PolicyIntegrityVerifier) {
    this.runsRepo = runsRepo;
    this.leaseManager = leaseManager;
    this.policyVerifier = policyVerifier ?? new PolicyIntegrityVerifier();
  }

  /**
   * Admits an incoming work request.
   * Duplicate idempotency keys return existing run without creating untracked duplicates.
   */
  async admitRequest(req: CreateRunRequest): Promise<AdmissionResult> {
    const requestId = req.requestId ?? `req-${crypto.randomUUID()}`;

    // Resolve or compute agentsMdSha256
    let agentsMdSha256 = req.agentsMdSha256;
    if (!agentsMdSha256 && req.agentsMdContent !== undefined) {
      agentsMdSha256 = computeAgentsMdSha256(req.agentsMdContent);
    }
    if (!agentsMdSha256) {
      agentsMdSha256 = "0".repeat(64);
    }

    // 1. Verify policy version, format, and check for authority violations
    this.policyVerifier.verifyAdmissionRequest({
      policyVersion: req.policyVersion,
      agentsMdSha256,
      agentsMdContent: req.agentsMdContent
    });

    const userPrompt = req.userPrompt;
    const maxFixLoops = req.maxFixLoops ?? 3;
    const executionKind = req.executionKind ?? "agent";
    const deterministicCommand = req.deterministicCommand;
    const intent = req.intent || (userPrompt ? userPrompt.trim().split("\n")[0].slice(0, 100) : "execute");

    // 2. Validate request shape according to intake contract
    validateRequestShape({
      request_id: requestId,
      idempotency_key: req.idempotencyKey,
      tenant_id: req.tenantId,
      repository_id: req.repositoryId,
      parent_git_sha: req.parentGitSha,
      intent,
      user_prompt: userPrompt,
      max_fix_loops: maxFixLoops,
      execution_kind: executionKind,
      deterministic_command: deterministicCommand,
      acceptance_criteria: req.acceptanceCriteria,
      policy_version: req.policyVersion,
      agents_md_sha256: agentsMdSha256,
      budget_cents: req.budgetCents
    });

    // 2. Check for duplicate idempotency key
    const existing = await this.runsRepo.findByIdempotencyKey(req.tenantId, req.idempotencyKey);
    if (existing) {
      return {
        isExisting: true,
        run: existing
      };
    }

    // 3. Create fresh run
    const runId = crypto.randomUUID();
    const run: FactoryRunRecord = {
      id: runId,
      tenant_id: req.tenantId,
      request_id: requestId,
      idempotency_key: req.idempotencyKey,
      parent_git_sha: req.parentGitSha,
      policy_version: req.policyVersion,
      phase: "created",
      state_version: 1,
      budget: { max_cost_cents: req.budgetCents },
      envelope: {
        intent,
        user_prompt: userPrompt,
        max_fix_loops: maxFixLoops,
        execution_kind: executionKind,
        deterministic_command: deterministicCommand,
        acceptance_criteria: req.acceptanceCriteria,
        repository_id: req.repositoryId,
        agents_md_sha256: agentsMdSha256
      }
    };

    await this.runsRepo.createRun(run);

    // 4. Acquire initial lease
    const lease = await this.leaseManager.acquireLease(runId, req.tenantId, 900000); // 15 minutes

    return {
      isExisting: false,
      run,
      lease
    };
  }
}
