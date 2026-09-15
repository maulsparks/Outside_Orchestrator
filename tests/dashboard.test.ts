import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import { getDashboardHtml } from "../src/ui/dashboardHtml.js";
import { InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { InMemoryTournamentArmStore, TournamentArbitrator } from "../src/core/tournament.js";
import { InMemoryPhaseEnvelopeStore } from "../src/core/dispatcher.js";
import { InMemoryEvidenceStore, EvidenceLedger } from "../src/warden/ledger.js";
import { prepareHarvestProposal, authorizeHarvest, commitHarvestRef, signHarvest } from "../src/core/harvest.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRun(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-dash-test-01",
    tenant_id: "tenant-dash-01",
    request_id: "req-dash-01",
    idempotency_key: "idem-dash-01",
    parent_git_sha: "1111111111111111111111111111111111111111",
    policy_version: "v2.0",
    phase: "clean_terminated",
    state_version: 6,
    budget: { max_cost_cents: 1000 },
    envelope: { task_envelope_hash: "2222222222222222222222222222222222222222222222222222222222222222" },
    ...overrides
  };
}

test("Operator Dashboard HTML: getDashboardHtml returns valid HTML with all required decks", () => {
  const html = getDashboardHtml();
  assert.ok(html.includes("<!DOCTYPE html>"), "HTML doctype present");
  assert.ok(html.includes("OUTSIDE ORCHESTRATOR"), "Brand title present");
  assert.ok(html.includes("Runs Explorer"), "Runs explorer panel present");
  assert.ok(html.includes("Phase Progression Pipeline"), "Progression pipeline present");
  assert.ok(html.includes("Multi-Criteria Pareto Tournament Arms"), "Tournament deck present");
  assert.ok(html.includes("1-Click Ed25519 Harvest Gate & Authorization"), "Harvest approval deck present");
  assert.ok(html.includes("Run Throughput by Phase"), "SVG charts present");
  assert.ok(html.includes("function resetNewRunModal()"), "resetNewRunModal function declared");
  assert.ok(html.includes("resetNewRunModal();"), "closeNewRunModal invokes resetNewRunModal");
  assert.ok(html.includes("onclick=\"closeNewRunModal()\">Cancel"), "Cancel button triggers closeNewRunModal");
});

test("HTTP Server: Serves Dashboard on /dashboard, /ui, and HTML /", async () => {
  const runStore = new InMemoryRunStateStore();
  const run = makeRun({ id: "run-srv-test" });
  runStore.setRun(run);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if ((pathname === "/dashboard" || pathname === "/ui") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    if (pathname === "/" && req.method === "GET") {
      const accept = req.headers.accept || "";
      if (accept.includes("text/html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getDashboardHtml());
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", node: "test-node" }));
      return;
    }

    if ((pathname === "/runs" || pathname === "/v1/runs") && req.method === "GET") {
      const runs = await runStore.listRuns!(50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(runs));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /dashboard returns HTML
    const dashRes = await fetch(`${baseUrl}/dashboard`);
    assert.equal(dashRes.status, 200);
    assert.ok(dashRes.headers.get("content-type")?.includes("text/html"));
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes("OUTSIDE ORCHESTRATOR"));

    // 2. GET /ui returns HTML
    const uiRes = await fetch(`${baseUrl}/ui`);
    assert.equal(uiRes.status, 200);
    assert.ok(uiRes.headers.get("content-type")?.includes("text/html"));

    // 3. Browser GET / with Accept: text/html returns HTML
    const browserRes = await fetch(`${baseUrl}/`, {
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
    assert.equal(browserRes.status, 200);
    assert.ok(browserRes.headers.get("content-type")?.includes("text/html"));

    // 4. API GET / without text/html returns JSON health check
    const jsonRes = await fetch(`${baseUrl}/`, {
      headers: { Accept: "application/json" }
    });
    assert.equal(jsonRes.status, 200);
    const jsonBody = (await jsonRes.json()) as any;
    assert.equal(jsonBody.status, "ok");

    // 5. GET /v1/runs returns runs list
    const runsRes = await fetch(`${baseUrl}/v1/runs`);
    assert.equal(runsRes.status, 200);
    const runsList = (await runsRes.json()) as any[];
    assert.equal(runsList.length, 1);
    assert.equal(runsList[0].id, "run-srv-test");
  } finally {
    server.close();
  }
});

test("HTTP Server: 1-Click Ed25519 Quick Approve commits harvest and records evidence", async () => {
  const runStore = new InMemoryRunStateStore();
  const armStore = new InMemoryTournamentArmStore();
  const phaseStore = new InMemoryPhaseEnvelopeStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-dash-test");

  const runId = "run-quick-harvest-01";
  const run = makeRun({ id: runId, phase: "clean_terminated" });
  runStore.setRun(run);

  // Set terminal phase envelope
  const treeSha = "3333333333333333333333333333333333333333";
  await phaseStore.recordPhaseEnvelope({
    runId: run.id,
    tenantId: run.tenant_id,
    phase: "build",
    attempt: 1,
    inputs: {},
    envelopeHash: "hash-env-build"
  });
  await phaseStore.recordPhaseOutputs({
    runId: run.id,
    phase: "build",
    attempt: 1,
    outputs: {
      status: "completed",
      declared_changed_files: ["src/index.ts"],
      output_tree_sha: treeSha,
      clean_terminated: true
    }
  });

  // Record required gate evidence in evidence store
  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "advisory_output_collected",
    source: { role: "Outside_Orchestrator" },
    observation: { trace_manifest_sha256: "manifest-sha-123" }
  });

  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "erg_result",
    source: { role: "Outside_Orchestrator" },
    observation: {
      erg_result: { passed: true, unauthorizedTouches: [] }
    }
  });

  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "test_result",
    source: { role: "Outside_Orchestrator" },
    observation: {
      test_gate_result: { passed: true, exitCode: 0 }
    }
  });

  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "teardown_probe_passed",
    source: { role: "Outside_Orchestrator" },
    observation: {
      terminal_state: "CLEAN_TERMINATED",
      clean_terminated: true
    }
  });

  // Create mock server with quick-approve route
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/harvest\/quick-approve$/);

    if (match && req.method === "POST") {
      const runId = match[1];
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        const body = JSON.parse(bodyStr || "{}");
        const proposal = await prepareHarvestProposal({
          runId,
          runStore,
          phaseStore,
          evidenceStore: ledger.getStore(),
          armStore
        });

        const signature = signHarvest(
          {
            runId,
            treeSha: proposal.acceptedTreeSha,
            envelopeHash: proposal.taskEnvelopeHash,
            policyVersion: proposal.policyVersion
          },
          privateKey
        );

        const authResult = await authorizeHarvest({
          runId,
          selectedArmId: proposal.selectedArmId,
          treeSha: proposal.acceptedTreeSha,
          envelopeHash: proposal.taskEnvelopeHash,
          policyVersion: proposal.policyVersion,
          signerIdentity: body.reviewer_identity || "human:operator@dashboard",
          signature,
          publicKeyPem: publicKey,
          isCleanTerminated: proposal.gates.isCleanTerminated,
          ergPassed: proposal.gates.ergPassed,
          testGatePassed: proposal.gates.testGatePassed,
          teardownEvidenceId: proposal.teardownEvidenceId,
          tenantId: run.tenant_id,
          requestId: run.request_id,
          ledger
        });

        if (!authResult.authorized) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify(authResult));
          return;
        }

        const commitResult = await commitHarvestRef({
          runId,
          acceptedTreeSha: proposal.acceptedTreeSha,
          parentGitSha: proposal.parentGitSha,
          attestation: authResult.attestation!,
          targetBranch: "main",
          commitMessage: `1-Click Harvest run ${runId}`,
          ledger,
          tenantId: run.tenant_id,
          requestId: run.request_id
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          run_id: runId,
          authorized: true,
          attestation: authResult.attestation,
          git_ref: commitResult.gitRef,
          commit_sha: commitResult.commitSha
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const quickRes = await fetch(`${baseUrl}/v1/runs/${runId}/harvest/quick-approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer_identity: "human:operator@dashboard" })
    });

    assert.equal(quickRes.status, 200);
    const data = (await quickRes.json()) as any;
    assert.equal(data.success, true);
    assert.equal(data.authorized, true);
    assert.equal(data.git_ref, `refs/tags/harvest-${runId}`);
    assert.ok(data.commit_sha.length >= 40);
    assert.equal(data.attestation.run_id, runId);
  } finally {
    server.close();
  }
});
