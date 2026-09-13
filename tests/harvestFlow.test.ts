import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import {
  prepareHarvestProposal,
  commitHarvestRef,
  authorizeHarvest,
  signHarvest,
  computeHarvestMessage
} from "../src/core/harvest.js";
import { InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { InMemoryPhaseEnvelopeStore } from "../src/core/dispatcher.js";
import { InMemoryEvidenceStore, EvidenceLedger } from "../src/warden/ledger.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRun(overrides?: Partial<FactoryRunRecord>): FactoryRunRecord {
  return {
    id: "run-hflow-001",
    tenant_id: "tenant-hflow-001",
    request_id: "req-hflow-001",
    idempotency_key: "idem-hflow-001",
    parent_git_sha: "1111111111111111111111111111111111111111",
    policy_version: "v1.0.0",
    phase: "clean_terminated",
    state_version: 6,
    budget: { max_cost_cents: 500 },
    envelope: { task_envelope_hash: "2222222222222222222222222222222222222222222222222222222222222222" },
    ...overrides
  };
}

test("prepareHarvestProposal generates full proposal and verifies all gates for clean run", async () => {
  const runStore = new InMemoryRunStateStore();
  const phaseStore = new InMemoryPhaseEnvelopeStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const { privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun();
  runStore.setRun(run);

  // 1. Record phase envelopes with accepted output tree SHA
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
      declared_changed_files: ["src/index.ts", "src/core.ts"],
      output_tree_sha: "3333333333333333333333333333333333333333",
      clean_terminated: true
    }
  });

  // 2. Record boundary evidence for advisory output, ERG, tests, and clean teardown
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

  const proposal = await prepareHarvestProposal({
    runId: run.id,
    runStore,
    phaseStore,
    evidenceStore
  });

  assert.equal(proposal.runId, run.id);
  assert.equal(proposal.acceptedTreeSha, "3333333333333333333333333333333333333333");
  assert.equal(proposal.gates.isCleanTerminated, true);
  assert.equal(proposal.gates.ergPassed, true);
  assert.equal(proposal.gates.testGatePassed, true);
  assert.equal(proposal.gates.advisoryOutputCollected, true);
  assert.equal(proposal.readyForHarvest, true);
  assert.equal(proposal.blockingReasons.length, 0);
  assert.deepEqual(proposal.summary.declaredChanges, ["src/core.ts", "src/index.ts"]);

  const expectedCanonical = computeHarvestMessage({
    runId: run.id,
    treeSha: "3333333333333333333333333333333333333333",
    envelopeHash: "2222222222222222222222222222222222222222222222222222222222222222",
    policyVersion: "v1.0.0"
  });
  assert.equal(proposal.canonicalMessage, expectedCanonical);
});

test("prepareHarvestProposal blocks harvest if run is in active or incomplete phase", async () => {
  const runStore = new InMemoryRunStateStore();
  const run = makeRun({ id: "run-inprog", phase: "in_progress" });
  runStore.setRun(run);

  const proposal = await prepareHarvestProposal({
    runId: run.id,
    runStore
  });

  assert.equal(proposal.gates.isCleanTerminated, false);
  assert.equal(proposal.readyForHarvest, false);
  assert.ok(proposal.blockingReasons.some((r) => r.includes("in_progress")));
});

test("prepareHarvestProposal blocks harvest if ERG detected unauthorized touches", async () => {
  const runStore = new InMemoryRunStateStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const { privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun({ id: "run-erg-fail" });
  runStore.setRun(run);

  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "erg_result",
    source: { role: "Outside_Orchestrator" },
    observation: {
      erg_result: { passed: false, unauthorizedTouches: ["secret/config.json"] }
    }
  });

  const proposal = await prepareHarvestProposal({
    runId: run.id,
    runStore,
    evidenceStore
  });

  assert.equal(proposal.gates.ergPassed, false);
  assert.equal(proposal.readyForHarvest, false);
  assert.ok(proposal.blockingReasons.some((r) => r.includes("Effect Reconciliation Gate")));
});

test("prepareHarvestProposal blocks harvest if acceptance test suite failed", async () => {
  const runStore = new InMemoryRunStateStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const { privateKey } = generateEd25519KeyPair();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun({ id: "run-test-fail" });
  runStore.setRun(run);

  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "test_result",
    source: { role: "Outside_Orchestrator" },
    observation: {
      test_gate_result: { passed: false, exitCode: 1 }
    }
  });

  const proposal = await prepareHarvestProposal({
    runId: run.id,
    runStore,
    evidenceStore
  });

  assert.equal(proposal.gates.testGatePassed, false);
  assert.equal(proposal.readyForHarvest, false);
  assert.ok(proposal.blockingReasons.some((r) => r.includes("acceptance test suite failed")));
});

test("commitHarvestRef creates deterministic ref and records signed evidence", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun({ id: "run-commit-ref" });
  const acceptedTreeSha = "4444444444444444444444444444444444444444";
  const envelopeHash = "5555555555555555555555555555555555555555555555555555555555555555";

  const signature = signHarvest(
    {
      runId: run.id,
      treeSha: acceptedTreeSha,
      envelopeHash,
      policyVersion: run.policy_version
    },
    privateKey
  );

  const authResult = await authorizeHarvest({
    runId: run.id,
    selectedArmId: "arm-a",
    treeSha: acceptedTreeSha,
    envelopeHash,
    policyVersion: run.policy_version,
    signerIdentity: "human:lead@firm.internal",
    signature,
    publicKeyPem: publicKey,
    isCleanTerminated: true,
    ergPassed: true,
    testGatePassed: true,
    teardownEvidenceId: "evt-clean-123",
    tenantId: run.tenant_id,
    requestId: run.request_id,
    ledger
  });

  assert.equal(authResult.authorized, true);

  const commitResult = await commitHarvestRef({
    runId: run.id,
    acceptedTreeSha,
    parentGitSha: run.parent_git_sha,
    attestation: authResult.attestation!,
    targetBranch: "main",
    ledger,
    tenantId: run.tenant_id,
    requestId: run.request_id
  });

  assert.equal(commitResult.gitRef, `refs/tags/harvest-${run.id}`);
  assert.equal(commitResult.commitSha.length, 40);
  assert.equal(commitResult.tagCreated, true);

  // Assert signed evidence recorded in ledger
  const records = await evidenceStore.getAllForRun(run.id);
  const commitEvent = records.find(
    (r) => (r.payload as Record<string, unknown>).observation &&
           ((r.payload as any).observation as Record<string, unknown>).harvest_committed === true
  );
  assert.ok(commitEvent, "Expected harvest_committed event in evidence ledger");
  const obs = (commitEvent?.payload as any)?.observation;
  assert.equal(obs.git_ref, `refs/tags/harvest-${run.id}`);
  assert.equal(obs.commit_sha, commitResult.commitSha);
});

test("HTTP REST API: GET /harvest/proposal and POST /harvest flow", async () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const runStore = new InMemoryRunStateStore();
  const phaseStore = new InMemoryPhaseEnvelopeStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(evidenceStore, privateKey, "warden-test");

  const run = makeRun({ id: "run-http-api" });
  runStore.setRun(run);

  // Setup healthy execution state
  await phaseStore.recordPhaseEnvelope({
    runId: run.id,
    tenantId: run.tenant_id,
    phase: "test",
    attempt: 1,
    inputs: {},
    envelopeHash: "hash-env-test"
  });
  await phaseStore.recordPhaseOutputs({
    runId: run.id,
    phase: "test",
    attempt: 1,
    outputs: {
      status: "completed",
      output_tree_sha: "6666666666666666666666666666666666666666"
    }
  });
  await ledger.recordEvent({
    tenantId: run.tenant_id,
    requestId: run.request_id,
    runId: run.id,
    sandboxId: "sbx-test",
    policyVersion: run.policy_version,
    eventType: "advisory_output_collected",
    source: { role: "Outside_Orchestrator" },
    observation: { trace_manifest_sha256: "advisory-sha" }
  });

  // Create lightweight in-memory HTTP server mimicking server.ts routes
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    // 1. GET /v1/runs/:runId/harvest/proposal
    const proposalMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/harvest\/proposal$/);
    if (proposalMatch && req.method === "GET") {
      const runId = proposalMatch[1];
      try {
        const proposal = await prepareHarvestProposal({
          runId,
          runStore,
          phaseStore,
          evidenceStore
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(proposal));
      } catch (err: any) {
        res.writeHead(err.message.includes("RunNotFound") ? 404 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 2. POST /v1/runs/:runId/harvest
    const harvestMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/harvest$/);
    if (harvestMatch && req.method === "POST") {
      const runId = harvestMatch[1];
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        const body = JSON.parse(bodyStr || "{}");
        const proposal = await prepareHarvestProposal({
          runId,
          runStore,
          phaseStore,
          evidenceStore
        });

        const auth = await authorizeHarvest({
          runId,
          selectedArmId: body.selected_arm_id ?? proposal.selectedArmId,
          treeSha: proposal.acceptedTreeSha,
          envelopeHash: proposal.taskEnvelopeHash,
          policyVersion: proposal.policyVersion,
          signerIdentity: body.signer_identity,
          signature: body.signature,
          publicKeyPem: body.public_key_pem ?? publicKey,
          isCleanTerminated: proposal.gates.isCleanTerminated,
          ergPassed: proposal.gates.ergPassed,
          testGatePassed: proposal.gates.testGatePassed,
          teardownEvidenceId: proposal.teardownEvidenceId,
          tenantId: run.tenant_id,
          requestId: run.request_id,
          ledger
        });

        if (!auth.authorized) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify(auth));
          return;
        }

        const commitResult = await commitHarvestRef({
          runId,
          acceptedTreeSha: proposal.acceptedTreeSha,
          parentGitSha: proposal.parentGitSha,
          attestation: auth.attestation!,
          ledger,
          tenantId: run.tenant_id,
          requestId: run.request_id
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          authorized: true,
          attestation: auth.attestation,
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
    // 1. Fetch proposal
    const propRes = await fetch(`${baseUrl}/v1/runs/run-http-api/harvest/proposal`);
    assert.equal(propRes.status, 200);
    const proposal = (await propRes.json()) as any;
    assert.equal(proposal.readyForHarvest, true);
    assert.equal(proposal.acceptedTreeSha, "6666666666666666666666666666666666666666");

    // 2. Reject forged signature
    const forgedSig = "invalid-base64url-signature";
    const rejectRes = await fetch(`${baseUrl}/v1/runs/run-http-api/harvest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signature: forgedSig,
        signer_identity: "human:attacker@untrusted.org"
      })
    });
    assert.equal(rejectRes.status, 403);
    const rejectJson = (await rejectRes.json()) as any;
    assert.equal(rejectJson.authorized, false);
    assert.ok(rejectJson.reasons.some((r: string) => r.includes("signature")));

    // 3. Authorize with valid signature
    const validSig = signHarvest(
      {
        runId: proposal.runId,
        treeSha: proposal.acceptedTreeSha,
        envelopeHash: proposal.taskEnvelopeHash,
        policyVersion: proposal.policyVersion
      },
      privateKey
    );

    const approveRes = await fetch(`${baseUrl}/v1/runs/run-http-api/harvest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signature: validSig,
        signer_identity: "human:auditor@platform.internal"
      })
    });

    assert.equal(approveRes.status, 200);
    const approveJson = (await approveRes.json()) as any;
    assert.equal(approveJson.authorized, true);
    assert.equal(approveJson.attestation.run_id, "run-http-api");
    assert.equal(approveJson.attestation.accepted_tree_sha, "6666666666666666666666666666666666666666");
    assert.equal(approveJson.git_ref, "refs/tags/harvest-run-http-api");
    assert.ok(approveJson.commit_sha);
  } finally {
    server.close();
  }
});
