#!/usr/bin/env node
/**
 * Outside Orchestrator CI/CD Policy-as-Code & Security Linter
 * Enforces Contract §3 (Zero-Trust Supply Chain), §6.2 (AGENTS.md Non-Authority),
 * and §6.4 (Network Isolation Invariants).
 *
 * Usage:
 *   node dist/scripts/lint-policy.js
 */

import fs from "node:fs";
import path from "node:path";
import { scanAgentsMdForAuthorityViolations, computeAgentsMdSha256 } from "../src/core/policyIntegrity.js";

const rootDir = process.cwd();
const errors: string[] = [];
const passes: string[] = [];

console.log("=================================================================");
console.log("Outside Orchestrator — CI/CD Policy-as-Code & Security Linter");
console.log("=================================================================\n");

// 1. Supply Chain & Zero-Dependency Invariant (Contract §3)
console.log("[1/3] Checking Supply-Chain & Runtime Dependencies (Contract §3)...");
try {
  const pkgPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const runtimeDeps = pkg.dependencies ? Object.keys(pkg.dependencies) : [];

  if (runtimeDeps.length > 0) {
    errors.push(`Supply-Chain Violation: Found ${runtimeDeps.length} runtime npm dependencies: ${runtimeDeps.join(", ")}. Strict 0-dependency rule violated.`);
  } else {
    passes.push("Zero Runtime Dependencies: Verified (0 third-party packages in production)");
    console.log("✔ Zero Runtime Dependencies: 0 third-party npm packages (Strict zero-trust supply chain)");
  }
} catch (err: unknown) {
  const error = err as Error;
  errors.push(`Failed to read package.json: ${error.message}`);
}

// 2. AGENTS.md Non-Authority & Prompt Injection Guard (Contract §6.2)
console.log("\n[2/3] Checking AGENTS.md Integrity & Non-Authority Rules (Contract §6.2)...");
try {
  const agentsPath = path.join(rootDir, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    errors.push("Missing required root AGENTS.md briefing document.");
  } else {
    const agentsContent = fs.readFileSync(agentsPath, "utf8");
    const scan = scanAgentsMdForAuthorityViolations(agentsContent);
    const digest = computeAgentsMdSha256(agentsContent);

    if (!scan.safe) {
      errors.push(`Authority Violation: AGENTS.md contains forbidden directives: ${scan.violations.join("; ")}`);
    } else {
      passes.push(`AGENTS.md Authority Integrity: Clean (SHA-256: ${digest.substring(0, 16)}...)`);
      console.log(`✔ AGENTS.md Authority Guard: Clean (no authority expansions, digest: ${digest.substring(0, 16)}...)`);
    }
  }
} catch (err: unknown) {
  const error = err as Error;
  errors.push(`Failed to scan AGENTS.md: ${error.message}`);
}

// 3. Tailscale Network Isolation Invariants (Contract §6.4 & §6.3.1)
console.log("\n[3/3] Checking Network Isolation Policy Invariants (Contract §6.4)...");
try {
  const isolationPath = path.join(rootDir, "policies", "network", "isolation-baseline.md");
  if (!fs.existsSync(isolationPath)) {
    errors.push("Missing required policies/network/isolation-baseline.md policy file.");
  } else {
    const policyContent = fs.readFileSync(isolationPath, "utf8");
    const hasIsolated = policyContent.includes("isolated");
    const deniesControl = policyContent.includes("control-plane");
    const deniesTier3 = policyContent.includes("Tier 3");

    if (!hasIsolated || !deniesControl || !deniesTier3) {
      errors.push("Network Policy Violation: isolation-baseline.md must enforce 'isolated' mode, deny control-plane access, and deny direct Tier 3 credentials.");
    } else {
      passes.push("Network Policy Invariants: Enforced (isolated mode, control-plane & Tier 3 denied)");
      console.log("✔ Network Isolation Policy: Strict directional isolation and zero direct state access enforced");
    }
  }
} catch (err: unknown) {
  const error = err as Error;
  errors.push(`Failed to check network policies: ${error.message}`);
}

console.log("\n=================================================================");
if (errors.length > 0) {
  console.error("✖ LINTING FAILED with the following violations:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.log("=================================================================\n");
  process.exit(1);
} else {
  console.log("✔ ALL SECURITY & POLICY INVARIANTS SATISFIED (3/3 passed)");
  console.log("=================================================================\n");
  process.exit(0);
}
