import crypto from "node:crypto";
import { AdvisoryOutputPackage } from "../../src/warden/collector.js";

/**
 * Mock Inside Orchestrator Sandbox Harness (ISSUE-17)
 * Simulates Inside Orchestrator output packaging and trace emission.
 */
export class MockSandboxHarness {
  public runId: string;
  public tenantId: string;
  public phase: string;
  public phaseAttempt: number;
  public sandboxId: string;
  public traceEvents: Array<{ event: string; timestamp: string; detail?: unknown }> = [];
  public declaredChangedFiles: string[] = [];
  public resultStatus: "completed" | "failed" = "completed";
  public corruptManifestHash = false;

  constructor(options?: Partial<{ runId: string; tenantId: string; phase: string; sandboxId: string }>) {
    this.runId = options?.runId ?? "run-mock-001";
    this.tenantId = options?.tenantId ?? "tenant-mock-001";
    this.phase = options?.phase ?? "build";
    this.phaseAttempt = 1;
    this.sandboxId = options?.sandboxId ?? "sbx-001";

    this.traceEvents = [
      { event: "phase_started", timestamp: new Date(Date.now() - 5000).toISOString() },
      { event: "command_executed", timestamp: new Date(Date.now() - 3000).toISOString(), detail: "npm run build" },
      { event: "phase_completed", timestamp: new Date().toISOString() }
    ];
    this.declaredChangedFiles = ["src/index.ts", "package.json"];
  }

  getTraceJsonl(): string {
    return this.traceEvents.map((e) => JSON.stringify(e)).join("\n");
  }

  getComputedManifestSha256(): string {
    return crypto.createHash("sha256").update(this.getTraceJsonl(), "utf8").digest("hex");
  }

  async fetchPackage(): Promise<AdvisoryOutputPackage> {
    const traceJsonl = this.getTraceJsonl();
    let manifestHash = this.getComputedManifestSha256();

    if (this.corruptManifestHash) {
      manifestHash = "f".repeat(64); // corrupt hash to test rejection
    }

    return {
      runId: this.runId,
      tenantId: this.tenantId,
      phase: this.phase,
      phaseAttempt: this.phaseAttempt,
      sandboxId: this.sandboxId,
      traceManifestSha256: manifestHash,
      traceJsonl,
      declaredChangedFiles: [...this.declaredChangedFiles],
      resultStatus: this.resultStatus
    };
  }
}
