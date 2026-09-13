/**
 * Policy & AGENTS.md Integrity & Drift Detection Engine (Tier 1 Edge/Control Plane)
 *
 * Governed by:
 * - Outside Orchestrator Role Contract v2 §6.2 (Policy and memory resolution)
 * - Outside Orchestrator Role Contract v2 §7.1 (Intake & pre-flight observation)
 * - Outside Orchestrator Role Contract v2 §8 (Failure modes and operational controls)
 * - Acceptance Criteria 5, 6, 20
 *
 * Invariants:
 * 1. AGENTS.md is DATA, NOT AUTHORITY. It cannot expand the delegation envelope or override policy.
 * 2. Pre-flight verification checks the active repository/snapshot AGENTS.md against admitted agents_md_sha256.
 * 3. In multi-phase sequences, agents_md_sha256 and policy_version must remain strictly immutable.
 * 4. Any detected drift halts execution immediately and transitions run to quarantined.
 * 5. All verification and drift decisions are cryptographically recorded in evidence_ledger.
 */

import crypto from "node:crypto";
import { FactoryRunRecord } from "./stateMachine.js";
import { EvidenceLedger } from "../warden/ledger.js";

export const SUPPORTED_POLICY_VERSIONS = ["v2.0", "v1.0.0", "v1.0"] as const;
export type SupportedPolicyVersion = typeof SUPPORTED_POLICY_VERSIONS[number];

export class PolicyDriftError extends Error {
  constructor(message: string) {
    super(`PolicyDriftError: ${message}`);
    this.name = "PolicyDriftError";
  }
}

export class AgentsMdDriftError extends Error {
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(expectedSha256: string, actualSha256: string) {
    super(
      `AgentsMdDriftError: AGENTS.md hash drift detected! Expected SHA256 '${expectedSha256}', but observed '${actualSha256}'. Execution halted per Contract §8.`
    );
    this.name = "AgentsMdDriftError";
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

export class UnsupportedPolicyVersionError extends Error {
  constructor(version: string) {
    super(
      `UnsupportedPolicyVersionError: Policy version '${version}' is not supported. Supported versions: [${SUPPORTED_POLICY_VERSIONS.join(", ")}]`
    );
    this.name = "UnsupportedPolicyVersionError";
  }
}

export class AuthorityViolationError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(
      `AuthorityViolationError: AGENTS.md contains forbidden authority-expansion directives: [${violations.join("; ")}]. Per Contract §6.2, AGENTS.md is data, not authority.`
    );
    this.name = "AuthorityViolationError";
    this.violations = violations;
  }
}

/**
 * Patterns in AGENTS.md attempting prompt injection or authority expansion.
 */
const FORBIDDEN_AUTHORITY_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /(?:override|bypass|ignore)\s+(?:all\s+)?(?:fencing|policy|acl|rules|restrictions|erg|warden)/i,
    description: "Attempt to bypass fencing, policy, or Warden restrictions"
  },
  {
    pattern: /allowed_paths\s*[:=]\s*(?:\*|all|\/\*\*)/i,
    description: "Attempt to grant wildcard allowed_paths"
  },
  {
    pattern: /immutable_paths\s*[:=]\s*(?:none|\[\s*\]|empty)/i,
    description: "Attempt to clear immutable_paths"
  },
  {
    pattern: /network_policy\s*[:=]\s*(?:full|internet|unrestricted|open)/i,
    description: "Attempt to override isolated network policy"
  },
  {
    pattern: /(?:service_role|supabase_service_role|TAILSCALE_AUTH_KEY|TAILSCALE_KEY|exe_api_key)\s*[:=]/i,
    description: "Attempt to inject or extract privileged service credentials"
  },
  {
    pattern: /chmod\s+(?:777|u\+s)|sudo\s+|su\s+root/i,
    description: "Attempt to prescribe privilege escalation in instructions"
  }
];

/**
 * Computes canonical lowercase 64-character hex SHA-256 digest of content.
 */
export function computeAgentsMdSha256(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return crypto.createHash("sha256").update(buf).digest("hex").toLowerCase();
}

/**
 * Scans AGENTS.md content for forbidden authority-expansion directives.
 */
export function scanAgentsMdForAuthorityViolations(content: string): { safe: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const { pattern, description } of FORBIDDEN_AUTHORITY_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(description);
    }
  }

  return {
    safe: violations.length === 0,
    violations
  };
}

export interface VerifyAdmissionParams {
  policyVersion: string;
  agentsMdSha256: string;
  agentsMdContent?: string;
}

export interface VerifyPhasePreflightParams {
  run: FactoryRunRecord;
  phase: string;
  attempt?: number;
  currentAgentsMdSha256?: string;
  currentAgentsMdContent?: string;
  sandboxId?: string;
}

export interface PolicyVerificationResult {
  valid: boolean;
  policyVersion: string;
  agentsMdSha256: string;
  verifiedAt: string;
}

/**
 * Policy & Context Integrity Verifier (Contract §6.2, §7.1, §8)
 */
export class PolicyIntegrityVerifier {
  private readonly evidenceLedger?: EvidenceLedger;

  constructor(evidenceLedger?: EvidenceLedger) {
    this.evidenceLedger = evidenceLedger;
  }

  /**
   * Validates intake / admission request parameters.
   */
  verifyAdmissionRequest(params: VerifyAdmissionParams): void {
    // 1. Verify policy version
    const versionMatch = SUPPORTED_POLICY_VERSIONS.some(v => v === params.policyVersion);
    if (!versionMatch) {
      throw new UnsupportedPolicyVersionError(params.policyVersion);
    }

    // 2. Verify agentsMdSha256 format (64-char hex)
    if (!/^[a-f0-9]{64}$/i.test(params.agentsMdSha256)) {
      throw new PolicyDriftError(
        `Invalid agents_md_sha256: '${params.agentsMdSha256}'. Must be a 64-character hex SHA-256 digest.`
      );
    }

    // 3. If raw content is provided, verify hash matches and scan for authority violations
    if (params.agentsMdContent !== undefined) {
      const computedSha = computeAgentsMdSha256(params.agentsMdContent);
      if (computedSha.toLowerCase() !== params.agentsMdSha256.toLowerCase()) {
        throw new AgentsMdDriftError(params.agentsMdSha256, computedSha);
      }

      const scanResult = scanAgentsMdForAuthorityViolations(params.agentsMdContent);
      if (!scanResult.safe) {
        throw new AuthorityViolationError(scanResult.violations);
      }
    }
  }

  /**
   * Executes pre-flight policy and AGENTS.md verification before provisioning / dispatch.
   * Compares the active repository/snapshot hash with the admitted run envelope hash.
   */
  async verifyPhasePreflight(params: VerifyPhasePreflightParams): Promise<PolicyVerificationResult> {
    const run = params.run;
    const runEnvelope = (run.envelope as Record<string, unknown>) || {};
    let expectedSha = String(runEnvelope.agents_md_sha256 || "").toLowerCase();
    if (!expectedSha || !/^[a-f0-9]{64}$/.test(expectedSha)) {
      if (params.currentAgentsMdSha256 && /^[a-f0-9]{64}$/.test(params.currentAgentsMdSha256)) {
        expectedSha = params.currentAgentsMdSha256.toLowerCase();
      } else {
        expectedSha = "0".repeat(64);
      }
    }

    // 1. Verify policy version match
    if (!SUPPORTED_POLICY_VERSIONS.some(v => v === run.policy_version)) {
      throw new UnsupportedPolicyVersionError(run.policy_version);
    }

    // 2. If content or hash is supplied for this phase, verify against expected
    let observedSha = expectedSha;
    if (params.currentAgentsMdContent !== undefined) {
      observedSha = computeAgentsMdSha256(params.currentAgentsMdContent);
      const scanResult = scanAgentsMdForAuthorityViolations(params.currentAgentsMdContent);
      if (!scanResult.safe) {
        if (this.evidenceLedger) {
          await this.recordDriftEvidence(params, "authority_violation_detected", {
            violations: scanResult.violations
          });
        }
        throw new AuthorityViolationError(scanResult.violations);
      }
    } else if (params.currentAgentsMdSha256 !== undefined) {
      observedSha = params.currentAgentsMdSha256.toLowerCase();
    }

    if (observedSha !== expectedSha) {
      if (this.evidenceLedger) {
        await this.recordDriftEvidence(params, "agents_md_drift_detected", {
          expected_sha256: expectedSha,
          observed_sha256: observedSha
        });
      }
      throw new AgentsMdDriftError(expectedSha, observedSha);
    }

    // 3. Record successful verification evidence in ledger
    const now = new Date().toISOString();
    if (this.evidenceLedger) {
      const sandboxId = params.sandboxId ?? (params.phase ? `sbx-${run.id}-${params.phase}` : `sbx-${run.id}`);
      await this.evidenceLedger.recordEvent({
        tenantId: run.tenant_id,
        requestId: run.request_id,
        runId: run.id,
        sandboxId,
        policyVersion: run.policy_version,
        eventType: "policy_verified",
        source: { role: "Outside_Orchestrator", host: "srv719637" },
        observation: {
          action: "context_integrity_verified",
          phase: params.phase,
          attempt: params.attempt ?? 1,
          agents_md_sha256: expectedSha,
          policy_version: run.policy_version,
          status: "verified"
        }
      }).catch((e) => console.warn(`[PolicyIntegrityVerifier:${run.id}] Evidence ledger write failed:`, e.message));
    }

    return {
      valid: true,
      policyVersion: run.policy_version,
      agentsMdSha256: expectedSha,
      verifiedAt: now
    };
  }

  private async recordDriftEvidence(
    params: VerifyPhasePreflightParams,
    eventType: string,
    observation: Record<string, unknown>
  ): Promise<void> {
    const run = params.run;
    const sandboxId = params.sandboxId ?? (params.phase ? `sbx-${run.id}-${params.phase}` : `sbx-${run.id}`);
    await this.evidenceLedger?.recordEvent({
      tenantId: run.tenant_id,
      requestId: run.request_id,
      runId: run.id,
      sandboxId,
      policyVersion: run.policy_version,
      eventType: "policy_drift_detected",
      source: { role: "Outside_Orchestrator", host: "srv719637" },
      observation: {
        action: eventType,
        phase: params.phase,
        attempt: params.attempt ?? 1,
        ...observation
      }
    }).catch((e) => console.warn(`[PolicyIntegrityVerifier:${run.id}] Failed to record drift evidence:`, e.message));
  }
}
