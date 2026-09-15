import crypto from "node:crypto";
import { assertV1DelegationPolicy, DelegationEnvelope } from "./delegation.js";
import { canonicalizeJson } from "../warden/canonicalizer.js";
import { FactoryRunRecord } from "./stateMachine.js";
import { SupabaseRestClient } from "../adapters/supabase/client.js";
import type { Phase as FactoryExecutionPhase } from "../../contracts/interfaces.js";

export interface BuildDelegationOptions {
  run: FactoryRunRecord;
  phase: FactoryExecutionPhase;
  phaseAttempt?: number;
  taskEnvelopeHash: string;
  agentsMdSha256: string;
  userPrompt?: string;
  maxFixLoops?: number;
  executionKind?: "agent" | "code";
  deterministicCommand?: string;
  allowedPaths: string[];
  immutablePaths: string[];
  acceptanceCriteria: string[];
  commandPolicyId: string;
  runtimeCredentialReference: string;
  resourceLimits?: {
    cpu_millis?: number;
    memory_mb?: number;
    wall_time_seconds?: number;
    output_bytes?: number;
  };
  ttlSeconds?: number;
}

export interface DispatchResult {
  envelope: DelegationEnvelope;
  envelopeHash: string;
}

export interface PhaseEnvelopeRecord {
  id?: string;
  run_id: string;
  tenant_id: string;
  phase: string;
  attempt: number;
  schema_version: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown> | null;
  envelope_hash: string;
  created_at?: string;
}

export interface PhaseEnvelopeStore {
  recordPhaseEnvelope(params: {
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    inputs: Record<string, unknown>;
    envelopeHash: string;
  }): Promise<void>;
  recordPhaseOutputs(params: {
    runId: string;
    phase: string;
    attempt: number;
    outputs: Record<string, unknown>;
  }): Promise<void>;
  listPhaseEnvelopes(runId: string): Promise<PhaseEnvelopeRecord[]>;
}

export class SupabasePhaseEnvelopeStore implements PhaseEnvelopeStore {
  private readonly client: SupabaseRestClient;

  constructor(client: SupabaseRestClient) {
    this.client = client;
  }

  async recordPhaseEnvelope(params: {
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    inputs: Record<string, unknown>;
    envelopeHash: string;
  }): Promise<void> {
    await this.client.insert("phase_envelopes", {
      run_id: params.runId,
      tenant_id: params.tenantId,
      phase: params.phase,
      attempt: params.attempt,
      schema_version: "v1",
      inputs: params.inputs,
      envelope_hash: params.envelopeHash
    });
  }

  async recordPhaseOutputs(params: {
    runId: string;
    phase: string;
    attempt: number;
    outputs: Record<string, unknown>;
  }): Promise<void> {
    await this.client.update(
      "phase_envelopes",
      {
        run_id: params.runId,
        phase: params.phase,
        attempt: params.attempt
      },
      {
        outputs: params.outputs
      }
    );
  }

  async listPhaseEnvelopes(runId: string): Promise<PhaseEnvelopeRecord[]> {
    const rows = await this.client.select<Record<string, unknown>>("phase_envelopes", {
      eq: { run_id: runId },
      order: "created_at.asc"
    });
    return rows.map((r) => ({
      id: String(r.id),
      run_id: String(r.run_id),
      tenant_id: String(r.tenant_id),
      phase: String(r.phase),
      attempt: Number(r.attempt),
      schema_version: String(r.schema_version ?? "v1"),
      inputs: (r.inputs as Record<string, unknown>) ?? {},
      outputs: (r.outputs as Record<string, unknown>) ?? null,
      envelope_hash: String(r.envelope_hash),
      created_at: r.created_at ? String(r.created_at) : undefined
    }));
  }
}

export class InMemoryPhaseEnvelopeStore implements PhaseEnvelopeStore {
  readonly envelopes: Array<{
    id?: string;
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    schemaVersion?: string;
    inputs: Record<string, unknown>;
    outputs?: Record<string, unknown> | null;
    envelopeHash: string;
    createdAt?: string;
  }> = [];

  async recordPhaseEnvelope(params: {
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    inputs: Record<string, unknown>;
    envelopeHash: string;
  }): Promise<void> {
    this.envelopes.push({
      runId: params.runId,
      tenantId: params.tenantId,
      phase: params.phase,
      attempt: params.attempt,
      inputs: params.inputs,
      outputs: null,
      envelopeHash: params.envelopeHash,
      createdAt: new Date().toISOString()
    });
  }

  async recordPhaseOutputs(params: {
    runId: string;
    phase: string;
    attempt: number;
    outputs: Record<string, unknown>;
  }): Promise<void> {
    const env = this.envelopes.find(
      (e) => e.runId === params.runId && e.phase === params.phase && e.attempt === params.attempt
    );
    if (env) {
      env.outputs = params.outputs;
    }
  }

  async listPhaseEnvelopes(runId: string): Promise<PhaseEnvelopeRecord[]> {
    return this.envelopes
      .filter((e) => e.runId === runId)
      .map((e) => ({
        id: e.id,
        run_id: e.runId,
        tenant_id: e.tenantId,
        phase: e.phase,
        attempt: e.attempt,
        schema_version: e.schemaVersion ?? "v1",
        inputs: e.inputs,
        outputs: e.outputs ?? null,
        envelope_hash: e.envelopeHash,
        created_at: e.createdAt
      }));
  }
}

/**
 * Single-Phase "Isolated" Delegation Broker & Dispatcher (ISSUE-13 / AC 20)
 * Builds, verifies, hashes, and records single-phase isolated delegation envelopes.
 */
export class DelegationDispatcher {
  private readonly store?: PhaseEnvelopeStore;

  constructor(store?: PhaseEnvelopeStore) {
    this.store = store;
  }

  /**
   * Constructs and verifies a single-phase isolated delegation envelope.
   */
  async buildAndDispatchEnvelope(options: BuildDelegationOptions): Promise<DispatchResult> {
    const attempt = options.phaseAttempt ?? 1;
    const ttlSeconds = options.ttlSeconds ?? 3600;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const envelope: DelegationEnvelope = {
      run_id: options.run.id,
      tenant_id: options.run.tenant_id,
      phase: options.phase,
      phase_attempt: attempt,
      schema_version: "v1",
      policy_version: options.run.policy_version,
      parent_git_sha: options.run.parent_git_sha,
      task_envelope_hash: options.taskEnvelopeHash,
      agents_md_sha256: options.agentsMdSha256,
      user_prompt: options.userPrompt,
      max_fix_loops: options.maxFixLoops ?? 3,
      execution_kind: options.executionKind ?? (options.phase === "test" ? "code" : "agent"),
      deterministic_command: options.deterministicCommand ?? (options.executionKind === "code" || options.phase === "test" ? "npm test" : undefined),
      allowed_paths: options.allowedPaths,
      immutable_paths: options.immutablePaths,
      acceptance_criteria: options.acceptanceCriteria,
      command_policy_id: options.commandPolicyId,
      network_policy: "isolated", // v1 invariant: isolated only
      resource_limits: {
        cpu_millis: options.resourceLimits?.cpu_millis ?? 2000,
        memory_mb: options.resourceLimits?.memory_mb ?? 4096,
        wall_time_seconds: options.resourceLimits?.wall_time_seconds ?? ttlSeconds,
        output_bytes: options.resourceLimits?.output_bytes ?? 10 * 1024 * 1024 // 10MB
      },
      runtime_credential_reference: options.runtimeCredentialReference,
      expires_at: expiresAt
    };

    // 1. Assert strict v1 isolated policy
    assertV1DelegationPolicy(envelope);

    // 2. Canonicalize and hash the envelope
    const canonical = canonicalizeJson(envelope);
    const envelopeHash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");

    // 3. Record in phase_envelopes store if configured
    if (this.store) {
      await this.store.recordPhaseEnvelope({
        runId: options.run.id,
        tenantId: options.run.tenant_id,
        phase: options.phase,
        attempt,
        inputs: envelope as unknown as Record<string, unknown>,
        envelopeHash
      });
    }

    return {
      envelope,
      envelopeHash
    };
  }
}
