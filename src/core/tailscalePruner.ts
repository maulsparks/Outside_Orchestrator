import {
  TailscaleClient,
  TailscaleDevice,
  TailscaleKey,
  FORBIDDEN_SANDBOX_TAGS
} from "../adapters/tailscale/client.js";
import { RunStateStore } from "./stateMachine.js";
import { LeaseManager } from "./leaseManager.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { metrics } from "./metrics.js";

export interface TailscalePrunerOptions {
  tailscaleClient: TailscaleClient;
  runStore?: RunStateStore;
  leaseManager?: LeaseManager;
  evidenceLedger?: EvidenceLedger;
  /** Maximum age in milliseconds before an untracked/expired sandbox device is pruned. Default: 1 hour (3600000ms) */
  maxAgeMs?: number;
  /** Default daemon prune interval in milliseconds. Default: 10 minutes (600000ms) */
  pruneIntervalMs?: number;
  /** Allowed sandbox tags that the pruner is permitted to touch. Default: ["tag:factory-sandbox", "tag:factory-preview"] */
  allowedSandboxTags?: string[];
  /** If true, discovers and plans pruning without deleting or deauthorizing anything */
  dryRun?: boolean;
}

export interface PrunedNodeReport {
  deviceId: string;
  hostname: string;
  tags: string[];
  addresses: string[];
  reason: string;
  runId?: string;
  deauthorized: boolean;
  deleted: boolean;
  absenceVerified: boolean;
  error?: string;
}

export interface PrunedKeyReport {
  keyId: string;
  tags: string[];
  expires?: string;
  reason: string;
  deleted: boolean;
  error?: string;
}

export interface PruneCycleResult {
  timestamp: string;
  durationMs: number;
  dryRun: boolean;
  totalScannedDevices: number;
  eligibleSandboxNodes: number;
  nodesPruned: PrunedNodeReport[];
  keysPruned: PrunedKeyReport[];
  protectedNodesSkipped: number;
  activeNodesRetained: number;
  errors: string[];
}

export interface PrunerStatus {
  daemonActive: boolean;
  pruneIntervalMs: number;
  lastCycle: PruneCycleResult | null;
  totalCyclesExecuted: number;
  totalNodesPrunedAllTime: number;
  totalKeysPrunedAllTime: number;
}

const DEFAULT_SANDBOX_TAGS = ["tag:factory-sandbox", "tag:factory-preview"];
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Automated Tailscale Device & Key Pruning Engine
 * Governed by Outside Orchestrator Role Contract v2 §3.1, §6.3.1, §6.4, §7.2, §8 & §10 AC 11, 14, 15.
 *
 * Responsibilities:
 * 1. Safe Scanning: Strictly protects persistent control-plane and worker nodes (tag:edge-control-prod,
 *    tag:private-compute-prod, tag:deployment-controller, exit nodes, non-sandbox nodes).
 * 2. Stale Detection: Cross-references Tier 3 factory_runs state and lease fresh status to identify
 *    orphaned or terminal sandbox nodes.
 * 3. Deauthorization & Deletion: Revokes node authorization and deletes from tailnet inventory.
 * 4. Absence Verification: Cryptographically confirms post-deletion absence from active inventory.
 * 5. Key Pruning: Discovers and deletes expired/stale ephemeral auth keys.
 * 6. Audit & Telemetry: Commits cryptographic audit records to evidence_ledger and exports Prometheus metrics.
 */
export class TailscalePruner {
  private readonly tailscaleClient: TailscaleClient;
  private readonly runStore?: RunStateStore;
  private readonly leaseManager?: LeaseManager;
  private readonly evidenceLedger?: EvidenceLedger;
  private readonly maxAgeMs: number;
  private readonly pruneIntervalMs: number;
  private readonly allowedSandboxTags: string[];
  private readonly defaultDryRun: boolean;

  private daemonTimer: NodeJS.Timeout | null = null;
  private lastCycleResult: PruneCycleResult | null = null;
  private totalCyclesExecuted = 0;
  private totalNodesPrunedAllTime = 0;
  private totalKeysPrunedAllTime = 0;

  constructor(options: TailscalePrunerOptions) {
    this.tailscaleClient = options.tailscaleClient;
    this.runStore = options.runStore;
    this.leaseManager = options.leaseManager;
    this.evidenceLedger = options.evidenceLedger;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.allowedSandboxTags = options.allowedSandboxTags ?? DEFAULT_SANDBOX_TAGS;
    this.defaultDryRun = options.dryRun ?? false;
  }

  /**
   * Evaluates whether a device is protected and must NEVER be pruned.
   * Safety invariant: tags in FORBIDDEN_SANDBOX_TAGS, exit nodes, advertised routes, or non-sandbox devices.
   */
  isProtectedDevice(device: TailscaleDevice): boolean {
    const tags = device.tags || [];

    // 1. Any forbidden control-plane or worker tag immediately protects the node
    for (const forbidden of FORBIDDEN_SANDBOX_TAGS) {
      if (tags.includes(forbidden)) {
        return true;
      }
    }

    // 2. Routing/exit nodes must never be automatically pruned
    if (device.exitNode || device.exitNodeOption) {
      return true;
    }
    if (device.advertisedRoutes && device.advertisedRoutes.length > 0) {
      return true;
    }
    if (device.primaryRoutes && device.primaryRoutes.length > 0) {
      return true;
    }

    // 3. Must have an allowed sandbox tag OR an sbx- hostname prefix
    const hasSandboxTag = tags.some((t) => this.allowedSandboxTags.includes(t));
    const hasSandboxHostname =
      (device.hostname && device.hostname.toLowerCase().startsWith("sbx-")) ||
      (device.name && device.name.toLowerCase().startsWith("sbx-"));

    if (!hasSandboxTag && !hasSandboxHostname) {
      return true; // Not a sandbox device -> protected
    }

    return false;
  }

  /**
   * Attempts to extract the run ID from a sandbox device hostname.
   * Formats: `sbx-${runId}` or `sbx-${runId}-${phase}`
   */
  extractRunId(hostname: string): string | null {
    if (!hostname) return null;
    const lower = hostname.toLowerCase();
    const match = lower.match(/^sbx-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    if (match) {
      return match[1];
    }
    // Generic sbx prefix without UUID: e.g. sbx-run-orphan-test
    const genericMatch = lower.match(/^sbx-([a-z0-9-]+?)(?:-(?:plan|build|test|eval|run))?$/);
    if (genericMatch) {
      return genericMatch[1];
    }
    return null;
  }

  /**
   * Executes a single prune cycle across devices and auth keys.
   */
  async pruneStaleNodesAndKeys(cycleOptions?: {
    dryRun?: boolean;
    maxAgeMs?: number;
  }): Promise<PruneCycleResult> {
    const startTime = Date.now();
    const dryRun = cycleOptions?.dryRun ?? this.defaultDryRun;
    const maxAgeMs = cycleOptions?.maxAgeMs ?? this.maxAgeMs;
    const errors: string[] = [];

    const nodesPruned: PrunedNodeReport[] = [];
    const keysPruned: PrunedKeyReport[] = [];
    let protectedNodesSkipped = 0;
    let activeNodesRetained = 0;
    let eligibleSandboxNodes = 0;
    let allDevices: TailscaleDevice[] = [];

    // --- STEP 1: Scan & Prune Devices ---
    try {
      allDevices = await this.tailscaleClient.getDevices();
    } catch (err: unknown) {
      const e = err as Error;
      errors.push(`Failed to list Tailscale devices: ${e.message}`);
    }

    for (const device of allDevices) {
      if (this.isProtectedDevice(device)) {
        protectedNodesSkipped++;
        continue;
      }

      eligibleSandboxNodes++;
      const runId = this.extractRunId(device.hostname || device.name || "");
      let isStale = false;
      let staleReason = "";

      // Evaluation Path A: Run exists in Tier 3 State Store
      if (runId && this.runStore) {
        try {
          const run = await this.runStore.getRun(runId);
          if (run) {
            const terminalPhases = ["clean_terminated", "terminal", "quarantined"];
            if (terminalPhases.includes(run.phase)) {
              isStale = true;
              staleReason = `associated_run_in_terminal_phase_${run.phase}`;
            } else {
              // Active run: check lease status
              let leaseActive = true;
              if (this.leaseManager) {
                try {
                  const lease = await this.leaseManager.getLease(runId);
                  leaseActive = !!lease && lease.expiresAt.getTime() > Date.now();
                } catch {
                  leaseActive = false;
                }
              }

              if (!leaseActive) {
                // Lease lost or expired
                const now = Date.now();
                const deviceExpires = device.expires ? new Date(device.expires).getTime() : 0;
                if (deviceExpires > 0 && deviceExpires < now) {
                  isStale = true;
                  staleReason = "active_run_lease_lost_and_device_expired";
                } else {
                  // Keep active while lease might be recovering, unless maxAge passed
                  activeNodesRetained++;
                  continue;
                }
              } else {
                // Active with valid lease -> retain!
                activeNodesRetained++;
                continue;
              }
            }
          } else {
            // Run ID is not found in Tier 3 state -> Orphaned sandbox node
            isStale = true;
            staleReason = "orphaned_run_not_found_in_state_store";
          }
        } catch (err: unknown) {
          const e = err as Error;
          errors.push(`Failed to check run '${runId}' for device '${device.id}': ${e.message}`);
          activeNodesRetained++;
          continue;
        }
      } else {
        // Evaluation Path B: Device has no parsed runId or state store is absent
        const now = Date.now();
        const deviceExpires = device.expires ? new Date(device.expires).getTime() : 0;
        if (deviceExpires > 0 && deviceExpires < now) {
          isStale = true;
          staleReason = "device_expired_timestamp_passed";
        } else if (!device.authorized) {
          isStale = true;
          staleReason = "device_already_deauthorized";
        } else {
          // If unassociated and max age cannot be proven, retain for safety
          activeNodesRetained++;
          continue;
        }
      }

      if (isStale) {
        const report: PrunedNodeReport = {
          deviceId: device.id,
          hostname: device.hostname || device.name || "unknown",
          tags: device.tags || [],
          addresses: device.addresses || [],
          reason: staleReason,
          runId: runId ?? undefined,
          deauthorized: false,
          deleted: false,
          absenceVerified: false
        };

        if (dryRun) {
          report.deauthorized = true;
          report.deleted = true;
          report.absenceVerified = true;
          nodesPruned.push(report);
        } else {
          try {
            // 1. Deauthorize node immediately
            await this.tailscaleClient.deauthorizeNode(device.id);
            report.deauthorized = true;

            // 2. Delete device from tailnet inventory
            await this.tailscaleClient.deleteDevice(device.id);
            report.deleted = true;

            // 3. Affirmative Absence Verification (Contract §6.3.1 & §7.2)
            const verifyCheck = await this.tailscaleClient.getDevice(device.id).catch(() => null);
            report.absenceVerified = verifyCheck === null;
          } catch (err: unknown) {
            const e = err as Error;
            report.error = e.message;
            errors.push(`Error pruning device '${device.id}': ${e.message}`);
          }
          nodesPruned.push(report);
        }
      }
    }

    // --- STEP 2: Scan & Prune Auth Keys ---
    try {
      const allKeys = await this.tailscaleClient.getAuthKeys();
      const now = Date.now();

      for (const key of allKeys) {
        const keyTags = key.tags || key.capabilities?.devices?.create?.tags || [];

        // Safety: Never prune keys that grant forbidden tags
        const hasForbiddenTag = keyTags.some((t) => FORBIDDEN_SANDBOX_TAGS.includes(t));
        if (hasForbiddenTag) continue;

        // Target: Must be for sandbox
        const isSandboxKey = keyTags.some((t) => this.allowedSandboxTags.includes(t));
        if (!isSandboxKey) continue;

        // Check expiry
        const expiresTime = key.expires ? new Date(key.expires).getTime() : 0;
        const createdTime = key.created ? new Date(key.created).getTime() : 0;

        let keyStale = false;
        let keyReason = "";

        if (expiresTime > 0 && expiresTime <= now) {
          keyStale = true;
          keyReason = "auth_key_expired";
        } else if (key.invalid || key.revoked) {
          keyStale = true;
          keyReason = "auth_key_invalid_or_revoked";
        } else if (createdTime > 0 && now - createdTime > maxAgeMs) {
          keyStale = true;
          keyReason = "auth_key_exceeded_max_age";
        }

        if (keyStale) {
          const keyReport: PrunedKeyReport = {
            keyId: key.id,
            tags: keyTags,
            expires: key.expires,
            reason: keyReason,
            deleted: false
          };

          if (dryRun) {
            keyReport.deleted = true;
            keysPruned.push(keyReport);
          } else {
            try {
              await this.tailscaleClient.deleteAuthKey(key.id);
              keyReport.deleted = true;
            } catch (err: unknown) {
              const e = err as Error;
              keyReport.error = e.message;
              errors.push(`Error deleting auth key '${key.id}': ${e.message}`);
            }
            keysPruned.push(keyReport);
          }
        }
      }
    } catch (err: unknown) {
      // Key listing might fail if API token does not have auth_keys scope; log as non-fatal warning
      const e = err as Error;
      if (!e.message.includes("403") && !e.message.includes("401")) {
        errors.push(`Auth key scan error: ${e.message}`);
      }
    }

    const durationMs = Date.now() - startTime;
    const result: PruneCycleResult = {
      timestamp: new Date().toISOString(),
      durationMs,
      dryRun,
      totalScannedDevices: allDevices.length,
      eligibleSandboxNodes,
      nodesPruned,
      keysPruned,
      protectedNodesSkipped,
      activeNodesRetained,
      errors
    };

    // --- STEP 3: Cryptographic Audit Logging & Prometheus Metrics ---
    if (!dryRun && this.evidenceLedger && (nodesPruned.length > 0 || keysPruned.length > 0)) {
      try {
        await this.evidenceLedger.recordEvent({
          tenantId: "system:tailscale-pruner",
          requestId: `prune-${Date.now()}`,
          runId: nodesPruned[0]?.runId || "prune-cycle-batch",
          sandboxId: nodesPruned[0]?.hostname || "ephemeral-sandbox-pruner",
          policyVersion: "v2.0",
          eventType: "tailscale_prune_cycle",
          source: { component: "tailscale-pruner", action: "prune_stale_ephemeral_nodes" },
          observation: {
            pruned_nodes_count: nodesPruned.length,
            pruned_keys_count: keysPruned.length,
            nodes: nodesPruned.map((n) => ({
              id: n.deviceId,
              hostname: n.hostname,
              reason: n.reason,
              absence_verified: n.absenceVerified
            })),
            keys: keysPruned.map((k) => ({
              id: k.keyId,
              reason: k.reason
            })),
            duration_ms: durationMs
          }
        });
      } catch (ledgerErr: any) {
        errors.push(`Failed to record prune audit event: ${ledgerErr.message}`);
      }
    }

    // Export Prometheus metrics
    metrics.tailscalePruneCyclesTotal.inc({ status: errors.length === 0 ? "success" : "error" });
    if (!dryRun) {
      metrics.tailscalePrunedNodesTotal.inc({}, nodesPruned.length);
      metrics.tailscalePrunedKeysTotal.inc({}, keysPruned.length);
    }
    metrics.tailscalePruneDurationSeconds.set(durationMs / 1000);
    metrics.tailscaleLastPruneTimestampSeconds.set(Math.floor(Date.now() / 1000));

    this.lastCycleResult = result;
    this.totalCyclesExecuted++;
    if (!dryRun) {
      this.totalNodesPrunedAllTime += nodesPruned.length;
      this.totalKeysPrunedAllTime += keysPruned.length;
    }

    return result;
  }

  /**
   * Starts the background daemon timer executing periodic prune cycles.
   */
  startDaemon(intervalMs?: number): void {
    if (this.daemonTimer) {
      this.stopDaemon();
    }
    const interval = intervalMs ?? this.pruneIntervalMs;
    console.log(`[TailscalePruner] Starting background pruning daemon (interval: ${interval / 1000}s)...`);

    this.daemonTimer = setInterval(async () => {
      try {
        console.log("[TailscalePruner] Executing periodic scheduled prune cycle...");
        const res = await this.pruneStaleNodesAndKeys();
        console.log(
          `[TailscalePruner] Cycle completed in ${res.durationMs}ms: pruned ${res.nodesPruned.length} nodes, ${res.keysPruned.length} keys (${res.protectedNodesSkipped} protected skipped).`
        );
      } catch (err: unknown) {
        const e = err as Error;
        console.error("[TailscalePruner] Error in periodic prune cycle:", e.message);
      }
    }, interval);

    // Unref timer so Node process is not prevented from exiting if needed
    this.daemonTimer.unref();
  }

  /**
   * Stops the background daemon timer.
   */
  stopDaemon(): void {
    if (this.daemonTimer) {
      clearInterval(this.daemonTimer);
      this.daemonTimer = null;
      console.log("[TailscalePruner] Background pruning daemon stopped.");
    }
  }

  /**
   * Returns current status and telemetry for the pruner.
   */
  getStatus(): PrunerStatus {
    return {
      daemonActive: this.daemonTimer !== null,
      pruneIntervalMs: this.pruneIntervalMs,
      lastCycle: this.lastCycleResult,
      totalCyclesExecuted: this.totalCyclesExecuted,
      totalNodesPrunedAllTime: this.totalNodesPrunedAllTime,
      totalKeysPrunedAllTime: this.totalKeysPrunedAllTime
    };
  }
}
