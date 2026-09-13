import { FactoryRunRecord, Phase, RunStateStore } from "../../core/stateMachine.js";
import { SupabaseRestClient } from "./client.js";

export class SupabaseRunStateStore implements RunStateStore {
  private readonly client: SupabaseRestClient;

  constructor(client: SupabaseRestClient) {
    this.client = client;
  }

  async createRun(run: FactoryRunRecord): Promise<void> {
    await this.client.insert("factory_runs", {
      id: run.id,
      tenant_id: run.tenant_id,
      request_id: run.request_id,
      idempotency_key: run.idempotency_key,
      parent_git_sha: run.parent_git_sha,
      policy_version: run.policy_version,
      phase: run.phase,
      state_version: run.state_version,
      budget: run.budget,
      envelope: run.envelope
    });
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<FactoryRunRecord | null> {
    const rows = await this.client.select<Record<string, unknown>>("factory_runs", {
      eq: { tenant_id: tenantId, idempotency_key: idempotencyKey },
      limit: 1
    });

    if (rows.length === 0) {
      return null;
    }

    const r = rows[0];
    return {
      id: String(r.id),
      tenant_id: String(r.tenant_id),
      request_id: String(r.request_id),
      idempotency_key: String(r.idempotency_key),
      parent_git_sha: String(r.parent_git_sha),
      policy_version: String(r.policy_version),
      phase: r.phase as Phase,
      state_version: Number(r.state_version),
      budget: (r.budget as Record<string, unknown>) ?? {},
      envelope: (r.envelope as Record<string, unknown>) ?? {},
      created_at: r.created_at ? String(r.created_at) : undefined,
      updated_at: r.updated_at ? String(r.updated_at) : undefined
    };
  }

  async getRun(runId: string): Promise<FactoryRunRecord | null> {
    const rows = await this.client.select<Record<string, unknown>>("factory_runs", {
      eq: { id: runId },
      limit: 1
    });

    if (rows.length === 0) {
      return null;
    }

    const r = rows[0];
    return {
      id: String(r.id),
      tenant_id: String(r.tenant_id),
      request_id: String(r.request_id),
      idempotency_key: String(r.idempotency_key),
      parent_git_sha: String(r.parent_git_sha),
      policy_version: String(r.policy_version),
      phase: r.phase as Phase,
      state_version: Number(r.state_version),
      budget: (r.budget as Record<string, unknown>) ?? {},
      envelope: (r.envelope as Record<string, unknown>) ?? {},
      created_at: r.created_at ? String(r.created_at) : undefined,
      updated_at: r.updated_at ? String(r.updated_at) : undefined
    };
  }

  async compareAndSwapRun(
    runId: string,
    tenantId: string,
    expectedPhase: Phase,
    expectedStateVersion: number,
    targetPhase: Phase,
    newStateVersion: number,
    event?: { eventType: string; payload: Record<string, unknown>; sequence: number }
  ): Promise<boolean> {
    // 1. Perform CAS update on factory_runs
    const updatedRows = await this.client.update<Record<string, unknown>>(
      "factory_runs",
      {
        id: runId,
        phase: expectedPhase,
        state_version: expectedStateVersion
      },
      {
        phase: targetPhase,
        state_version: newStateVersion,
        updated_at: new Date().toISOString()
      }
    );

    if (updatedRows.length === 0) {
      // Concurrency conflict or condition mismatch
      return false;
    }

    // 2. Insert event into outbox if present
    if (event) {
      await this.client.insert("events", {
        run_id: runId,
        tenant_id: tenantId,
        event_type: event.eventType,
        sequence: event.sequence,
        payload: event.payload
      });
    }

    return true;
  }
}
