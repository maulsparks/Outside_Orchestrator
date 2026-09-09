# Acceptance Criteria Operationalization (v1)

Source of truth: `docs/outside_orchestrator_role_v2.md` §10.

## Matrix

1. Idempotency conflict test (same key, single run)
2. Durable transition + restart recovery + fence enforcement
3. Credential minimization inside sandbox
4. Expected Tailscale ephemeral identity + denied mgmt ports
5. ERG rejects false changed-file claims
6. Frozen suite integrity against builder tampering
7. Stale/duplicate/out-of-order callback immunity
8. Tier 3 runtime access claim-scoped only
9. Tournament arm isolation
10. Harvest signature and tree SHA verification
11. Teardown behavior across terminal paths
12. DR rehearsal within RTO target
13. Tailscale policy validate/apply ETag safety
14. CI/CD identity separation for policy/device ops
15. Single-use ephemeral sandbox auth-key behavior
16. Continuous signed evidence chain
17. Impossible clean termination without full teardown proofs
18. Advisory-output pull + hash verification required
19. External lease ownership + silent sandbox stop path
20. Delegation posture: isolated-only, one-phase-per-attempt, fresh VM default
