import { SupabaseRestClient } from "./client.js";
import {
  TournamentArm,
  TournamentArmStore,
  CreateArmInput,
  TournamentArmStatus,
  SelectionStatus
} from "../../core/tournament.js";

export class SupabaseTournamentArmStore implements TournamentArmStore {
  private readonly client: SupabaseRestClient;

  constructor(client: SupabaseRestClient) {
    this.client = client;
  }

  private mapRow(r: Record<string, unknown>): TournamentArm {
    return {
      id: String(r.id),
      run_id: String(r.run_id),
      tenant_id: String(r.tenant_id),
      arm_id: String(r.arm_id),
      status: (r.status as TournamentArmStatus) || "pending",
      model_id: r.model_id ? String(r.model_id) : undefined,
      tree_sha: r.tree_sha ? String(r.tree_sha) : undefined,
      cost_cents: Number(r.cost_cents || 0),
      latency_ms: Number(r.latency_ms || 0),
      selection_status: (r.selection_status as SelectionStatus) || "unselected",
      metadata: (r.metadata as Record<string, unknown>) || {},
      created_at: String(r.created_at || new Date().toISOString()),
      updated_at: String(r.updated_at || new Date().toISOString())
    };
  }

  async createArm(input: CreateArmInput): Promise<TournamentArm> {
    const payload = {
      run_id: input.run_id,
      tenant_id: input.tenant_id,
      arm_id: input.arm_id,
      status: input.status || "pending",
      model_id: input.model_id || null,
      tree_sha: input.tree_sha || null,
      cost_cents: input.cost_cents || 0,
      latency_ms: input.latency_ms || 0,
      selection_status: input.selection_status || "unselected",
      metadata: input.metadata || {}
    };

    const inserted = await this.client.insert<Record<string, unknown>>("tournament_arms", payload);
    return this.mapRow(inserted[0]);
  }

  async getArm(runId: string, armId: string): Promise<TournamentArm | null> {
    const rows = await this.client.select<Record<string, unknown>>("tournament_arms", {
      eq: { run_id: runId, arm_id: armId },
      limit: 1
    });

    if (rows.length === 0) {
      return null;
    }

    return this.mapRow(rows[0]);
  }

  async listArmsForRun(runId: string): Promise<TournamentArm[]> {
    const rows = await this.client.select<Record<string, unknown>>("tournament_arms", {
      eq: { run_id: runId },
      order: "arm_id.asc"
    });

    return rows.map((r) => this.mapRow(r));
  }

  async updateArm(
    runId: string,
    armId: string,
    updates: Partial<Omit<TournamentArm, "id" | "run_id" | "arm_id" | "created_at">>
  ): Promise<TournamentArm> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.model_id !== undefined) payload.model_id = updates.model_id;
    if (updates.tree_sha !== undefined) payload.tree_sha = updates.tree_sha;
    if (updates.cost_cents !== undefined) payload.cost_cents = updates.cost_cents;
    if (updates.latency_ms !== undefined) payload.latency_ms = updates.latency_ms;
    if (updates.selection_status !== undefined) payload.selection_status = updates.selection_status;
    if (updates.metadata !== undefined) payload.metadata = updates.metadata;

    const updatedRows = await this.client.update<Record<string, unknown>>(
      "tournament_arms",
      { run_id: runId, arm_id: armId },
      payload
    );

    if (updatedRows.length === 0) {
      throw new Error(`TournamentArmNotFound: Arm '${armId}' not found for run '${runId}'`);
    }

    return this.mapRow(updatedRows[0]);
  }

  async selectWinner(
    runId: string,
    winnerArmId: string,
    rationale?: string
  ): Promise<{ winner: TournamentArm; others: TournamentArm[] }> {
    const arms = await this.listArmsForRun(runId);
    const candidate = arms.find((a) => a.arm_id === winnerArmId);
    if (!candidate) {
      throw new Error(`TournamentArmNotFound: Winner candidate arm '${winnerArmId}' not found in run '${runId}'`);
    }

    const others: TournamentArm[] = [];
    let winner: TournamentArm = candidate;

    for (const arm of arms) {
      if (arm.arm_id === winnerArmId) {
        winner = await this.updateArm(runId, arm.arm_id, {
          selection_status: "winner",
          metadata: { ...arm.metadata, selection_rationale: rationale }
        });
      } else {
        const updatedOther = await this.updateArm(runId, arm.arm_id, {
          selection_status: "runner_up"
        });
        others.push(updatedOther);
      }
    }

    return { winner, others };
  }
}
