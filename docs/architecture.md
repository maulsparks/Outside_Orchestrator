# Outside Orchestrator Architecture (v1)

This document translates `outside_orchestrator_role_v2.md` into implementation-oriented components for a Node/TypeScript control-plane service.

## Core services

1. **Ingress API**
   - Authenticates requests
   - Enforces idempotency and schema validation
   - Creates immutable run envelope

2. **Run State Engine**
   - Owns durable phase transitions in Tier 3
   - Enforces lease + fencing preconditions
   - Writes transactional outbox events

3. **Lease Manager**
   - External-only acquisition/renewal/release
   - Monotonic fencing token handling
   - Silent-sandbox timeout decisions

4. **Sandbox Provisioner**
   - Creates run-scoped exe.dev VM
   - Applies isolated network posture before execution
   - Enrolls ephemeral Tailscale identity

5. **Delegation Broker**
   - Issues exactly one phase delegation per attempt
   - Records envelope hash before dispatch
   - Rejects mismatched callback identity/scope

6. **Evidence/Warden Integrator**
   - Pulls advisory outputs from sandbox
   - Performs hash verification against trace manifest
   - Appends signed boundary evidence chain

7. **ERG + Test Gate**
   - Verifies declared vs observed tree effects
   - Runs/authorizes frozen acceptance suite
   - Emits acceptance decision inputs

8. **Harvest Controller**
   - Requires human+signature gate
   - Verifies `(run_id, tree_sha, envelope_hash, policy_version)`
   - Coordinates final merge/cherry-pick flow

9. **Teardown Manager**
   - Revokes runtime credentials
   - Deauthorizes/removes Tailscale node
   - Destroys VM and emits teardown attestation

## Data model (minimum)

- `factory_runs`
- `phase_envelopes`
- `leases`
- `events`
- `evidence_ledger`
- `tournament_arms`

## v1 invariants

- Sandbox never renews lease or touches fencing.
- Delegation network policy is always `isolated`.
- One phase per sandbox attempt.
- Acceptance is blocked without `advisory_output_collected` + hash match.
- `CLEAN_TERMINATED` requires complete teardown proof.
