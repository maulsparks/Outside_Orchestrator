import { SupabaseRestClient } from "../adapters/supabase/client.js";

export interface LeaseRecord {
  runId: string;
  tenantId: string;
  holderId: string;
  fencingToken: number;
  expiresAt: Date;
}

export interface LeaseStorage {
  getLease(runId: string): Promise<LeaseRecord | null>;
  upsertLease(lease: LeaseRecord): Promise<void>;
}

export class SupabaseLeaseStorage implements LeaseStorage {
  private readonly client: SupabaseRestClient;

  constructor(client: SupabaseRestClient) {
    this.client = client;
  }

  async getLease(runId: string): Promise<LeaseRecord | null> {
    const rows = await this.client.select<Record<string, unknown>>("leases", {
      eq: { run_id: runId },
      limit: 1
    });

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      runId: String(row.run_id),
      tenantId: String(row.tenant_id),
      holderId: String(row.holder_id),
      fencingToken: Number(row.fencing_token),
      expiresAt: new Date(String(row.expires_at))
    };
  }

  async upsertLease(lease: LeaseRecord): Promise<void> {
    const existing = await this.getLease(lease.runId);
    if (existing) {
      await this.client.update(
        "leases",
        { run_id: lease.runId },
        {
          holder_id: lease.holderId,
          fencing_token: lease.fencingToken,
          expires_at: lease.expiresAt.toISOString(),
          updated_at: new Date().toISOString()
        }
      );
    } else {
      await this.client.insert("leases", {
        run_id: lease.runId,
        tenant_id: lease.tenantId,
        holder_id: lease.holderId,
        fencing_token: lease.fencingToken,
        expires_at: lease.expiresAt.toISOString()
      });
    }
  }
}

export class InMemoryLeaseStorage implements LeaseStorage {
  private readonly leases = new Map<string, LeaseRecord>();

  async getLease(runId: string): Promise<LeaseRecord | null> {
    const record = this.leases.get(runId);
    if (!record) return null;
    return { ...record, expiresAt: new Date(record.expiresAt.getTime()) };
  }

  async upsertLease(lease: LeaseRecord): Promise<void> {
    this.leases.set(lease.runId, {
      ...lease,
      expiresAt: new Date(lease.expiresAt.getTime())
    });
  }
}

export interface WatchdogOptions {
  heartbeatWindowMs: number;
  checkIntervalMs?: number;
  getExternalActivityTimestamp: () => number;
  onSilentSandbox: () => Promise<void> | void;
}

export interface WatchdogController {
  stop: () => void;
  isTriggered: () => boolean;
}

/**
 * External-Only Lease Manager (ISSUE-03)
 * Operates exclusively on Tier 1 Edge/Control Plane.
 * Inside sandbox VMs are lease-passive and have no lease authority.
 */
export class LeaseManager {
  private readonly storage: LeaseStorage;
  readonly defaultHolderId: string;

  constructor(storage: LeaseStorage, defaultHolderId: string = "outside-orchestrator-srv719637") {
    this.storage = storage;
    this.defaultHolderId = defaultHolderId;
  }

  /**
   * Retrieves the current lease record for a run if present.
   */
  async getLease(runId: string): Promise<LeaseRecord | null> {
    return this.storage.getLease(runId);
  }

  /**
   * Acquires a lease for a run. Monotonically increments the fencing token.
   * Rejects if active unexpired lease is held by another worker, unless force=true (e.g. crash recovery).
   */
  async acquireLease(
    runId: string,
    tenantId: string,
    ttlMs: number,
    holderId?: string,
    force: boolean = false
  ): Promise<{ fencingToken: number; expiresAt: Date }> {
    const activeHolder = holderId ?? this.defaultHolderId;
    const now = Date.now();
    const existing = await this.storage.getLease(runId);

    if (existing && existing.expiresAt.getTime() > now && existing.holderId !== activeHolder && !force) {
      throw new Error(`LeaseConflictError: Run ${runId} is held by active worker ${existing.holderId}`);
    }

    const nextFencingToken = existing ? existing.fencingToken + 1 : 1;
    const expiresAt = new Date(now + ttlMs);

    const record: LeaseRecord = {
      runId,
      tenantId,
      holderId: activeHolder,
      fencingToken: nextFencingToken,
      expiresAt
    };

    await this.storage.upsertLease(record);
    return { fencingToken: nextFencingToken, expiresAt };
  }

  /**
   * Renews an existing lease using the current fencing token.
   * Rejects if fencing token is stale or lease has expired.
   */
  async renewLease(
    runId: string,
    currentFencingToken: number,
    extensionMs: number,
    holderId?: string
  ): Promise<{ fencingToken: number; expiresAt: Date }> {
    const activeHolder = holderId ?? this.defaultHolderId;
    const now = Date.now();
    const existing = await this.storage.getLease(runId);

    if (!existing) {
      throw new Error(`LeaseNotFoundError: No lease exists for run ${runId}`);
    }

    if (existing.fencingToken !== currentFencingToken) {
      throw new Error(
        `StaleFencingTokenError: Expected token ${currentFencingToken}, but database holds ${existing.fencingToken}`
      );
    }

    if (existing.expiresAt.getTime() <= now) {
      throw new Error(`ExpiredLeaseError: Cannot renew expired lease for run ${runId}; re-acquisition required`);
    }

    if (existing.holderId !== activeHolder) {
      throw new Error(`LeaseHolderMismatchError: Lease held by ${existing.holderId}, renewal attempted by ${activeHolder}`);
    }

    const nextExpiresAt = new Date(now + extensionMs);
    const updated: LeaseRecord = {
      ...existing,
      expiresAt: nextExpiresAt
    };

    await this.storage.upsertLease(updated);
    return { fencingToken: currentFencingToken, expiresAt: nextExpiresAt };
  }

  /**
   * Explicitly releases a lease upon clean phase termination or run completion.
   */
  async releaseLease(runId: string, currentFencingToken: number): Promise<void> {
    const existing = await this.storage.getLease(runId);
    if (!existing) return;

    if (existing.fencingToken !== currentFencingToken) {
      throw new Error(`StaleFencingTokenError: Cannot release lease; expected token ${currentFencingToken}`);
    }

    // Expire immediately
    await this.storage.upsertLease({
      ...existing,
      expiresAt: new Date(0)
    });
  }

  /**
   * Starts external silent-sandbox watchdog.
   * Assesses liveness via outside observation rather than sandbox self-reports.
   */
  startLivenessWatchdog(runId: string, options: WatchdogOptions): WatchdogController {
    let triggered = false;
    const intervalMs = options.checkIntervalMs ?? Math.min(options.heartbeatWindowMs / 2, 5000);

    const timer = setInterval(async () => {
      if (triggered) return;

      const lastActivity = options.getExternalActivityTimestamp();
      const elapsed = Date.now() - lastActivity;

      if (elapsed > options.heartbeatWindowMs) {
        triggered = true;
        clearInterval(timer);
        try {
          await options.onSilentSandbox();
        } catch (err) {
          console.error(`Error in onSilentSandbox for run ${runId}:`, err);
        }
      }
    }, intervalMs);

    return {
      stop: () => clearInterval(timer),
      isTriggered: () => triggered
    };
  }
}
