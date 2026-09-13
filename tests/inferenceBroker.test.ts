import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import {
  InferenceBroker,
  ModelNotAllowedError,
  BudgetExceededError,
  InferenceWorkerUnavailableError,
  DEFAULT_MODEL_POLICY
} from "../src/core/inferenceBroker.js";
import { InMemoryRunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { EvidenceLedger, InMemoryEvidenceStore } from "../src/warden/ledger.js";
import { TailscaleClient, TailscaleDevice } from "../src/adapters/tailscale/client.js";

function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function makeRun(id = "run-inf-001", maxCostCents = 100, currentCostCents = 0): FactoryRunRecord {
  return {
    id,
    tenant_id: "tenant-001",
    request_id: "req-inf-001",
    idempotency_key: `idem-${id}`,
    parent_git_sha: "0123456789012345678901234567890123456789",
    policy_version: "v2.0",
    phase: "delegated",
    state_version: 1,
    budget: {
      max_cost_cents: maxCostCents,
      current_cost_cents: currentCostCents,
      total_tokens_consumed: 0
    },
    envelope: {}
  };
}

test("InferenceBroker successfully proxies chat completion and updates run budget", async (t) => {
  let receivedPayload: any = null;

  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-mock-12345",
          model: receivedPayload.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "function add(a: number, b: number): number { return a + b; }"
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150
          }
        }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const runStore = new InMemoryRunStateStore();
  const run = makeRun("run-chat-ok", 100, 0);
  runStore.setRun(run);

  const broker = new InferenceBroker({
    runStore,
    policy: {
      defaultEndpoint: `http://127.0.0.1:${port}`
    }
  });

  const response = await broker.brokerChat({
    runId: "run-chat-ok",
    model: "qwen2.5-coder:32b",
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Implement add(a, b)" }
    ],
    temperature: 0.1,
    max_tokens: 512
  });

  assert.equal(response.id, "chatcmpl-mock-12345");
  assert.equal(response.model, "qwen2.5-coder:32b");
  assert.ok(response.content.includes("function add"));
  assert.equal(response.promptTokens, 100);
  assert.equal(response.completionTokens, 50);
  assert.equal(response.totalTokens, 150);
  assert.ok(response.costCents > 0);
  assert.ok(response.remainingBudgetCents < 100);

  // Verify run budget updated in store
  const updatedRun = await runStore.getRun("run-chat-ok");
  const budget = updatedRun?.budget as any;
  assert.equal(budget.last_model_used, "qwen2.5-coder:32b");
  assert.equal(budget.total_tokens_consumed, 150);
  assert.equal(budget.current_cost_cents, response.costCents);
});

test("InferenceBroker rejects unapproved models via ModelNotAllowedError", async () => {
  const runStore = new InMemoryRunStateStore();
  runStore.setRun(makeRun("run-bad-model"));

  const broker = new InferenceBroker({ runStore });

  await assert.rejects(
    async () => {
      await broker.brokerChat({
        runId: "run-bad-model",
        model: "unauthorized-gpt-5-model",
        messages: [{ role: "user", content: "hello" }]
      });
    },
    (err: any) => {
      assert.ok(err instanceof ModelNotAllowedError);
      assert.ok(err.message.includes("unauthorized-gpt-5-model"));
      assert.ok(err.message.includes("qwen2.5-coder:32b"));
      return true;
    }
  );
});

test("InferenceBroker rejects requests when budget is exhausted via BudgetExceededError", async () => {
  const runStore = new InMemoryRunStateStore();
  // Max 50 cents, already consumed 50 cents
  runStore.setRun(makeRun("run-budget-out", 50, 50));

  const broker = new InferenceBroker({ runStore });

  await assert.rejects(
    async () => {
      await broker.brokerChat({
        runId: "run-budget-out",
        model: "qwen2.5-coder:32b",
        messages: [{ role: "user", content: "hello" }]
      });
    },
    (err: any) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.ok(err.message.includes("exhausted its budget"));
      return true;
    }
  );
});

test("InferenceBroker resolves worker endpoint from Tailscale private compute tag", async () => {
  const runStore = new InMemoryRunStateStore();
  const mockTailscaleClient = {
    getDevices: async (): Promise<TailscaleDevice[]> => [
      {
        id: "node-worker-01",
        hostname: "worker-01",
        name: "private-gpu-worker",
        addresses: ["100.81.98.55"],
        tags: ["tag:private-compute-prod"],
        authorized: true,
        isExternal: false
      }
    ]
  } as unknown as TailscaleClient;

  const broker = new InferenceBroker({
    runStore,
    tailscaleClient: mockTailscaleClient
  });

  const endpoint = await broker.resolveWorkerEndpoint();
  assert.equal(endpoint, "http://100.81.98.55:8000");
});

test("InferenceBroker falls back to MODEL_INFERENCE_ENDPOINT env var", async () => {
  const runStore = new InMemoryRunStateStore();
  const originalEnv = process.env.MODEL_INFERENCE_ENDPOINT;
  process.env.MODEL_INFERENCE_ENDPOINT = "http://10.0.0.99:11434";

  try {
    const broker = new InferenceBroker({ runStore });
    const endpoint = await broker.resolveWorkerEndpoint();
    assert.equal(endpoint, "http://10.0.0.99:11434");
  } finally {
    if (originalEnv !== undefined) {
      process.env.MODEL_INFERENCE_ENDPOINT = originalEnv;
    } else {
      delete process.env.MODEL_INFERENCE_ENDPOINT;
    }
  }
});

test("InferenceBroker commits signed audit trail to EvidenceLedger", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-audit-test",
        model: "deepseek-coder-v2",
        choices: [{ message: { role: "assistant", content: "code output" } }],
        usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  t.after(() => server.close());

  const keyPair = generateEd25519KeyPair();
  const evidenceStore = new InMemoryEvidenceStore();
  const ledger = new EvidenceLedger(evidenceStore, keyPair.privateKey);

  const runStore = new InMemoryRunStateStore();
  runStore.setRun(makeRun("run-audit-ledger", 200, 0));

  const broker = new InferenceBroker({
    runStore,
    evidenceLedger: ledger,
    policy: {
      defaultEndpoint: `http://127.0.0.1:${port}`
    }
  });

  await broker.brokerChat({
    runId: "run-audit-ledger",
    model: "deepseek-coder-v2",
    messages: [{ role: "user", content: "Audit test" }]
  });

  // Verify evidence ledger recorded the network_decision_observed event
  const events = await evidenceStore.getAllForRun("run-audit-ledger");
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.payload.event_type, "network_decision_observed");
  assert.equal(event.run_id, "run-audit-ledger");
  const payload = event.payload as any;
  assert.ok(payload.observation);
  assert.equal(payload.observation.action, "brokered_inference");
  assert.equal(payload.observation.model, "deepseek-coder-v2");
  assert.equal(payload.observation.total_tokens, 75);
  assert.ok(payload.observation.response_sha256);
  assert.ok(event.signature);
});

test("InferenceBroker throws InferenceWorkerUnavailableError when server unreachable", async () => {
  const runStore = new InMemoryRunStateStore();
  runStore.setRun(makeRun("run-unreachable"));

  const broker = new InferenceBroker({
    runStore,
    policy: {
      defaultEndpoint: "http://127.0.0.1:59999" // Unreachable port
    }
  });

  await assert.rejects(
    async () => {
      await broker.brokerChat({
        runId: "run-unreachable",
        model: "qwen2.5-coder:32b",
        messages: [{ role: "user", content: "ping" }]
      });
    },
    (err: any) => {
      assert.ok(err instanceof InferenceWorkerUnavailableError);
      assert.ok(err.message.includes("Failed to reach inference worker"));
      return true;
    }
  );
});
