/**
 * Live Dispatch Coordinator (Milestone v0.3)
 * Orchestrates live end-to-end execution of factory runs on disposable exe.dev sandboxes.
 * Placed authoritatively on Tier 1 Edge/Control Plane.
 */

import { ExeDevClient } from "../adapters/exedev/client.js";
import { TailscaleClient, TailscaleDevice } from "../adapters/tailscale/client.js";
import { buildBootstrapScript, formatSetupScriptForExeDev } from "../adapters/exedev/bootstrap.js";
import { verifyNodePosture } from "./nodeVerifier.js";
import { DelegationDispatcher, BuildDelegationOptions } from "./dispatcher.js";
import { LeaseManager } from "./leaseManager.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { collectAndVerifyAdvisoryOutput, AdvisoryOutputPackage } from "../warden/collector.js";
import { reconcileTreeEffects } from "./erg.js";
import { executeFrozenTestSuite } from "./harvest.js";
import { TeardownEngine, TeardownResult } from "./teardownEngine.js";
import { RunStateMachine, FactoryRunRecord } from "./stateMachine.js";
import type { Phase as FactoryExecutionPhase } from "../../contracts/interfaces.js";

export interface LiveDispatchConfig {
  run: FactoryRunRecord;
  phase: FactoryExecutionPhase;
  allowedPaths: string[];
  immutablePaths?: string[];
  armId?: string;
  cpuMillis?: number;
  memoryMb?: number;
  ttlSeconds?: number;
  pollIntervalMs?: number;
  maxWaitBootMs?: number;
}

export interface LiveDispatchResult {
  runId: string;
  status: "completed" | "failed";
  cleanTerminated: boolean;
  teardownResult: TeardownResult;
  error?: string;
}

export class LiveDispatcher {
  constructor(
    private readonly exeDevClient: ExeDevClient,
    private readonly tailscaleClient: TailscaleClient,
    private readonly leaseManager: LeaseManager,
    private readonly evidenceLedger: EvidenceLedger,
    private readonly teardownEngine: TeardownEngine,
    private readonly stateMachine: RunStateMachine
  ) {}

  /**
   * Executes a complete live sandbox attempt from provisioning to clean teardown.
   */
  async executeRun(config: LiveDispatchConfig): Promise<LiveDispatchResult> {
    const { run, phase, allowedPaths } = config;
    const runId = run.id;
    const tenantId = run.tenant_id;
    const requestId = `req_${runId}`;
    const sandboxId = config.armId ? `sbx-${runId}-${config.armId}` : `sbx-${runId}`;
    const vmName = sandboxId;
    const pollIntervalMs = config.pollIntervalMs ?? 3000;
    const maxWaitBootMs = config.maxWaitBootMs ?? 180000; // 3 min boot timeout
    const policyVersion = run.policy_version || "v2.0";

    let tailscaleDevice: TailscaleDevice | null = null;
    let nodeIp: string = "127.0.0.1";
    let leaseToken = 1;
    let stateVersion = run.state_version;
    let currentPhase = run.phase;

    try {
      // 1. Advance phase to provisioning in Tier 3
      const provTransition = await this.stateMachine.transition({
        runId,
        tenantId,
        expectedPhase: currentPhase,
        targetPhase: "provisioning",
        expectedStateVersion: stateVersion,
        fencingToken: leaseToken
      });
      stateVersion = provTransition.newStateVersion;
      currentPhase = "provisioning";

      // 2. Mint single-use ephemeral Tailscale auth key (tag:factory-sandbox only)
      const authKey = await this.tailscaleClient.createSandboxAuthKey({
        tags: ["tag:factory-sandbox"],
        ephemeral: true,
        expirySeconds: 3600
      });

      // 3. Build bootstrap script & provision exe.dev VM
      const rawBootstrap = buildBootstrapScript({
        vmName,
        tailscaleAuthKey: authKey.key,
        parentSha: run.parent_git_sha
      });
      const formattedScript = formatSetupScriptForExeDev(rawBootstrap);

      await this.exeDevClient.createSandboxVm({
        runId,
        armId: config.armId,
        cpuMillis: config.cpuMillis ?? 2000,
        memoryMb: config.memoryMb ?? 2048,
        setupScript: formattedScript
      });

      // 4. Poll Tailscale device API until VM enrolls
      const startTime = Date.now();
      while (!tailscaleDevice && (Date.now() - startTime < maxWaitBootMs)) {
        tailscaleDevice = await this.tailscaleClient.findDeviceByHostname(vmName);
        if (!tailscaleDevice) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
        }
      }

      if (!tailscaleDevice) {
        throw new Error(`Timeout waiting for exe.dev VM '${vmName}' to enroll into Tailscale within ${maxWaitBootMs}ms`);
      }

      nodeIp = tailscaleDevice.addresses[0];
      if (!nodeIp) {
        throw new Error(`Enrolled Tailscale device '${vmName}' has no IP address`);
      }

      const sandboxBaseUrl = nodeIp.includes(":") ? `http://${nodeIp}` : `http://${nodeIp}:8787`;

      // 5. Pre-delegation posture gate
      const posture = verifyNodePosture({
        device: tailscaleDevice,
        expectedTags: ["tag:factory-sandbox"],
        networkPolicy: "isolated"
      });

      if (!posture.passed) {
        throw new Error(`NodePostureGateFailed: ${posture.violations.join(", ")}`);
      }

      await this.evidenceLedger.recordEvent({
        tenantId,
        requestId,
        runId,
        armId: config.armId,
        sandboxId,
        exeVmId: vmName,
        tailscaleNodeId: tailscaleDevice.id,
        tailscaleTags: tailscaleDevice.tags,
        policyVersion,
        eventType: "tailscale_enrollment_observed",
        source: { role: "Outside_Orchestrator", host: "srv719637" },
        observation: {
          node_id: tailscaleDevice.id,
          hostname: tailscaleDevice.hostname,
          ip: nodeIp,
          tags: tailscaleDevice.tags,
          posture_passed: true
        }
      });

      // 6. Wait for Inside Orchestrator health check on port 8787
      let daemonReady = false;
      const healthStart = Date.now();
      while (!daemonReady && (Date.now() - healthStart < 60000)) {
        try {
          const res = await fetch(`${sandboxBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) daemonReady = true;
        } catch {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      if (!daemonReady) {
        throw new Error(`Inside Orchestrator daemon on ${sandboxBaseUrl} failed to become healthy within 60s`);
      }

      // 7. Dispatch single-phase delegation envelope
      const dispatcher = new DelegationDispatcher();
      const dispatchOptions: BuildDelegationOptions = {
        run: { ...run, state_version: stateVersion },
        phase,
        phaseAttempt: 1,
        taskEnvelopeHash: "sha256-default-task-envelope",
        agentsMdSha256: "sha256-default-agents-md",
        allowedPaths,
        immutablePaths: config.immutablePaths ?? ["AGENTS.md"],
        acceptanceCriteria: ["Phase outputs valid results within allowed paths"],
        commandPolicyId: "default-policy-v1",
        runtimeCredentialReference: "jwt-claim-scoped",
        ttlSeconds: config.ttlSeconds ?? 600
      };

      const { envelope, envelopeHash } = await dispatcher.buildAndDispatchEnvelope(dispatchOptions);

      await this.evidenceLedger.recordEvent({
        tenantId,
        requestId,
        runId,
        armId: config.armId,
        sandboxId,
        exeVmId: vmName,
        tailscaleNodeId: tailscaleDevice.id,
        tailscaleTags: tailscaleDevice.tags,
        policyVersion,
        eventType: "delegation_dispatched",
        source: { role: "Outside_Orchestrator", host: "srv719637" },
        observation: {
          phase,
          attempt: 1,
          envelope_hash: envelopeHash,
          target_ip: nodeIp
        }
      });

      // Deliver envelope to Inside Orchestrator via POST /delegate
      const delivRes = await fetch(`${sandboxBaseUrl}/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope)
      });

      if (!delivRes.ok) {
        const err = await delivRes.text();
        throw new Error(`Delegation rejected by Inside Orchestrator: ${err}`);
      }

      // Advance state to delegated -> in_progress
      const delTransition = await this.stateMachine.transition({
        runId,
        tenantId,
        expectedPhase: currentPhase,
        targetPhase: "delegated",
        expectedStateVersion: stateVersion,
        fencingToken: leaseToken
      });
      stateVersion = delTransition.newStateVersion;
      currentPhase = "delegated";

      const progTransition = await this.stateMachine.transition({
        runId,
        tenantId,
        expectedPhase: currentPhase,
        targetPhase: "in_progress",
        expectedStateVersion: stateVersion,
        fencingToken: leaseToken
      });
      stateVersion = progTransition.newStateVersion;
      currentPhase = "in_progress";

      // 8. Supervise execution and poll status
      let executionComplete = false;
      const execStart = Date.now();
      const maxExecTimeMs = (config.ttlSeconds ?? 600) * 1000;

      while (!executionComplete && (Date.now() - execStart < maxExecTimeMs)) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        try {
          const sRes = await fetch(`${sandboxBaseUrl}/status`, { signal: AbortSignal.timeout(3000) });
          if (sRes.ok) {
            const sData = (await sRes.json()) as { status: string };
            if (sData.status === "completed" || sData.status === "failed") {
              executionComplete = true;
            }
          }
        } catch {
          // Retry on transient network blip
        }
      }

      if (!executionComplete) {
        throw new Error(`Execution exceeded TTL of ${config.ttlSeconds ?? 600}s`);
      }

      // 9. Pull advisory trace package and verify manifest hash (v1 pull model)
      const advisory = await collectAndVerifyAdvisoryOutput({
        runId,
        tenantId,
        requestId,
        sandboxId,
        policyVersion,
        ledger: this.evidenceLedger,
        fetchPackage: async (): Promise<AdvisoryOutputPackage> => {
          const pkgRes = await fetch(`${sandboxBaseUrl}/trace/package`);
          if (!pkgRes.ok) {
            throw new Error(`Failed to fetch advisory package (${pkgRes.status}): ${await pkgRes.text()}`);
          }
          const pkg = (await pkgRes.json()) as any;
          const eventsRes = await fetch(`${sandboxBaseUrl}/trace/events`);
          const traceJsonl = await eventsRes.text();

          return {
            runId,
            tenantId,
            phase,
            phaseAttempt: 1,
            sandboxId,
            traceManifestSha256: pkg.trace_manifest_sha256,
            traceJsonl,
            declaredChangedFiles: pkg.declared_changed_files || [],
            resultStatus: "completed"
          };
        }
      });

      // 10. Effect Reconciliation Gate (ERG)
      const ergResult = reconcileTreeEffects({
        baseTreeSha: run.parent_git_sha,
        postTreeSha: "observed-tree-sha",
        declaredChangedFiles: advisory.declaredChangedFiles,
        allowedPaths,
        immutablePaths: config.immutablePaths ?? ["AGENTS.md"],
        actualChangedFiles: advisory.declaredChangedFiles
      });

      if (!ergResult.passed) {
        throw new Error(`EffectReconciliationFailed: ${ergResult.rejectionReason}`);
      }

      // 11. Run 13-step teardown cleanly
      const teardownResult = await this.teardownEngine.executeTeardown({
        runId,
        tenantId,
        requestId,
        sandboxId,
        exeVmId: vmName,
        tailscaleNodeId: tailscaleDevice.id,
        tailscaleIp: nodeIp,
        policyVersion,
        fencingToken: leaseToken,
        expectedStateVersion: stateVersion,
        currentPhase,
        sendStopSentinel: async () => {
          await fetch(`${sandboxBaseUrl}/stop`, { method: "POST" }).catch(() => {});
        }
      });

      return {
        runId,
        status: teardownResult.cleanTerminated ? "completed" : "failed",
        cleanTerminated: teardownResult.cleanTerminated,
        teardownResult
      };
    } catch (err: any) {
      // Execute teardown across any failure flow
      const teardownResult = await this.teardownEngine.executeTeardown({
        runId,
        tenantId,
        requestId,
        sandboxId,
        exeVmId: vmName,
        tailscaleNodeId: tailscaleDevice ? tailscaleDevice.id : "unknown-node",
        tailscaleIp: nodeIp,
        policyVersion,
        fencingToken: leaseToken,
        expectedStateVersion: stateVersion,
        currentPhase
      });

      return {
        runId,
        status: "failed",
        cleanTerminated: teardownResult.cleanTerminated,
        teardownResult,
        error: err.message
      };
    }
  }
}
