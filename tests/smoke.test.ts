import assert from "node:assert/strict";
import test from "node:test";

import { assertV1DelegationPolicy } from "../src/core/delegation.js";
import { hasAdvisoryCollectionEvidence } from "../src/core/evidence.js";
import { validateRequestShape } from "../src/core/intake.js";
import { assertLeaseFresh } from "../src/core/leaseGuard.js";
import { canBeCleanTerminated } from "../src/core/teardown.js";

test("assertV1DelegationPolicy throws for non-isolated policy", () => {
  assert.throws(() =>
    assertV1DelegationPolicy({
      run_id: "run-1",
      tenant_id: "tenant-1",
      phase: "build",
      phase_attempt: 1,
      schema_version: "v1",
      policy_version: "v1",
      parent_git_sha: "0123456789012345678901234567890123456789",
      task_envelope_hash: "a".repeat(64),
      agents_md_sha256: "b".repeat(64),
      allowed_paths: [],
      immutable_paths: [],
      acceptance_criteria: [],
      command_policy_id: "policy",
      network_policy: "approved_private_only",
      resource_limits: {
        cpu_millis: 1000,
        memory_mb: 512,
        wall_time_seconds: 60,
        output_bytes: 1024
      },
      runtime_credential_reference: "cred-ref",
      expires_at: "2030-01-01T00:00:00Z"
    })
  );
});

test("hasAdvisoryCollectionEvidence identifies advisory output evidence", () => {
  const result = hasAdvisoryCollectionEvidence([
    {
      evidence_id: "e-1",
      run_id: "run-1",
      request_id: "req-1",
      sequence: 1,
      event_type: "advisory_output_collected",
      observed_at: "2026-01-01T00:00:00Z",
      source_identity: "source",
      policy_version: "v1",
      payload_sha256: "c".repeat(64),
      event_hash: "d".repeat(64),
      signing_key_id: "key-1",
      warden_signature: "sig-1"
    }
  ]);

  assert.equal(result, true);
});

test("validateRequestShape throws for invalid request", () => {
  assert.throws(() =>
    validateRequestShape({
      request_id: "req-1",
      idempotency_key: "",
      tenant_id: "tenant-1",
      repository_id: "repo-1",
      parent_git_sha: "short",
      intent: "build",
      acceptance_criteria: [],
      policy_version: "v1",
      agents_md_sha256: "e".repeat(64),
      budget_cents: 100
    })
  );
});

test("assertLeaseFresh throws when lease is expired", () => {
  assert.throws(() =>
    assertLeaseFresh(
      {
        runId: "run-1",
        fencingToken: 1,
        expiresAtIso: "2000-01-01T00:00:00Z"
      },
      "2030-01-01T00:00:00Z"
    )
  );
});

test("canBeCleanTerminated returns true for complete attestation", () => {
  const result = canBeCleanTerminated({
    run_id: "run-1",
    sandbox_id: "sandbox-1",
    exe_vm_id: "vm-1",
    tailscale_node_id: "tail-1",
    terminal_state: "CLEAN_TERMINATED",
    credentials_revoked: true,
    tailscale_absent_or_deauthorized: true,
    exe_vm_absent_or_provider_terminal: true,
    post_teardown_probes_passed: true,
    evidence_chain_head: "hash-1",
    signing_key_id: "key-1",
    signature: "sig-1"
  });

  assert.equal(result, true);
});
