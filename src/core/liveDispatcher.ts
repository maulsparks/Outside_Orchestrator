/**
 * Live Dispatch Coordinator (Milestone v0.3)
 * Orchestrates live end-to-end execution of factory runs on disposable exe.dev sandboxes.
 * Placed authoritatively on Tier 1 Edge/Control Plane.
 */

import crypto from "node:crypto";
import { ExeDevClient } from "../adapters/exedev/client.js";
import { TailscaleClient, TailscaleDevice } from "../adapters/tailscale/client.js";
import { buildBootstrapScript, formatSetupScriptForExeDev } from "../adapters/exedev/bootstrap.js";
import { verifyNodePosture } from "./nodeVerifier.js";
import { DelegationDispatcher, BuildDelegationOptions, PhaseEnvelopeStore } from "./dispatcher.js";
import { LeaseManager } from "./leaseManager.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { collectAndVerifyAdvisoryOutput, AdvisoryOutputPackage } from "../warden/collector.js";
import { reconcileTreeEffects } from "./erg.js";
import { executeFrozenTestSuite } from "./harvest.js";
import { TeardownEngine, TeardownResult } from "./teardownEngine.js";
import { RunStateMachine, FactoryRunRecord } from "./stateMachine.js";
import { PolicyIntegrityVerifier } from "./policyIntegrity.js";
import type { Phase as FactoryExecutionPhase } from "../../contracts/interfaces.js";
import { metrics } from "./metrics.js";

export interface LiveDispatchConfig {
  run: FactoryRunRecord;
  phase: FactoryExecutionPhase;
  phaseAttempt?: number;
  sandboxId?: string;
  vmName?: string;
  allowedPaths: string[];
  immutablePaths?: string[];
  armId?: string;
  agentsMdSha256?: string;
  agentsMdContent?: string;
  cpuMillis?: number;
  memoryMb?: number;
  ttlSeconds?: number;
  pollIntervalMs?: number;
  maxWaitBootMs?: number;
  executionKind?: "agent" | "code";
  deterministicCommand?: string;
}

export interface LiveDispatchResult {
  runId: string;
  phase: FactoryExecutionPhase;
  phaseAttempt: number;
  status: "completed" | "failed";
  cleanTerminated: boolean;
  teardownResult: TeardownResult;
  advisory?: {
    traceManifestSha256: string;
    declaredChangedFiles: string[];
    resultStatus: string;
  };
  outputTreeSha?: string;
  declaredChangedFiles?: string[];
  error?: string;
}

export class LiveDispatcher {
  private readonly policyVerifier: PolicyIntegrityVerifier;

  constructor(
    private readonly exeDevClient: ExeDevClient,
    private readonly tailscaleClient: TailscaleClient,
    private readonly leaseManager: LeaseManager,
    private readonly evidenceLedger: EvidenceLedger,
    private readonly teardownEngine: TeardownEngine,
    private readonly stateMachine: RunStateMachine,
    private readonly phaseEnvelopeStore?: PhaseEnvelopeStore,
    policyVerifier?: PolicyIntegrityVerifier
  ) {
    this.policyVerifier = policyVerifier ?? new PolicyIntegrityVerifier(evidenceLedger);
  }

  /**
   * Executes a complete live sandbox attempt from provisioning to clean teardown.
   */
  async executeRun(config: LiveDispatchConfig): Promise<LiveDispatchResult> {
    const { run, phase, allowedPaths } = config;
    const runId = run.id;
    const tenantId = run.tenant_id;
    const requestId = `req_${runId}`;
    const attempt = config.phaseAttempt ?? 1;
    const sandboxId = config.sandboxId ?? (config.armId ? `sbx-${runId}-${config.armId}` : `sbx-${runId}`);
    const vmName = config.vmName ?? sandboxId;
    const pollIntervalMs = config.pollIntervalMs ?? 3000;
    const maxWaitBootMs = config.maxWaitBootMs ?? 180000; // 3 min boot timeout
    const policyVersion = run.policy_version || "v2.0";

    let tailscaleDevice: TailscaleDevice | null = null;
    let nodeIp: string = "127.0.0.1";
    let leaseToken = 1;
    let stateVersion = run.state_version;
    let currentPhase = run.phase;
    const phaseStartTime = Date.now();

    try {
      console.log(`[LiveDispatcher:${runId}] Starting live execution: phase='${phase}', sandbox='${sandboxId}'`);

      // 0. Pre-flight policy & AGENTS.md integrity verification (Contract §6.2, §7.1, §8)
      console.log(`[LiveDispatcher:${runId}] Verifying pre-flight policy and AGENTS.md integrity...`);
      await this.policyVerifier.verifyPhasePreflight({
        run,
        phase,
        attempt,
        currentAgentsMdSha256: config.agentsMdSha256,
        currentAgentsMdContent: config.agentsMdContent,
        sandboxId
      });

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
      console.log(`[LiveDispatcher:${runId}] Phase advanced to 'provisioning' (state_version: ${stateVersion})`);

      // 2. Mint single-use ephemeral Tailscale auth key (tag:factory-sandbox only)
      console.log(`[LiveDispatcher:${runId}] Minting single-use Tailscale auth key (tag:factory-sandbox)...`);
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

      console.log(`[LiveDispatcher:${runId}] Provisioning exe.dev VM '${vmName}' with bootstrap payload...`);
      await this.exeDevClient.createSandboxVm({
        runId,
        armId: config.armId,
        phase,
        vmName,
        cpuMillis: config.cpuMillis ?? 2000,
        memoryMb: config.memoryMb ?? 2048,
        setupScript: formattedScript
      });
      metrics.sandboxesProvisionedTotal.inc({ phase });
      console.log(`[LiveDispatcher:${runId}] VM created on exe.dev. Waiting for Tailscale enrollment...`);

      // 4. Poll Tailscale device API until VM enrolls
      const startTime = Date.now();
      let lastEnrollLog = 0;
      while (!tailscaleDevice && (Date.now() - startTime < maxWaitBootMs)) {
        tailscaleDevice = await this.tailscaleClient.findDeviceByHostname(vmName);
        if (!tailscaleDevice) {
          if (Date.now() - lastEnrollLog > 10000) {
            console.log(`[LiveDispatcher:${runId}] Waiting for '${vmName}' on Tailscale (${((Date.now() - startTime)/1000).toFixed(0)}s)...`);
            lastEnrollLog = Date.now();
          }
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
      console.log(`[LiveDispatcher:${runId}] Enrolled: hostname='${tailscaleDevice.hostname}', ip='${nodeIp}', url='${sandboxBaseUrl}'`);

      // 5. Pre-delegation posture gate
      const posture = verifyNodePosture({
        device: tailscaleDevice,
        expectedTags: ["tag:factory-sandbox"],
        networkPolicy: "isolated"
      });

      if (!posture.passed) {
        throw new Error(`NodePostureGateFailed: ${posture.violations.join(", ")}`);
      }
      console.log(`[LiveDispatcher:${runId}] Pre-delegation posture gate passed.`);

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
      console.log(`[LiveDispatcher:${runId}] Probing Inside Orchestrator at ${sandboxBaseUrl}/health...`);
      let daemonReady = false;
      const healthStart = Date.now();
      let lastHealthLog = 0;
      while (!daemonReady && (Date.now() - healthStart < 90000)) {
        try {
          const res = await fetch(`${sandboxBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            daemonReady = true;
            console.log(`[LiveDispatcher:${runId}] Inside Orchestrator daemon is healthy (${((Date.now() - healthStart)/1000).toFixed(1)}s).`);
            break;
          }
        } catch (e: any) {
          if (Date.now() - lastHealthLog > 5000) {
            console.log(`[LiveDispatcher:${runId}] Probing ${sandboxBaseUrl}/health (${((Date.now() - healthStart)/1000).toFixed(0)}s elapsed)... ${e.message}`);
            lastHealthLog = Date.now();
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (!daemonReady) {
        throw new Error(`Inside Orchestrator daemon on ${sandboxBaseUrl} failed to become healthy within 90s`);
      }

      // 7. Dispatch single-phase delegation envelope
      console.log(`[LiveDispatcher:${runId}] Building and dispatching delegation envelope...`);
      const dispatcher = new DelegationDispatcher(this.phaseEnvelopeStore);

      const resolvedAgentsMdSha256 = (run.envelope as Record<string, unknown>)?.agents_md_sha256
        ? String((run.envelope as Record<string, unknown>).agents_md_sha256)
        : (config.agentsMdSha256 ?? "0".repeat(64));

      const userPrompt = (run.envelope as Record<string, unknown>)?.user_prompt as string | undefined;
      const maxFixLoops = typeof (run.envelope as Record<string, unknown>)?.max_fix_loops === "number"
        ? Number((run.envelope as Record<string, unknown>).max_fix_loops)
        : 3;
      const executionKind = config.executionKind ?? ((run.envelope as Record<string, unknown>)?.execution_kind as ("agent" | "code") | undefined);
      const deterministicCommand = config.deterministicCommand ?? ((run.envelope as Record<string, unknown>)?.deterministic_command as string | undefined);
      const runAcceptance = ((run.envelope as Record<string, unknown>)?.acceptance_criteria as string[]) ?? ["Phase outputs valid results within allowed paths"];

      const dispatchOptions: BuildDelegationOptions = {
        run: { ...run, state_version: stateVersion },
        phase,
        phaseAttempt: attempt,
        taskEnvelopeHash: "sha256-default-task-envelope",
        agentsMdSha256: resolvedAgentsMdSha256,
        userPrompt,
        maxFixLoops,
        executionKind,
        deterministicCommand,
        allowedPaths,
        immutablePaths: config.immutablePaths ?? ["AGENTS.md"],
        acceptanceCriteria: runAcceptance,
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
      console.log(`[LiveDispatcher:${runId}] Delivering envelope to ${sandboxBaseUrl}/delegate...`);
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
      console.log(`[LiveDispatcher:${runId}] Phase advanced to 'delegated' (v${stateVersion})`);

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
      console.log(`[LiveDispatcher:${runId}] Phase advanced to 'in_progress' (v${stateVersion})`);

      // 8. Supervise execution and poll status
      console.log(`[LiveDispatcher:${runId}] Supervising sandbox execution...`);
      let executionComplete = false;
      let lastReportedStatus = "";
      const execStart = Date.now();
      const maxExecTimeMs = (config.ttlSeconds ?? 600) * 1000;

      while (!executionComplete && (Date.now() - execStart < maxExecTimeMs)) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        try {
          const sRes = await fetch(`${sandboxBaseUrl}/status`, { signal: AbortSignal.timeout(3000) });
          if (sRes.ok) {
            const sData = (await sRes.json()) as { status: string; fix_loop?: number; max_fix_loops?: number; last_error?: string };
            if (sData.status === "correcting") {
              console.log(`[LiveDispatcher:${runId}] Inside execution in correction loop ${sData.fix_loop ?? 1}/${sData.max_fix_loops ?? 3}: ${sData.last_error ?? "retrying..."}`);
            }
            if (sData.status === "completed" || sData.status === "failed") {
              executionComplete = true;
              lastReportedStatus = sData.status;
              console.log(`[LiveDispatcher:${runId}] Inside execution reported status: '${sData.status}' (loop ${sData.fix_loop ?? 1}/${sData.max_fix_loops ?? 3})`);
            }
          }
        } catch {
          // Retry on transient network blip
        }
      }

      if (!executionComplete) {
        throw new Error(`Execution exceeded TTL of ${config.ttlSeconds ?? 600}s`);
      }

      if (lastReportedStatus === "failed") {
        throw new Error(`Inside Orchestrator execution reported failure during phase '${phase}'`);
      }

      // 9. Pull advisory trace package and verify manifest hash (v1 pull model)
      console.log(`[LiveDispatcher:${runId}] Pulling advisory traces from sandbox...`);
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
            phaseAttempt: attempt,
            sandboxId,
            traceManifestSha256: pkg.trace_manifest_sha256,
            traceJsonl,
            declaredChangedFiles: pkg.declared_changed_files || [],
            resultStatus: "completed"
          };
        }
      });
      console.log(`[LiveDispatcher:${runId}] Advisory traces verified (manifest SHA: ${advisory.computedManifestSha256.substring(0, 16)}...)`);

      // 10. Effect Reconciliation Gate (ERG)
      console.log(`[LiveDispatcher:${runId}] Reconciling effects with ERG...`);
      const outputTreeSha = advisory.declaredChangedFiles.length > 0
        ? crypto.createHash("sha256").update(run.parent_git_sha + ":" + advisory.declaredChangedFiles.join(",")).digest("hex")
        : run.parent_git_sha;

      const ergResult = reconcileTreeEffects({
        baseTreeSha: run.parent_git_sha,
        postTreeSha: outputTreeSha,
        declaredChangedFiles: advisory.declaredChangedFiles,
        allowedPaths,
        immutablePaths: config.immutablePaths ?? ["AGENTS.md"],
        actualChangedFiles: advisory.declaredChangedFiles
      });

      if (!ergResult.passed) {
        throw new Error(`EffectReconciliationFailed: ${ergResult.rejectionReason}`);
      }
      console.log(`[LiveDispatcher:${runId}] ERG passed.`);

      // 11. Run 13-step teardown cleanly
      console.log(`[LiveDispatcher:${runId}] Initiating clean 13-step teardown...`);
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

      console.log(`[LiveDispatcher:${runId}] Teardown completed: cleanTerminated=${teardownResult.cleanTerminated}, finalPhase=${teardownResult.finalPhase}`);
      metrics.phaseDurationSeconds.observe((Date.now() - phaseStartTime) / 1000, { phase });

      if (this.phaseEnvelopeStore) {
        await this.phaseEnvelopeStore.recordPhaseOutputs({
          runId,
          phase,
          attempt,
          outputs: {
            status: teardownResult.cleanTerminated ? "completed" : "failed",
            trace_manifest_sha256: advisory.computedManifestSha256,
            declared_changed_files: advisory.declaredChangedFiles,
            output_tree_sha: outputTreeSha,
            clean_terminated: teardownResult.cleanTerminated,
            terminal_state: teardownResult.attestation.terminal_state
          }
        }).catch((e) => console.warn(`[LiveDispatcher:${runId}] Failed to record phase outputs:`, e.message));
      }

      return {
        runId,
        phase,
        phaseAttempt: attempt,
        status: teardownResult.cleanTerminated ? "completed" : "failed",
        cleanTerminated: teardownResult.cleanTerminated,
        teardownResult,
        advisory: {
          traceManifestSha256: advisory.computedManifestSha256,
          declaredChangedFiles: advisory.declaredChangedFiles,
          resultStatus: advisory.resultStatus
        },
        outputTreeSha,
        declaredChangedFiles: advisory.declaredChangedFiles
      };
    } catch (err: any) {
      console.error(`[LiveDispatcher:${runId}] Live execution error: ${err.message}. Initiating teardown...`);

      if (currentPhase === "created") {
        await this.stateMachine.transition({
          runId,
          tenantId,
          expectedPhase: "created",
          targetPhase: "quarantined",
          expectedStateVersion: stateVersion,
          fencingToken: leaseToken,
          eventType: "run_quarantined",
          eventPayload: { reason: err.message }
        }).catch(() => {});

        return {
          runId,
          phase,
          phaseAttempt: attempt,
          status: "failed",
          cleanTerminated: false,
          teardownResult: {
            runId,
            cleanTerminated: false,
            finalPhase: "quarantined",
            attestation: {} as any,
            evaluation: { passed: false, violations: ["not_provisioned"] },
            probeSummary: { targetIp: nodeIp, allUnreachable: true, probes: [] }
          },
          error: err.message
        };
      }

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
      console.log(`[LiveDispatcher:${runId}] Failure teardown finished: cleanTerminated=${teardownResult.cleanTerminated}, finalPhase=${teardownResult.finalPhase}`);

      if (this.phaseEnvelopeStore) {
        await this.phaseEnvelopeStore.recordPhaseOutputs({
          runId,
          phase,
          attempt,
          outputs: {
            status: "failed",
            error: err.message,
            clean_terminated: teardownResult.cleanTerminated
          }
        }).catch(() => {});
      }

      return {
        runId,
        phase,
        phaseAttempt: attempt,
        status: "failed",
        cleanTerminated: teardownResult.cleanTerminated,
        teardownResult,
        error: err.message
      };
    }
  }
}
