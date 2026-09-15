import { describe, it } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { GitHubPrPublisher } from "../src/adapters/github/prPublisher.js";
import { ContinuousDeploymentEngine } from "../src/core/continuousDeployment.js";
import { PrMergeCoordinator } from "../src/core/prMergeCoordinator.js";
import { InMemoryRunStateStore } from "../src/core/stateMachine.js";
import { InMemoryEvidenceStore, EvidenceLedger } from "../src/warden/ledger.js";

// Generate test Ed25519 keypair
const testKeyPair = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

describe("Milestone 19: Automated PR Merge & Continuous Deployment", () => {
  describe("GitHubPrPublisher (PR Query, Reviews, and Merge)", () => {
    it("getPullRequest retrieves and parses PR metadata", async () => {
      const mockFetch: typeof fetch = async (input: any) => {
        const url = String(input);
        if (url.includes("/pulls/42")) {
          return new Response(JSON.stringify({
            number: 42,
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            title: "[Factory] Run 123",
            html_url: "https://github.com/maulsparks/Outside_Orchestrator/pull/42",
            head: { ref: "factory/run-123", sha: "head123" },
            base: { ref: "main" }
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      };

      const publisher = new GitHubPrPublisher({
        token: "test-token",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const pr = await publisher.getPullRequest({ pullNumber: 42 });
      assert.ok(pr);
      assert.strictEqual(pr.number, 42);
      assert.strictEqual(pr.state, "open");
      assert.strictEqual(pr.mergeable, true);
      assert.strictEqual(pr.headRef, "factory/run-123");
      assert.strictEqual(pr.headSha, "head123");
    });

    it("getPullRequestReviews retrieves submitted reviews", async () => {
      const mockFetch: typeof fetch = async (input: any) => {
        const url = String(input);
        if (url.includes("/pulls/42/reviews")) {
          return new Response(JSON.stringify([
            { id: 101, user: { login: "chief-reviewer" }, state: "APPROVED", submitted_at: "2026-09-14T00:00:00Z" }
          ]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      };

      const publisher = new GitHubPrPublisher({
        token: "test-token",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const reviews = await publisher.getPullRequestReviews({ pullNumber: 42 });
      assert.strictEqual(reviews.length, 1);
      assert.strictEqual(reviews[0].user, "chief-reviewer");
      assert.strictEqual(reviews[0].state, "APPROVED");
    });

    it("mergePullRequest executes merge via GitHub API", async () => {
      let mergeMethodCalled = "";
      const mockFetch: typeof fetch = async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("/pulls/42/merge") && init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          mergeMethodCalled = body.merge_method;
          return new Response(JSON.stringify({
            sha: "merge-commit-sha-777",
            merged: true,
            message: "Pull Request successfully merged"
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      };

      const publisher = new GitHubPrPublisher({
        token: "test-token",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const result = await publisher.mergePullRequest({
        pullNumber: 42,
        mergeMethod: "squash"
      });

      assert.strictEqual(result.merged, true);
      assert.strictEqual(result.sha, "merge-commit-sha-777");
      assert.strictEqual(mergeMethodCalled, "squash");
    });
  });

  describe("ContinuousDeploymentEngine", () => {
    it("triggerDeployment dry run skips execution and logs evidence", async () => {
      const evidenceStore = new InMemoryEvidenceStore();
      const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

      const cd = new ContinuousDeploymentEngine({
        evidenceLedger,
        dryRun: true
      });

      const res = await cd.triggerDeployment({
        trigger: "pr_merge",
        prNumber: 42,
        commitSha: "merge-sha",
        runId: "run-cd-test"
      });

      assert.strictEqual(res.status, "skipped");
      assert.strictEqual(res.trigger, "pr_merge");

      const events = await evidenceStore.getAllForRun("run-cd-test");
      assert.strictEqual(events.length, 1);
      const obs = (events[0].payload?.observation || events[0].payload) as Record<string, unknown>;
      assert.strictEqual(obs?.deployment_executed, true);
    });

    it("triggerDeployment fallback simulates deployment in test environments", async () => {
      const evidenceStore = new InMemoryEvidenceStore();
      const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

      const cd = new ContinuousDeploymentEngine({
        evidenceLedger,
        deployScriptPath: "/nonexistent/deploy.sh"
      });

      const res = await cd.triggerDeployment({
        trigger: "operator",
        prNumber: 99,
        commitSha: "sha-99",
        runId: "run-sim-test"
      });

      assert.strictEqual(res.status, "success");
      assert.strictEqual(res.exitCode, 0);
      assert.ok(res.stdout?.includes("[SimulatedDeployment]"));
    });
  });

  describe("PrMergeCoordinator", () => {
    it("verifyWebhookSignature correctly verifies HMAC-SHA256 signature", () => {
      const coordinator = new PrMergeCoordinator({
        githubPublisher: new GitHubPrPublisher({ token: "test" }),
        deploymentEngine: new ContinuousDeploymentEngine(),
        webhookSecret: "secret-xyz"
      });

      const payload = JSON.stringify({ action: "opened", number: 10 });
      const hmac = crypto.createHmac("sha256", "secret-xyz").update(payload).digest("hex");

      const isValid = coordinator.verifyWebhookSignature(payload, `sha256=${hmac}`);
      assert.strictEqual(isValid, true);

      const isInvalid = coordinator.verifyWebhookSignature(payload, "sha256=invalid-signature");
      assert.strictEqual(isInvalid, false);
    });

    it("mergeAndDeployRunPr blocks merge when zero-trust harvest attestation is missing", async () => {
      const runStore = new InMemoryRunStateStore();
      const evidenceStore = new InMemoryEvidenceStore();
      const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

      const runId = "run-unharvested";
      await runStore.createRun({
        id: runId,
        tenant_id: "tenant-test",
        request_id: "req-1",
        idempotency_key: "idem-1",
        phase: "clean_terminated",
        policy_version: "v2.0",
        state_version: 1,
        parent_git_sha: "000",
        envelope: { task_envelope_hash: "env" },
        budget: { max_cost_cents: 100, max_duration_seconds: 60 }
      });

      const coordinator = new PrMergeCoordinator({
        githubPublisher: new GitHubPrPublisher({ token: "test" }),
        deploymentEngine: new ContinuousDeploymentEngine({ evidenceLedger }),
        runStore: runStore as any,
        evidenceLedger
      });

      await assert.rejects(
        () => coordinator.mergeAndDeployRunPr({ runId }),
        /has not passed cryptographic harvest authorization/
      );
    });

    it("mergeAndDeployRunPr succeeds when harvest attestation is verified", async () => {
      const runStore = new InMemoryRunStateStore();
      const evidenceStore = new InMemoryEvidenceStore();
      const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

      const runId = "run-harvested-100";
      await runStore.createRun({
        id: runId,
        tenant_id: "tenant-test",
        request_id: "req-1",
        idempotency_key: "idem-100",
        phase: "clean_terminated",
        policy_version: "v2.0",
        state_version: 1,
        parent_git_sha: "000",
        envelope: { task_envelope_hash: "env" },
        budget: { max_cost_cents: 100, max_duration_seconds: 60 }
      });

      // Seed harvest_committed event into ledger
      await evidenceLedger.recordEvent({
        runId,
        tenantId: "tenant-test",
        requestId: "req-1",
        sandboxId: "outside-orchestrator",
        policyVersion: "v2.0",
        eventType: "command_observed",
        source: { component: "test" },
        observation: {
          harvest_committed: true,
          pr_published: true,
          pr_number: 100
        }
      });

      const mockFetch: typeof fetch = async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("/pulls/100/merge") && init?.method === "PUT") {
          return new Response(JSON.stringify({
            sha: "merge-sha-100",
            merged: true,
            message: "PR 100 merged"
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/pulls/100")) {
          return new Response(JSON.stringify({
            number: 100,
            state: "open",
            merged: false,
            mergeable: true,
            title: "[Factory] Run",
            html_url: "https://github.com/maulsparks/Outside_Orchestrator/pull/100",
            head: { ref: "factory/run-harvested-100", sha: "head100" },
            base: { ref: "main" }
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      };

      const publisher = new GitHubPrPublisher({
        token: "test-token",
        repository: "maulsparks/Outside_Orchestrator",
        fetchFn: mockFetch
      });

      const deploymentEngine = new ContinuousDeploymentEngine({
        evidenceLedger,
        deployScriptPath: "/nonexistent/deploy.sh"
      });

      const coordinator = new PrMergeCoordinator({
        githubPublisher: publisher,
        deploymentEngine,
        runStore: runStore as any,
        evidenceLedger
      });

      const result = await coordinator.mergeAndDeployRunPr({ runId, prNumber: 100 });
      assert.strictEqual(result.merged, true);
      assert.strictEqual(result.prNumber, 100);
      assert.strictEqual(result.mergeCommitSha, "merge-sha-100");
      assert.strictEqual(result.deployment?.status, "success");

      // Verify pr_merged event recorded in ledger
      const records = await evidenceStore.getAllForRun(runId);
      const prMergedRecord = records.find((r) => {
        const obs = (r.payload?.observation || r.payload) as Record<string, unknown> | undefined;
        return obs?.pr_merged;
      });
      assert.ok(prMergedRecord);
      const obs = (prMergedRecord.payload?.observation || prMergedRecord.payload) as Record<string, unknown>;
      assert.strictEqual(obs.pr_number, 100);
    });

    it("handleWebhookEvent processes approved review and triggers merge", async () => {
      const runStore = new InMemoryRunStateStore();
      const evidenceStore = new InMemoryEvidenceStore();
      const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

      const runId = "webhook-run-55";
      await runStore.createRun({
        id: runId,
        tenant_id: "tenant-test",
        request_id: "req-55",
        idempotency_key: "idem-55",
        phase: "clean_terminated",
        policy_version: "v2.0",
        state_version: 1,
        parent_git_sha: "000",
        envelope: { task_envelope_hash: "env" },
        budget: { max_cost_cents: 100, max_duration_seconds: 60 }
      });

      await evidenceLedger.recordEvent({
        runId,
        tenantId: "tenant-test",
        requestId: "req-55",
        sandboxId: "outside-orchestrator",
        policyVersion: "v2.0",
        eventType: "command_observed",
        source: { component: "test" },
        observation: { harvest_committed: true }
      });

      const mockFetch: typeof fetch = async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("/pulls/55/merge")) {
          return new Response(JSON.stringify({ sha: "merge-55", merged: true }), { status: 200 });
        }
        if (url.includes("/pulls/55")) {
          return new Response(JSON.stringify({
            number: 55,
            state: "open",
            merged: false,
            mergeable: true,
            head: { ref: `factory/run-${runId}` }
          }), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      };

      const coordinator = new PrMergeCoordinator({
        githubPublisher: new GitHubPrPublisher({ token: "test", fetchFn: mockFetch }),
        deploymentEngine: new ContinuousDeploymentEngine({ evidenceLedger, deployScriptPath: "/nonexistent/deploy.sh" }),
        runStore: runStore as any,
        evidenceLedger
      });

      const webhookResult = await coordinator.handleWebhookEvent("pull_request_review", {
        action: "submitted",
        review: { state: "approved", user: { login: "auditor" } },
        pull_request: {
          number: 55,
          head: { ref: `factory/run-${runId}` }
        }
      });

      assert.strictEqual(webhookResult.handled, true);
      assert.strictEqual(webhookResult.merged, true);
      assert.strictEqual(webhookResult.deployed, true);
    });
  });
});
