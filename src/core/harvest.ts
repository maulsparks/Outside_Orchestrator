import crypto from "node:crypto";
import { HarvestAttestation } from "../../contracts/interfaces.js";
import { EvidenceLedger } from "../warden/ledger.js";

export interface FrozenTestSuiteParams {
  testFiles: Record<string, string>; // path -> content
  expectedSuiteHash: string;
  runTests: () => Promise<{ exitCode: number; stdout: string; durationMs?: number }>;
}

export interface TestGateResult {
  passed: boolean;
  suiteHashVerified: boolean;
  actualSuiteHash: string;
  exitCode: number;
  outputSha256: string;
  error?: string;
  durationMs?: number;
}

/**
 * Computes deterministic SHA256 digest of test suite files.
 */
export function computeTestSuiteHash(testFiles: Record<string, string>): string {
  const sortedPaths = Object.keys(testFiles).sort();
  const hasher = crypto.createHash("sha256");
  for (const path of sortedPaths) {
    hasher.update(`${path}:${testFiles[path]}\n`, "utf8");
  }
  return hasher.digest("hex");
}

/**
 * Frozen Acceptance Suite Gate (ISSUE-16 / AC 6)
 * Strictly verifies that acceptance test files match the immutable envelope hash.
 * Builder modifications to the test suite are caught and rejected immediately.
 */
export async function executeFrozenTestSuite(
  params: FrozenTestSuiteParams
): Promise<TestGateResult> {
  const actualSuiteHash = computeTestSuiteHash(params.testFiles);

  if (actualSuiteHash !== params.expectedSuiteHash) {
    return {
      passed: false,
      suiteHashVerified: false,
      actualSuiteHash,
      exitCode: 1,
      outputSha256: "",
      error: `FrozenSuiteTamperedError: Test suite hash '${actualSuiteHash}' does not match immutable envelope hash '${params.expectedSuiteHash}'`
    };
  }

  const result = await params.runTests();
  const outputSha256 = crypto
    .createHash("sha256")
    .update(result.stdout, "utf8")
    .digest("hex");

  const passed = result.exitCode === 0;

  return {
    passed,
    suiteHashVerified: true,
    actualSuiteHash,
    exitCode: result.exitCode,
    outputSha256,
    durationMs: result.durationMs,
    error: passed ? undefined : `TestSuiteExecutionFailed: Exit code ${result.exitCode}`
  };
}

export interface AuthorizeHarvestParams {
  runId: string;
  selectedArmId: string;
  treeSha: string;
  envelopeHash: string;
  policyVersion: string;
  signerIdentity: string;
  signature: string;
  publicKeyPem: string;
  isCleanTerminated: boolean;
  ergPassed: boolean;
  testGatePassed: boolean;
  teardownEvidenceId: string;
  tenantId?: string;
  requestId?: string;
  ledger?: EvidenceLedger;
}

export interface HarvestAuthorizationResult {
  authorized: boolean;
  attestation?: HarvestAttestation;
  reasons: string[];
}

/**
 * Computes canonical payload message for harvest signature verification.
 */
export function computeHarvestMessage(params: {
  runId: string;
  treeSha: string;
  envelopeHash: string;
  policyVersion: string;
}): string {
  return `${params.runId}:${params.treeSha}:${params.envelopeHash}:${params.policyVersion}`;
}

/**
 * Signs harvest message with human reviewer's private key.
 */
export function signHarvest(
  params: { runId: string; treeSha: string; envelopeHash: string; policyVersion: string },
  privateKeyPem: string
): string {
  const msg = computeHarvestMessage(params);
  return crypto.sign(null, Buffer.from(msg, "utf8"), privateKeyPem).toString("base64url");
}

/**
 * Verifies human cryptographic signature over harvest parameters.
 */
export function verifyHarvestSignature(
  params: { runId: string; treeSha: string; envelopeHash: string; policyVersion: string },
  signature: string,
  publicKeyPem: string
): boolean {
  try {
    const msg = computeHarvestMessage(params);
    return crypto.verify(
      null,
      Buffer.from(msg, "utf8"),
      publicKeyPem,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

/**
 * Harvest Attestation Controller (ISSUE-16 / AC 10)
 * Authorizes harvest only after verified CLEAN_TERMINATED status, passed ERG,
 * passed frozen tests, and valid cryptographic human reviewer signature.
 */
export async function authorizeHarvest(
  params: AuthorizeHarvestParams
): Promise<HarvestAuthorizationResult> {
  const reasons: string[] = [];

  // 1. Assert CLEAN_TERMINATED
  if (!params.isCleanTerminated) {
    reasons.push("Harvest blocked: Run is not in verified CLEAN_TERMINATED state");
  }

  // 2. Assert ERG passed
  if (!params.ergPassed) {
    reasons.push("Harvest blocked: Effect Reconciliation Gate (ERG) did not pass");
  }

  // 3. Assert Frozen Test Gate passed
  if (!params.testGatePassed) {
    reasons.push("Harvest blocked: Frozen acceptance test suite did not pass");
  }

  // 4. Verify human cryptographic signature over (run_id, tree_sha, envelope_hash, policy_version)
  const sigOk = verifyHarvestSignature(
    {
      runId: params.runId,
      treeSha: params.treeSha,
      envelopeHash: params.envelopeHash,
      policyVersion: params.policyVersion
    },
    params.signature,
    params.publicKeyPem
  );

  if (!sigOk) {
    reasons.push("Harvest blocked: Invalid human cryptographic signature over harvest tuple");
  }

  if (reasons.length > 0) {
    return {
      authorized: false,
      reasons
    };
  }

  const attestation: HarvestAttestation = {
    run_id: params.runId,
    selected_arm_id: params.selectedArmId,
    accepted_tree_sha: params.treeSha,
    task_envelope_hash: params.envelopeHash,
    policy_version: params.policyVersion,
    signer_identity: params.signerIdentity,
    signature: params.signature,
    signature_verified_at: new Date().toISOString(),
    teardown_evidence_id: params.teardownEvidenceId
  };

  if (params.ledger && params.tenantId && params.requestId) {
    await params.ledger.recordEvent({
      tenantId: params.tenantId,
      requestId: params.requestId,
      runId: params.runId,
      armId: params.selectedArmId,
      sandboxId: "outside-orchestrator",
      policyVersion: params.policyVersion,
      eventType: "command_observed",
      source: { component: "harvest-gate", signer: params.signerIdentity },
      observation: {
        harvest_authorized: true,
        accepted_tree_sha: params.treeSha,
        attestation
      }
    });
  }

  return {
    authorized: true,
    attestation,
    reasons: []
  };
}
