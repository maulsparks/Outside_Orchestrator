export type Phase =
  | "created"
  | "provisioning"
  | "delegated"
  | "in_progress"
  | "evaluating"
  | "terminal"
  | "clean_terminated"
  | "quarantined";

export const ALLOWED_TRANSITIONS: Record<Phase, readonly Phase[]> = {
  created: ["provisioning", "quarantined"],
  provisioning: ["delegated", "quarantined", "terminal"],
  delegated: ["in_progress", "quarantined", "terminal"],
  in_progress: ["evaluating", "quarantined", "terminal"],
  evaluating: ["terminal", "quarantined"],
  terminal: ["clean_terminated", "quarantined"],
  clean_terminated: ["provisioning", "quarantined"],
  quarantined: []
};

export interface FactoryRunRecord {
  id: string;
  tenant_id: string;
  request_id: string;
  idempotency_key: string;
  parent_git_sha: string;
  policy_version: string;
  phase: Phase;
  state_version: number;
  budget: Record<string, unknown>;
  envelope: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface TransitionRequest {
  runId: string;
  tenantId: string;
  expectedPhase: Phase;
  expectedStateVersion: number;
  targetPhase: Phase;
  fencingToken: number;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
}

export interface TransitionResult {
  runId: string;
  previousPhase: Phase;
  newPhase: Phase;
  previousStateVersion: number;
  newStateVersion: number;
  fencingToken: number;
  eventId?: string;
}

export interface RunStateStore {
  getRun(runId: string): Promise<FactoryRunRecord | null>;
  compareAndSwapRun(
    runId: string,
    tenantId: string,
    expectedPhase: Phase,
    expectedStateVersion: number,
    targetPhase: Phase,
    newStateVersion: number,
    event?: { eventType: string; payload: Record<string, unknown>; sequence: number }
  ): Promise<boolean>;
  updateBudget?(runId: string, budget: Record<string, unknown>): Promise<void> | void;
}

export class InMemoryRunStateStore implements RunStateStore {
  private readonly runs = new Map<string, FactoryRunRecord>();
  private readonly events: Array<{ runId: string; eventType: string; payload: Record<string, unknown>; sequence: number }> = [];

  setRun(run: FactoryRunRecord): void {
    this.runs.set(run.id, { ...run });
  }

  async getRun(runId: string): Promise<FactoryRunRecord | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async updateBudget(runId: string, budget: Record<string, unknown>): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.budget = { ...budget };
    }
  }

  async compareAndSwapRun(
    runId: string,
    tenantId: string,
    expectedPhase: Phase,
    expectedStateVersion: number,
    targetPhase: Phase,
    newStateVersion: number,
    event?: { eventType: string; payload: Record<string, unknown>; sequence: number }
  ): Promise<boolean> {
    const current = this.runs.get(runId);
    if (!current) return false;
    if (current.tenant_id !== tenantId) return false;
    if (current.phase !== expectedPhase) return false;
    if (current.state_version !== expectedStateVersion) return false;

    current.phase = targetPhase;
    current.state_version = newStateVersion;

    if (event) {
      this.events.push({ runId, ...event });
    }

    return true;
  }

  getEvents(runId: string) {
    return this.events.filter((e) => e.runId === runId);
  }
}

/**
 * State Transition Guard & Transactional Outbox Engine (ISSUE-04)
 * Enforces strict phase transitions, CAS version guards, and fencing checks.
 */
export class RunStateMachine {
  private readonly store: RunStateStore;

  constructor(store: RunStateStore) {
    this.store = store;
  }

  /**
   * Evaluates if a transition from currentPhase to targetPhase is permissible.
   */
  canTransition(currentPhase: Phase, targetPhase: Phase): boolean {
    const allowed = ALLOWED_TRANSITIONS[currentPhase] ?? [];
    return allowed.includes(targetPhase);
  }

  /**
   * Executes a guarded phase transition using Compare-And-Swap.
   */
  async transition(req: TransitionRequest): Promise<TransitionResult> {
    const current = await this.store.getRun(req.runId);
    if (!current) {
      throw new Error(`RunNotFoundError: Run ${req.runId} not found`);
    }

    if (current.tenant_id !== req.tenantId) {
      throw new Error(`TenantMismatchError: Request tenant ${req.tenantId} != run tenant ${current.tenant_id}`);
    }

    if (current.phase !== req.expectedPhase) {
      throw new Error(
        `PhaseConflictError: Expected phase '${req.expectedPhase}', but run is currently at phase '${current.phase}'`
      );
    }

    if (current.state_version !== req.expectedStateVersion) {
      throw new Error(
        `VersionConflictError: Expected state version ${req.expectedStateVersion}, but run is at version ${current.state_version}`
      );
    }

    if (!this.canTransition(current.phase, req.targetPhase)) {
      throw new Error(
        `IllegalTransitionError: Transition from '${current.phase}' to '${req.targetPhase}' is not permitted by policy`
      );
    }

    const newStateVersion = current.state_version + 1;
    const event = req.eventType
      ? {
          eventType: req.eventType,
          payload: req.eventPayload ?? {},
          sequence: newStateVersion
        }
      : undefined;

    const casSuccess = await this.store.compareAndSwapRun(
      req.runId,
      req.tenantId,
      req.expectedPhase,
      req.expectedStateVersion,
      req.targetPhase,
      newStateVersion,
      event
    );

    if (!casSuccess) {
      throw new Error(
        `CASConcurrencyConflict: Compare-and-swap failed for run ${req.runId} (concurrent modification detected)`
      );
    }

    return {
      runId: req.runId,
      previousPhase: current.phase,
      newPhase: req.targetPhase,
      previousStateVersion: current.state_version,
      newStateVersion,
      fencingToken: req.fencingToken
    };
  }
}
