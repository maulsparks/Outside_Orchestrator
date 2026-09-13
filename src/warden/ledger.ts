import { SupabaseRestClient } from "../adapters/supabase/client.js";
import {
  computeEventHash,
  computePayloadSha256,
  createSignedBoundaryEvent,
  verifyBoundaryEvent
} from "./signer.js";
import { canonicalizeJson } from "./canonicalizer.js";

export interface EvidenceRecord {
  id?: string;
  run_id: string;
  tenant_id: string;
  sandbox_id?: string;
  sequence: number;
  previous_event_hash: string;
  event_hash: string;
  payload_sha256: string;
  key_id: string;
  signature: string;
  payload: Record<string, unknown>;
  recorded_at?: string;
}

export interface EvidenceStore {
  getChainHead(runId: string): Promise<EvidenceRecord | null>;
  append(record: EvidenceRecord): Promise<void>;
  getAllForRun(runId: string): Promise<EvidenceRecord[]>;
}

export class SupabaseEvidenceStore implements EvidenceStore {
  private readonly client: SupabaseRestClient;

  constructor(client: SupabaseRestClient) {
    this.client = client;
  }

  async getChainHead(runId: string): Promise<EvidenceRecord | null> {
    const rows = await this.client.select<Record<string, unknown>>("evidence_ledger", {
      eq: { run_id: runId },
      order: "sequence.desc",
      limit: 1
    });

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: String(r.id),
      run_id: String(r.run_id),
      tenant_id: String(r.tenant_id),
      sandbox_id: r.sandbox_id ? String(r.sandbox_id) : undefined,
      sequence: Number(r.sequence),
      previous_event_hash: String(r.previous_event_hash),
      event_hash: String(r.event_hash),
      payload_sha256: String(r.payload_sha256),
      key_id: String(r.key_id),
      signature: String(r.signature),
      payload: (r.payload as Record<string, unknown>) ?? {},
      recorded_at: r.recorded_at ? String(r.recorded_at) : undefined
    };
  }

  async append(record: EvidenceRecord): Promise<void> {
    await this.client.insert("evidence_ledger", {
      run_id: record.run_id,
      tenant_id: record.tenant_id,
      sandbox_id: record.sandbox_id,
      sequence: record.sequence,
      previous_event_hash: record.previous_event_hash,
      event_hash: record.event_hash,
      payload_sha256: record.payload_sha256,
      key_id: record.key_id,
      signature: record.signature,
      payload: record.payload
    });
  }

  async getAllForRun(runId: string): Promise<EvidenceRecord[]> {
    const rows = await this.client.select<Record<string, unknown>>("evidence_ledger", {
      eq: { run_id: runId },
      order: "sequence.asc"
    });

    return rows.map((r) => ({
      id: String(r.id),
      run_id: String(r.run_id),
      tenant_id: String(r.tenant_id),
      sandbox_id: r.sandbox_id ? String(r.sandbox_id) : undefined,
      sequence: Number(r.sequence),
      previous_event_hash: String(r.previous_event_hash),
      event_hash: String(r.event_hash),
      payload_sha256: String(r.payload_sha256),
      key_id: String(r.key_id),
      signature: String(r.signature),
      payload: (r.payload as Record<string, unknown>) ?? {},
      recorded_at: r.recorded_at ? String(r.recorded_at) : undefined
    }));
  }
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly records: EvidenceRecord[] = [];

  async getChainHead(runId: string): Promise<EvidenceRecord | null> {
    const forRun = this.records
      .filter((r) => r.run_id === runId)
      .sort((a, b) => b.sequence - a.sequence);
    return forRun[0] ? { ...forRun[0] } : null;
  }

  async append(record: EvidenceRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async getAllForRun(runId: string): Promise<EvidenceRecord[]> {
    return this.records
      .filter((r) => r.run_id === runId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((r) => ({ ...r }));
  }

  tamperRecord(runId: string, sequence: number, mutate: (record: EvidenceRecord) => void): void {
    const rec = this.records.find((r) => r.run_id === runId && r.sequence === sequence);
    if (rec) {
      mutate(rec);
    }
  }
}

export interface AppendEventParams {
  tenantId: string;
  requestId: string;
  runId: string;
  armId?: string;
  sandboxId: string;
  exeVmId?: string;
  tailscaleNodeId?: string;
  tailscaleTags?: string[];
  policyVersion: string;
  eventType: string;
  source: Record<string, unknown>;
  observation: Record<string, unknown>;
}

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  chainLength: number;
  chainHead?: string;
}

/**
 * Hash-Chained Boundary Evidence Ledger Adapter (ISSUE-06)
 * Enforces contiguous sequencing and cryptographic hash linking.
 */
export class EvidenceLedger {
  private readonly store: EvidenceStore;
  private readonly privateKeyPem: string;
  private readonly keyId: string;

  constructor(store: EvidenceStore, privateKeyPem: string, keyId: string = "warden-srv719637-2026") {
    this.store = store;
    this.privateKeyPem = privateKeyPem;
    this.keyId = keyId;
  }

  /**
   * Appends an observation event to the hash chain.
   */
  async recordEvent(params: AppendEventParams): Promise<EvidenceRecord> {
    const head = await this.store.getChainHead(params.runId);
    const nextSequence = head ? head.sequence + 1 : 1;
    const previousEventHash = head ? head.event_hash : "0".repeat(64);
    const observedAt = new Date().toISOString();
    const eventId = `evt_${Date.now()}_${nextSequence}`;

    const signed = createSignedBoundaryEvent(
      {
        eventId,
        sequence: nextSequence,
        eventType: params.eventType,
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        armId: params.armId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        tailscaleNodeId: params.tailscaleNodeId,
        tailscaleTags: params.tailscaleTags,
        policyVersion: params.policyVersion,
        observedAt,
        source: params.source,
        observation: params.observation,
        previousEventHash
      },
      this.privateKeyPem,
      this.keyId
    );

    const record: EvidenceRecord = {
      run_id: params.runId,
      tenant_id: params.tenantId,
      sandbox_id: params.sandboxId,
      sequence: nextSequence,
      previous_event_hash: previousEventHash,
      event_hash: signed.eventHash,
      payload_sha256: signed.payloadSha256,
      key_id: this.keyId,
      signature: signed.signature,
      payload: JSON.parse(signed.canonicalBody)
    };

    await this.store.append(record);
    return record;
  }

  /**
   * Verifies the complete cryptographic evidence chain for a run.
   */
  async verifyChain(runId: string, publicKeyPem: string): Promise<VerificationResult> {
    const records = await this.store.getAllForRun(runId);
    const errors: string[] = [];

    if (records.length === 0) {
      return { valid: true, errors: [], chainLength: 0 };
    }

    let expectedPrevHash = "0".repeat(64);
    let expectedSequence = 1;

    for (const record of records) {
      // 1. Sequence check
      if (record.sequence !== expectedSequence) {
        errors.push(
          `Sequence broken at index ${record.sequence}: expected ${expectedSequence}`
        );
      }

      // 2. Previous hash check
      if (record.previous_event_hash !== expectedPrevHash) {
        errors.push(
          `Previous hash broken at sequence ${record.sequence}: expected ${expectedPrevHash}, got ${record.previous_event_hash}`
        );
      }

      // 3. Payload SHA-256 recalculation
      const canonicalBody = canonicalizeJson(record.payload);
      const recomputedPayloadSha = computePayloadSha256(canonicalBody);
      if (recomputedPayloadSha !== record.payload_sha256) {
        errors.push(
          `Payload hash mismatch at sequence ${record.sequence}: expected ${record.payload_sha256}, got ${recomputedPayloadSha}`
        );
      }

      // 4. Event hash recalculation
      const recomputedEventHash = computeEventHash({
        runId: record.run_id,
        sandboxId: record.sandbox_id ?? "",
        sequence: record.sequence,
        previousEventHash: record.previous_event_hash,
        payloadSha256: recomputedPayloadSha
      });

      if (recomputedEventHash !== record.event_hash) {
        errors.push(
          `Event hash mismatch at sequence ${record.sequence}: expected ${record.event_hash}, got ${recomputedEventHash}`
        );
      }

      // 5. Signature verification
      const sigOk = verifyBoundaryEvent(record.event_hash, record.signature, publicKeyPem);
      if (!sigOk) {
        errors.push(`Invalid Ed25519 signature at sequence ${record.sequence}`);
      }

      expectedPrevHash = record.event_hash;
      expectedSequence++;
    }

    const last = records[records.length - 1];
    return {
      valid: errors.length === 0,
      errors,
      chainLength: records.length,
      chainHead: last ? last.event_hash : undefined
    };
  }
}
