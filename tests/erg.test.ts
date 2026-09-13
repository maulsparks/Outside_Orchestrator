import assert from "node:assert/strict";
import test from "node:test";

import { matchesPathPattern, reconcileTreeEffects } from "../src/core/erg.js";

test("matchesPathPattern supports wildcard globs and directory prefixes", () => {
  assert.equal(matchesPathPattern("src/index.ts", "src/**"), true);
  assert.equal(matchesPathPattern("src/adapters/client.ts", "src/**"), true);
  assert.equal(matchesPathPattern("src/index.ts", "src/*.ts"), true);
  assert.equal(matchesPathPattern("src/adapters/client.ts", "src/*.ts"), false);
  assert.equal(matchesPathPattern("package.json", "package.json"), true);
  assert.equal(matchesPathPattern("AGENTS.md", "AGENTS.md"), true);
  assert.equal(matchesPathPattern("tests/acceptance/test.ts", "tests/acceptance/**"), true);
});

test("reconcileTreeEffects passes when changes are declared and conform to policy", () => {
  const result = reconcileTreeEffects({
    baseTreeSha: "1111111111111111111111111111111111111111",
    postTreeSha: "2222222222222222222222222222222222222222",
    actualChangedFiles: ["src/index.ts", "src/server.ts"],
    declaredChangedFiles: ["src/index.ts", "src/server.ts"],
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md", ".github/**", "tests/acceptance/**"]
  });

  assert.equal(result.passed, true);
  assert.equal(result.undeclaredTouches.length, 0);
  assert.equal(result.immutableViolations.length, 0);
  assert.equal(result.unallowedTouches.length, 0);
});

test("reconcileTreeEffects rejects runs with undeclared file touches", () => {
  const result = reconcileTreeEffects({
    baseTreeSha: "1111111111111111111111111111111111111111",
    postTreeSha: "2222222222222222222222222222222222222222",
    actualChangedFiles: ["src/index.ts", "src/server.ts", "src/secret.ts"],
    declaredChangedFiles: ["src/index.ts", "src/server.ts"], // secret.ts not declared!
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"]
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.undeclaredTouches, ["src/secret.ts"]);
  assert.ok(result.rejectionReason?.includes("Undeclared file touches"));
});

test("reconcileTreeEffects rejects modifications to immutable paths (e.g. AGENTS.md)", () => {
  const result = reconcileTreeEffects({
    baseTreeSha: "1111111111111111111111111111111111111111",
    postTreeSha: "2222222222222222222222222222222222222222",
    actualChangedFiles: ["src/index.ts", "AGENTS.md"],
    declaredChangedFiles: ["src/index.ts", "AGENTS.md"],
    allowedPaths: ["src/**", "AGENTS.md"],
    immutablePaths: ["AGENTS.md", ".github/**"]
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.immutableViolations, ["AGENTS.md"]);
  assert.ok(result.rejectionReason?.includes("Immutable path violations"));
});

test("reconcileTreeEffects rejects modifications outside allowed paths", () => {
  const result = reconcileTreeEffects({
    baseTreeSha: "1111111111111111111111111111111111111111",
    postTreeSha: "2222222222222222222222222222222222222222",
    actualChangedFiles: ["infra/terraform/main.tf"],
    declaredChangedFiles: ["infra/terraform/main.tf"],
    allowedPaths: ["src/**"],
    immutablePaths: ["AGENTS.md"]
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.unallowedTouches, ["infra/terraform/main.tf"]);
  assert.ok(result.rejectionReason?.includes("Unallowed path touches"));
});
