import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import {
  InMemoryTournamentArmStore,
  TournamentArbitrator,
  TournamentArm
} from "../src/core/tournament.js";
import { InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { InMemoryPhaseEnvelopeStore } from "../src/core/dispatcher.js";
import { InMemoryEvidenceStore, EvidenceLedger } from "../src/warden/ledger.js";
import { prepareHarvestProposal, signHarvest, authorizeHarvest } from "../src/core/harvest.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRun(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-tourn-test-01",
    tenant_id: "tenant-tourn-01",
    request_id: "req-tourn-01",
    idempotency_key: "idem-tourn-01",
    parent_git_sha: "1111111111111111111111111111111111111111",
    policy_version: "v2.0",
    phase: "clean_terminated",
    state_version: 6,
    budget: { max_cost_cents: 1000 },
    envelope: { task_envelope_hash: "2222222222222222222222222222222222222222222222222222222222222222" },
    ...overrides
  };
}

test("TournamentArmStore: createArm creates and isolates arms by (runId, armId)", async () => {
  const store = new InMemoryTournamentArmStore();

  const armA = await store.createArm({
    run_id: "run-t1",
    tenant_id: "tenant-1",
    arm_id: "arm-a",
    model_id: "claude-3-5-sonnet",
    cost_cents: 45,
    latency_ms: 3200
  });

  const armB = await store.createArm({
    run_id: "run-t1",
    tenant_id: "tenant-1",
    arm_id: "arm-b",
    model_id: "deepseek-coder",
    cost_cents: 15,
    latency_ms: 2100
  });

  assert.equal(armA.arm_id, "arm-a");
  assert.equal(armA.cost_cents, 45);
  assert.equal(armB.arm_id, "arm-b");
  assert.equal(armB.cost_cents, 15);

  const arms = await store.listArmsForRun("run-t1");
  assert.equal(arms.length, 2);
  assert.deepEqual(arms.map((a) => a.arm_id), ["arm-a", "arm-b"]);

  // Duplicate arm creation must fail
  await assert.rejects(
    async () => {
      await store.createArm({
        run_id: "run-t1",
        tenant_id: "tenant-1",
        arm_id: "arm-a"
      });
    },
    /TournamentArmConflict/
  );
});

test("AC 9: Tournament arms cannot overwrite each other and maintain separate state", async () => {
  const store = new InMemoryTournamentArmStore();

  await store.createArm({
    run_id: "run-t2",
    tenant_id: "tenant-1",
    arm_id: "arm-fast",
    status: "completed",
    tree_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    cost_cents: 10,
    latency_ms: 1500
  });

  await store.createArm({
    run_id: "run-t2",
    tenant_id: "tenant-1",
    arm_id: "arm-smart",
    status: "completed",
    tree_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    cost_cents: 50,
    latency_ms: 4500
  });

  // Updating arm-fast must NOT alter arm-smart
  await store.updateArm("run-t2", "arm-fast", {
    status: "failed",
    cost_cents: 12
  });

  const armFast = await store.getArm("run-t2", "arm-fast");
  const armSmart = await store.getArm("run-t2", "arm-smart");

  assert.equal(armFast?.status, "failed");
  assert.equal(armFast?.cost_cents, 12);

  assert.equal(armSmart?.status, "completed");
  assert.equal(armSmart?.tree_sha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(armSmart?.cost_cents, 50);
});

test("TournamentArbitrator.evaluateArms correctly ranks arms by cost and latency", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);

  const arms: TournamentArm[] = [
    {
      id: "1",
      run_id: "run-arb",
      tenant_id: "ten",
      arm_id: "arm-expensive",
      status: "completed",
      cost_cents: 80,
      latency_ms: 2000,
      selection_status: "unselected",
      metadata: { clean_terminated: true, erg_passed: true, tests_passed: true },
      created_at: "",
      updated_at: ""
    },
    {
      id: "2",
      run_id: "run-arb",
      tenant_id: "ten",
      arm_id: "arm-cheap",
      status: "completed",
      cost_cents: 20,
      latency_ms: 3000,
      selection_status: "unselected",
      metadata: { clean_terminated: true, erg_passed: true, tests_passed: true },
      created_at: "",
      updated_at: ""
    },
    {
      id: "3",
      run_id: "run-arb",
      tenant_id: "ten",
      arm_id: "arm-broken",
      status: "completed",
      cost_cents: 5,
      latency_ms: 500,
      selection_status: "unselected",
      metadata: { clean_terminated: true, erg_passed: false, tests_passed: true },
      created_at: "",
      updated_at: ""
    }
  ];

  // Evaluate with lowest_cost strategy (default)
  const evalCost = arbitrator.evaluateArms(arms, { strategy: "lowest_cost" });
  assert.equal(evalCost[0].arm.arm_id, "arm-cheap");
  assert.equal(evalCost[0].rank, 1);
  assert.equal(evalCost[0].eligible, true);

  assert.equal(evalCost[1].arm.arm_id, "arm-expensive");
  assert.equal(evalCost[1].rank, 2);
  assert.equal(evalCost[1].eligible, true);

  assert.equal(evalCost[2].arm.arm_id, "arm-broken");
  assert.equal(evalCost[2].eligible, false);
  assert.ok(evalCost[2].reasons.some((r) => r.includes("ERG")));

  // Evaluate with fastest_latency strategy
  const evalLat = arbitrator.evaluateArms(arms, { strategy: "fastest_latency" });
  assert.equal(evalLat[0].arm.arm_id, "arm-expensive"); // 2000ms vs 3000ms among eligible
  assert.equal(evalLat[0].rank, 1);
});

test("TournamentArbitrator.selectWinner promotes winner, updates runners-up, and records evidence", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);
  const evidenceStore = new InMemoryEvidenceStore();
  const { privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");
  const runStore = new InMemoryRunStateStore();

  const run = makeRun({ id: "run-select-test" });
  runStore.setRun(run);

  await store.createArm({
    run_id: run.id,
    tenant_id: run.tenant_id,
    arm_id: "arm-1",
    status: "completed",
    tree_sha: "tree-111111111111111111111111111111111111",
    cost_cents: 25,
    latency_ms: 1800
  });

  await store.createArm({
    run_id: run.id,
    tenant_id: run.tenant_id,
    arm_id: "arm-2",
    status: "completed",
    tree_sha: "tree-222222222222222222222222222222222222",
    cost_cents: 40,
    latency_ms: 2200
  });

  const result = await arbitrator.selectWinner({
    runId: run.id,
    winnerArmId: "arm-1",
    rationale: "Lowest cost among green test runs",
    reviewerIdentity: "human:lead-reviewer@firm.internal",
    armStore: store,
    ledger,
    runStore,
    tenantId: run.tenant_id,
    requestId: run.request_id,
    policyVersion: run.policy_version
  });

  assert.equal(result.winner.arm_id, "arm-1");
  assert.equal(result.winner.selection_status, "winner");
  assert.equal(result.others.length, 1);
  assert.equal(result.others[0].arm_id, "arm-2");
  assert.equal(result.others[0].selection_status, "runner_up");

  // Verify evidence ledger entry
  const events = await evidenceStore.getAllForRun(run.id);
  const winEvent = events.find((e) => (e.payload as any)?.observation?.tournament_winner_selected === true);
  assert.ok(winEvent, "Expected tournament_winner_selected event in evidence ledger");
  const obs = (winEvent?.payload as any)?.observation;
  assert.equal(obs.arm_id, "arm-1");
  assert.equal(obs.tree_sha, "tree-111111111111111111111111111111111111");
});

test("Harvest Proposal Integration: Tournament blocks harvest until winner selected, then uses winner tree SHA", async () => {
  const runStore = new InMemoryRunStateStore();
  const armStore = new InMemoryTournamentArmStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const { privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun({ id: "run-prop-tourn" });
  runStore.setRun(run);

  // Setup healthy base evidence
  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "teardown_probe_passed",
    source: { role: "Outside_Orchestrator" },
    observation: { terminal_state: "CLEAN_TERMINATED", clean_terminated: true }
  });

  await armStore.createArm({
    run_id: run.id,
    tenant_id: run.tenant_id,
    arm_id: "candidate-a",
    status: "completed",
    tree_sha: "aaaa4444aaaa4444aaaa4444aaaa4444aaaa4444",
    selection_status: "unselected"
  });

  await armStore.createArm({
    run_id: run.id,
    tenant_id: run.tenant_id,
    arm_id: "candidate-b",
    status: "completed",
    tree_sha: "bbbb5555bbbb5555bbbb5555bbbb5555bbbb5555",
    selection_status: "unselected"
  });

  // 1. Prior to winner selection, harvest is BLOCKED
  const proposalBefore = await prepareHarvestProposal({
    runId: run.id,
    runStore,
    armStore,
    evidenceStore
  });

  assert.equal(proposalBefore.readyForHarvest, false);
  assert.ok(
    proposalBefore.blockingReasons.some((r) => r.includes("deliberate winner selection")),
    "Should block harvest until winner is selected"
  );

  // 2. Deliberately select candidate-b
  const arbitrator = new TournamentArbitrator(armStore);
  await arbitrator.selectWinner({
    runId: run.id,
    winnerArmId: "candidate-b",
    rationale: "Selected candidate-b for production release",
    armStore,
    ledger,
    tenantId: run.tenant_id,
    requestId: run.request_id
  });

  // 3. After selection, proposal reflects winner's arm and tree SHA
  const proposalAfter = await prepareHarvestProposal({
    runId: run.id,
    runStore,
    armStore,
    evidenceStore
  });

  assert.equal(proposalAfter.selectedArmId, "candidate-b");
  assert.equal(proposalAfter.acceptedTreeSha, "bbbb5555bbbb5555bbbb5555bbbb5555bbbb5555");
  assert.equal(proposalAfter.readyForHarvest, true);
  assert.equal(proposalAfter.blockingReasons.length, 0);

  // Canonical message contains winner's tree SHA
  assert.ok(proposalAfter.canonicalMessage.includes("bbbb5555bbbb5555bbbb5555bbbb5555bbbb5555"));
});

test("HTTP REST API: Tournament arms inspection and winner selection flow", async () => {
  const runStore = new InMemoryRunStateStore();
  const armStore = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(armStore);
  const evidenceStore = new InMemoryEvidenceStore();
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun({ id: "run-http-tourn" });
  runStore.setRun(run);

  // Create lightweight server mimicking server.ts tournament routes
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    // 1. GET /v1/runs/:runId/tournament
    const getMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament$/);
    if (getMatch && req.method === "GET") {
      const runId = getMatch[1];
      const arms = await armStore.listArmsForRun(runId);
      const evaluations = arbitrator.evaluateArms(arms);
      const winner = arms.find((a) => a.selection_status === "winner");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run_id: runId,
        total_arms: arms.length,
        selected_winner: winner || null,
        evaluations,
        arms
      }));
      return;
    }

    // 2. POST /v1/runs/:runId/tournament/arms
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

    // 3. POST /v1/runs/:runId/tournament/select
    const postSelectMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/select$/);
    if (postSelectMatch && req.method === "POST") {
      const runId = postSelectMatch[1];
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        const body = JSON.parse(bodyStr || "{}");
        try {
          const result = await arbitrator.selectWinner({
            runId,
            winnerArmId: body.winner_arm_id,
            rationale: body.rationale,
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
    // 1. Register arm-alpha
    const arm1Res = await fetch(`${baseUrl}/v1/runs/run-http-tourn/tournament/arms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arm_id: "arm-alpha",
        status: "completed",
        model_id: "claude-3-5-sonnet",
        tree_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cost_cents: 30,
        latency_ms: 1900
      })
    });
    assert.equal(arm1Res.status, 201);

    // 2. Register arm-beta
    const arm2Res = await fetch(`${baseUrl}/v1/runs/run-http-tourn/tournament/arms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arm_id: "arm-beta",
        status: "completed",
        model_id: "deepseek-coder",
        tree_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        cost_cents: 12,
        latency_ms: 2200
      })
    });
    assert.equal(arm2Res.status, 201);

    // 3. Query tournament status
    const getRes = await fetch(`${baseUrl}/v1/runs/run-http-tourn/tournament`);
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as any;
    assert.equal(getJson.total_arms, 2);
    assert.equal(getJson.selected_winner, null);
    assert.equal(getJson.evaluations.length, 2);

    // 4. Select arm-beta as winner
    const selectRes = await fetch(`${baseUrl}/v1/runs/run-http-tourn/tournament/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        winner_arm_id: "arm-beta",
        rationale: "Lowest cost solution achieving complete acceptance",
        reviewer_identity: "human:architect@platform.internal"
      })
    });
    assert.equal(selectRes.status, 200);
    const selectJson = (await selectRes.json()) as any;
    assert.equal(selectJson.success, true);
    assert.equal(selectJson.selected_winner.arm_id, "arm-beta");
    assert.equal(selectJson.selected_winner.selection_status, "winner");
    assert.equal(selectJson.runners_up.length, 1);
    assert.equal(selectJson.runners_up[0].arm_id, "arm-alpha");
    assert.equal(selectJson.runners_up[0].selection_status, "runner_up");

    // 5. Query tournament status again to confirm persisted winner
    const afterRes = await fetch(`${baseUrl}/v1/runs/run-http-tourn/tournament`);
    assert.equal(afterRes.status, 200);
    const afterJson = (await afterRes.json()) as any;
    assert.equal(afterJson.selected_winner.arm_id, "arm-beta");
  } finally {
    server.close();
  }
});

test("TournamentArbitrator: Disqualifies arm from Pareto frontier when deterministic test gate fails", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);

  const armPass = await store.createArm({
    run_id: "run-det-tourn-1",
    tenant_id: "tenant-1",
    arm_id: "arm-pass",
    status: "completed",
    cost_cents: 35,
    latency_ms: 2200,
    metadata: {
      clean_terminated: true,
      erg_passed: true,
      deterministic_tests: {
        passed_count: 24,
        failed_count: 0,
        total_count: 24,
        coverage_pct: 91.5,
        exit_code: 0,
        duration_ms: 1200,
        stdout_sha256: "0".repeat(64),
        command: "npm test"
      }
    }
  });

  const armFail = await store.createArm({
    run_id: "run-det-tourn-1",
    tenant_id: "tenant-1",
    arm_id: "arm-fail",
    status: "completed",
    cost_cents: 10, // Cheaper and faster, but test failed
    latency_ms: 1100,
    metadata: {
      clean_terminated: true,
      erg_passed: true,
      deterministic_tests: {
        passed_count: 20,
        failed_count: 4,
        total_count: 24,
        coverage_pct: 70.0,
        exit_code: 1,
        duration_ms: 900,
        stdout_sha256: "1".repeat(64),
        command: "npm test"
      }
    }
  });

  const evaluations = arbitrator.evaluateArms([armPass, armFail]);

  const evalPass = evaluations.find((e) => e.arm.arm_id === "arm-pass");
  const evalFail = evaluations.find((e) => e.arm.arm_id === "arm-fail");

  assert.ok(evalPass);
  assert.ok(evalFail);

  // arm-pass is eligible and Pareto optimal
  assert.equal(evalPass.eligible, true);
  assert.equal(evalPass.isParetoOptimal, true);
  assert.equal(evalPass.rank, 1);
  assert.equal(evalPass.metrics.coveragePct, 91.5);
  assert.equal(evalPass.metrics.testPassRate, 1.0);

  // arm-fail must be strictly disqualified despite lower cost
  assert.equal(evalFail.eligible, false);
  assert.equal(evalFail.isParetoOptimal, false);
  assert.ok(evalFail.reasons.some((r) => r.includes("failed deterministic code test gate (exit code: 1, 4 failures)")));
});

test("TournamentArbitrator: Enforces minimum coverage threshold (minCoveragePct)", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);

  const armLowCov = await store.createArm({
    run_id: "run-cov-test",
    tenant_id: "tenant-1",
    arm_id: "arm-low-cov",
    status: "completed",
    cost_cents: 20,
    latency_ms: 1500,
    metadata: {
      clean_terminated: true,
      erg_passed: true,
      deterministic_tests: {
        passed_count: 10,
        failed_count: 0,
        total_count: 10,
        coverage_pct: 72.0,
        exit_code: 0,
        duration_ms: 500
      }
    }
  });

  const armHighCov = await store.createArm({
    run_id: "run-cov-test",
    tenant_id: "tenant-1",
    arm_id: "arm-high-cov",
    status: "completed",
    cost_cents: 28,
    latency_ms: 1800,
    metadata: {
      clean_terminated: true,
      erg_passed: true,
      deterministic_tests: {
        passed_count: 10,
        failed_count: 0,
        total_count: 10,
        coverage_pct: 88.5,
        exit_code: 0,
        duration_ms: 600
      }
    }
  });

  // Evaluate with minCoveragePct: 80.0
  const evaluations = arbitrator.evaluateArms([armLowCov, armHighCov], {
    minCoveragePct: 80.0
  });

  const evalLow = evaluations.find((e) => e.arm.arm_id === "arm-low-cov");
  const evalHigh = evaluations.find((e) => e.arm.arm_id === "arm-high-cov");

  assert.ok(evalLow);
  assert.ok(evalHigh);

  assert.equal(evalLow.eligible, false);
  assert.ok(evalLow.reasons.some((r) => r.includes("below required threshold 80%")));

  assert.equal(evalHigh.eligible, true);
  assert.equal(evalHigh.rank, 1);
});

test("TournamentArbitrator: Computes 6D Pareto dominance and ranks by highest_coverage strategy", async () => {
  const store = new InMemoryTournamentArmStore();
  const arbitrator = new TournamentArbitrator(store);

  const armCheaper = await store.createArm({
    run_id: "run-strat-test",
    tenant_id: "tenant-1",
    arm_id: "arm-cheaper",
    status: "completed",
    cost_cents: 15,
    latency_ms: 1200,
    metadata: {
      clean_terminated: true,
      erg_passed: true,
      deterministic_tests: {
        passed_count: 10,
        failed_count: 0,
        total_count: 10,
        coverage_pct: 82.0,
        exit_code: 0,
        duration_ms: 400
      }
    }
  });

  const armDenser = await store.createArm({
    run_id: "run-strat-test",
    tenant_id: "tenant-1",
    arm_id: "arm-denser",
    status: "completed",
    cost_cents: 25,
    latency_ms: 1800,
    metadata: {
      clean_terminated: true,
      erg_passed: true,
      deterministic_tests: {
        passed_count: 10,
        failed_count: 0,
        total_count: 10,
        coverage_pct: 98.4,
        exit_code: 0,
        duration_ms: 450
      }
    }
  });

  // 1. Both arms are Pareto optimal (neither dominates across all 6 dimensions)
  const evalsPareto = arbitrator.evaluateArms([armCheaper, armDenser], {
    strategy: "pareto_optimal"
  });
  assert.equal(evalsPareto[0].isParetoOptimal, true);
  assert.equal(evalsPareto[1].isParetoOptimal, true);

  // 2. Under highest_coverage strategy, arm-denser is ranked #1
  const evalsCoverage = arbitrator.evaluateArms([armCheaper, armDenser], {
    strategy: "highest_coverage"
  });
  assert.equal(evalsCoverage[0].arm.arm_id, "arm-denser");
  assert.equal(evalsCoverage[0].rank, 1);
  assert.equal(evalsCoverage[1].arm.arm_id, "arm-cheaper");
  assert.equal(evalsCoverage[1].rank, 2);

  // 3. Under lowest_cost strategy, arm-cheaper is ranked #1
  const evalsCost = arbitrator.evaluateArms([armCheaper, armDenser], {
    strategy: "lowest_cost"
  });
  assert.equal(evalsCost[0].arm.arm_id, "arm-cheaper");
  assert.equal(evalsCost[0].rank, 1);
});

