/**
 * Multi-Phase External Sequencer (Contract §6.5 & AC 20)
 * Orchestrates external sequencing of factory phases (e.g. plan -> build -> test -> review).
 * Enforces clean-room sandbox VM lifecycle, external lease management, parent tree SHA propagation,
 * and immutable Tier 3 phase envelopes for each phase attempt.
 */

import { LiveDispatcher, LiveDispatchConfig, LiveDispatchResult } from "./liveDispatcher.js";
import { FactoryRunRecord, RunStateMachine, RunStateStore } from "./stateMachine.js";
import { PhaseEnvelopeStore } from "./dispatcher.js";
import { EvidenceLedger } from "../warden/ledger.js";
import type { Phase as FactoryExecutionPhase } from "../../contracts/interfaces.js";

export interface MultiPhaseSequenceConfig {
  run: FactoryRunRecord;
  phases: FactoryExecutionPhase[];
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
}

export interface MultiPhaseSequenceResult {
  runId: string;
  status: "completed" | "failed";
  finalPhase?: FactoryExecutionPhase;
  failedPhase?: FactoryExecutionPhase;
  completedPhases: FactoryExecutionPhase[];
  finalTreeSha: string;
  phaseResults: Record<string, LiveDispatchResult>;
  error?: string;
}

export class MultiPhaseSequencer {
  constructor(
    private readonly liveDispatcher: LiveDispatcher,
    private readonly stateMachine: RunStateMachine,
    private readonly runStore: RunStateStore,
    private readonly evidenceLedger?: EvidenceLedger,
    private readonly phaseEnvelopeStore?: PhaseEnvelopeStore
  ) {}

  /**
   * Executes a sequence of factory phases with fresh clean-room VMs per phase attempt.
   */
  async executeSequence(config: MultiPhaseSequenceConfig): Promise<MultiPhaseSequenceResult> {
    const { run, phases, allowedPaths } = config;
    const runId = run.id;
    const tenantId = run.tenant_id;
    const requestId = run.request_id || `req_${runId}`;
    const policyVersion = run.policy_version || "v2.0";

    if (!phases || phases.length === 0) {
      throw new Error("MultiPhaseSequenceError: phases array must contain at least one phase");
    }

    console.log(
      `[MultiPhaseSequencer:${runId}] Starting sequence of ${phases.length} phases: [${phases.join(" -> ")}]`
    );

    let currentParentGitSha = run.parent_git_sha;
    let currentRunStateVersion = run.state_version;
    let currentRunPhase = run.phase;
    const completedPhases: FactoryExecutionPhase[] = [];
    const phaseResults: Record<string, LiveDispatchResult> = {};

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      const phaseAttempt = 1;
      const sandboxId = config.armId
        ? `sbx-${runId}-${config.armId}-${phase}`
        : `sbx-${runId}-${phase}`;
      const vmName = sandboxId;

      console.log(
        `[MultiPhaseSequencer:${runId}] ========== Phase [${i + 1}/${phases.length}]: '${phase}' (parentSha: ${currentParentGitSha.substring(0, 12)}...) ==========`
      );

      // Construct phase run record with current propagated parent_git_sha
      const phaseRun: FactoryRunRecord = {
        ...run,
        phase: currentRunPhase,
        state_version: currentRunStateVersion,
        parent_git_sha: currentParentGitSha
      };

      const dispatchConfig: LiveDispatchConfig = {
        run: phaseRun,
        phase,
        phaseAttempt,
        sandboxId,
        vmName,
        allowedPaths,
        immutablePaths: config.immutablePaths ?? ["AGENTS.md"],
        armId: config.armId,
        agentsMdSha256: config.agentsMdSha256,
        agentsMdContent: config.agentsMdContent,
        cpuMillis: config.cpuMillis,
        memoryMb: config.memoryMb,
        ttlSeconds: config.ttlSeconds,
        pollIntervalMs: config.pollIntervalMs,
        maxWaitBootMs: config.maxWaitBootMs
      };

      const result = await this.liveDispatcher.executeRun(dispatchConfig);
      phaseResults[phase] = result;

      // Check for phase failure
      if (result.status !== "completed" || !result.cleanTerminated) {
        console.error(
          `[MultiPhaseSequencer:${runId}] Phase '${phase}' failed (${result.error || "Clean termination not attested"}). Halting sequence.`
        );

        if (this.evidenceLedger) {
          await this.evidenceLedger.recordEvent({
            tenantId,
            requestId,
            runId,
            armId: config.armId,
            sandboxId,
            exeVmId: vmName,
            tailscaleNodeId: result.teardownResult.attestation.tailscale_node_id,
            tailscaleTags: ["tag:factory-sandbox"],
            policyVersion,
            eventType: "teardown_failed",
            source: { role: "Outside_Orchestrator", host: "srv719637" },
            observation: {
              failed_phase: phase,
              error: result.error,
              clean_terminated: result.cleanTerminated
            }
          }).catch(() => {});
        }

        return {
          runId,
          status: "failed",
          failedPhase: phase,
          completedPhases,
          finalTreeSha: currentParentGitSha,
          phaseResults,
          error: `Phase '${phase}' failed: ${result.error || "clean termination failed"}`
        };
      }

      // Record successful phase completion
      completedPhases.push(phase);
      const nextTreeSha = result.outputTreeSha || currentParentGitSha;
      console.log(
        `[MultiPhaseSequencer:${runId}] Phase '${phase}' successfully completed! (outputTreeSha: ${nextTreeSha.substring(0, 12)}...)`
      );

      // Record ledger event for phase completion
      if (this.evidenceLedger) {
        await this.evidenceLedger.recordEvent({
          tenantId,
          requestId,
          runId,
          armId: config.armId,
          sandboxId,
          exeVmId: vmName,
          tailscaleNodeId: result.teardownResult.attestation.tailscale_node_id,
          tailscaleTags: ["tag:factory-sandbox"],
          policyVersion,
          eventType: "tree_observed",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: {
            phase,
            attempt: phaseAttempt,
            parent_git_sha: currentParentGitSha,
            accepted_tree_sha: nextTreeSha,
            declared_changed_files: result.declaredChangedFiles || [],
            clean_terminated: result.cleanTerminated
          }
        }).catch(() => {});
      }

      // Propagate accepted tree SHA as parent SHA for subsequent phase
      currentParentGitSha = nextTreeSha;

      // Refresh run state from store to ensure synchronization
      const refreshedRun = await this.runStore.getRun(runId);
      if (refreshedRun) {
        currentRunStateVersion = refreshedRun.state_version;
        currentRunPhase = refreshedRun.phase;
      } else {
        currentRunPhase = "clean_terminated";
        currentRunStateVersion += 1;
      }
    }

    console.log(
      `[MultiPhaseSequencer:${runId}] All ${phases.length} phases successfully executed! Run reached verified CLEAN_TERMINATED state.`
    );

    return {
      runId,
      status: "completed",
      finalPhase: phases[phases.length - 1],
      completedPhases,
      finalTreeSha: currentParentGitSha,
      phaseResults
    };
  }
}
