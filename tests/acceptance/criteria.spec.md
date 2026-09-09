# Acceptance Matrix (v1)

This test matrix maps controlled tests to criteria 1–20 from the role contract.

- [ ] 1. Duplicate idempotency key cannot create second run
- [ ] 2. Lease/fence guarded durable transition, restart-resumable
- [ ] 3. Sandbox receives only short-lived scoped credentials
- [ ] 4. Expected Tailscale ephemeral identity, denied management ports
- [ ] 5. False changed-files claim rejected by host tree reconciliation
- [ ] 6. Frozen suite cannot be replaced by builder
- [ ] 7. Stale/duplicate/out-of-order callbacks cannot advance state
- [ ] 8. Tier 3 runtime access remains tenant/run scoped
- [ ] 9. Tournament arms remain isolated
- [ ] 10. Harvest requires verified signature + tree SHA
- [ ] 11. Teardown revokes access + destroys VM across terminal flows
- [ ] 12. DR rehearsal meets declared RTO
- [ ] 13. Tailscale policy validate/apply honors ETag concurrency
- [ ] 14. CI/CD identities remain separated by operation
- [ ] 15. Sandbox auth key is ephemeral/single-use scoped
- [ ] 16. Continuous signed evidence chain exists
- [ ] 17. CLEAN_TERMINATED impossible without full proof set
- [ ] 18. Advisory output must be collected + hash verified
- [ ] 19. Sandbox cannot renew lease; silent sandbox externally terminated
- [ ] 20. One-phase-per-attempt, isolated-only delegation, fresh VM default
