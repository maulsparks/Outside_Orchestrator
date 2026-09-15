import { describe, it } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { LiveSandboxRunner, LiveSandboxRunOptions } from "../src/core/liveRunner.js";
import { InMemoryRunStateStore, RunStateMachine, FactoryRunRecord } from "../src/core/stateMachine.js";
import { InMemoryEvidenceStore, EvidenceLedger } from "../src/warden/ledger.js";
import { LiveDispatcher, LiveDispatchConfig, LiveDispatchResult } from "../src/core/liveDispatcher.js";
import { GitHubPrPublisher } from "../src/adapters/github/prPublisher.js";

// Generate test Ed25519 keypair
const testKeyPair = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

describe("LiveSandboxRunner (Milestone 18)", () => {
  it("executes full end-to-end sandbox lifecycle and publishes GitHub PR", async () => {
    const runStore = new InMemoryRunStateStore();
    const stateMachine = new RunStateMachine(runStore);
    const evidenceStore = new InMemoryEvidenceStore();
    const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

    let dispatchedConfig: LiveDispatchConfig | null = null;

    // Mock LiveDispatcher
    const mockDispatcher = {
      executeRun: async (config: LiveDispatchConfig): Promise<LiveDispatchResult> => {
        dispatchedConfig = config;

        // Transition run to clean_terminated in state store
        const phases: Array<{ from: any; to: any }> = [
          { from: "created", to: "provisioning" },
          { from: "provisioning", to: "delegated" },
          { from: "delegated", to: "in_progress" },
          { from: "in_progress", to: "evaluating" },
          { from: "evaluating", to: "terminal" },
          { from: "terminal", to: "clean_terminated" }
        ];
        for (const p of phases) {
          const current = await runStore.getRun(config.run.id);
          await stateMachine.transition({
            runId: config.run.id,
            tenantId: config.run.tenant_id,
            expectedPhase: p.from,
            targetPhase: p.to,
            expectedStateVersion: current!.state_version,
            fencingToken: 1
          });
        }

        // Record boundary evidence: advisory_output_collected, erg_result, test_result, teardown_probe_passed
        await evidenceLedger.recordEvent({
          tenantId: config.run.tenant_id,
          requestId: `req_${config.run.id}`,
          runId: config.run.id,
          sandboxId: `sbx-${config.run.id}`,
          policyVersion: "v2.0",
          eventType: "advisory_output_collected",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: { trace_manifest_sha256: "manifest-sha256-verified" }
        });

        await evidenceLedger.recordEvent({
          tenantId: config.run.tenant_id,
          requestId: `req_${config.run.id}`,
          runId: config.run.id,
          sandboxId: `sbx-${config.run.id}`,
          policyVersion: "v2.0",
          eventType: "erg_result",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: { erg_result: { passed: true, unauthorizedTouches: [] } }
        });

        await evidenceLedger.recordEvent({
          tenantId: config.run.tenant_id,
          requestId: `req_${config.run.id}`,
          runId: config.run.id,
          sandboxId: `sbx-${config.run.id}`,
          policyVersion: "v2.0",
          eventType: "test_result",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: { test_gate_result: { passed: true, exitCode: 0 } }
        });

        await evidenceLedger.recordEvent({
          tenantId: config.run.tenant_id,
          requestId: `req_${config.run.id}`,
          runId: config.run.id,
          sandboxId: `sbx-${config.run.id}`,
          policyVersion: "v2.0",
          eventType: "teardown_probe_passed",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: { terminal_state: "CLEAN_TERMINATED", clean_terminated: true }
        });

        return {
          runId: config.run.id,
          phase: config.phase,
          phaseAttempt: 1,
          status: "completed",
          cleanTerminated: true,
          teardownResult: {
            runId: config.run.id,
            cleanTerminated: true,
            finalPhase: "clean_terminated",
            attestation: {
              run_id: config.run.id,
              terminal_state: "CLEAN_TERMINATED",
              clean_terminated: true
            } as any,
            evaluation: { passed: true, violations: [] },
            probeSummary: { targetIp: "100.81.98.73", allUnreachable: true, probes: [] }
          },
          outputTreeSha: "732dfcfcab03c978abffaf7a5ae0f0497ef6c8ea",
          declaredChangedFiles: ["output/phase_result.json"]
        };
      }
    } as unknown as LiveDispatcher;

    // Mock GitHubPrPublisher
    const mockPublisher = new GitHubPrPublisher({
      token: "test-token",
      fetchFn: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("/git/refs")) {
          return new Response(JSON.stringify({ ref: "refs/heads/factory/run-test", object: { sha: "commit123" } }), { status: 201 });
        }
        if (u.includes("/pulls")) {
          return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/maulsparks/Outside_Orchestrator/pull/42" }), { status: 201 });
        }
        return new Response("{}", { status: 200 });
      }) as any
    });

    const runner = new LiveSandboxRunner(
      mockDispatcher,
      stateMachine,
      runStore,
      evidenceLedger,
      undefined,
      mockPublisher
    );

    const testRunId = "run-live-test-001";
    const result = await runner.executeLiveRun({
      runId: testRunId,
      tenantId: "tenant-test",
      parentGitSha: "364ce4f34e3c65ba7d55268457cc71194274a411",
      userPrompt: "Test user prompt for live runner",
      executionKind: "code",
      deterministicCommand: "npm test",
      allowedPaths: ["output/**"],
      privateKeyPem: testKeyPair.privateKey,
      githubToken: "test-token",
      repositoryId: "maulsparks/Outside_Orchestrator",
      autoHarvest: true
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.cleanTerminated, true);
    assert.strictEqual(result.runId, testRunId);
    assert.strictEqual(result.prNumber, 42);
    assert.strictEqual(result.prUrl, "https://github.com/maulsparks/Outside_Orchestrator/pull/42");
    assert.strictEqual(result.prStatus, "created");
    assert.ok(result.attestation);
    assert.strictEqual(result.attestation.run_id, testRunId);
    assert.ok(result.attestation.signature);

    // Verify durable events in evidence ledger
    const events = await evidenceStore.getAllForRun(testRunId);
    const prPublishedEvt = events.find(e => (e.payload as any)?.observation?.pr_published === true);
    assert.ok(prPublishedEvt, "Missing pr_published evidence in ledger");
    assert.strictEqual((prPublishedEvt.payload as any).observation.pr_number, 42);
  });

  it("handles execution failure gracefully without publishing PR", async () => {
    const runStore = new InMemoryRunStateStore();
    const stateMachine = new RunStateMachine(runStore);
    const evidenceStore = new InMemoryEvidenceStore();
    const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

    const mockDispatcher = {
      executeRun: async (config: LiveDispatchConfig): Promise<LiveDispatchResult> => {
        return {
          runId: config.run.id,
          phase: config.phase,
          phaseAttempt: 1,
          status: "failed",
          cleanTerminated: false,
          teardownResult: {
            runId: config.run.id,
            cleanTerminated: false,
            finalPhase: "quarantined",
            attestation: {
              run_id: config.run.id,
              terminal_state: "QUARANTINED",
              clean_terminated: false
            } as any,
            evaluation: { passed: false, violations: ["Command failed inside sandbox"] },
            probeSummary: { targetIp: "100.81.98.73", allUnreachable: true, probes: [] }
          },
          error: "Simulated sandbox execution failure"
        };
      }
    } as unknown as LiveDispatcher;

    const runner = new LiveSandboxRunner(
      mockDispatcher,
      stateMachine,
      runStore,
      evidenceLedger
    );

    const testRunId = "run-fail-001";
    const result = await runner.executeLiveRun({
      runId: testRunId,
      tenantId: "tenant-test",
      parentGitSha: "364ce4f34e3c65ba7d55268457cc71194274a411",
      executionKind: "code",
      deterministicCommand: "exit 1",
      privateKeyPem: testKeyPair.privateKey,
      autoHarvest: true
    });

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.cleanTerminated, false);
    assert.strictEqual(result.prNumber, undefined);
    assert.strictEqual(result.prUrl, undefined);
    assert.ok(result.error?.includes("Simulated sandbox execution failure"));
  });

  it("respects autoHarvest: false option", async () => {
    const runStore = new InMemoryRunStateStore();
    const stateMachine = new RunStateMachine(runStore);
    const evidenceStore = new InMemoryEvidenceStore();
    const evidenceLedger = new EvidenceLedger(evidenceStore, testKeyPair.privateKey, "warden-test");

    const mockDispatcher = {
      executeRun: async (config: LiveDispatchConfig): Promise<LiveDispatchResult> => {
        return {
          runId: config.run.id,
          phase: config.phase,
          phaseAttempt: 1,
          status: "completed",
          cleanTerminated: true,
          teardownResult: {
            runId: config.run.id,
            cleanTerminated: true,
            finalPhase: "clean_terminated",
            attestation: {
              run_id: config.run.id,
              terminal_state: "CLEAN_TERMINATED",
              clean_terminated: true
            } as any,
            evaluation: { passed: true, violations: [] },
            probeSummary: { targetIp: "100.81.98.73", allUnreachable: true, probes: [] }
          }
        };
      }
    } as unknown as LiveDispatcher;

    const runner = new LiveSandboxRunner(
      mockDispatcher,
      stateMachine,
      runStore,
      evidenceLedger
    );

    const testRunId = "run-no-harvest-001";
    const result = await runner.executeLiveRun({
      runId: testRunId,
      tenantId: "tenant-test",
      parentGitSha: "364ce4f34e3c65ba7d55268457cc71194274a411",
      autoHarvest: false
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.cleanTerminated, true);
    assert.strictEqual(result.prNumber, undefined);
    assert.strictEqual(result.harvestResult, undefined);
  });
});
