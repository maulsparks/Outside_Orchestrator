import type { SandboxDelegation } from "../../contracts/interfaces.js";

export function assertV1DelegationPolicy(delegation: SandboxDelegation): void {
  if (delegation.network_policy !== "isolated") {
    throw new Error("v1 requires isolated network_policy");
  }
  if (delegation.phase_attempt < 1) {
    throw new Error("phase_attempt must be >= 1");
  }
}
