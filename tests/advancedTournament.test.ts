import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import {
  InMemoryTournamentArmStore,
  TournamentArbitrator,
  TournamentArm,
  resolveModelFallback,
  ModelFallbackPolicy,
  ArbitrationPolicy
} from "../src/core/tournament.js";
import { InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { InMemoryEvidenceStore, EvidenceLedger } from "../src/warden/ledger.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRun(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-adv-tourn-01",
    tenant_id: "tenant-adv-01",
    request_id: "req-adv-01",
    idempotency_key: "idem-adv-01",
    parent_git_sha: "1111111111111111111111111111111111111111",
    policy_version: "v2.0",
    phase: "clean_terminated",
    state_version: 6,
    budget: { max_cost_cents: 1000 },
    envelope: { task_envelope_hash: "2222222222222222222222222222222222222222222222222222222222222222" },
    ...overrides
  };
}

test("Multi-criteria Pareto Dominance: Non-dominated arms form Pareto frontier and dominated arms are detected", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);

  // Arm 1: Cheaper, slower
  await store.createArm({
    run_id: "run-pareto-1",
    tenant_id: "tenant-1",
    arm_id: "arm-cheap",
    status: "completed",
    cost_cents: 10,
    latency_ms: 2000,
    metadata: { quality_score: 95, declared_changed_files: ["src/a.ts"] }
  });

  // Arm 2: Faster, pricier
  await store.createArm({
    run_id: "run-pareto-1",
    tenant_id: "tenant-1",
    arm_id: "arm-fast",
    status: "completed",
    cost_cents: 50,
    latency_ms: 300,
    metadata: { quality_score: 95, declared_changed_files: ["src/a.ts"] }
  });

  // Arm 3: Higher quality, moderate cost/latency
  await store.createArm({
    run_id: "run-pareto-1",
    tenant_id: "tenant-1",
    arm_id: "arm-balanced",
    status: "completed",
    cost_cents: 25,
    latency_ms: 1000,
    metadata: { quality_score: 99, declared_changed_files: ["src/a.ts"] }
  });

  // Arm 4: Strictly inferior in cost, latency, quality, and churn
  await store.createArm({
    run_id: "run-pareto-1",
    tenant_id: "tenant-1",
    arm_id: "arm-inferior",
    status: "completed",
    cost_cents: 60,
    latency_ms: 2500,
    metadata: { quality_score: 80, declared_changed_files: ["src/a.ts", "src/b.ts", "src/c.ts"] }
  });

  const arms = await store.listArmsForRun("run-pareto-1");
  const evaluations = arbitrator.evaluateArms(arms, { strategy: "pareto_optimal" });

  const evalCheap = evaluations.find((e) => e.arm.arm_id === "arm-cheap")!;
  const evalFast = evaluations.find((e) => e.arm.arm_id === "arm-fast")!;
  const evalBalanced = evaluations.find((e) => e.arm.arm_id === "arm-balanced")!;
  const evalInferior = evaluations.find((e) => e.arm.arm_id === "arm-inferior")!;

  assert.equal(evalCheap.isParetoOptimal, true, "arm-cheap should be Pareto-optimal");
  assert.equal(evalCheap.dominatedBy.length, 0);

  assert.equal(evalFast.isParetoOptimal, true, "arm-fast should be Pareto-optimal");
  assert.equal(evalFast.dominatedBy.length, 0);

  assert.equal(evalBalanced.isParetoOptimal, true, "arm-balanced should be Pareto-optimal");
  assert.equal(evalBalanced.dominatedBy.length, 0);

  assert.equal(evalInferior.isParetoOptimal, false, "arm-inferior should be dominated");
  assert.ok(evalInferior.dominatedBy.length > 0, "arm-inferior should list dominating arms");
  assert.ok(evalInferior.dominatedBy.includes("arm-cheap"));
  assert.ok(evalInferior.dominatedBy.includes("arm-balanced"));

  // Pareto-optimal arms should rank higher than dominated arms
  assert.ok(evalCheap.rank < evalInferior.rank);
  assert.ok(evalFast.rank < evalInferior.rank);
  assert.ok(evalBalanced.rank < evalInferior.rank);
});

test("Multi-objective weighted composite utility scoring ranks arms according to weight distribution", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);

  await store.createArm({
    run_id: "run-utility-1",
    tenant_id: "tenant-1",
    arm_id: "arm-cost-saver",
    status: "completed",
    cost_cents: 5,
    latency_ms: 3000,
    metadata: { quality_score: 90, declared_changed_files: ["src/index.ts"] }
  });

  await store.createArm({
    run_id: "run-utility-1",
    tenant_id: "tenant-1",
    arm_id: "arm-speed-demon",
    status: "completed",
    cost_cents: 80,
    latency_ms: 200,
    metadata: { quality_score: 90, declared_changed_files: ["src/index.ts"] }
  });

  const arms = await store.listArmsForRun("run-utility-1");

  // Strategy 1: Emphasize cost
  const costPolicy: ArbitrationPolicy = {
    strategy: "weighted_composite",
    weights: { cost: 0.8, latency: 0.1, quality: 0.05, churn: 0.05 }
  };
  const costEvals = arbitrator.evaluateArms(arms, costPolicy);
  assert.equal(costEvals[0].arm.arm_id, "arm-cost-saver", "Cost-saver arm should rank 1st when cost is weighted 0.8");
  assert.ok(costEvals[0].utilityScore >= 0 && costEvals[0].utilityScore <= 1);

  // Strategy 2: Emphasize latency
  const latencyPolicy: ArbitrationPolicy = {
    strategy: "weighted_composite",
    weights: { cost: 0.05, latency: 0.8, quality: 0.1, churn: 0.05 }
  };
  const latencyEvals = arbitrator.evaluateArms(arms, latencyPolicy);
  assert.equal(latencyEvals[0].arm.arm_id, "arm-speed-demon", "Speed-demon arm should rank 1st when latency is weighted 0.8");
  assert.ok(latencyEvals[0].utilityScore >= 0 && latencyEvals[0].utilityScore <= 1);
});

test("Automated model fallback chain (resolveModelFallback) advances, bounds, and exhausts", () => {
  const policy: ModelFallbackPolicy = {
    fallbackChain: ["claude-3-5-sonnet", "deepseek-coder", "gemini-1-5-pro"],
    triggers: ["timeout", "execution_failed"],
    maxRetriesPerArm: 2
  };

  // 1. Valid fallback advancement
  const res1 = resolveModelFallback("claude-3-5-sonnet", "timeout", policy, 1);
  assert.equal(res1.canFallback, true);
  assert.equal(res1.nextModel, "deepseek-coder");

  const res2 = resolveModelFallback("deepseek-coder", "execution_failed", policy, 2);
  assert.equal(res2.canFallback, true);
  assert.equal(res2.nextModel, "gemini-1-5-pro");

  // 2. Fallback chain exhaustion at the end of chain
  const res3 = resolveModelFallback("gemini-1-5-pro", "timeout", policy, 2);
  assert.equal(res3.canFallback, false);
  assert.equal(res3.nextModel, null);
  assert.match(res3.reason, /exhausted/i);

  // 3. Unconfigured trigger rejection
  const resTrigger = resolveModelFallback("claude-3-5-sonnet", "gate_failed", policy, 1);
  assert.equal(resTrigger.canFallback, false);
  assert.equal(resTrigger.nextModel, null);
  assert.match(resTrigger.reason, /not configured/i);

  // 4. Exceeded retry attempts
  const resRetries = resolveModelFallback("claude-3-5-sonnet", "timeout", policy, 3);
  assert.equal(resRetries.canFallback, false);
  assert.equal(resRetries.nextModel, null);
  assert.match(resRetries.reason, /max retries/i);

  // 5. Unknown model selects primary fallback
  const resUnknown = resolveModelFallback("unknown-model", "timeout", policy, 1);
  assert.equal(resUnknown.canFallback, true);
  assert.equal(resUnknown.nextModel, "claude-3-5-sonnet");
});

test("HTTP REST API: Dynamic tournament evaluation and auto_pareto winner selection", async () => {
  const armStore = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(armStore);
  const runStore = new InMemoryRunStateStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "ed25519-k1");

  const run = makeRun({ id: "run-http-adv", tenant_id: "tenant-adv" });
  runStore.setRun(run);

  // Create lightweight HTTP server mimicking server.ts tournament routes
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // GET /v1/runs/:runId/tournament
    const getMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament$/);
    if (getMatch && req.method === "GET") {
      const runId = getMatch[1];
      const arms = await armStore.listArmsForRun(runId);
      const evaluations = arbitrator.evaluateArms(arms);
      const winner = arms.find((a) => a.selection_status === "winner");
      const paretoFrontier = evaluations.filter((e) => e.isParetoOptimal).map((e) => e.arm.arm_id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run_id: runId,
        total_arms: arms.length,
        pareto_frontier: paretoFrontier,
        selected_winner: winner || null,
        evaluations,
        arms
      }));
      return;
    }

    // POST /v1/runs/:runId/tournament/arms
    const postArmMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/arms$/);
    if (postArmMatch && req.method === "POST") {
      const runId = postArmMatch[1];
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        const body = JSON.parse(bodyStr || "{}");
        const arm = await armStore.createArm({
          run_id: runId,
          tenant_id: run.tenant_id,
          arm_id: body.arm_id,
          status: body.status || "pending",
          model_id: body.model_id,
          tree_sha: body.tree_sha,
          cost_cents: body.cost_cents,
          latency_ms: body.latency_ms,
          metadata: body.metadata
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(arm));
      });
      return;
    }

    // POST /v1/runs/:runId/tournament/evaluate
    const evalMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/evaluate$/);
    if (evalMatch && req.method === "POST") {
      const runId = evalMatch[1];
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        const body = JSON.parse(bodyStr || "{}");
        const arms = await armStore.listArmsForRun(runId);
        const evaluations = arbitrator.evaluateArms(arms, body);
        const paretoFrontier = evaluations.filter((e) => e.isParetoOptimal).map((e) => e.arm.arm_id);
        const recommendedWinner = evaluations.find((e) => e.eligible && e.rank === 1)?.arm.arm_id || null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          run_id: runId,
          strategy: body?.strategy || "lowest_cost",
          total_arms: arms.length,
          eligible_arms: evaluations.filter((e) => e.eligible).length,
          pareto_frontier: paretoFrontier,
          recommended_winner: recommendedWinner,
          evaluations
        }));
      });
      return;
    }

    // POST /v1/runs/:runId/tournament/select
    const postSelectMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/select$/);
    if (postSelectMatch && req.method === "POST") {
      const runId = postSelectMatch[1];
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        const body = JSON.parse(bodyStr || "{}");
        try {
          let effectiveWinnerArmId = body.winner_arm_id;
          let selectionRationale = body.rationale;

          if (body.winner_arm_id === "auto_pareto") {
            const arms = await armStore.listArmsForRun(runId);
            const evaluations = arbitrator.evaluateArms(arms, { strategy: "pareto_optimal" });
            const bestArm = evaluations.find((e) => e.eligible && e.isParetoOptimal && e.rank === 1) ||
                            evaluations.find((e) => e.eligible && e.rank === 1);
            if (!bestArm) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "NoEligibleParetoWinner" }));
              return;
            }
            effectiveWinnerArmId = bestArm.arm.arm_id;
            selectionRationale = `${selectionRationale || "Automated Pareto frontier selection"} (Selected Arm '${effectiveWinnerArmId}' with utility score ${bestArm.utilityScore})`;
          }

          const result = await arbitrator.selectWinner({
            runId,
            winnerArmId: effectiveWinnerArmId,
            rationale: selectionRationale,
            reviewerIdentity: body.reviewer_identity,
            armStore,
            ledger,
            tenantId: run.tenant_id,
            requestId: run.request_id
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            selected_winner: result.winner,
            runners_up: result.others
          }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
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
    // 1. Register candidate arms
    await fetch(`${baseUrl}/v1/runs/run-http-adv/tournament/arms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arm_id: "arm-opt-1",
        status: "completed",
        model_id: "claude-3-5-sonnet",
        tree_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cost_cents: 18,
        latency_ms: 1200,
        metadata: { quality_score: 98, declared_changed_files: ["src/app.ts"] }
      })
    });

    await fetch(`${baseUrl}/v1/runs/run-http-adv/tournament/arms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arm_id: "arm-opt-2",
        status: "completed",
        model_id: "deepseek-coder",
        tree_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        cost_cents: 8,
        latency_ms: 2400,
        metadata: { quality_score: 95, declared_changed_files: ["src/app.ts"] }
      })
    });

    await fetch(`${baseUrl}/v1/runs/run-http-adv/tournament/arms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arm_id: "arm-dominated",
        status: "completed",
        model_id: "fallback-model",
        tree_sha: "cccccccccccccccccccccccccccccccccccccccc",
        cost_cents: 50,
        latency_ms: 4000,
        metadata: { quality_score: 70, declared_changed_files: ["src/app.ts", "src/extra.ts"] }
      })
    });

    // 2. GET /v1/runs/:runId/tournament includes pareto_frontier
    const getRes = await fetch(`${baseUrl}/v1/runs/run-http-adv/tournament`);
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as any;
    assert.equal(getJson.total_arms, 3);
    assert.ok(Array.isArray(getJson.pareto_frontier));
    assert.ok(getJson.pareto_frontier.includes("arm-opt-1"));
    assert.ok(getJson.pareto_frontier.includes("arm-opt-2"));
    assert.ok(!getJson.pareto_frontier.includes("arm-dominated"));

    // 3. POST /v1/runs/:runId/tournament/evaluate with custom policy
    const evalRes = await fetch(`${baseUrl}/v1/runs/run-http-adv/tournament/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "weighted_composite",
        weights: { cost: 0.6, latency: 0.2, quality: 0.1, churn: 0.1 }
      })
    });
    assert.equal(evalRes.status, 200);
    const evalJson = (await evalRes.json()) as any;
    assert.equal(evalJson.strategy, "weighted_composite");
    assert.equal(evalJson.eligible_arms, 3);
    assert.ok(evalJson.pareto_frontier.length >= 2);
    assert.ok(evalJson.recommended_winner !== null);

    // 4. POST /v1/runs/:runId/tournament/select with auto_pareto
    const selectRes = await fetch(`${baseUrl}/v1/runs/run-http-adv/tournament/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        winner_arm_id: "auto_pareto",
        rationale: "Select highest utility arm on Pareto frontier",
        reviewer_identity: "system:pareto-arbitrator"
      })
    });
    assert.equal(selectRes.status, 200);
    const selectJson = (await selectRes.json()) as any;
    assert.equal(selectJson.success, true);
    assert.equal(selectJson.selected_winner.selection_status, "winner");
    assert.ok(getJson.pareto_frontier.includes(selectJson.selected_winner.arm_id));
    assert.match(selectJson.selected_winner.metadata.selection_rationale, /utility score/);
  } finally {
    server.close();
  }
});
