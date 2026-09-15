import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  GitHubPrPublisher,
  formatIssueAcknowledgmentComment,
  formatIssueCompletionComment
} from "../src/adapters/github/prPublisher.js";
import { PrMergeCoordinator } from "../src/core/prMergeCoordinator.js";
import { ContinuousDeploymentEngine } from "../src/core/continuousDeployment.js";
import { TaskDecomposer } from "../src/core/taskDecomposer.js";
import { RequestAdmissionEngine, AdmissionResult, CreateRunRequest } from "../src/core/ingress.js";
import { LiveSandboxRunner, LiveSandboxRunOptions, LiveSandboxRunResult } from "../src/core/liveRunner.js";

describe("Milestone 21: GitHub Issue Webhook Ingress & PR Feedback Loop", () => {
  describe("GitHubPrPublisher Issue API Extensions", () => {
    it("formats structured issue acknowledgment comment with parameters and bounds", () => {
      const comment = formatIssueAcknowledgmentComment({
        runId: "run-issue-42-test",
        intent: "code",
        confidence: 0.95,
        allowedPaths: ["src/server.ts", "tests/server.test.ts", "output/**"],
        immutablePaths: ["AGENTS.md", ".github/**", "package.json"],
        acceptanceCriteria: [
          "Target test suite passes without error: npm test tests/server.test.ts",
          "TypeScript typecheck compiles without errors: npm run check"
        ],
        suggestedPhases: ["build", "test"],
        estimatedBudgetCents: 500
      });

      assert.ok(comment.includes("run-issue-42-test"));
      assert.ok(comment.includes("CODE"));
      assert.ok(comment.includes("95%"));
      assert.ok(comment.includes("`src/server.ts`"));
      assert.ok(comment.includes("`AGENTS.md`"));
      assert.ok(comment.includes("- [ ] Target test suite passes"));
      assert.ok(comment.includes("$5.00"));
    });

    it("formats structured issue completion comment with PR link and ERG metrics", () => {
      const comment = formatIssueCompletionComment({
        runId: "run-issue-42-test",
        prNumber: 99,
        prUrl: "https://github.com/maulsparks/Outside_Orchestrator/pull/99",
        branch: "factory/run-issue-42-test",
        undeclaredTouchesCount: 0,
        testPassRate: 1.0,
        durationMs: 4200
      });

      assert.ok(comment.includes("[PR #99](https://github.com/maulsparks/Outside_Orchestrator/pull/99)"));
      assert.ok(comment.includes("factory/run-issue-42-test"));
      assert.ok(comment.includes("Effect Reconciliation Gate (ERG)"));
      assert.ok(comment.includes("0 undeclared touches"));
      assert.ok(comment.includes("100% pass rate"));
      assert.ok(comment.includes("4.2s"));
    });

    it("createIssueComment posts to GitHub Issues REST API", async () => {
      let requestedUrl = "";
      let requestedMethod = "";
      let requestedBody: any = null;

      const mockFetch: typeof fetch = async (url: any, init: any) => {
        requestedUrl = String(url);
        requestedMethod = init?.method;
        requestedBody = JSON.parse(init?.body || "{}");
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 12345, html_url: "https://github.com/maulsparks/Outside_Orchestrator/issues/42#issuecomment-12345" })
        } as any;
      };

      const publisher = new GitHubPrPublisher({
        token: "ghp_mocktoken",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const result = await publisher.createIssueComment({
        issueNumber: 42,
        body: "Test comment content"
      });

      assert.ok(result);
      assert.strictEqual(result.id, 12345);
      assert.strictEqual(requestedMethod, "POST");
      assert.ok(requestedUrl.includes("/repos/maulsparks/Outside_Orchestrator/issues/42/comments"));
      assert.strictEqual(requestedBody.body, "Test comment content");
    });

    it("addIssueLabels and removeIssueLabel call GitHub Labels API", async () => {
      const calls: { url: string; method: string; body?: any }[] = [];

      const mockFetch: typeof fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(init.body) : undefined
        });
        return {
          ok: true,
          status: 200,
          json: async () => [{ name: "factory-in-progress" }]
        } as any;
      };

      const publisher = new GitHubPrPublisher({
        token: "ghp_mocktoken",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const added = await publisher.addIssueLabels({
        issueNumber: 42,
        labels: ["factory-in-progress"]
      });
      assert.deepStrictEqual(added, ["factory-in-progress"]);
      assert.strictEqual(calls[0].method, "POST");
      assert.ok(calls[0].url.includes("/issues/42/labels"));

      const removed = await publisher.removeIssueLabel({
        issueNumber: 42,
        label: "factory-in-progress"
      });
      assert.strictEqual(removed, true);
      assert.strictEqual(calls[1].method, "DELETE");
      assert.ok(calls[1].url.includes("/issues/42/labels/factory-in-progress"));
    });
  });

  describe("PrMergeCoordinator Issue Trigger Flow", () => {
    it("autonomously triggers on 'issues.labeled' with 'factory-run', decomposes prompt, admits run, and posts feedback", async () => {
      const postedComments: string[] = [];
      const addedLabels: string[][] = [];
      const removedLabels: string[] = [];

      const mockFetch: typeof fetch = async (url: any, init: any) => {
        const u = String(url);
        if (init?.method === "POST" && u.includes("/comments")) {
          const b = JSON.parse(init.body);
          postedComments.push(b.body);
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: postedComments.length, html_url: `https://github.com/test/issues/10#comment-${postedComments.length}` })
          } as any;
        }
        if (init?.method === "POST" && u.includes("/labels")) {
          const b = JSON.parse(init.body);
          addedLabels.push(b.labels);
          return {
            ok: true,
            status: 200,
            json: async () => b.labels.map((l: string) => ({ name: l }))
          } as any;
        }
        if (init?.method === "DELETE" && u.includes("/labels/")) {
          const label = decodeURIComponent(u.split("/").pop() || "");
          removedLabels.push(label);
          return { ok: true, status: 200 } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      };

      const publisher = new GitHubPrPublisher({
        token: "ghp_test",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const deploymentEngine = new ContinuousDeploymentEngine({});
      const taskDecomposer = new TaskDecomposer();

      let admittedRequest: CreateRunRequest | null = null;
      const mockAdmissionEngine = {
        admitRequest: async (req: CreateRunRequest): Promise<AdmissionResult> => {
          admittedRequest = req;
          return {
            isExisting: false,
            run: {
              runId: req.requestId?.replace("req-", "run-") || "run-test",
              tenantId: req.tenantId,
              requestId: req.requestId,
              parentGitSha: req.parentGitSha,
              policyVersion: req.policyVersion,
              phase: "build",
              phaseAttempt: 1,
              stateVersion: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              envelope: {
                task: req.userPrompt,
                acceptance_criteria: req.acceptanceCriteria
              }
            } as any,
            lease: {
              runId: req.requestId?.replace("req-", "run-") || "run-test",
              fencingToken: 1,
              expiresAt: new Date(Date.now() + 60000)
            } as any
          };
        }
      } as unknown as RequestAdmissionEngine;

      let liveRunExecuted: LiveSandboxRunOptions | null = null;
      const mockLiveRunner = {
        executeLiveRun: async (options: LiveSandboxRunOptions): Promise<LiveSandboxRunResult> => {
          liveRunExecuted = options;
          return {
            runId: options.runId || "test-run",
            tenantId: options.tenantId || "tenant-test",
            status: "completed",
            cleanTerminated: true,
            phase: "build",
            phaseAttempt: 1,
            dispatchResult: {
              status: "completed",
              phase: "build",
              phaseAttempt: 1,
              exitCode: 0,
              durationMs: 3500
            } as any,
            branch: `factory/${options.runId}`,
            prNumber: 55,
            prUrl: "https://github.com/maulsparks/Outside_Orchestrator/pull/55",
            prStatus: "created"
          };
        }
      } as unknown as LiveSandboxRunner;

      const coordinator = new PrMergeCoordinator({
        githubPublisher: publisher,
        deploymentEngine,
        taskDecomposer,
        admissionEngine: mockAdmissionEngine,
        liveRunner: mockLiveRunner,
        webhookSecret: "super-secret-test-key"
      });

      const payload = {
        action: "labeled",
        issue: {
          number: 10,
          title: "Implement JWT expiration check in src/core/jwt.ts",
          body: "Please add jwt token expiration tests in tests/jwt.test.ts",
          updated_at: "2026-09-15T10:00:00Z",
          labels: [{ name: "factory-run" }]
        },
        label: { name: "factory-run" },
        repository: { full_name: "maulsparks/Outside_Orchestrator" }
      };

      const result = await coordinator.handleWebhookEvent("issues", payload);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.issueNumber, 10);
      assert.strictEqual(result.prNumber, 55);
      assert.strictEqual(result.prUrl, "https://github.com/maulsparks/Outside_Orchestrator/pull/55");

      // Verify prompt decomposition and admission
      assert.ok(admittedRequest);
      assert.ok((admittedRequest as any).acceptanceCriteria.some((c: string) => c.includes("jwt.test.ts")));
      assert.strictEqual((admittedRequest as any).intent, "code");

      // Verify liveRunner dispatch
      assert.ok(liveRunExecuted);
      assert.strictEqual((liveRunExecuted as any).issueNumber, 10);
      assert.ok((liveRunExecuted as any).allowedPaths.includes("src/core/jwt.ts"));
      assert.ok((liveRunExecuted as any).allowedPaths.includes("tests/jwt.test.ts"));

      // Verify comments: first acknowledgment comment, then completion comment
      assert.strictEqual(postedComments.length, 2);
      assert.ok(postedComments[0].includes("Factory Run Initiated"));
      assert.ok(postedComments[0].includes("`src/core/jwt.ts`"));
      assert.ok(postedComments[1].includes("Factory Run Completed & Pull Request Published"));
      assert.ok(postedComments[1].includes("PR #55"));

      // Verify label transitions
      assert.deepStrictEqual(addedLabels[0], ["factory-in-progress"]);
      assert.strictEqual(removedLabels[0], "factory-in-progress");
      assert.deepStrictEqual(addedLabels[1], ["factory-pr-created"]);
    });

    it("triggers on 'issue_comment.created' with '/factory-run' command", async () => {
      const postedComments: string[] = [];
      const mockFetch: typeof fetch = async (url: any, init: any) => {
        if (init?.method === "POST" && String(url).includes("/comments")) {
          postedComments.push(JSON.parse(init.body).body);
        }
        return { ok: true, status: 200, json: async () => ({ id: 1 }) } as any;
      };

      const publisher = new GitHubPrPublisher({
        token: "ghp_test",
        fetchFn: mockFetch
      });

      const taskDecomposer = new TaskDecomposer();
      let admitted = false;
      const mockAdmissionEngine = {
        admitRequest: async (req: CreateRunRequest): Promise<AdmissionResult> => {
          admitted = true;
          return {
            isExisting: false,
            run: { runId: "run-comment-test", envelope: {} } as any,
            lease: { fencingToken: 1, expiresAt: new Date(Date.now() + 60000) } as any
          };
        }
      } as unknown as RequestAdmissionEngine;

      const coordinator = new PrMergeCoordinator({
        githubPublisher: publisher,
        deploymentEngine: new ContinuousDeploymentEngine({}),
        taskDecomposer,
        admissionEngine: mockAdmissionEngine
      });

      const payload = {
        action: "created",
        issue: {
          number: 15,
          title: "Refactor Tailscale connection pooling",
          body: "Improve retry handling in src/adapters/tailscale/client.ts"
        },
        comment: {
          body: "/factory-run please also include tests in tests/tailscale.test.ts"
        },
        repository: { full_name: "maulsparks/Outside_Orchestrator" }
      };

      const result = await coordinator.handleWebhookEvent("issue_comment", payload);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(admitted, true);
      assert.strictEqual(postedComments.length, 1);
      assert.ok(postedComments[0].includes("Factory Run Initiated"));
    });

    it("ignores issues with unrelated labels", async () => {
      const coordinator = new PrMergeCoordinator({
        githubPublisher: new GitHubPrPublisher({ token: "test" }),
        deploymentEngine: new ContinuousDeploymentEngine({})
      });

      const payload = {
        action: "labeled",
        issue: { number: 99, title: "Question about docs" },
        label: { name: "documentation" }
      };

      const result = await coordinator.handleWebhookEvent("issues", payload);
      assert.strictEqual(result.handled, false);
      assert.ok(result.message?.includes("ignored"));
    });

    it("validates HMAC-SHA256 signature on webhook request payload", () => {
      const coordinator = new PrMergeCoordinator({
        githubPublisher: new GitHubPrPublisher({ token: "test" }),
        deploymentEngine: new ContinuousDeploymentEngine({}),
        webhookSecret: "my-webhook-secret"
      });

      const payload = JSON.stringify({ action: "labeled", issue: { number: 1 } });
      const hmac = crypto.createHmac("sha256", "my-webhook-secret").update(payload).digest("hex");
      const validSig = `sha256=${hmac}`;

      assert.strictEqual(coordinator.verifyWebhookSignature(payload, validSig), true);
      assert.strictEqual(coordinator.verifyWebhookSignature(payload, "sha256=invalidhex"), false);
      assert.strictEqual(coordinator.verifyWebhookSignature(payload, undefined), false);
    });
  });
});
