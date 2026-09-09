# Isolation Baseline (v1)

This baseline policy operationalizes the v1 contract posture:

- Delegation network mode must be `isolated`.
- No direct sandbox access to Tier 3/state credentials by default.
- No direct sandbox access to control-plane management APIs.
- Advisory output is collected by pull through the Warden/status path.

## Required checks in orchestrator

1. Reject delegation where `network_policy !== "isolated"`.
2. Reject attempts to provide reusable fleet credentials to sandbox.
3. Require host-side evidence for Tailscale enrollment identity.
4. Block acceptance if `advisory_output_collected` is missing or hash-mismatched.
