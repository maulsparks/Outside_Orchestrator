import crypto from "node:crypto";
import { EvidenceLedger } from "../warden/ledger.js";
import { RunStateStore } from "./stateMachine.js";

export type TournamentArmStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "quarantined";

export type SelectionStatus = "unselected" | "winner" | "runner_up" | "rejected";

export interface TournamentArm {
  id: string;
  run_id: string;
  tenant_id: string;
  arm_id: string;
  status: TournamentArmStatus;
  model_id?: string;
  tree_sha?: string;
  cost_cents: number;
  latency_ms: number;
  selection_status: SelectionStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateArmInput {
  run_id: string;
  tenant_id: string;
  arm_id: string;
  status?: TournamentArmStatus;
  model_id?: string;
  tree_sha?: string;
  cost_cents?: number;
  latency_ms?: number;
  selection_status?: SelectionStatus;
  metadata?: Record<string, unknown>;
}

export interface TournamentArmStore {
  createArm(input: CreateArmInput): Promise<TournamentArm>;
  getArm(runId: string, armId: string): Promise<TournamentArm | null>;
  listArmsForRun(runId: string): Promise<TournamentArm[]>;
  updateArm(
    runId: string,
    armId: string,
    updates: Partial<Omit<TournamentArm, "id" | "run_id" | "arm_id" | "created_at">>
  ): Promise<TournamentArm>;
  selectWinner(
    runId: string,
    winnerArmId: string,
    rationale?: string
  ): Promise<{ winner: TournamentArm; others: TournamentArm[] }>;
}

/**
 * In-memory tournament arm store for isolated testing and local runs.
 * Enforces strict isolation: arms cannot overwrite each other (AC 9).
 */
export class InMemoryTournamentArmStore implements TournamentArmStore {
  private readonly arms = new Map<string, TournamentArm>();

  private makeKey(runId: string, armId: string): string {
    return `${runId}:${armId}`;
  }

  async createArm(input: CreateArmInput): Promise<TournamentArm> {
    const key = this.makeKey(input.run_id, input.arm_id);
    if (this.arms.has(key)) {
      throw new Error(`TournamentArmConflict: Arm '${input.arm_id}' already exists for run '${input.run_id}'`);
    }

    const now = new Date().toISOString();
    const arm: TournamentArm = {
      id: crypto.randomUUID(),
      run_id: input.run_id,
      tenant_id: input.tenant_id,
      arm_id: input.arm_id,
      status: input.status ?? "pending",
      model_id: input.model_id,
      tree_sha: input.tree_sha,
      cost_cents: input.cost_cents ?? 0,
      latency_ms: input.latency_ms ?? 0,
      selection_status: input.selection_status ?? "unselected",
      metadata: input.metadata ?? {},
      created_at: now,
      updated_at: now
    };

    this.arms.set(key, arm);
    return { ...arm };
  }

  async getArm(runId: string, armId: string): Promise<TournamentArm | null> {
    const key = this.makeKey(runId, armId);
    const arm = this.arms.get(key);
    return arm ? { ...arm } : null;
  }

  async listArmsForRun(runId: string): Promise<TournamentArm[]> {
    const results: TournamentArm[] = [];
    for (const arm of this.arms.values()) {
      if (arm.run_id === runId) {
        results.push({ ...arm });
      }
    }
    return results.sort((a, b) => a.arm_id.localeCompare(b.arm_id));
  }

  async updateArm(
    runId: string,
    armId: string,
    updates: Partial<Omit<TournamentArm, "id" | "run_id" | "arm_id" | "created_at">>
  ): Promise<TournamentArm> {
    const key = this.makeKey(runId, armId);
    const existing = this.arms.get(key);
    if (!existing) {
      throw new Error(`TournamentArmNotFound: Arm '${armId}' not found for run '${runId}'`);
    }

    const updated: TournamentArm = {
      ...existing,
      ...updates,
      metadata: updates.metadata ? { ...existing.metadata, ...updates.metadata } : existing.metadata,
      updated_at: new Date().toISOString()
    };

    this.arms.set(key, updated);
    return { ...updated };
  }

  async selectWinner(
    runId: string,
    winnerArmId: string,
    rationale?: string
  ): Promise<{ winner: TournamentArm; others: TournamentArm[] }> {
    const allArms = await this.listArmsForRun(runId);
    const winner = allArms.find((a) => a.arm_id === winnerArmId);
    if (!winner) {
      throw new Error(`TournamentArmNotFound: Winner candidate arm '${winnerArmId}' not found in run '${runId}'`);
    }

    const others: TournamentArm[] = [];
    for (const arm of allArms) {
      if (arm.arm_id === winnerArmId) {
        const updatedWinner = await this.updateArm(runId, arm.arm_id, {
          selection_status: "winner",
          metadata: { ...arm.metadata, selection_rationale: rationale }
        });
        Object.assign(winner, updatedWinner);
      } else {
        const updatedOther = await this.updateArm(runId, arm.arm_id, {
          selection_status: "runner_up"
        });
        others.push(updatedOther);
      }
    }

    return { winner: { ...winner }, others };
  }
}

export interface ArbitrationWeights {
  cost?: number;    // Default 0.4
  latency?: number; // Default 0.3
  quality?: number; // Default 0.2 (test pass rate / score)
  churn?: number;   // Default 0.1 (number of declared touched files)
}

export type FallbackTrigger =
  | "worker_unavailable"
  | "timeout"
  | "execution_failed"
  | "gate_failed";

export interface ModelFallbackPolicy {
  fallbackChain: string[];
  triggers: FallbackTrigger[];
  maxRetriesPerArm: number;
  maxCostCentsPerArm?: number;
}

export interface ArbitrationPolicy {
  strategy?: "lowest_cost" | "fastest_latency" | "pareto_optimal" | "weighted_composite" | "manual";
  weights?: ArbitrationWeights;
  requireCleanTerminated?: boolean;
  requireErgPass?: boolean;
  requireTestPass?: boolean;
  fallbackPolicy?: ModelFallbackPolicy;
}

export interface ArmEvaluationMetrics {
  costCents: number;
  latencyMs: number;
  qualityScore: number;
  churnFiles: number;
}

export interface ArmEvaluationResult {
  arm: TournamentArm;
  eligible: boolean;
  score: number;
  rank: number;
  isParetoOptimal: boolean;
  dominatedBy: string[];
  utilityScore: number;
  metrics: ArmEvaluationMetrics;
  reasons: string[];
}

export interface ModelFallbackResult {
  nextModel: string | null;
  canFallback: boolean;
  reason: string;
}

/**
 * Resolves next model in an automated fallback chain when an arm encounters failures.
 */
export function resolveModelFallback(
  currentModel: string,
  trigger: FallbackTrigger,
  policy: ModelFallbackPolicy,
  currentAttempt: number = 1
): ModelFallbackResult {
  if (!policy.triggers.includes(trigger)) {
    return {
      nextModel: null,
      canFallback: false,
      reason: `Trigger '${trigger}' is not configured in fallback triggers: [${policy.triggers.join(", ")}]`
    };
  }

  if (currentAttempt > policy.maxRetriesPerArm) {
    return {
      nextModel: null,
      canFallback: false,
      reason: `Max retries per arm reached (${currentAttempt} > ${policy.maxRetriesPerArm})`
    };
  }

  const idx = policy.fallbackChain.indexOf(currentModel);
  if (idx === -1) {
    if (policy.fallbackChain.length > 0) {
      return {
        nextModel: policy.fallbackChain[0],
        canFallback: true,
        reason: `Current model '${currentModel}' not in chain; selecting primary fallback '${policy.fallbackChain[0]}'`
      };
    }
    return { nextModel: null, canFallback: false, reason: "Fallback chain is empty" };
  }

  if (idx + 1 < policy.fallbackChain.length) {
    const next = policy.fallbackChain[idx + 1];
    return {
      nextModel: next,
      canFallback: true,
      reason: `Advancing from '${currentModel}' to fallback '${next}' in chain`
    };
  }

  return {
    nextModel: null,
    canFallback: false,
    reason: `Fallback chain exhausted for '${currentModel}' (chain length: ${policy.fallbackChain.length})`
  };
}

export interface SelectTournamentWinnerParams {
  runId: string;
  winnerArmId: string;
  rationale: string;
  reviewerIdentity?: string;
  armStore: TournamentArmStore;
  ledger?: EvidenceLedger;
  runStore?: RunStateStore;
  tenantId?: string;
  requestId?: string;
  policyVersion?: string;
}

/**
 * Tournament Arbitrator (Contract §4, §6.8, §9 & §10 AC 9).
 * Arbitrates Best-of-N executions, evaluates comparative metrics across arms,
 * computes Pareto-optimal frontiers, and coordinates deliberate winner selection.
 */
export class TournamentArbitrator {
  constructor(private readonly armStore: TournamentArmStore) {}

  /**
   * Evaluates all arms for a run against arbitration policy.
   * Computes Pareto-optimal frontier, multi-criteria dominance, and utility rankings.
   */
  evaluateArms(arms: TournamentArm[], policy?: ArbitrationPolicy): ArmEvaluationResult[] {
    const strat = policy?.strategy ?? "lowest_cost";
    const requireClean = policy?.requireCleanTerminated ?? true;
    const requireErg = policy?.requireErgPass ?? true;
    const requireTest = policy?.requireTestPass ?? true;

    // 1. Initial eligibility and metric extraction
    const rawEvals = arms.map((arm) => {
      const reasons: string[] = [];
      let eligible = true;

      if (arm.status !== "completed") {
        eligible = false;
        reasons.push(`Arm is in status '${arm.status}', not 'completed'`);
      }

      if (requireClean && arm.metadata?.clean_terminated === false) {
        eligible = false;
        reasons.push("Arm failed CLEAN_TERMINATED verification");
      }

      if (requireErg && arm.metadata?.erg_passed === false) {
        eligible = false;
        reasons.push("Arm failed Effect Reconciliation Gate (ERG)");
      }

      if (requireTest && arm.metadata?.tests_passed === false) {
        eligible = false;
        reasons.push("Arm failed frozen acceptance test suite");
      }

      const qualityScore = typeof arm.metadata?.quality_score === "number"
        ? (arm.metadata.quality_score as number)
        : (arm.metadata?.tests_passed !== false ? 100 : 0);

      const churnFiles = Array.isArray(arm.metadata?.declared_changed_files)
        ? (arm.metadata.declared_changed_files as unknown[]).length
        : Number(arm.metadata?.churn_files || 0);

      const metrics: ArmEvaluationMetrics = {
        costCents: arm.cost_cents,
        latencyMs: arm.latency_ms,
        qualityScore,
        churnFiles
      };

      return {
        arm,
        eligible,
        score: 0,
        rank: 0,
        isParetoOptimal: false,
        dominatedBy: [] as string[],
        utilityScore: 0,
        metrics,
        reasons
      };
    });

    const eligibleArms = rawEvals.filter((e) => e.eligible);

    // 2. Compute Pareto Dominance among eligible arms
    for (let i = 0; i < eligibleArms.length; i++) {
      for (let j = 0; j < eligibleArms.length; j++) {
        if (i === j) continue;
        const A = eligibleArms[i];
        const B = eligibleArms[j];

        // A dominates B if A is no worse in all 4 metrics and strictly better in at least one
        const noWorse =
          A.metrics.costCents <= B.metrics.costCents &&
          A.metrics.latencyMs <= B.metrics.latencyMs &&
          A.metrics.qualityScore >= B.metrics.qualityScore &&
          A.metrics.churnFiles <= B.metrics.churnFiles;

        const strictlyBetter =
          A.metrics.costCents < B.metrics.costCents ||
          A.metrics.latencyMs < B.metrics.latencyMs ||
          A.metrics.qualityScore > B.metrics.qualityScore ||
          A.metrics.churnFiles < B.metrics.churnFiles;

        if (noWorse && strictlyBetter) {
          B.dominatedBy.push(A.arm.arm_id);
        }
      }
    }

    for (const item of eligibleArms) {
      item.isParetoOptimal = item.dominatedBy.length === 0;
    }

    // 3. Compute Min-Max Normalized Utility Scores
    if (eligibleArms.length > 0) {
      const minCost = Math.min(...eligibleArms.map((e) => e.metrics.costCents));
      const maxCost = Math.max(...eligibleArms.map((e) => e.metrics.costCents));
      const minLat = Math.min(...eligibleArms.map((e) => e.metrics.latencyMs));
      const maxLat = Math.max(...eligibleArms.map((e) => e.metrics.latencyMs));
      const minQual = Math.min(...eligibleArms.map((e) => e.metrics.qualityScore));
      const maxQual = Math.max(...eligibleArms.map((e) => e.metrics.qualityScore));
      const minChurn = Math.min(...eligibleArms.map((e) => e.metrics.churnFiles));
      const maxChurn = Math.max(...eligibleArms.map((e) => e.metrics.churnFiles));

      const wCost = policy?.weights?.cost ?? 0.4;
      const wLat = policy?.weights?.latency ?? 0.3;
      const wQual = policy?.weights?.quality ?? 0.2;
      const wChurn = policy?.weights?.churn ?? 0.1;
      const totalWeight = wCost + wLat + wQual + wChurn || 1.0;

      for (const item of eligibleArms) {
        const normCost = maxCost > minCost ? (maxCost - item.metrics.costCents) / (maxCost - minCost) : 1.0;
        const normLat = maxLat > minLat ? (maxLat - item.metrics.latencyMs) / (maxLat - minLat) : 1.0;
        const normQual = maxQual > minQual ? (item.metrics.qualityScore - minQual) / (maxQual - minQual) : 1.0;
        const normChurn = maxChurn > minChurn ? (maxChurn - item.metrics.churnFiles) / (maxChurn - minChurn) : 1.0;

        item.utilityScore = Math.round(
          ((wCost * normCost + wLat * normLat + wQual * normQual + wChurn * normChurn) / totalWeight) * 1000
        ) / 1000;
      }
    }

    // 4. Compute Strategy Specific Scores & Rankings
    for (const item of eligibleArms) {
      if (strat === "lowest_cost") {
        item.score = item.metrics.costCents * 10000 + item.metrics.latencyMs;
      } else if (strat === "fastest_latency") {
        item.score = item.metrics.latencyMs * 10000 + item.metrics.costCents;
      } else if (strat === "pareto_optimal") {
        // Pareto optimal arms get score bonus (higher utility ranks first)
        const paretoBonus = item.isParetoOptimal ? 10 : 0;
        item.score = -(paretoBonus + item.utilityScore);
      } else if (strat === "weighted_composite") {
        // Higher utility ranks first
        item.score = -item.utilityScore;
      } else {
        item.score = 0;
      }
    }

    // Sort eligible arms by score (ascending: lower score is better)
    eligibleArms.sort((a, b) => a.score - b.score);
    const ineligibleArms = rawEvals.filter((e) => !e.eligible);

    let currentRank = 1;
    for (const item of eligibleArms) {
      item.rank = currentRank++;
    }
    for (const item of ineligibleArms) {
      item.rank = currentRank++;
    }

    return [...eligibleArms, ...ineligibleArms];
  }

  /**
   * Deliberately selects a tournament winner, marking all others as runners-up.
   * Records signed command_observed boundary evidence in the Evidence Ledger.
   */
  async selectWinner(
    params: SelectTournamentWinnerParams
  ): Promise<{ winner: TournamentArm; others: TournamentArm[] }> {
    const arm = await params.armStore.getArm(params.runId, params.winnerArmId);
    if (!arm) {
      throw new Error(`TournamentArmNotFound: Arm '${params.winnerArmId}' not found for run '${params.runId}'`);
    }

    if (arm.status !== "completed") {
      throw new Error(
        `InvalidWinnerCandidate: Arm '${params.winnerArmId}' is in status '${arm.status}', must be 'completed' to be selected as winner`
      );
    }

    const { winner, others } = await params.armStore.selectWinner(
      params.runId,
      params.winnerArmId,
      params.rationale
    );

    // Update run metadata if runStore provided
    if (params.runStore) {
      try {
        const run = await params.runStore.getRun(params.runId);
        if (run) {
          const env = (run.envelope as Record<string, unknown>) || {};
          env.selected_tournament_arm = winner.arm_id;
          env.accepted_tree_sha = winner.tree_sha;
          env.selection_rationale = params.rationale;
        }
      } catch {
        // Non-blocking
      }
    }

    // Record signed evidence ledger event
    if (params.ledger && params.tenantId && params.requestId) {
      await params.ledger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        armId: winner.arm_id,
        sandboxId: "outside-orchestrator",
        policyVersion: params.policyVersion || "v2.0",
        eventType: "command_observed",
        source: {
          component: "tournament-arbitrator",
          signer: params.reviewerIdentity || "system:tournament-arbitrator"
        },
        observation: {
          tournament_winner_selected: true,
          arm_id: winner.arm_id,
          tree_sha: winner.tree_sha,
          model_id: winner.model_id,
          cost_cents: winner.cost_cents,
          latency_ms: winner.latency_ms,
          rationale: params.rationale,
          other_arm_count: others.length
        }
      });
    }

    return { winner, others };
  }
}
