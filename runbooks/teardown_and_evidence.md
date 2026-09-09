# Teardown and Evidence Runbook

## Objective

Guarantee `CLEAN_TERMINATED` is emitted only when teardown proofs are complete.

## Ordered teardown

1. Mark run as terminal-intent (`cancelled`, `completed`, `timeout`, etc.).
2. Revoke runtime credential and record `credential_revoked`.
3. Request Tailscale logout/deauth and record request evidence.
4. Confirm node absence or explicit deauthorization evidence.
5. Request exe.dev VM destruction and record request evidence.
6. Confirm VM provider-terminal/absent state.
7. Pull advisory outputs again at teardown boundary.
8. Verify evidence hash-chain continuity and append final attestation.

## Failure handling

- If any proof is missing, set `TEARDOWN_PENDING` or `QUARANTINED`.
- Never emit `CLEAN_TERMINATED` when node/VM/credential/evidence status is indeterminate.
