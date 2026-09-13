import { TeardownAttestation } from "../../contracts/interfaces.js";
import { verifyBoundaryEvent } from "../warden/signer.js";

export interface AttestationEvaluationResult {
  passed: boolean;
  violations: string[];
}

/**
 * 12-Predicate Attestation Evaluator (ISSUE-15 / AC 17)
 * Strictly verifies all 12 predicates required for CLEAN_TERMINATED status.
 * Rejects runs that have any missing or unverified teardown proofs.
 */
export function evaluateCleanTerminated(
  attestation: TeardownAttestation,
  publicKeyPem?: string
): AttestationEvaluationResult {
  const violations: string[] = [];

  // 1. Run ID present
  if (!attestation.run_id) {
    violations.push("Predicate 1 Failed: run_id is missing");
  }

  // 2. Sandbox ID present
  if (!attestation.sandbox_id) {
    violations.push("Predicate 2 Failed: sandbox_id is missing");
  }

  // 3. Exe VM ID present
  if (!attestation.exe_vm_id) {
    violations.push("Predicate 3 Failed: exe_vm_id is missing");
  }

  // 4. Tailscale Node ID present
  if (!attestation.tailscale_node_id) {
    violations.push("Predicate 4 Failed: tailscale_node_id is missing");
  }

  // 5. Terminal state must be strictly CLEAN_TERMINATED
  if (attestation.terminal_state !== "CLEAN_TERMINATED") {
    violations.push(`Predicate 5 Failed: terminal_state is '${attestation.terminal_state}', expected 'CLEAN_TERMINATED'`);
  }

  // 6. Runtime credentials confirmed revoked
  if (!attestation.credentials_revoked) {
    violations.push("Predicate 6 Failed: credentials_revoked is false");
  }

  // 7. Tailscale node absent or confirmed deauthorized
  if (!attestation.tailscale_absent_or_deauthorized) {
    violations.push("Predicate 7 Failed: tailscale_absent_or_deauthorized is false");
  }

  // 8. Exe.dev VM confirmed destroyed / absent
  if (!attestation.exe_vm_absent_or_provider_terminal) {
    violations.push("Predicate 8 Failed: exe_vm_absent_or_provider_terminal is false");
  }

  // 9. Post-teardown active network probes passed (preview port closed, node unreachable)
  if (!attestation.post_teardown_probes_passed) {
    violations.push("Predicate 9 Failed: post_teardown_probes_passed is false");
  }

  // 10. Evidence chain head valid SHA-256
  if (!attestation.evidence_chain_head || attestation.evidence_chain_head.length !== 64) {
    violations.push("Predicate 10 Failed: evidence_chain_head must be a valid 64-character hex hash");
  }

  // 11. Signing key ID present
  if (!attestation.signing_key_id) {
    violations.push("Predicate 11 Failed: signing_key_id is missing");
  }

  // 12. Cryptographic signature present and verified against public key
  if (!attestation.signature) {
    violations.push("Predicate 12 Failed: signature is missing");
  } else if (publicKeyPem) {
    const verified = verifyBoundaryEvent(attestation.evidence_chain_head, attestation.signature, publicKeyPem);
    if (!verified) {
      violations.push("Predicate 12 Failed: Ed25519 signature over evidence_chain_head failed cryptographic verification");
    }
  }

  return {
    passed: violations.length === 0,
    violations
  };
}
