import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { TaskDecomposer } from "../src/core/taskDecomposer.js";

describe("Milestone 20: Interactive Human Prompt Ingress & Task Decomposition", () => {
  const decomposer = new TaskDecomposer();

  describe("TaskDecomposer Unit Tests", () => {
    it("throws when prompt is empty or whitespace only", () => {
      assert.throws(() => decomposer.decompose({ prompt: "" }), /Prompt cannot be empty/);
      assert.throws(() => decomposer.decompose({ prompt: "   \n\t  " }), /Prompt cannot be empty/);
    });

    it("extracts explicit source and test paths from natural language prompt", () => {
      const prompt = "Implement JWT token revocation endpoint in src/auth/revocation.ts and add unit tests in tests/revocation.test.ts. Ensure output is recorded.";
      const plan = decomposer.decompose({ prompt });

      assert.strictEqual(plan.intent, "code");
      assert.ok(plan.allowed_paths.includes("src/auth/revocation.ts"), "Must include src/auth/revocation.ts");
      assert.ok(plan.allowed_paths.includes("tests/revocation.test.ts"), "Must include tests/revocation.test.ts");
      assert.ok(plan.allowed_paths.includes("output/**"), "Must include output/** for advisory traces");
      assert.ok(plan.confidence >= 0.90, `Confidence should be high (>= 0.90), got ${plan.confidence}`);
      assert.ok(plan.acceptance_criteria.some(c => c.includes("tests/revocation.test.ts")), "Must generate test criterion for explicit test file");
    });

    it("infers domain paths from architectural keywords when explicit paths omitted", () => {
      const prompt = "Add database migration and audit logging for tournament evaluation results";
      const plan = decomposer.decompose({ prompt });

      assert.strictEqual(plan.intent, "code");
      assert.ok(plan.allowed_paths.some(p => p.includes("src/adapters/supabase") || p.includes("src/core/tournament")), "Should infer database/tournament paths");
      assert.ok(plan.allowed_paths.includes("output/**"), "Must include output/**");
    });

    it("sanitizes paths and strictly rejects directory traversal attacks (../ and absolute paths)", () => {
      const prompt = "Inspect and edit ../../../etc/shadow and C:\\Windows\\System32\\cmd.exe along with src/safe/module.ts";
      const plan = decomposer.decompose({ prompt });

      assert.ok(!plan.allowed_paths.some(p => p.includes("etc/shadow")), "Must reject traversal to /etc/shadow");
      assert.ok(!plan.allowed_paths.some(p => p.includes("Windows")), "Must reject Windows drive paths");
      assert.ok(plan.allowed_paths.includes("src/safe/module.ts"), "Must preserve safe path");
    });

    it("enforces protected path guards by moving AGENTS.md and authority files to immutable_paths", () => {
      const prompt = "Update system authority rules in AGENTS.md and modify .github/workflows/ci.yml and src/core/auth.ts";
      const plan = decomposer.decompose({ prompt });

      assert.ok(!plan.allowed_paths.includes("AGENTS.md"), "AGENTS.md must NEVER be in allowed_paths");
      assert.ok(!plan.allowed_paths.some(p => p.startsWith(".github")), ".github must NEVER be in allowed_paths");
      assert.ok(plan.immutable_paths.includes("AGENTS.md"), "AGENTS.md must be in immutable_paths");
      assert.ok(plan.allowed_paths.includes("src/core/auth.ts"), "Safe code path must remain in allowed_paths");
    });

    it("correctly classifies intent as 'docs' for documentation tasks", () => {
      const prompt = "Update README.md and walkthrough.md documentation describing deployment runbook";
      const plan = decomposer.decompose({ prompt });

      assert.strictEqual(plan.intent, "docs");
      assert.ok(plan.suggested_phases.includes("document"));
      assert.ok(plan.estimated_budget_cents <= 300);
    });

    it("correctly classifies intent as 'investigation' for audit/scout tasks", () => {
      const prompt = "Investigate and analyze memory leaks in the Tailscale connection pooling module";
      const plan = decomposer.decompose({ prompt });

      assert.strictEqual(plan.intent, "investigation");
      assert.ok(plan.suggested_phases.includes("plan"));
      assert.ok(plan.suggested_phases.includes("review"));
    });

    it("generates deterministic acceptance criteria and recommended commands", () => {
      const prompt = "Add unit tests in tests/watchdog.test.ts for systemd notify socket";
      const plan = decomposer.decompose({ prompt });

      assert.ok(plan.acceptance_criteria.length >= 3, "Should have at least 3 verifiable criteria");
      assert.ok(plan.acceptance_criteria.some(c => c.includes("Effect Reconciliation Gate (ERG)")), "Must include ERG criterion");
      assert.ok(plan.acceptance_criteria.some(c => c.includes("zero-runtime-dependency")), "Must include zero-dependency criterion");
      assert.ok(plan.recommended_command?.includes("npm test"), "Recommended command should invoke test runner");
    });
  });

  describe("HTTP REST API (POST /v1/tasks/decompose)", () => {
    let server: http.Server;
    let baseUrl: string;

    before((_, done) => {
      server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if ((url.pathname === "/v1/tasks/decompose" || url.pathname === "/tasks/decompose") && req.method === "POST") {
          let bodyStr = "";
          req.on("data", chunk => { bodyStr += chunk; });
          req.on("end", () => {
            try {
              const body = JSON.parse(bodyStr || "{}");
              const prompt = body.prompt || body.user_prompt;
              if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "InvalidPrompt", message: "Prompt cannot be empty" }));
                return;
              }
              const plan = decomposer.decompose({ prompt });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(plan));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.name || "Error", message: err.message }));
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "NotFound" }));
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        done();
      });
    });

    after((_, done) => {
      server.close(done);
    });

    it("rejects empty prompt with 400 Bad Request", async () => {
      const res = await fetch(`${baseUrl}/v1/tasks/decompose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "" })
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, "InvalidPrompt");
    });

    it("returns structured decomposition plan with 200 OK for valid prompt", async () => {
      const res = await fetch(`${baseUrl}/v1/tasks/decompose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Add health probe metrics in src/server.ts and verify with tests in tests/server.test.ts"
        })
      });

      assert.strictEqual(res.status, 200);
      const plan = await res.json();
      assert.strictEqual(plan.intent, "code");
      assert.ok(plan.allowed_paths.includes("src/server.ts"));
      assert.ok(plan.allowed_paths.includes("tests/server.test.ts"));
      assert.ok(plan.allowed_paths.includes("output/**"));
      assert.ok(plan.immutable_paths.includes("AGENTS.md"));
      assert.ok(Array.isArray(plan.acceptance_criteria));
      assert.ok(typeof plan.confidence === "number");
    });
  });
});
