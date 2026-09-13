import crypto from "node:crypto";
import { EvidenceLedger } from "./ledger.js";

export interface AdvisoryOutputPackage {
  runId: string;
  tenantId: string;
  phase: string;
  phaseAttempt: number;
  sandboxId: string;
  traceManifestSha256: string;
  traceJsonl: string;
  declaredChangedFiles: string[];
  resultStatus: "completed" | "failed";
}

export interface CollectAdvisoryParams {
  runId: string;
  tenantId: string;
  requestId: string;
  sandboxId: string;
  policyVersion: string;
  ledger: EvidenceLedger;
  fetchPackage: () => Promise<AdvisoryOutputPackage>;
}

export interface CollectedAdvisoryResult {
  verified: boolean;
  computedManifestSha256: string;
  declaredChangedFiles: string[];
  resultStatus: "completed" | "failed";
  evidenceEventHash: string;
}

/**
 * Pull-Based Advisory Output Collector & Manifest Verifier (ISSUE-07 / AC 18)
 * v1 Invariant: Sandboxes NEVER push to Warden. Warden pulls advisory outputs,
 * re-computes trace manifest SHA256, and writes signed boundary evidence.
 */
export async function collectAndVerifyAdvisoryOutput(
  params: CollectAdvisoryParams
): Promise<CollectedAdvisoryResult> {
  const pkg = await params.fetchPackage();

  if (pkg.runId !== params.runId) {
    throw new Error(`RunIdMismatchError: Package runId '${pkg.runId}' != requested '${params.runId}'`);
  }

  // Hash-verify trace manifest SHA256 against actual trace content
  const computedManifestSha256 = crypto
    .createHash("sha256")
    .update(pkg.traceJsonl, "utf8")
    .digest("hex");

  if (computedManifestSha256 !== pkg.traceManifestSha256) {
    throw new Error(
      `ManifestVerificationError: Declared manifest SHA256 '${pkg.traceManifestSha256}' does not match computed '${computedManifestSha256}'`
    );
  }

  // Record signed advisory_output_collected boundary evidence
  const evidence = await params.ledger.recordEvent({
    tenantId: params.tenantId,
    requestId: params.requestId,
    runId: params.runId,
    sandboxId: params.sandboxId,
    policyVersion: params.policyVersion,
    eventType: "advisory_output_collected",
    source: {
      collector: "warden-pull-v1",
      endpoint: `tag:factory-sandbox:${params.sandboxId}:8787`
    },
    observation: {
      phase: pkg.phase,
      phase_attempt: pkg.phaseAttempt,
      result_status: pkg.resultStatus,
      trace_manifest_sha256: computedManifestSha256,
      declared_changed_files: pkg.declaredChangedFiles,
      verified: true
    }
  });

  return {
    verified: true,
    computedManifestSha256,
    declaredChangedFiles: pkg.declaredChangedFiles,
    resultStatus: pkg.resultStatus,
    evidenceEventHash: evidence.event_hash
  };
}
