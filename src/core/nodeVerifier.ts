import { FORBIDDEN_SANDBOX_TAGS, TailscaleDevice } from "../adapters/tailscale/client.js";

export interface NodePostureOptions {
  device: TailscaleDevice;
  expectedTags: string[];
  forbiddenTags?: string[];
  networkPolicy: "isolated" | "approved_private_only";
}

export interface NodePostureResult {
  passed: boolean;
  violations: string[];
}

/**
 * Pre-Delegation Node Identity & Network Posture Verification Gate (ISSUE-11 / AC 4, AC 15, AC 20)
 * Evaluates sandbox node posture prior to dispatching the delegation envelope.
 */
export function verifyNodePosture(options: NodePostureOptions): NodePostureResult {
  const violations: string[] = [];
  const tags = options.device.tags ?? [];

  // 1. Invariant: in v1, only "isolated" network policy is supported
  if (options.networkPolicy !== "isolated") {
    violations.push(`UnsupportedNetworkPolicy: Only 'isolated' network policy is supported in v1`);
  }

  // 2. Invariant: Must carry expected tags (e.g. tag:factory-sandbox)
  for (const expTag of options.expectedTags) {
    if (!tags.includes(expTag)) {
      violations.push(`MissingExpectedTag: Node lacks required tag '${expTag}'`);
    }
  }

  // 3. Invariant: Must NOT carry any forbidden control tags
  const forbidden = options.forbiddenTags ?? FORBIDDEN_SANDBOX_TAGS;
  for (const tag of tags) {
    if (forbidden.includes(tag)) {
      violations.push(`ForbiddenTagViolation: Node carries prohibited control tag '${tag}'`);
    }
  }

  // 4. Invariant: Must not advertise any routes (prevent rogue subnet routers)
  const advertisedRoutes = options.device.advertisedRoutes ?? [];
  const primaryRoutes = options.device.primaryRoutes ?? [];
  if (advertisedRoutes.length > 0 || primaryRoutes.length > 0) {
    violations.push(`SubnetRouterViolation: Sandbox node is advertising routes`);
  }

  // 5. Invariant: Must not be configured as an exit node
  if (options.device.exitNode || options.device.exitNodeOption) {
    violations.push(`ExitNodeViolation: Sandbox node is configured as an exit node`);
  }

  // 6. Invariant: Must be authorized in tailnet
  if (!options.device.authorized) {
    violations.push(`UnauthorizedNodeViolation: Node is not authorized in tailnet`);
  }

  // 7. Invariant: Expiration must not be in the past
  if (options.device.expires) {
    const expiresAt = new Date(options.device.expires).getTime();
    if (expiresAt <= Date.now()) {
      violations.push(`ExpiredNodeViolation: Tailscale node registration has expired`);
    }
  }

  return {
    passed: violations.length === 0,
    violations
  };
}
