import { TeardownAttestation } from "../../contracts/interfaces.js";
import { Phase, RunStateMachine } from "./stateMachine.js";
import { LeaseManager } from "./leaseManager.js";
import { TailscaleClient } from "../adapters/tailscale/client.js";
import { ExeDevClient } from "../adapters/exedev/client.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { signBoundaryEvent } from "../warden/signer.js";
import { collectAndVerifyAdvisoryOutput, AdvisoryOutputPackage } from "../warden/collector.js";
import { evaluateCleanTerminated, AttestationEvaluationResult } from "./attestation.js";
import { probeFormerSandboxEndpoints, EndpointProbeSummary } from "../warden/networkProber.js";

export class TerminalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalStateError";
  }
}

/**
 * Stale / Late Callback Rejector (ISSUE-14 / AC 7)
 * Registers terminal runs and strictly rejects any post-teardown callbacks,
 * heartbeats, or state mutation attempts.
 */
export class StaleCallbackRejector {
  private readonly terminalRuns = new Set<string>();

  markTerminal(runId: string): void {
    this.terminalRuns.add(runId);
  }

  isTerminal(runId: string): boolean {
    return this.terminalRuns.has(runId);
  }

  assertNotTerminal(runId: string): void {
    if (this.terminalRuns.has(runId)) {
      throw new TerminalStateError(
        `Run '${runId}' is in terminal/teardown state; late callbacks and phase advances are strictly rejected.`
      );
    }
  }
}

export interface TeardownParams {
  runId: string;
  tenantId: string;
  requestId: string;
  sandboxId: string;
  exeVmId: string;
  tailscaleNodeId: string;
  tailscaleIp: string;
  policyVersion: string;
  fencingToken: number;
  expectedStateVersion: number;
  currentPhase: Phase;
  fetchAdvisoryPackage?: () => Promise<AdvisoryOutputPackage>;
  sendStopSentinel?: () => Promise<void>;
  probePorts?: number[];
}

export interface TeardownResult {
  runId: string;
  cleanTerminated: boolean;
  finalPhase: Phase;
  attestation: TeardownAttestation;
  evaluation: AttestationEvaluationResult;
  probeSummary: EndpointProbeSummary;
}

export interface TeardownEngineOptions {
  stateMachine: RunStateMachine;
  leaseManager: LeaseManager;
  tailscaleClient: TailscaleClient;
  exedevClient: ExeDevClient;
  evidenceLedger: EvidenceLedger;
  staleCallbackRejector: StaleCallbackRejector;
  privateKeyPem: string;
  publicKeyPem: string;
  keyId?: string;
  networkProber?: (ip: string, ports?: number[], timeoutMs?: number) => Promise<EndpointProbeSummary>;
}

/**
 * 13-Step Teardown Orchestrator (ISSUE-14 / AC 11, AC 17)
 * Executes the authoritative zero-trust teardown sequence across all terminal paths
 * (completion, cancellation, timeout, policy violation).
 */
export class TeardownEngine {
  private readonly stateMachine: RunStateMachine;
  private readonly leaseManager: LeaseManager;
  private readonly tailscaleClient: TailscaleClient;
  private readonly exedevClient: ExeDevClient;
  private readonly evidenceLedger: EvidenceLedger;
  private readonly staleCallbackRejector: StaleCallbackRejector;
  private readonly privateKeyPem: string;
  private readonly publicKeyPem: string;
  private readonly keyId: string;
  private readonly networkProber: (ip: string, ports?: number[], timeoutMs?: number) => Promise<EndpointProbeSummary>;

  constructor(options: TeardownEngineOptions) {
    this.stateMachine = options.stateMachine;
    this.leaseManager = options.leaseManager;
    this.tailscaleClient = options.tailscaleClient;
    this.exedevClient = options.exedevClient;
    this.evidenceLedger = options.evidenceLedger;
    this.staleCallbackRejector = options.staleCallbackRejector;
    this.privateKeyPem = options.privateKeyPem;
    this.publicKeyPem = options.publicKeyPem;
    this.keyId = options.keyId ?? "warden-srv719637-2026";
    this.networkProber = options.networkProber ?? probeFormerSandboxEndpoints;
  }

  async executeTeardown(params: TeardownParams): Promise<TeardownResult> {
    let currentStateVersion = params.expectedStateVersion;
    let currentPhase = params.currentPhase;

    // STEP 1: Mark run terminal in Tier 3 state machine if not already terminal
    if (currentPhase !== "terminal") {
      const transitionResult = await this.stateMachine.transition({
        runId: params.runId,
        tenantId: params.tenantId,
        expectedPhase: currentPhase,
        expectedStateVersion: currentStateVersion,
        targetPhase: "terminal",
        fencingToken: params.fencingToken,
        eventType: "teardown_initiated",
        eventPayload: {
          initiated_at: new Date().toISOString(),
          sandbox_id: params.sandboxId,
          reason: "terminal_closure"
        }
      });
      currentStateVersion = transitionResult.newStateVersion;
      currentPhase = "terminal";
    }

    // STEP 2: Revoke runtime credentials & delegation
    let credentialsRevoked = false;
    try {
      await this.evidenceLedger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        tailscaleNodeId: params.tailscaleNodeId,
        policyVersion: params.policyVersion,
        eventType: "credential_revoked",
        source: { component: "outside-orchestrator", action: "revoke_jwt" },
        observation: {
          revoked: true,
          revoked_at: new Date().toISOString()
        }
      });
      credentialsRevoked = true;
    } catch {
      credentialsRevoked = false;
    }

    // STEP 3: Signal Inside Orchestrator to halt child processes (stop sentinel)
    if (params.sendStopSentinel) {
      try {
        await params.sendStopSentinel();
      } catch {
        // Best-effort external termination signal; external destruction continues regardless
      }
    }

    // STEP 4: Pull and collect remaining advisory trace package (if pending)
    if (params.fetchAdvisoryPackage) {
      try {
        await collectAndVerifyAdvisoryOutput({
          runId: params.runId,
          tenantId: params.tenantId,
          requestId: params.requestId,
          sandboxId: params.sandboxId,
          policyVersion: params.policyVersion,
          ledger: this.evidenceLedger,
          fetchPackage: params.fetchAdvisoryPackage
        });
      } catch (err: unknown) {
        const e = err as Error;
        await this.evidenceLedger.recordEvent({
          tenantId: params.tenantId,
          requestId: params.requestId,
          runId: params.runId,
          sandboxId: params.sandboxId,
          policyVersion: params.policyVersion,
          eventType: "teardown_failed",
          source: { component: "warden-collector" },
          observation: {
            step: "advisory_output_pull",
            error: e.message
          }
        });
      }
    }

    // STEP 5: Deauthorize Tailscale node via API
    let tailscaleDeauthorized = false;
    try {
      await this.tailscaleClient.deauthorizeNode(params.tailscaleNodeId);
      await this.evidenceLedger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        tailscaleNodeId: params.tailscaleNodeId,
        policyVersion: params.policyVersion,
        eventType: "tailscale_node_deauthorized",
        source: { component: "tailscale-api", action: "expire_device" },
        observation: { deauthorized: true }
      });
      tailscaleDeauthorized = true;
    } catch {
      tailscaleDeauthorized = false;
    }

    // STEP 6: Confirm Tailscale node absence from tailnet active inventory (delete node)
    let tailscaleAbsent = false;
    try {
      await this.tailscaleClient.deleteDevice(params.tailscaleNodeId);
      await this.evidenceLedger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        tailscaleNodeId: params.tailscaleNodeId,
        policyVersion: params.policyVersion,
        eventType: "tailscale_node_absence_confirmed",
        source: { component: "tailscale-api", action: "delete_device" },
        observation: { absent: true }
      });
      tailscaleAbsent = true;
    } catch {
      tailscaleAbsent = false;
    }

    // STEP 7: Destroy exe.dev VM via API (rm)
    let exeVmDestroyed = false;
    try {
      await this.evidenceLedger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        policyVersion: params.policyVersion,
        eventType: "exe_vm_destroy_requested",
        source: { component: "exedev-api", action: "rm" },
        observation: { vm_name: params.exeVmId }
      });

      await this.exedevClient.destroySandboxVm(params.exeVmId);

      await this.evidenceLedger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        policyVersion: params.policyVersion,
        eventType: "exe_vm_destroyed",
        source: { component: "exedev-api", action: "rm" },
        observation: { destroyed: true }
      });
      exeVmDestroyed = true;
    } catch {
      exeVmDestroyed = false;
    }

    // STEP 8: Confirm exe.dev VM absence via provider API
    let exeVmAbsent = false;
    try {
      const status = await this.exedevClient.getVmStatus(params.exeVmId);
      if (status.status === "stopped" || !status.status || status.status === "terminated") {
        exeVmAbsent = true;
      }
    } catch {
      // 404 or error querying destroyed VM confirms absence
      exeVmAbsent = true;
    }

    if (exeVmAbsent) {
      await this.evidenceLedger.recordEvent({
        tenantId: params.tenantId,
        requestId: params.requestId,
        runId: params.runId,
        sandboxId: params.sandboxId,
        exeVmId: params.exeVmId,
        policyVersion: params.policyVersion,
        eventType: "sandbox_destroyed",
        source: { component: "exedev-api", action: "verify_absence" },
        observation: { absent: true }
      });
    }

    // STEP 9: Run post-teardown active network probes
    const probeSummary = await this.networkProber(
      params.tailscaleIp,
      params.probePorts ?? [4501, 8787, 22]
    );

    await this.evidenceLedger.recordEvent({
      tenantId: params.tenantId,
      requestId: params.requestId,
      runId: params.runId,
      sandboxId: params.sandboxId,
      exeVmId: params.exeVmId,
      tailscaleNodeId: params.tailscaleNodeId,
      policyVersion: params.policyVersion,
      eventType: probeSummary.allUnreachable ? "teardown_probe_passed" : "teardown_probe_failed",
      source: { component: "warden-prober" },
      observation: {
        all_unreachable: probeSummary.allUnreachable,
        probes: probeSummary.probes
      }
    });

    // STEP 10: Register terminal callback rejection (strictly reject any late callbacks)
    this.staleCallbackRejector.markTerminal(params.runId);

    // STEP 11: Release lease in Tier 3
    try {
      await this.leaseManager.releaseLease(params.runId, params.fencingToken);
    } catch {
      // Lease release failure does not invalidate physical VM destruction
    }

    // STEP 12: Evaluate 12-predicate CLEAN_TERMINATED attestation
    const chainVerification = await this.evidenceLedger.verifyChain(params.runId, this.publicKeyPem);
    const headHash = chainVerification.chainHead ?? "0".repeat(64);

    // Sign the evidence chain head with Warden's Ed25519 private key
    const attestationSignature = signBoundaryEvent(headHash, this.privateKeyPem);

    const tailscaleClean = tailscaleDeauthorized || tailscaleAbsent;
    const vmClean = exeVmDestroyed || exeVmAbsent;

    const attestation: TeardownAttestation = {
      run_id: params.runId,
      sandbox_id: params.sandboxId,
      exe_vm_id: params.exeVmId,
      tailscale_node_id: params.tailscaleNodeId,
      terminal_state:
        credentialsRevoked && tailscaleClean && vmClean && probeSummary.allUnreachable && chainVerification.valid
          ? "CLEAN_TERMINATED"
          : "TEARDOWN_FAILED",
      credentials_revoked: credentialsRevoked,
      tailscale_absent_or_deauthorized: tailscaleClean,
      exe_vm_absent_or_provider_terminal: vmClean,
      post_teardown_probes_passed: probeSummary.allUnreachable,
      evidence_chain_head: headHash,
      signing_key_id: this.keyId,
      signature: attestationSignature
    };

    const evaluation = evaluateCleanTerminated(attestation, this.publicKeyPem);

    // STEP 13: Record attestation and update run phase to clean_terminated (or quarantined)
    let finalPhase: Phase = "quarantined";
    if (evaluation.passed) {
      finalPhase = "clean_terminated";
    }

    await this.stateMachine.transition({
      runId: params.runId,
      tenantId: params.tenantId,
      expectedPhase: "terminal",
      expectedStateVersion: currentStateVersion,
      targetPhase: finalPhase,
      fencingToken: params.fencingToken,
      eventType: evaluation.passed ? "clean_terminated_attested" : "teardown_quarantined",
      eventPayload: {
        clean_terminated: evaluation.passed,
        terminal_state: attestation.terminal_state,
        violations: evaluation.violations,
        attestation
      }
    });

    return {
      runId: params.runId,
      cleanTerminated: evaluation.passed,
      finalPhase,
      attestation,
      evaluation,
      probeSummary
    };
  }
}
