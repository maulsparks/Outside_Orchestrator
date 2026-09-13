import crypto from "node:crypto";
import { canonicalizeJson } from "./canonicalizer.js";

export interface ComputeEventHashParams {
  runId: string;
  sandboxId: string;
  sequence: number;
  previousEventHash: string;
  payloadSha256: string;
}

export interface SignedBoundaryEventResult {
  canonicalBody: string;
  payloadSha256: string;
  eventHash: string;
  signature: string;
  signingKeyId: string;
  signatureAlgorithm: "Ed25519";
}

export interface BoundaryEventInput {
  schemaVersion?: string;
  eventId: string;
  sequence: number;
  eventType: string;
  tenantId: string;
  requestId: string;
  runId: string;
  armId?: string;
  sandboxId: string;
  exeVmId?: string;
  tailscaleNodeId?: string;
  tailscaleTags?: string[];
  policyVersion: string;
  observedAt: string;
  source: Record<string, unknown>;
  observation: Record<string, unknown>;
  previousEventHash: string;
}

/**
 * Computes SHA256 hex digest of a canonical string.
 */
export function computePayloadSha256(canonicalBody: string): string {
  return crypto.createHash("sha256").update(canonicalBody, "utf8").digest("hex");
}

/**
 * Computes the domain-separated event hash according to Warden Policy §4:
 * SHA256("warden-evidence-v1" || run_id || sandbox_id || sequence || previous_event_hash || payload_sha256)
 */
export function computeEventHash(params: ComputeEventHashParams): string {
  const preimage = [
    "warden-evidence-v1",
    params.runId,
    params.sandboxId,
    String(params.sequence),
    params.previousEventHash,
    params.payloadSha256
  ].join("||");

  return crypto.createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * Signs the event hash using Ed25519 private key. Returns base64url signature.
 */
export function signBoundaryEvent(eventHash: string, privateKeyPem: string): string {
  const data = Buffer.from(eventHash, "utf8");
  const signature = crypto.sign(null, data, privateKeyPem);
  return signature.toString("base64url");
}

/**
 * Verifies Ed25519 signature over event hash using public key.
 */
export function verifyBoundaryEvent(
  eventHash: string,
  signatureBase64Url: string,
  publicKeyPem: string
): boolean {
  try {
    const data = Buffer.from(eventHash, "utf8");
    const sigBuffer = Buffer.from(signatureBase64Url, "base64url");
    return crypto.verify(null, data, publicKeyPem, sigBuffer);
  } catch {
    return false;
  }
}

/**
 * High-level helper to construct, canonicalize, hash, and sign a Warden boundary event.
 */
export function createSignedBoundaryEvent(
  eventInput: BoundaryEventInput,
  privateKeyPem: string,
  keyId: string
): SignedBoundaryEventResult {
  const canonicalBody = canonicalizeJson({
    schema_version: eventInput.schemaVersion ?? "warden.evidence.v1",
    event_id: eventInput.eventId,
    sequence: eventInput.sequence,
    event_type: eventInput.eventType,
    tenant_id: eventInput.tenantId,
    request_id: eventInput.requestId,
    run_id: eventInput.runId,
    arm_id: eventInput.armId,
    sandbox_id: eventInput.sandboxId,
    exe_vm_id: eventInput.exeVmId,
    tailscale_node_id: eventInput.tailscaleNodeId,
    tailscale_tags: eventInput.tailscaleTags,
    policy_version: eventInput.policyVersion,
    observed_at: eventInput.observedAt,
    source: eventInput.source,
    observation: eventInput.observation,
    previous_event_hash: eventInput.previousEventHash
  });

  const payloadSha256 = computePayloadSha256(canonicalBody);
  const eventHash = computeEventHash({
    runId: eventInput.runId,
    sandboxId: eventInput.sandboxId,
    sequence: eventInput.sequence,
    previousEventHash: eventInput.previousEventHash,
    payloadSha256
  });

  const signature = signBoundaryEvent(eventHash, privateKeyPem);

  return {
    canonicalBody,
    payloadSha256,
    eventHash,
    signature,
    signingKeyId: keyId,
    signatureAlgorithm: "Ed25519"
  };
}
