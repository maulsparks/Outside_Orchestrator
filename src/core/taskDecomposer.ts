/**
 * Task Decomposition Engine
 *
 * Implements Outside Orchestrator Role Contract v2 §4, §6.1, §6.2, & §6.6.
 * Ingests rich, freeform human task prompts and decomposes them into:
 * 1. Strictly bounded allowed_paths (least-privilege glob set conforming to zero-tolerance ERG).
 * 2. Immutable/protected paths preventing privilege escalation (e.g. AGENTS.md).
 * 3. Frozen, verifiable acceptance criteria.
 * 4. Recommended commands, phases, budget, and sandbox TTL.
 *
 * Strict zero-runtime-dependency implementation.
 */

export interface DecomposeTaskRequest {
  prompt: string;
  repositoryContext?: string;
  targetBranch?: string;
  existingFiles?: string[];
}

export interface DecomposedTaskPlan {
  title: string;
  intent: "code" | "test" | "docs" | "review" | "investigation";
  allowed_paths: string[];
  immutable_paths: string[];
  acceptance_criteria: string[];
  recommended_command?: string;
  execution_kind: "code" | "agent";
  suggested_phases: Array<"plan" | "build" | "test" | "review" | "document">;
  estimated_budget_cents: number;
  recommended_ttl_seconds: number;
  reasoning: string;
  confidence: number;
}

// Protected paths that can NEVER be modified by execution sandboxes
const PROTECTED_PATHS = [
  "AGENTS.md",
  ".github/**",
  ".git/**",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".env",
  ".env.*",
  "/etc/**",
  "node_modules/**"
];

// Architectural domain mapping
const DOMAIN_MAP: Record<string, { paths: string[]; tests?: string[] }> = {
  auth: {
    paths: ["src/auth/**", "src/core/auth/**"],
    tests: ["tests/auth.test.ts", "tests/jwt.test.ts"]
  },
  jwt: {
    paths: ["src/core/jwt.ts", "src/auth/**"],
    tests: ["tests/jwt.test.ts"]
  },
  server: {
    paths: ["src/server.ts", "src/routes/**"],
    tests: ["tests/server.test.ts", "tests/api.test.ts"]
  },
  ui: {
    paths: ["src/ui/**"],
    tests: ["tests/ui.test.ts"]
  },
  dashboard: {
    paths: ["src/ui/dashboardHtml.ts", "src/ui/**"],
    tests: ["tests/ui.test.ts"]
  },
  db: {
    paths: ["src/adapters/supabase/**", "src/core/store/**"],
    tests: ["tests/supabase.test.ts"]
  },
  database: {
    paths: ["src/adapters/supabase/**", "src/core/store/**"],
    tests: ["tests/supabase.test.ts"]
  },
  tournament: {
    paths: ["src/core/tournament.ts", "src/adapters/supabase/tournamentRepo.ts"],
    tests: ["tests/tournament.test.ts"]
  },
  tailscale: {
    paths: ["src/core/tailscalePruner.ts", "src/adapters/tailscale/**"],
    tests: ["tests/tailscale.test.ts", "tests/tailscalePruner.test.ts"]
  },
  warden: {
    paths: ["src/warden/**"],
    tests: ["tests/warden.test.ts"]
  },
  deploy: {
    paths: ["src/core/continuousDeployment.ts", "scripts/deploy.sh"],
    tests: ["tests/prMergeAndDeploy.test.ts"]
  },
  pr: {
    paths: ["src/adapters/github/prPublisher.ts", "src/core/prMergeCoordinator.ts"],
    tests: ["tests/prMergeAndDeploy.test.ts"]
  },
  merge: {
    paths: ["src/core/prMergeCoordinator.ts", "scripts/merge-and-deploy-pr.ts"],
    tests: ["tests/prMergeAndDeploy.test.ts"]
  },
  test: {
    paths: ["tests/**"],
    tests: ["tests/**"]
  },
  docs: {
    paths: ["docs/**", "README.md", "walkthrough.md"],
    tests: []
  }
};

export class TaskDecomposer {
  /**
   * Analyzes and decomposes a human prompt into bounded factory execution parameters.
   */
  public decompose(request: DecomposeTaskRequest): DecomposedTaskPlan {
    const prompt = (request.prompt || "").trim();
    if (!prompt) {
      throw new Error("Prompt cannot be empty");
    }

    const lowerPrompt = prompt.toLowerCase();

    const firstLine = prompt.split("\n")[0].trim();
    const title = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;

    // 1. Extract Explicit File and Directory Paths
    const explicitPaths = this.extractExplicitPaths(prompt);

    const hasSourceTarget = explicitPaths.some(p => p.startsWith("src/") || p.endsWith(".ts") || p.endsWith(".js"));
    const isOnlyDocs = explicitPaths.length > 0 && explicitPaths.every(p => p.endsWith(".md") || p.startsWith("docs/"));
    const hasCodeAction = /\b(add|implement|create|build|write|fix|patch|refactor|develop)\b/i.test(prompt);

    let intent: DecomposedTaskPlan["intent"] = "code";
    let suggestedPhases: DecomposedTaskPlan["suggested_phases"] = ["build", "test"];
    let executionKind: DecomposedTaskPlan["execution_kind"] = "code";
    let estimatedBudgetCents = 500;
    let recommendedTtlSeconds = 300;

    if (/\b(tournament|compare|pareto|multi-arm)\b/i.test(prompt)) {
      intent = "code";
      suggestedPhases = ["plan", "build", "test", "review"];
      executionKind = "code";
      estimatedBudgetCents = 1000;
      recommendedTtlSeconds = 600;
    } else if (isOnlyDocs || (/\b(docs?|document\w*|readme|markdown|guide\w*|walkthrough\w*)\b/i.test(prompt) && !hasSourceTarget && !/\b(code|api|endpoint|server)\b/i.test(prompt))) {
      intent = "docs";
      suggestedPhases = ["document"];
      executionKind = "code";
      estimatedBudgetCents = 200;
      recommendedTtlSeconds = 180;
    } else if (/\b(investigat\w*|analy\w*|audit\w*|inspect\w*|diagno\w*|scout\w*)\b/i.test(prompt) && !hasCodeAction) {
      intent = "investigation";
      suggestedPhases = ["plan", "review"];
      executionKind = "code";
      estimatedBudgetCents = 400;
      recommendedTtlSeconds = 240;
    } else if (/\b(tests?|specs?|coverage|benchmark\w*)\b/i.test(prompt) && !hasCodeAction && !hasSourceTarget) {
      intent = "test";
      suggestedPhases = ["build", "test"];
      executionKind = "code";
      estimatedBudgetCents = 350;
      recommendedTtlSeconds = 240;
    }

    // 3. Domain & Keyword Inferences
    const inferredPaths: string[] = [];
    const inferredTests: string[] = [];
    for (const [keyword, mapping] of Object.entries(DOMAIN_MAP)) {
      const regex = new RegExp(`\\b${keyword}\\b`, "i");
      if (regex.test(prompt)) {
        inferredPaths.push(...mapping.paths);
        if (mapping.tests) {
          inferredTests.push(...mapping.tests);
        }
      }
    }

    // 4. Combine and Filter Allowed Paths
    const rawAllowed = new Set<string>();
    for (const p of explicitPaths) {
      rawAllowed.add(p);
    }
    for (const p of inferredPaths) {
      rawAllowed.add(p);
    }

    // Default fallback if no paths detected
    if (rawAllowed.size === 0) {
      if (intent === "docs") {
        rawAllowed.add("docs/**");
        rawAllowed.add("README.md");
      } else if (intent === "test") {
        rawAllowed.add("tests/**");
      } else {
        rawAllowed.add("src/**");
        rawAllowed.add("tests/**");
      }
    }

    // Always ensure sandbox can write advisory output
    rawAllowed.add("output/**");

    // Security Confinement: Strip protected paths, sanitize traversals
    const allowedPaths: string[] = [];
    const immutablePaths: string[] = ["AGENTS.md"];

    for (const path of Array.from(rawAllowed)) {
      const sanitized = this.sanitizePath(path);
      if (!sanitized) continue;

      if (this.isProtectedPath(sanitized)) {
        if (!immutablePaths.includes(sanitized)) {
          immutablePaths.push(sanitized);
        }
      } else {
        allowedPaths.push(sanitized);
      }
    }

    // Sort allowed paths deterministically
    allowedPaths.sort();

    // 5. Generate Verifiable Acceptance Criteria
    const acceptanceCriteria: string[] = [];

    if (explicitPaths.some(p => p.startsWith("test") || p.endsWith(".test.ts"))) {
      const testFiles = explicitPaths.filter(p => p.startsWith("test") || p.endsWith(".test.ts"));
      acceptanceCriteria.push(`Target test suite passes without error: npm test ${testFiles.join(" ")}`);
    } else if (inferredTests.length > 0) {
      acceptanceCriteria.push(`Related test suites pass: npm test ${inferredTests.slice(0, 2).join(" ")}`);
    } else {
      acceptanceCriteria.push("Full automated test suite passes: npm test");
    }

    if (intent === "code") {
      acceptanceCriteria.push("TypeScript typecheck compiles without errors: npm run check");
    }

    acceptanceCriteria.push("Effect Reconciliation Gate (ERG) reports zero undeclared file touches");
    acceptanceCriteria.push("Strict zero-runtime-dependency constraint satisfied: dependencies: {}");

    // 6. Recommended Command
    let recommendedCommand = "npm test";
    if (explicitPaths.some(p => p.endsWith(".test.ts"))) {
      const targetTest = explicitPaths.find(p => p.endsWith(".test.ts"));
      recommendedCommand = `npm test ${targetTest}`;
    } else if (intent === "docs") {
      recommendedCommand = "ls -la docs/";
    }

    // 7. Reasoning and Confidence Calculation
    let confidence = 0.85;
    const reasoningParts: string[] = [];

    if (explicitPaths.length > 0) {
      reasoningParts.push(`Extracted ${explicitPaths.length} explicit path reference(s) from prompt (${explicitPaths.slice(0, 3).join(", ")}).`);
      confidence += 0.10;
    } else {
      reasoningParts.push("Inferred candidate paths from domain keywords.");
      confidence -= 0.05;
    }

    reasoningParts.push(`Classified intent as '${intent}'. Bounded allowed_paths to ${allowedPaths.length} target(s) including 'output/**' for advisory traces.`);
    reasoningParts.push(`Enforced immutable boundary on ${immutablePaths.join(", ")}.`);

    confidence = Math.min(1.0, Math.max(0.5, Number(confidence.toFixed(2))));

    return {
      title,
      intent,
      allowed_paths: allowedPaths,
      immutable_paths: immutablePaths,
      acceptance_criteria: acceptanceCriteria,
      recommended_command: recommendedCommand,
      execution_kind: executionKind,
      suggested_phases: suggestedPhases,
      estimated_budget_cents: estimatedBudgetCents,
      recommended_ttl_seconds: recommendedTtlSeconds,
      reasoning: reasoningParts.join(" "),
      confidence
    };
  }

  /**
   * Extracts explicit paths mentioned in prompt using pattern matching.
   */
  private extractExplicitPaths(text: string): string[] {
    const paths: string[] = [];

    // Match patterns like:
    // - src/foo/bar.ts
    // - tests/baz.test.ts
    // - scripts/run.sh
    // - docs/index.md
    // - src/core/**
    const regex = /(?:^|[\s"'`([<{])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*(?:\.[a-zA-Z0-9]+|\/\*\*|\/\*|\/)?)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      let candidate = match[1];
      if (!candidate) continue;
      candidate = candidate.replace(/[.,;:!?)]+$/, "");
      if (
        candidate &&
        (candidate.includes("/") || candidate.endsWith(".ts") || candidate.endsWith(".js") || candidate.endsWith(".md") || candidate.endsWith(".json")) &&
        !candidate.startsWith("http://") &&
        !candidate.startsWith("https://") &&
        !candidate.includes("://") &&
        candidate.length > 2
      ) {
        paths.push(candidate);
      }
    }

    return Array.from(new Set(paths));
  }

  /**
   * Sanitizes a candidate path, stripping traversals and dangerous characters.
   */
  private sanitizePath(path: string): string | null {
    let clean = path.trim().replace(/^[\/\\]+/, "").replace(/^\.\//, "");

    // Path traversal check
    if (clean.includes("..") || clean.includes(":") || clean.startsWith("~")) {
      return null;
    }

    // Strip trailing slash if not wildcard
    if (clean.endsWith("/") && !clean.endsWith("/**") && !clean.endsWith("/*")) {
      clean = clean + "**";
    }

    return clean.length > 0 ? clean : null;
  }

  /**
   * Checks if a path is in the protected immutable list.
   */
  private isProtectedPath(path: string): boolean {
    if (path === "AGENTS.md") return true;
    for (const protectedGlob of PROTECTED_PATHS) {
      if (protectedGlob === path) return true;
      if (protectedGlob.endsWith("/**")) {
        const prefix = protectedGlob.slice(0, -3);
        if (path === prefix || path.startsWith(prefix + "/")) return true;
      }
    }
    return false;
  }
}
