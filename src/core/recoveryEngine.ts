/**
 * Orchestrator Crash & Restart Recovery Engine (Tier 1 Edge/Control Plane)
 *
 * Governed by:
 * - Outside Orchestrator Role Contract v2 §3 (Recovery boundary)
 * - Outside Orchestrator Role Contract v2 §5.1 (State synchronization protocol - step 8)
 * - Outside Orchestrator Role Contract v2 §8 (Failure, retry, and recovery behavior)
 * - Acceptance Criteria 2 & 12
 *
 * Invariants:
 * 1. Resume ONLY from committed durable state in Tier 3.
 * 2. Reacquire leases and advance monotonic fencing tokens to strictly lockout stale actors.
 * 3. Discover and clean up any orphaned sandbox VMs or Tailscale nodes across crash boundaries.
 * 4. Record signed cryptographic evidence of every recovery decision in evidence_ledger.
 */

import { FactoryRunRecord, RunStateStore, RunStateMachine } from "./stateMachine.js";
import { LeaseManager } from "./leaseManager.js";
import { TailscaleClient, TailscaleDevice } from "../adapters/tailscale/client.js";
import { ExeDevClient } from "../adapters/exedev/client.js";
import { TeardownEngine } from "./teardownEngine.js";
import { EvidenceLedger } from "../warden/ledger.js";

export interface RecoveredRunReport {
  runId: string;
  tenantId: string;
  previousPhase: string;
  newPhase: string;
  previousStateVersion: number;
  newStateVersion: number;
  newFencingToken: number;
  orphanedSandboxCleaned: boolean;
  status: "recovered" | "quarantined" | "unchanged" | "error";
  error?: string;
}

export interface RecoverySummary {
  recoveredCount: number;
  quarantinedCount: number;
  errorCount: number;
  reports: RecoveredRunReport[];
  timestamp: string;
}

export interface RecoveryEngineOptions {
  runStore: RunStateStore;
  stateMachine: RunStateMachine;
  leaseManager: LeaseManager;
  teardownEngine?: TeardownEngine;
  tailscaleClient?: TailscaleClient;
  exedevClient?: ExeDevClient;
  evidenceLedger?: EvidenceLedger;
  defaultTtlMs?: number;
}

export class RecoveryEngine {
  private readonly runStore: RunStateStore;
  private readonly stateMachine: RunStateMachine;
  private readonly leaseManager: LeaseManager;
  private readonly teardownEngine?: TeardownEngine;
  private readonly tailscaleClient?: TailscaleClient;
  private readonly exedevClient?: ExeDevClient;
  private readonly evidenceLedger?: EvidenceLedger;
  private readonly defaultTtlMs: number;

  constructor(options: RecoveryEngineOptions) {
    this.runStore = options.runStore;
    this.stateMachine = options.stateMachine;
    this.leaseManager = options.leaseManager;
    this.teardownEngine = options.teardownEngine;
    this.tailscaleClient = options.tailscaleClient;
    this.exedevClient = options.exedevClient;
    this.evidenceLedger = options.evidenceLedger;
    this.defaultTtlMs = options.defaultTtlMs ?? 900000; // 15 minutes
  }

  /**
   * Finds all non-terminal runs in Tier 3 state storage.
   */
  async findInFlightRuns(): Promise<FactoryRunRecord[]> {
    if (typeof this.runStore.listInFlightRuns === "function") {
      return this.runStore.listInFlightRuns();
    }
    return [];
  }

  /**
   * Recovers a single in-flight run after orchestrator crash/restart.
   */
  async recoverRun(run: FactoryRunRecord): Promise<RecoveredRunReport> {
    const runId = run.id;
    const tenantId = run.tenant_id;
    const previousPhase = run.phase;
    const previousStateVersion = run.state_version;

    console.log(`[RecoveryEngine:${runId}] Reconstructing state for in-flight run in phase '${previousPhase}'...`);

    try {
      // 1. Reacquire lease with monotonically advanced fencing token (locks out stale workers)
      const { fencingToken } = await this.leaseManager.acquireLease(runId, tenantId, this.defaultTtlMs, undefined, true);
      console.log(`[RecoveryEngine:${runId}] Reacquired lease: fencingToken=${fencingToken}`);

      // 2. Discover and clean up any orphaned sandbox VMs or Tailscale nodes
      let orphanedSandboxCleaned = false;
      let targetNodeId: string = "unknown-node";
      let targetIp: string = "127.0.0.1";

      if (this.tailscaleClient) {
        try {
          const devices = await this.tailscaleClient.getDevices();
          const prefix = `sbx-${runId}`.toLowerCase();
          const orphanedNode = devices.find((d: TailscaleDevice) =>
            (d.hostname && d.hostname.toLowerCase().startsWith(prefix)) ||
            (d.name && d.name.toLowerCase().startsWith(prefix))
          );

          if (orphanedNode) {
            targetNodeId = orphanedNode.id;
            targetIp = orphanedNode.addresses[0] || targetIp;
            console.log(`[RecoveryEngine:${runId}] Found orphaned Tailscale node '${orphanedNode.hostname}' (${orphanedNode.id}), deauthorizing...`);
            await this.tailscaleClient.deauthorizeNode(orphanedNode.id).catch(() => {});
            await this.tailscaleClient.deleteDevice(orphanedNode.id).catch(() => {});
            orphanedSandboxCleaned = true;
          }
        } catch (err: any) {
          console.warn(`[RecoveryEngine:${runId}] Tailscale orphan check warning:`, err.message);
        }
      }

      if (this.exedevClient) {
        try {
          const vms = await this.exedevClient.listVms();
          const prefix = `sbx-${runId}`.toLowerCase();
          const orphanedVm = vms.find((v) => v.name && v.name.toLowerCase().startsWith(prefix));

          if (orphanedVm) {
            console.log(`[RecoveryEngine:${runId}] Found orphaned exe.dev VM '${orphanedVm.name}', destroying...`);
            await this.exedevClient.destroySandboxVm(orphanedVm.name).catch(() => {});
            orphanedSandboxCleaned = true;
          }
        } catch (err: any) {
          console.warn(`[RecoveryEngine:${runId}] ExeDev orphan check warning:`, err.message);
        }
      }

      // 3. Determine target phase transition per Contract §8
      let newPhase = previousPhase;
      let newStateVersion = previousStateVersion;

      // If run was in flight without completed results, quarantine to prevent corrupt replay
      if (["provisioning", "delegated", "in_progress", "evaluating"].includes(previousPhase)) {
        console.log(`[RecoveryEngine:${runId}] Run was in interrupted phase '${previousPhase}'. Quarantining per Contract §8...`);
        const transResult = await this.stateMachine.transition({
          runId,
          tenantId,
          expectedPhase: previousPhase as any,
          targetPhase: "quarantined",
          expectedStateVersion: previousStateVersion,
          fencingToken,
          eventType: "run_quarantined",
          eventPayload: {
            reason: "orchestrator_restart_recovery",
            interrupted_phase: previousPhase,
            orphaned_sandbox_cleaned: orphanedSandboxCleaned
          }
        });
        newPhase = transResult.newPhase;
        newStateVersion = transResult.newStateVersion;
      }

      // 4. Record signed recovery observation in evidence_ledger
      if (this.evidenceLedger) {
        await this.evidenceLedger.recordEvent({
          tenantId,
          requestId: run.request_id || `req_rec_${runId}`,
          runId,
          sandboxId: `sbx-${runId}-recovery`,
          policyVersion: run.policy_version || "v2.0",
          eventType: "network_decision_observed",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: {
            action: "orchestrator_recovery_observed",
            previous_phase: previousPhase,
            new_phase: newPhase,
            previous_state_version: previousStateVersion,
            new_state_version: newStateVersion,
            fencing_token: fencingToken,
            orphaned_sandbox_cleaned: orphanedSandboxCleaned,
            recovered_at: new Date().toISOString()
          }
        }).catch((e) => console.warn(`[RecoveryEngine:${runId}] Evidence ledger write failed:`, e.message));
      }

      return {
        runId,
        tenantId,
        previousPhase,
        newPhase,
        previousStateVersion,
        newStateVersion,
        newFencingToken: fencingToken,
        orphanedSandboxCleaned,
        status: newPhase === "quarantined" ? "quarantined" : "recovered"
      };
    } catch (err: any) {
      console.error(`[RecoveryEngine:${runId}] Failed to recover run:`, err);
      return {
        runId,
        tenantId,
        previousPhase,
        newPhase: previousPhase,
        previousStateVersion,
        newStateVersion: previousStateVersion,
        newFencingToken: 0,
        orphanedSandboxCleaned: false,
        status: "error",
        error: err.message
      };
    }
  }

  /**
   * Scans and recovers all in-flight runs in the factory.
   */
  async recoverAllInFlightRuns(): Promise<RecoverySummary> {
    const inFlightRuns = await this.findInFlightRuns();
    console.log(`[RecoveryEngine] Found ${inFlightRuns.length} in-flight runs requiring state reconciliation.`);

    const reports: RecoveredRunReport[] = [];
    let recoveredCount = 0;
    let quarantinedCount = 0;
    let errorCount = 0;

    for (const run of inFlightRuns) {
      const report = await this.recoverRun(run);
      reports.push(report);

      if (report.status === "recovered") recoveredCount++;
      else if (report.status === "quarantined") quarantinedCount++;
      else if (report.status === "error") errorCount++;
    }

    const summary: RecoverySummary = {
      recoveredCount,
      quarantinedCount,
      errorCount,
      reports,
      timestamp: new Date().toISOString()
    };

    console.log(
      `[RecoveryEngine] Recovery complete: ${recoveredCount} recovered, ${quarantinedCount} quarantined, ${errorCount} errors.`
    );

    return summary;
  }
}
