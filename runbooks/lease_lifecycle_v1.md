# External Lease Lifecycle (v1)

## Principle

Lease ownership is external to sandbox execution.

## Rules

- Sandbox never acquires, renews, or releases leases.
- Outside orchestrator holds current fencing token.
- Silent sandbox is handled through outside liveness detection + termination channel.

## Liveness timeout procedure

1. Detect missing expected advisory output within liveness window.
2. Declare lease-lost in control plane.
3. Send termination signal (SIGTERM/file sentinel).
4. Revoke credentials and teardown regardless of sandbox acknowledgment.
5. Append evidence and decide bounded retry.
