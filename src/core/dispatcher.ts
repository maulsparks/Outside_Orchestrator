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

export interface PhaseEnvelopeStore {
  recordPhaseEnvelope(params: {
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    inputs: Record<string, unknown>;
    envelopeHash: string;
  }): Promise<void>;
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
}

export class InMemoryPhaseEnvelopeStore implements PhaseEnvelopeStore {
  readonly envelopes: Array<{
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    inputs: Record<string, unknown>;
    envelopeHash: string;
  }> = [];

  async recordPhaseEnvelope(params: {
    runId: string;
    tenantId: string;
    phase: string;
    attempt: number;
    inputs: Record<string, unknown>;
    envelopeHash: string;
  }): Promise<void> {
    this.envelopes.push({ ...params });
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
