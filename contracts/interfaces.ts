export type Phase = "plan" | "build" | "test" | "review" | "document";

export interface FactoryRequest {
  request_id: string;
  idempotency_key: string;
  tenant_id: string;
  repository_id: string;
  parent_git_sha: string;
  intent: string;
  acceptance_criteria: string[];
  policy_version: string;
  agents_md_sha256: string;
  budget_cents: number;
  requested_model_policy?: string;
}

export interface SandboxDelegation {
  run_id: string;
  tenant_id: string;
  arm_id?: string;
  phase: Phase;
  phase_attempt: number;
  schema_version: string;
  policy_version: string;
  parent_git_sha: string;
  task_envelope_hash: string;
  agents_md_sha256: string;
  allowed_paths: string[];
  immutable_paths: string[];
  acceptance_criteria: string[];
  command_policy_id: string;
  network_policy: "isolated" | "approved_private_only";
  resource_limits: {
    cpu_millis: number;
    memory_mb: number;
    wall_time_seconds: number;
    output_bytes: number;
  };
  frozen_suite_id?: string;
  runtime_credential_reference: string;
  expires_at: string;
}

export interface Tier2Binding {
  run_id: string;
  arm_id?: string;
  sandbox_id: string;
  compute_class: "persistent_model_worker" | "ephemeral_exe_vm";
  exe_vm_id?: string;
  tailscale_node_id: string;
  tailscale_tags: string[];
  policy_version: string;
  auth_key_id?: string;
  image_or_runtime_digest: string;
  expires_at: string;
}

export type BoundaryEventType =
  | "sandbox_creation_requested"
  | "sandbox_created"
  | "tailscale_enrollment_observed"
  | "delegation_issued"
  | "credential_issued"
  | "command_observed"
  | "tree_observed"
  | "network_decision_observed"
  | "advisory_output_collected"
  | "erg_result"
  | "test_result"
  | "credential_revoked"
  | "tailscale_logout_requested"
  | "tailscale_node_deauthorized"
  | "tailscale_node_absence_confirmed"
  | "exe_vm_destroy_requested"
  | "exe_vm_destroyed"
  | "teardown_probe_passed"
  | "teardown_probe_failed"
  | "sandbox_destroyed"
  | "teardown_failed";

export interface BoundaryEvidence {
  evidence_id: string;
  run_id: string;
  request_id: string;
  arm_id?: string;
  sandbox_id?: string;
  exe_vm_id?: string;
  tailscale_node_id?: string;
  phase?: Phase;
  phase_attempt?: number;
  sequence: number;
  event_type: BoundaryEventType;
  observed_at: string;
  source_identity: string;
  policy_version: string;
  payload_sha256: string;
  previous_event_hash?: string;
  event_hash: string;
  signing_key_id: string;
  warden_signature: string;
}

export interface TeardownAttestation {
  run_id: string;
  sandbox_id: string;
  exe_vm_id: string;
  tailscale_node_id: string;
  terminal_state:
    | "CLEAN_TERMINATED"
    | "TERMINATED_WITH_RETAINED_AUDIT_RECORD"
    | "TEARDOWN_PENDING"
    | "TEARDOWN_FAILED"
    | "QUARANTINED";
  credentials_revoked: boolean;
  tailscale_absent_or_deauthorized: boolean;
  exe_vm_absent_or_provider_terminal: boolean;
  post_teardown_probes_passed: boolean;
  evidence_chain_head: string;
  signing_key_id: string;
  signature: string;
}

export interface HarvestAttestation {
  run_id: string;
  selected_arm_id: string;
  accepted_tree_sha: string;
  task_envelope_hash: string;
  policy_version: string;
  signer_identity: string;
  signature: string;
  signature_verified_at: string;
  teardown_evidence_id: string;
}
