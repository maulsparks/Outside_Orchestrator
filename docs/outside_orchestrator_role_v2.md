# Outside Orchestrator Role Contract — v2 (Aligned)

**Role name:** Outside Orchestrator  
**Canonical placement:** Tier 1 Edge/Control Plane on the Hostinger control-plane host, operating outside the disposable exe.dev execution VM and integrating with Tier 3 state/memory services  
**Role status:** Authoritative control-plane component  
**Document purpose:** Define the responsibilities, authority, interfaces, security controls, and failure behavior of the orchestrator that operates the software factory from outside the untrusted sandbox

**Alignment note:** This revision aligns the contract with the ratified v1 scope decisions in the Inside-the-Sandbox Orchestrator Role Contract v2: pull-based advisory handoff (the sandbox never pushes to the Warden), external-only lease lifecycle (the sandbox never renews leases or tracks fencing tokens), isolated-only sandbox networking in v1, and exactly one delegated phase per sandbox attempt. Each corresponding Outside/Warden duty is stated explicitly in §5.2 (external lease lifecycle), §6.5 (single-phase isolated delegation and pull-based collection duty), §7.3 (advisory-output evidence), §8 (silent-sandbox failure path), and §10 (acceptance criteria 18–20).

> **Core rule:** The Outside Orchestrator operates the factory; it is not the factory floor.

## 1. Terminology and canonical placement

The source architecture names the Hostinger service the **Tier 1 Edge/Control Plane**, the DigitalOcean or exe.dev execution environments the **Tier 2 Compute/Execution Plane**, and Supabase the **Tier 3 State/Memory Plane**. The label “Outside Orchestrator” describes the orchestrator’s position outside the disposable execution sandbox. It does not create a new tier and does not move orchestration authority into Tier 3.

The Outside Orchestrator is deployed on the Tier 1 control-plane side. It persists authoritative workflow state in Tier 3, dispatches approved work to Tier 2, and supervises disposable exe.dev VMs. The requested “Inside Orchestrator” is a subordinate local execution controller inside one of those VMs. The two components must never be treated as peer schedulers or interchangeable implementations.

The deterministic-factory reference expresses the same boundary in operational terms: the host-side orchestrator retains long-lived provisioning and provider credentials, translates human intent into bounded requests, and mounts the execution environment without touching the sandbox working tree; the sandbox receives a cloned repository and short-lived runtime credentials and executes the deterministic factory phases. [1]

## 2. Executive definition

The Outside Orchestrator is the **policy-enforcing coordinator, durable state-transition authority, credential broker, Tier 2 compute lifecycle manager, evidence adjudicator, recovery manager, and harvest gate** for the AI software factory.

It receives an authenticated request, validates tenant and repository scope, resolves policy and memory, creates a durable run, acquires a lease, provisions an isolated exe.dev VM, enrolls the VM through the approved Tailscale path, delegates a bounded phase, observes results through the Warden boundary, reconciles declared and actual effects, runs or authorizes frozen acceptance tests, coordinates review, and performs deliberate harvest only after the required human and cryptographic gates.

It is not a model worker, code-editing agent, sandbox-local controller, general-purpose database, or trusted interpreter of sandbox claims.

## 3. Trust model

The software factory treats code-generating agents, repository instructions, retrieved documentation, model output, tool output, and local sandbox evidence as untrusted or semi-trusted inputs. Network location alone does not establish trust. Identity, authorization, resource limits, path confinement, credential scoping, immutable artifact digests, host-side evidence, and durable state transitions are required together.

The factory’s trust boundary is therefore layered:

| Layer | Outside Orchestrator responsibility | Required control |
|---|---|---|
| Request boundary | Authenticate and normalize the request, assign a request ID, enforce tenant and repository scope, and reject malformed work. | Gateway authentication, rate limits, idempotency keys, request schema validation. |
| State boundary | Establish durable truth for runs, phases, leases, policies, memories, events, and evidence references. | Tier 3 ACID transactions, RLS, leases, fencing tokens, append-only records. |
| Compute boundary | Dispatch to approved model workers without giving them workflow authority. | Tailscale ACLs, service identity, model allowlist, budgets, circuit breakers, worker health checks. |
| Sandbox boundary | Create, delegate, observe, revoke, and destroy the exe.dev VM. | Ephemeral lifecycle, short-lived credentials, Warden observation, no public listener, bounded egress. |
| Repository boundary | Establish the canonical parent SHA, reconcile the actual tree, and authorize harvest. | Git SHA and tree hashes, Effect Reconciliation Gate, frozen acceptance suite, human signature. |
| Recovery boundary | Resume only from committed durable state and prevent stale actors from writing. | PostgreSQL leases, monotonic fencing tokens, idempotent callbacks, replayable events. |

### 3.1 Tier 2 Compute/Execution Plane boundary

Tier 2 contains two operationally different classes of compute, and the Outside Orchestrator must not treat them as one undifferentiated worker pool:

| Tier 2 resource | Identity | Lifecycle | Default interaction with Tier 1 and Tier 3 |
|---|---|---|---|
| Persistent private model/inference worker | `tag:private-compute-prod` | Long-lived, independently patched, health-checked, and capacity-managed. | Tier 1 may reach only approved model API ports; Tier 3 access is application-scoped and not implied by Tailscale reachability. |
| Disposable exe.dev factory VM | `tag:factory-sandbox`, optionally `tag:factory-preview` | Run- or tournament-arm-scoped, short-lived, ephemerally enrolled, and destroyed or securely retired after terminal state. | Tier 1/Warden may reach the narrow Warden/status path; sandbox-to-control, sandbox-to-state, and sandbox-to-model access are denied by default. |

The persistent model worker is a service dependency. The exe.dev VM is an untrusted execution environment. They require separate Tailscale tags, auth-key profiles, ACL rules, budgets, evidence, and teardown procedures. A sandbox must not inherit the model worker’s identity or become a general member of the private compute network.

Tailscale supplies private transport and node identity only. It does not authorize a model request, a Tier 3 row mutation, a repository effect, or a harvest decision. Those actions remain subject to application authentication, claim-scoped credentials, Warden observation, and Tier 3 state guards.

## 4. Authority contract

The Outside Orchestrator owns coordination authority. It may delegate execution authority but may not delegate away its responsibility to enforce policy, persist state, and adjudicate evidence.

| Decision or action | Outside Orchestrator authority | Required proof or control |
|---|---|---|
| Accept a task | Accept, reject, or return a deterministic conflict response. | Authenticated principal, tenant scope, repository scope, request ID, idempotency key, policy decision. |
| Create a run | Create the durable run record and immutable task envelope. | Tier 3 transaction containing parent Git SHA, policy version, budget, acceptance criteria, and context hashes. |
| Advance a phase | Commit the next durable phase state. | Current lease, fencing token, expected state version, predecessor state, transition guard. |
| Provision an exe.dev VM | Create or request a disposable VM with declared resources and network mode. | Image/tool digests, run binding, TTL, Tailscale identity, host-side creation evidence. |
| Issue credentials | Mint or request short-lived credentials scoped to tenant, run, phase, attempt, audience, and expiry. | Credential broker/Warden record, no broad service credential in the sandbox. |
| Delegate local execution | Issue an authenticated delegation envelope. | Parent SHA, allowed paths, immutable paths, command policy, resource limits, network policy, frozen test identity, expiry. |
| Accept file-change claims | Accept only after comparing declared effects with host-observed tree state. | Warden tree observation, `git write-tree` or equivalent tree hash, zero-tolerance undeclared-touch policy. |
| Accept test results | Accept a result only when the suite and environment are independently controlled. | Frozen suite identity, read-only test inputs, clean runner, exit code, output hash, environment digest. |
| Select a tournament winner | Compare verified arms and record the deliberate choice. | Test and review results, cost/latency data, policy compliance, human gate where required. |
| Harvest or merge | Authorize the repository change. | Human signature over `(run_id, tree_sha, envelope_hash, policy_version)` and verified branch state. |
| Revoke and teardown | Stop work, revoke runtime access, destroy the VM, and archive evidence. | Warden lifecycle evidence, credential revocation evidence, teardown confirmation. |

The Outside Orchestrator must not allow the Inside Orchestrator or any model worker to create a new authoritative run, change tenant scope, widen a path set, mint credentials, apply Tailscale tags, alter ACLs, push to a protected branch, select a harvest result, or rewrite prior phase history.

## 5. Tier 3 state and memory responsibilities

Tier 3 is the durable state/memory substrate. It outlives the Hostinger process, DigitalOcean worker, and exe.dev VM. The Outside Orchestrator uses Tier 3 as a transactional source of truth rather than a passive log sink.

The minimum logical entities are:

| Entity | Purpose | Write rule |
|---|---|---|
| `factory_runs` | Tenant-scoped run identity, request envelope, parent SHA, lifecycle state, budget, policy version, and timestamps. | Guarded state transitions only. |
| `phase_envelopes` | Immutable inputs and outputs for each phase attempt. | Append-only by attempt; supersession is explicit. |
| `leases` | Run or phase ownership, expiration, and fencing token. | Transactional updates; stale tokens are rejected. |
| `memory_records` | Retrieved context, embeddings, summaries, and provenance. | Versioned or immutable records with source hashes and tenant scope. |
| `events` | Durable progress notifications and downstream messages. | Append-only with event ID, idempotency key, and sequence. |
| `evidence_ledger` | Warden- or host-generated boundary observations. | Append-only; sandbox narratives remain untrusted observations. |
| `tournament_arms` | Independent arm identity, policy, result, cost, and selection status. | One arm cannot overwrite another. |

Every business-significant state transition must commit to Tier 3 before the Outside Orchestrator acknowledges that the action occurred. A process-local variable, worker-local SQLite row, uncommitted queue message, or callback that was not durably accepted is not authoritative.

Runtime access to Tier 3 must use short-lived claim-scoped credentials bound to `tenant_id`, `run_id`, audience, and expiry. The broad Supabase `service_role` credential is prohibited from ordinary runtime loops. Supabase RLS remains responsible for tenant and row authorization; Tailscale supplies private transport and node identity, not row-level authorization. [2]

### 5.1 State synchronization protocol

The Outside Orchestrator synchronizes with Tier 3 through a versioned, lease-guarded protocol:

1. Create the run and immutable task envelope in one transaction.
2. Acquire a lease and receive a monotonic fencing token.
3. Resolve policy, memory, repository parent SHA, and model/tool selection; record their identifiers and content hashes.
4. Commit each phase transition using expected phase, expected state version, current fencing token, and unexpired lease.
5. Insert the corresponding event into a transactional outbox in the same transaction as the state mutation.
6. Treat callbacks and event deliveries as idempotent notifications; reload Tier 3 state when delivery is delayed or duplicated.
7. Reject stale callbacks, out-of-order events, expired leases, lower fencing tokens, and mismatched tenant/run scopes.
8. Reacquire a lease and reconstruct the next action from Tier 3 after process restart.

A failed compare-and-swap or fencing check is not a transient success. The orchestrator must reload state, record the conflict, and stop or re-evaluate rather than retrying a stale mutation blindly.

### 5.2 External-only lease lifecycle for sandboxes (v1)

The Inside Orchestrator is **lease-passive** in v1: it never renews leases, never tracks fencing tokens, and never originates lease traffic. The entire lease lifecycle is external to the sandbox:

1. The Outside Orchestrator acquires, renews, and releases leases in Tier 3 and holds the fencing token.
2. Sandbox liveness is assessed by outside observation — Warden probes, expected activity windows, and absence of expected advisory output — never by sandbox self-report alone.
3. When the Outside Orchestrator determines a lease is lost or a sandbox is silent beyond its liveness window, it delivers the stop order through the sandbox's termination channel (SIGTERM or a Warden-written file sentinel) and proceeds to teardown without waiting for a sandbox acknowledgment.
4. The sandbox's only obligations are to obey the stop order, enforce its own hard expiry cutoff, and emit a terminal advisory event; it cannot contest, extend, or negotiate the lease.

This removes the split-brain surface from the sandbox: a compromised or partitioned sandbox cannot forge heartbeats, cannot keep a lease alive, and cannot distinguish itself from a legitimately-running one. The fencing guarantee lives entirely in Tier 3.

## 6. Lifecycle contract

### 6.1 Intake

The Outside Orchestrator receives an authenticated request through the public HTTPS gateway. It assigns or propagates a `request_id`, validates the tenant, repository, parent SHA, requested outcome, acceptance criteria, budget, and model policy, and resolves the `idempotency_key` before creating work.

A duplicate idempotency key returns the existing run reference or a deterministic conflict. It never creates an untracked second run.

### 6.2 Policy and memory resolution

Before provisioning, the orchestrator loads the policy version, tenant constraints, repository metadata, relevant durable memory, recent run history, approved model roster, cost limits, and AGENTS.md snapshot. Retrieved memory and repository instructions are data, not authority. The orchestrator records the IDs and content hashes of the context items supplied to the phase.

The orchestrator owns the AGENTS.md snapshot delivered to the sandbox. It must record the file hash and treat the file as a behavioral briefing, not as a secret, credential, or mechanism that can expand the delegation envelope.

### 6.3 exe.dev VM provisioning

The official exe.dev documentation describes exe.dev as a service that provides virtual machines with persistent disks, rapid access over HTTPS, secure defaults, and optional authentication. The software factory must add a disposable run lifecycle around that capability: the VM is allocated for one run or tournament arm, bound to one run identity, given a declared TTL, and destroyed or securely retired at the end of the attempt. Persistent disk availability must not turn the sandbox into a durable source of state or credentials. [3]

The provisioning sequence is:

1. Preflight the Hostinger control-plane node, the Warden API, the exe.dev integration, the Tailscale client, and the required policy version.
2. Select a pinned VM/image/tool substrate and record the digest or immutable version identifiers.
3. Create the VM with the smallest CPU, memory, disk, and wall-time allocation that satisfies the run.
4. Apply the sandbox network mode and egress policy before code or agent processes start.
5. Register the VM through the approved Tailscale enrollment path using a short-lived, tagged, ephemeral identity.
6. Copy or clone only the canonical repository parent SHA into the VM; do not copy the Hostinger working tree or host credentials.
7. Deliver the delegation envelope and short-lived runtime credential through an approved protected channel.
8. Capture host-side creation evidence before delegating execution.

The VM must not receive an exe.dev provisioning key, Tailscale administrative key, Git push token, cloud metadata credential, long-lived provider secret, CI/CD policy token, Tailscale API token, or broad Supabase `service_role` credential.

### 6.3.1 Tailscale API and CI/CD provisioning boundary

Tailscale policy and node provisioning are control-plane operations. They may be automated by a protected CI/CD job or deployment service, but their credentials remain outside the exe.dev VM and outside the Inside Orchestrator.

The provisioning workflow separates operations and credentials:

| Operation | Credential scope | Control |
|---|---|---|
| Pull-request policy validation | `policy_file:read` | No live mutation; untrusted branches receive no write credential. |
| Protected policy apply | `policy_file` plus required read capability | Protected environment, reviewer approval, reviewed commit, and `If-Match` ETag concurrency guard. |
| Auth-key creation and device inventory | `auth_keys`, `devices:core`, and `devices:core:read` | Separate deployment identity; short-lived token or delegated trust credential. |
| Sandbox enrollment | Tagged, ephemeral, non-reusable auth key | One VM/run; secret delivered through a protected broker and never stored in the VM image or repository. |
| Device cleanup | Device/key administration | Identify the actual device ID, deauthorize/delete the node, destroy the VM, and verify absence. |

Tags are declared in `tagOwners` in the tailnet policy. Auth keys assign tags to newly enrolled devices. Applying tags to an already enrolled device is a separate device API operation and must be authorized independently. The Inside Orchestrator has none of these API capabilities.

The API automation must first retrieve the current policy and ETag, submit the candidate HuJSON/JSON to the non-mutating validation endpoint, and apply it only with `If-Match`. An ETag mismatch is a concurrency failure, not permission to overwrite another operator’s policy. The device-provisioning job stores an auth-key secret only long enough to deliver it to the intended node; it never emits the secret in logs or CI artifacts. [9] [10] [11]

### 6.4 Tailscale provisioning and network policy

Tailscale is the private transport and service-device identity layer. It is not application authorization, Supabase RLS, host-firewall enforcement, or evidence integrity. The Tailscale policy is managed outside the sandbox through reviewed policy-as-code.

The Outside Orchestrator or an explicitly delegated deployment controller is responsible for the following identities:

| Node or identity | Recommended Tailscale identity | Outside responsibility |
|---|---|---|
| Hostinger control plane | `tag:edge-control-prod` | Maintain the control-plane node, private APIs, Warden, and orchestration reachability. |
| Optional tag-assignment service | `tag:deployment-controller` | Apply only directly owned child tags during approved provisioning. |
| DigitalOcean inference node | `tag:private-compute-prod` | Permit only approved model-service flows and operator SSH. |
| exe.dev factory VM | `tag:factory-sandbox` | Create as ephemeral, run-scoped identity; revoke and remove at teardown. |
| Optional preview endpoint | `tag:factory-preview` | Apply only when the run explicitly enables a temporary preview on TCP 4501. |
| Monitoring collector | `tag:monitoring` | Permit bounded telemetry ingestion only. |

The baseline ACL posture is:

| Source | Destination | Ports | Decision |
|---|---|---:|---|
| `tag:edge-control-prod` | `tag:factory-sandbox` | TCP 8787 | Allow for Warden/status/evidence broker only. |
| `group:platform-reviewers` or explicitly approved preview audience | `tag:factory-preview` | TCP 4501 | Allow only while the preview is active. |
| `tag:edge-control-prod` | `tag:private-compute-prod` | TCP 8000 and/or 11434 | Allow only for deployed model APIs and only with application authentication. |
| `group:platform-ops` | `tag:edge-control-prod`, `tag:private-compute-prod` | TCP 22 | Allow through matching ACL and Tailscale SSH `check` rules. |
| `tag:factory-sandbox` | control-plane management ports | TCP 22, 8787, administrative APIs | Deny by default. |
| `tag:factory-sandbox` | Tier 3 state gateway or Supabase credentials | Any | Deny direct access by default; use brokered, claim-scoped access only if explicitly required. |
| Any sandbox or worker | public internet | Any | Deny by default or restrict to an approved egress allowlist. |

The Outside Orchestrator does not permit the Inside Orchestrator to create tags, change tag owners, edit ACLs, approve devices, advertise routes, create exit nodes, or mint auth keys. A sandbox status callback is not a policy request and cannot expand network authority.

### 6.5 Delegation

In v1, the orchestrator delegates **exactly one phase per sandbox attempt**. The Inside Orchestrator has no multi-phase sequencing capability in v1, so a multi-phase run is composed of multiple externally sequenced delegations, each advancing through its own Tier 3 phase transition (§5.1). The recommended v1 posture is a **fresh exe.dev VM per phase attempt**, so every delegation begins from a verified clean-room baseline; reusing one VM across sequential phase delegations is a v1.1 cost/latency optimization that requires an explicit policy decision and fresh baseline verification per delegation.

In v1, the orchestrator must only issue `network_policy: "isolated"` delegations. The Inside Orchestrator's startup gate rejects `approved_private_only` delegations with "not supported in v1", so issuing one guarantees a failed attempt. Private-endpoint access (model workers, monitoring, direct state gateways) is a v1.1 capability that arrives with the push-delivery channel and per-operation destination enforcement.

The envelope includes the run ID, tenant, phase, attempt, schema version, parent Git SHA, task hash, policy version, allowed paths, immutable paths, acceptance criteria, AGENTS.md hash, command policy, network mode, resource limits, frozen-suite identity, runtime credential reference, and expiry.

The orchestrator records the envelope hash before delivery and rejects any result whose run, phase, attempt, parent SHA, tenant, policy version, or sandbox identity does not match.

**Advisory-output collection duty (v1 pull model).** Because the Inside Orchestrator never pushes status or results to the Warden, the Warden (on behalf of the Outside Orchestrator) must **pull** the sandbox's advisory output: the trace JSONL, emitted status events, and the final result package from the sandbox's run-scoped output directory, over the approved `tag:edge-control-prod → tag:factory-sandbox:8787` broker path or via host-side filesystem observation before VM destruction. Collection happens at phase end and again at teardown. The Warden hash-verifies the collected result package against the declared `trace_manifest_sha256` and records an `advisory_output_collected` evidence event (§7.3); a run whose advisory output was not collected and hash-verified cannot be accepted (§10). The collected output remains `sandbox-originated-advisory` and never substitutes for host-side observation.

### 6.6 Effect reconciliation

The local sandbox may report `declared_changed_files`, but the Outside Orchestrator never treats that list as proof. The Warden independently observes the host-side tree transition and computes the actual before/after tree hashes. The Effect Reconciliation Gate rejects undeclared modifications with zero tolerance unless an external policy explicitly defines a separate approval path.

The canonical code pointer is the Git commit SHA. The Outside Orchestrator may authorize a provisional local commit for traceability, but only a verified and deliberately harvested commit becomes an accepted product artifact.

### 6.7 Test and review gates

The Outside Orchestrator owns the identity and integrity of the frozen acceptance suite. The builder must not be able to replace or weaken the suite used to certify its own work. Tests run in a clean, network-isolated environment and produce an exit code, suite ID, output hash, environment digest, duration, and artifact references.

A green test result is necessary but not sufficient. Review compares behavior with the original intent and acceptance criteria. Rejection creates typed findings and consumes bounded retry budget; it does not silently mutate the sandbox or rewrite prior history.

### 6.8 Best-of-N and harvest

For tournament execution, every arm receives the same bounded task envelope and a distinct arm ID. Arms have separate sandboxes, branches or worktrees, credentials, evidence streams, and budgets. No arm may overwrite another.

The Outside Orchestrator compares verified test results, review findings, latency, cost, retry count, policy compliance, and artifact integrity. A human selects or approves the winner when required. Harvest is a deliberate cherry-pick or merge, not an automatic consequence of a local pass.

Harvest requires a signature over `(run_id, tree_sha, envelope_hash, policy_version)`. After harvest or cancellation, the orchestrator revokes runtime credentials, destroys or retires the VM, records teardown evidence, and archives the run.

## 7. Interfaces

### 7.1 External request

```typescript
interface FactoryRequest {
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
```

### 7.2 Sandbox delegation

```typescript
interface SandboxDelegation {
  run_id: string;
  tenant_id: string;
  arm_id?: string;
  phase: "plan" | "build" | "test" | "review" | "document";
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
```

### 7.3 Tier 2 binding and Warden evidence

```typescript
interface Tier2Binding {
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

interface BoundaryEvidence {
  evidence_id: string;
  run_id: string;
  request_id: string;
  arm_id?: string;
  sandbox_id?: string;
  exe_vm_id?: string;
  tailscale_node_id?: string;
  phase?: string;
  phase_attempt?: number;
  sequence: number;
  event_type:
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
  observed_at: string;
  source_identity: string;
  policy_version: string;
  payload_sha256: string;
  previous_event_hash?: string;
  event_hash: string;
  signing_key_id: string;
  warden_signature: string;
}

interface TeardownAttestation {
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
```

The Warden signs canonical event bodies outside the sandbox using a protected signing key or KMS/HSM-backed signer. Each event includes a sequence number, previous-event hash, payload hash, event hash, source identity, provider IDs, policy version, and signing-key ID. The `advisory_output_collected` event carries the collected result-package digest and trace-manifest hash so the evidence chain remains continuous across the pull-based handoff. The final `CLEAN_TERMINATED` attestation is permitted only after credential revocation, Tailscale node absence or explicit deauthorization, exe.dev VM destruction, disk disposition, post-teardown probes, late-callback rejection, and evidence-chain verification.

### 7.4 Harvest attestation

```typescript
interface HarvestAttestation {
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
```

## 8. Failure, retry, and recovery behavior

The Outside Orchestrator fails closed when it cannot prove ownership, freshness, scope, or policy compliance. It must not repair missing evidence by trusting a later sandbox narrative.

| Failure | Required Outside behavior |
|---|---|
| Orchestrator restart | Reload the run and phase state from Tier 3, reacquire the lease, and resume only from the last committed transition. |
| Stale callback | Reject using fencing and version checks; append a rejection event; do not mutate current state. |
| Duplicate callback | Return the existing idempotent result or current state; do not create a new attempt unless policy says so. |
| Sandbox timeout | Revoke credentials, record timeout evidence, destroy the VM, and apply bounded retry policy. |
| Sandbox silent beyond liveness window (v1 lease-loss path) | Declare lease loss from outside observation (§5.2); deliver the cancellation signal; proceed to revocation and teardown without waiting for sandbox self-report; apply bounded retry policy. |
| Invalid Tailscale identity | Stop delegation, quarantine or remove the node, and investigate tag, key, and enrollment evidence. |
| Tailscale policy drift | Stop privileged dispatch until the expected policy version and node tags are restored. |
| Warden evidence gap | Do not harvest; preserve the run as incomplete or blocked. |
| RLS or Tier 3 failure | Stop new privileged work; never fall back to an unrestricted credential. |
| ERG mismatch | Mark unauthorized or repairable, preserve observed tree evidence, and block harvest. |
| Frozen test failure | Capture the result and start only an externally authorized bounded repair attempt. |
| Budget exhaustion | Stop dispatch, revoke credentials, destroy disposable resources, and close the run durably. |
| Human harvest rejection | Preserve artifacts, do not merge, and close or return only to the permitted phase. |
| Control-plane compromise suspicion | Quarantine the control path, revoke active credentials, preserve ledger checkpoints, and require operator intervention. |
| Policy validation or ETag conflict | Do not apply; refresh the policy, reconcile the reviewed commit, and rerun validation. |
| Unexpected Tailscale tag, route, or exit-node state | Stop delegation, quarantine/deauthorize the node, and investigate tag-owner or enrollment activity. |
| Auth key created but not securely delivered | Delete the auth key, mark it abandoned/compromised, and generate a new one only through the protected provisioning path. |
| VM destroyed but Tailscale node remains | Deauthorize/delete the actual device ID, preserve evidence, and keep the run `TEARDOWN_PENDING` or `QUARANTINED`. |
| Tailscale node absent but VM remains | Apply provider/cloud firewall containment, destroy the VM, and record the resource mismatch. |
| Warden signing or hash-chain failure | Do not issue clean teardown; preserve raw observations and open an integrity incident. |

The Tier 1 control plane must be reconstructible from Infrastructure-as-Code within the declared target of 30 minutes, and Tier 3 must support the declared point-in-time recovery objective. [2]

## 9. Observability and operational controls

The orchestrator emits distributed traces across ingress, orchestration, Warden, Tailscale enrollment, worker calls, sandbox lifecycle, and Tier 3. Required dimensions include request ID, run ID, phase, attempt, arm ID, model/worker identity, latency, token usage, GPU saturation where applicable, cost, retry count, queue wait time, Tailscale node identity, and terminal status. Prompt content, secrets, private keys, and runtime tokens are redacted or referenced by hash.

The control plane monitors:

| Signal | Required action |
|---|---|
| Queue depth or worker saturation | Apply back-pressure, circuit breaking, or approved degraded mode. |
| Unexpected Tailscale tag or node | Quarantine the node and review enrollment evidence. |
| Sandbox still active after terminal state | Revoke credentials, destroy the VM, and create a teardown incident. |
| Repeated stale callbacks | Treat as lease conflict, partition, or possible compromise. |
| RLS denial spike | Stop unsafe retries and inspect token scope, tenant claims, and replay indicators. |
| Policy or AGENTS.md hash drift | Stop the run or require explicit reauthorization. |
| Missing Warden evidence | Block acceptance and harvest. |
| Tailscale node active after terminal state | Revoke credentials, deauthorize/delete the node, destroy the VM, and block clean closure. |
| CI/CD credential exposure | Revoke the affected policy/device credential, inspect policy and device changes, and rotate dependent credentials. |

## 10. Acceptance criteria

The Outside Orchestrator is acceptable only when controlled tests demonstrate that:

1. A duplicate request with the same idempotency key does not create a second authoritative run.
2. Every phase transition is durable, lease-guarded, fencing-token protected, and recoverable after restart.
3. The exe.dev VM receives only the declared short-lived runtime credentials and no host provisioning keys, Git push tokens, cloud metadata credentials, or broad state-plane credentials.
4. The VM is enrolled with the expected ephemeral Tailscale identity and cannot reach denied management ports.
5. A false sandbox `changed_files` claim is rejected by host-side tree-hash reconciliation.
6. The builder cannot modify the frozen acceptance suite and certify that modification as a green pass.
7. Stale, duplicated, and out-of-order callbacks cannot advance the run.
8. Runtime Tier 3 access is tenant/run scoped and never uses an unrestricted service credential in the run loop.
9. Tournament arms cannot overwrite one another and the selected arm is deliberately recorded.
10. Harvest requires the expected signature and verified tree SHA.
11. Teardown revokes Tailscale/runtime access and destroys the VM after timeout, cancellation, harvest, and partial failure.
12. A disaster-recovery rehearsal reconstructs the control plane from IaC within the declared RTO.
13. Policy validation runs without mutation, and policy apply refuses an unexpected ETag instead of overwriting a concurrent change.
14. Separate CI/CD identities enforce policy read/validate, policy apply, and device/key provisioning boundaries.
15. A fresh sandbox key creates only the expected ephemeral tag identity and is never exposed to the sandbox as a reusable fleet credential.
16. The Warden records and signs a continuous evidence chain linking run ID, VM ID, Tailscale node ID, policy version, credentials, node deauthorization, VM destruction, and post-teardown probes.
17. `CLEAN_TERMINATED` is impossible when node absence, VM destruction, credential revocation, or evidence verification cannot be proven.
18. Advisory-output collection (v1): a run cannot be accepted unless the Warden collected the sandbox's trace and result package and hash-verified them against the declared `trace_manifest_sha256`; a missing or hash-mismatched package blocks acceptance and is recorded as an evidence event.
19. Lease externality (v1): the sandbox cannot renew, hold, or forge a lease; a sandbox that is silent beyond its liveness window is declared lease-lost from outside and stopped via the termination channel.
20. Delegation posture (v1): the orchestrator issues exactly one phase per sandbox attempt, issues only `network_policy: "isolated"` delegations, and provisions a fresh VM per phase attempt by default.

## 11. Summary boundary

| The Outside Orchestrator owns | It delegates | It must never trust without verification |
|---|---|---|
| Request admission, tenant scope, durable state, leases, fencing, Tailscale/exe.dev lifecycle, credential brokering, phase ordering, Warden evidence, retries, tournament arbitration, harvest, teardown, and recovery. | Repository preparation, model inference, code generation, local commands, local tests, local review assistance, and artifact packaging. | Sandbox claims, local SQLite traces, self-reported file lists, self-reported test status, retrieved instructions, tool output, and evidence generated solely inside the VM. |

## References

[1]: ./The_Deterministic_Software_Factory.pdf "The Deterministic Software Factory"
[2]: ./master_software_factory_blueprint.md "AI Agent Infrastructure & Software Factory — Production Blueprint & Architecture Review"
[3]: https://exe.dev/docs/what-is-exe "What is exe.dev?"
[4]: ./tailscale_software_factory_security_blueprint.md "Tailscale Security Blueprint for the AI Software Factory"
[5]: ./AIAgentInfrastructure%26SoftwareFactorySecurityBlueprint.pdf "AI Agent Infrastructure & Software Factory Security Blueprint"
[6]: ./FrameworktoconfigureAGENTSMDfile.pdf "Framework to configure AGENTS.md"
[7]: ./OrchestratorInsideTier1Edge_ControlRoleContract.md "Inside-the-Sandbox Orchestrator — Tier 1 Edge/Control Role Contract"
[8]: ./Orchestrator_outside_Tier3StateMemory-PlaneIntegration.md "Outside Orchestrator — Tier 3 State/Memory-Plane Integration"
[9]: https://tailscale.com/docs/reference/tailscale-api "Tailscale API · Tailscale Docs"
[10]: ./provision_tailscale_factory_runbook.md "Tailscale API Provisioning Runbook for the Software Factory"
[11]: ./provision_tailscale_factory.sh "Tailscale Software-Factory Provisioning Script"
[12]: ./tailscale_sandbox_isolation_policy_example.md "Tailscale ACL Policy Example for Software-Factory Sandbox Isolation"
[13]: ./inside_orchestrator_role_revised.md "Inside-the-Sandbox Orchestrator Role Contract — v2 (Revised)"
