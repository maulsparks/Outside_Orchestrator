import assert from "node:assert/strict";
import test from "node:test";

import { CreateRunRequest, IngressRunRepository, RequestAdmissionEngine } from "../src/core/ingress.js";
import { InMemoryLeaseStorage, LeaseManager } from "../src/core/leaseManager.js";
import { FactoryRunRecord } from "../src/core/stateMachine.js";

class InMemoryIngressRepo implements IngressRunRepository {
  private readonly runs = new Map<string, FactoryRunRecord>();

  async getRun(runId: string): Promise<FactoryRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async createRun(run: FactoryRunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<FactoryRunRecord | null> {
    for (const run of this.runs.values()) {
      if (run.tenant_id === tenantId && run.idempotency_key === idempotencyKey) {
        return { ...run };
      }
    }
    return null;
  }

  async compareAndSwapRun(): Promise<boolean> {
    return true;
  }
}

function makeValidRequest(overrides?: Partial<CreateRunRequest>): CreateRunRequest {
  return {
    idempotencyKey: "idem-key-100",
    tenantId: "tenant-prod-01",
    repositoryId: "repo-core",
    parentGitSha: "0123456789012345678901234567890123456789",
    intent: "Implement feature X",
    acceptanceCriteria: ["AC 1: must pass tests"],
    policyVersion: "v1.0.0",
    agentsMdSha256: "a".repeat(64),
    budgetCents: 500,
    ...overrides
  };
}

test("RequestAdmissionEngine admits valid request and acquires initial lease", async () => {
  const repo = new InMemoryIngressRepo();
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "worker-01");
  const engine = new RequestAdmissionEngine(repo, leaseManager);

  const req = makeValidRequest();
  const result = await engine.admitRequest(req);

  assert.equal(result.isExisting, false);
  assert.equal(result.run.tenant_id, "tenant-prod-01");
  assert.equal(result.run.phase, "created");
  assert.equal(result.run.state_version, 1);
  assert.ok(result.lease !== undefined);
  assert.equal(result.lease.fencingToken, 1);
});

test("RequestAdmissionEngine returns existing run on duplicate idempotency key (AC 1)", async () => {
  const repo = new InMemoryIngressRepo();
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "worker-01");
  const engine = new RequestAdmissionEngine(repo, leaseManager);

  const req = makeValidRequest();
  const first = await engine.admitRequest(req);
  const second = await engine.admitRequest(req);

  assert.equal(first.isExisting, false);
  assert.equal(second.isExisting, true);
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.run.idempotency_key, req.idempotencyKey);
});

test("RequestAdmissionEngine rejects malformed request", async () => {
  const repo = new InMemoryIngressRepo();
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "worker-01");
  const engine = new RequestAdmissionEngine(repo, leaseManager);

  const badReq = makeValidRequest({ parentGitSha: "short-sha" }); // invalid SHA
  await assert.rejects(async () => engine.admitRequest(badReq), { message: /invalid parent_git_sha/ });
});

test("RequestAdmissionEngine preserves userPrompt in run envelope", async () => {
  const repo = new InMemoryIngressRepo();
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "worker-01");
  const engine = new RequestAdmissionEngine(repo, leaseManager);

  const promptText = "Add a GET /api/tags endpoint\nWhere: src/server.ts\nDone means: tests pass\nOut of scope: UI";
  const req = makeValidRequest({ userPrompt: promptText, intent: "Explicit feature intent" });
  const result = await engine.admitRequest(req);

  assert.equal(result.run.envelope?.user_prompt, promptText);
  assert.equal(result.run.envelope?.intent, "Explicit feature intent");
});

test("RequestAdmissionEngine derives intent from userPrompt when intent is not provided", async () => {
  const repo = new InMemoryIngressRepo();
  const leaseManager = new LeaseManager(new InMemoryLeaseStorage(), "worker-01");
  const engine = new RequestAdmissionEngine(repo, leaseManager);

  const promptText = "Fix race condition in lease renewal timer";
  const req = makeValidRequest({ intent: undefined, userPrompt: promptText });
  const result = await engine.admitRequest(req);

  assert.equal(result.run.envelope?.intent, "Fix race condition in lease renewal timer");
  assert.equal(result.run.envelope?.user_prompt, promptText);
});

