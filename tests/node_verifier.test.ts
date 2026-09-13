import assert from "node:assert/strict";
import test from "node:test";

import { TailscaleDevice } from "../src/adapters/tailscale/client.js";
import { verifyNodePosture } from "../src/core/nodeVerifier.js";

function makeDevice(overrides?: Partial<TailscaleDevice>): TailscaleDevice {
  return {
    id: "dev-01",
    name: "sandbox-dev-01",
    hostname: "sandbox-dev-01",
    addresses: ["100.64.0.5"],
    tags: ["tag:factory-sandbox"],
    authorized: true,
    isExternal: false,
    advertisedRoutes: [],
    primaryRoutes: [],
    exitNode: false,
    exitNodeOption: false,
    expires: new Date(Date.now() + 3600000).toISOString(),
    ...overrides
  };
}

test("verifyNodePosture passes for valid isolated sandbox node", () => {
  const device = makeDevice();
  const result = verifyNodePosture({
    device,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });

  assert.equal(result.passed, true);
  assert.equal(result.violations.length, 0);
});

test("verifyNodePosture rejects node with forbidden control tags", () => {
  const device = makeDevice({
    tags: ["tag:factory-sandbox", "tag:edge-control-prod"]
  });

  const result = verifyNodePosture({
    device,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.includes("ForbiddenTagViolation")));
});

test("verifyNodePosture rejects node advertising routes", () => {
  const device = makeDevice({
    advertisedRoutes: ["10.0.0.0/24"]
  });

  const result = verifyNodePosture({
    device,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.includes("SubnetRouterViolation")));
});

test("verifyNodePosture rejects exit nodes", () => {
  const device = makeDevice({
    exitNode: true
  });

  const result = verifyNodePosture({
    device,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.includes("ExitNodeViolation")));
});

test("verifyNodePosture rejects non-isolated network policy in v1", () => {
  const device = makeDevice();
  const result = verifyNodePosture({
    device,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "approved_private_only"
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.includes("UnsupportedNetworkPolicy")));
});

test("verifyNodePosture rejects unauthorized or expired node", () => {
  const device = makeDevice({
    authorized: false,
    expires: new Date(Date.now() - 1000).toISOString()
  });

  const result = verifyNodePosture({
    device,
    expectedTags: ["tag:factory-sandbox"],
    networkPolicy: "isolated"
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.includes("UnauthorizedNodeViolation")));
  assert.ok(result.violations.some((v) => v.includes("ExpiredNodeViolation")));
});
