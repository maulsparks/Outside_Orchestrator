import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import {
  parseRepository,
  formatPullRequestBody,
  GitHubPrPublisher
} from "../src/adapters/github/prPublisher.js";
import { commitHarvestRef, signHarvest } from "../src/core/harvest.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

test("parseRepository correctly parses various repository formats", () => {
  assert.deepEqual(parseRepository("maulsparks/Outside_Orchestrator"), {
    owner: "maulsparks",
    repo: "Outside_Orchestrator"
  });
  assert.deepEqual(parseRepository("https://github.com/maulsparks/Outside_Orchestrator.git"), {
    owner: "maulsparks",
    repo: "Outside_Orchestrator"
  });
  assert.deepEqual(parseRepository("git@github.com:maulsparks/Outside_Orchestrator.git"), {
    owner: "maulsparks",
    repo: "Outside_Orchestrator"
  });
  assert.deepEqual(parseRepository(""), {
    owner: "maulsparks",
    repo: "Outside_Orchestrator"
  });
});

test("formatPullRequestBody generates rich markdown with metrics, tests, ERG, and attestation", () => {
  const attestation = {
    run_id: "run-pr-001",
    selected_arm_id: "arm-fast",
    accepted_tree_sha: "a".repeat(40),
    task_envelope_hash: "b".repeat(64),
    policy_version: "v2.0",
    signer_identity: "human:reviewer@operator",
    signature: "sig-test-base64url",
    signature_verified_at: "2026-09-15T00:00:00.000Z",
    teardown_evidence_id: "evt-clean-term"
  };

  const md = formatPullRequestBody({
    runId: "run-pr-001",
    tenantId: "tenant-production",
    requestId: "req-pr-001",
    parentGitSha: "c".repeat(40),
    acceptedTreeSha: "a".repeat(40),
    policyVersion: "v2.0",
    intent: "Implement automated PR publisher",
    userPrompt: "Please implement automated GitHub Pull Request publishing.",
    executionKind: "code",
    deterministicCommand: "npm test",
    tournamentArm: {
      armId: "arm-fast",
      modelId: "claude-3-5-sonnet",
      costCents: 15,
      latencyMs: 12500,
      testPassRate: 1.0,
      coveragePct: 98.4,
      testDurationMs: 2300,
      deterministicTests: {
        passedCount: 45,
        failedCount: 0,
        totalCount: 45,
        exitCode: 0,
        stdoutSha256: "d".repeat(64)
      }
    },
    changedFiles: ["src/core/harvest.ts", "src/adapters/github/prPublisher.ts"],
    attestation
  });

  assert.match(md, /AI Software Factory — Automated Harvest Approval/);
  assert.match(md, /run-pr-001/);
  assert.match(md, /tenant-production/);
  assert.match(md, /claude-3-5-sonnet/);
  assert.match(md, /\$0\.15/);
  assert.match(md, /98\.4%/);
  assert.match(md, /45 \/ 45/);
  assert.match(md, /src\/core\/harvest\.ts/);
  assert.match(md, /human:reviewer@operator/);
  assert.match(md, /Zero-Trust Security Invariants Verified/);
});

test("GitHubPrPublisher gracefully returns skipped when no token is present", async () => {
  const publisher = new GitHubPrPublisher({ token: "" });
  assert.equal(publisher.hasToken(), false);

  const res = await publisher.createPullRequest({
    runId: "run-no-token",
    branch: "factory/run-no-token",
    commitSha: "1".repeat(40)
  });

  assert.equal(res.status, "skipped");
  assert.match(res.error || "", /No GitHub token configured/);
});

test("GitHubPrPublisher creates branch and PR on 201 responses with injected fetcher", async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: urlStr, method, body });

    if (urlStr.endsWith("/git/refs") && method === "POST") {
      return {
        status: 201,
        ok: true,
        json: async () => ({ ref: body.ref, object: { sha: body.sha } })
      } as any;
    }

    if (urlStr.endsWith("/pulls") && method === "POST") {
      return {
        status: 201,
        ok: true,
        json: async () => ({ number: 99, html_url: "https://github.com/maulsparks/Outside_Orchestrator/pull/99" })
      } as any;
    }

    return { status: 404, ok: false, text: async () => "Not found" } as any;
  }) as typeof fetch;

  const publisher = new GitHubPrPublisher({
    token: "ghp_mock_token_123",
    repository: "maulsparks/Outside_Orchestrator",
    fetchFn: mockFetch
  });

  const result = await publisher.publishHarvestPullRequest({
    runId: "run-e2e-pr",
    commitSha: "f".repeat(40),
    title: "[Factory] Test PR",
    bodyMarkdown: "# Test Body"
  });

  assert.equal(result.status, "created");
  assert.equal(result.prNumber, 99);
  assert.equal(result.prUrl, "https://github.com/maulsparks/Outside_Orchestrator/pull/99");
  assert.equal(result.branch, "factory/run-e2e-pr");

  // Check calls made
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/git\/refs$/);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /\/pulls$/);
});

test("GitHubPrPublisher handles existing PR (422) by querying existing PR list", async () => {
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const method = init?.method || "GET";

    if (urlStr.endsWith("/git/refs") && method === "POST") {
      return {
        status: 422, // Reference already exists
        ok: false,
        text: async () => "Reference already exists"
      } as any;
    }

    if (urlStr.includes("/git/refs/heads/") && method === "PATCH") {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ref: "refs/heads/factory/run-existing" })
      } as any;
    }

    if (urlStr.endsWith("/pulls") && method === "POST") {
      return {
        status: 422, // PR already exists
        ok: false,
        text: async () => "A pull request already exists for maulsparks:factory/run-existing."
      } as any;
    }

    if (urlStr.includes("/pulls?head=") && method === "GET") {
      return {
        status: 200,
        ok: true,
        json: async () => [
          { number: 42, html_url: "https://github.com/maulsparks/Outside_Orchestrator/pull/42" }
        ]
      } as any;
    }

    return { status: 404, ok: false, text: async () => "Not found" } as any;
  }) as typeof fetch;

  const publisher = new GitHubPrPublisher({
    token: "ghp_mock_token_123",
    repository: "maulsparks/Outside_Orchestrator",
    fetchFn: mockFetch
  });

  const result = await publisher.publishHarvestPullRequest({
    runId: "run-existing",
    commitSha: "e".repeat(40),
    title: "[Factory] Existing PR Test",
    bodyMarkdown: "# Existing PR"
  });

  assert.equal(result.status, "existing");
  assert.equal(result.prNumber, 42);
  assert.equal(result.prUrl, "https://github.com/maulsparks/Outside_Orchestrator/pull/42");
});

test("commitHarvestRef creates feature branch and logs pr_published event in EvidenceLedger", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-key");

  const runId = "run-harvest-pr-commit";
  const attestation = {
    run_id: runId,
    selected_arm_id: "arm-best",
    accepted_tree_sha: "1".repeat(40),
    task_envelope_hash: "2".repeat(64),
    policy_version: "v2.0",
    signer_identity: "human:auditor@firm",
    signature: signHarvest(
      { runId, treeSha: "1".repeat(40), envelopeHash: "2".repeat(64), policyVersion: "v2.0" },
      privateKey
    ),
    signature_verified_at: new Date().toISOString(),
    teardown_evidence_id: "evt-clean-term"
  };

  const mockPublisher = new GitHubPrPublisher({
    token: "ghp_mock_token_123",
    repository: "maulsparks/Outside_Orchestrator",
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/git/refs")) return { status: 201, ok: true, json: async () => ({}) } as any;
      if (urlStr.endsWith("/pulls")) {
        return {
          status: 201,
          ok: true,
          json: async () => ({ number: 108, html_url: "https://github.com/maulsparks/Outside_Orchestrator/pull/108" })
        } as any;
      }
      return { status: 404, ok: false } as any;
    }) as typeof fetch
  });

  const res = await commitHarvestRef({
    runId,
    acceptedTreeSha: "1".repeat(40),
    parentGitSha: "0".repeat(40),
    attestation,
    ledger,
    tenantId: "tenant-harvest-pr",
    requestId: "req-harvest-pr",
    githubPublisher: mockPublisher,
    runEnvelope: {
      intent: "Automated PR Commit Test",
      execution_kind: "code",
      deterministic_command: "npm test"
    }
  });

  assert.equal(res.tagCreated, true);
  assert.equal(res.branchCreated, true);
  assert.equal(res.branch, `factory/${runId}`);
  assert.equal(res.prStatus, "created");
  assert.equal(res.prNumber, 108);
  assert.equal(res.prUrl, "https://github.com/maulsparks/Outside_Orchestrator/pull/108");

  // Verify evidence ledger recorded both harvest_committed and pr_published
  const events = await evidenceStore.getAllForRun(runId);
  assert.equal(events.length, 2);

  const commitEvent = events[0].payload as { observation?: { harvest_committed?: boolean; branch?: string } };
  assert.equal(commitEvent.observation?.harvest_committed, true);
  assert.equal(commitEvent.observation?.branch, `factory/${runId}`);

  const prEvent = events[1].payload as { observation?: { pr_published?: boolean; pr_number?: number; pr_url?: string } };
  assert.equal(prEvent.observation?.pr_published, true);
  assert.equal(prEvent.observation?.pr_number, 108);
  assert.equal(prEvent.observation?.pr_url, "https://github.com/maulsparks/Outside_Orchestrator/pull/108");
});
