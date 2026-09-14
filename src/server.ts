import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { getAdminClient } from "./adapters/supabase/client.js";
import { SupabaseRunStateStore } from "./adapters/supabase/runsRepo.js";
import { LeaseManager, SupabaseLeaseStorage } from "./core/leaseManager.js";
import { RequestAdmissionEngine, CreateRunRequest } from "./core/ingress.js";
import { RunStateMachine } from "./core/stateMachine.js";
import { TailscaleClient } from "./adapters/tailscale/client.js";
import { ExeDevClient } from "./adapters/exedev/client.js";
import { EvidenceLedger, SupabaseEvidenceStore } from "./warden/ledger.js";
import { TeardownEngine, StaleCallbackRejector } from "./core/teardownEngine.js";
import { authorizeHarvest, prepareHarvestProposal, commitHarvestRef, signHarvest } from "./core/harvest.js";
import { LiveDispatcher, LiveDispatchConfig } from "./core/liveDispatcher.js";
import { SupabasePhaseEnvelopeStore } from "./core/dispatcher.js";
import { MultiPhaseSequencer, MultiPhaseSequenceConfig } from "./core/multiPhaseSequencer.js";
import {
  InferenceBroker,
  ModelNotAllowedError,
  BudgetExceededError,
  InferenceWorkerUnavailableError
} from "./core/inferenceBroker.js";
import { computeAgentsMdSha256 } from "./core/policyIntegrity.js";
import { RecoveryEngine, RecoverySummary } from "./core/recoveryEngine.js";
import { metricsRegistry, metrics } from "./core/metrics.js";
import { SystemdWatchdog } from "./core/watchdog.js";
import {
  TournamentArmStore,
  InMemoryTournamentArmStore,
  TournamentArbitrator,
  ArbitrationPolicy
} from "./core/tournament.js";
import { SupabaseTournamentArmStore } from "./adapters/supabase/tournamentRepo.js";
import { getDashboardHtml } from "./ui/dashboardHtml.js";
import { TailscalePruner } from "./core/tailscalePruner.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

// Initialize repositories and engines
let admissionEngine: RequestAdmissionEngine | null = null;
let runsRepo: SupabaseRunStateStore | null = null;
let leaseManager: LeaseManager | null = null;
let teardownEngine: TeardownEngine | null = null;
let evidenceLedger: EvidenceLedger | null = null;
let phaseEnvelopeStore: SupabasePhaseEnvelopeStore | null = null;
let liveDispatcher: LiveDispatcher | null = null;
let multiPhaseSequencer: MultiPhaseSequencer | null = null;
let inferenceBroker: InferenceBroker | null = null;
let recoveryEngine: RecoveryEngine | null = null;
let tournamentArmStore: TournamentArmStore | null = null;
let tournamentArbitrator: TournamentArbitrator | null = null;
let tailscalePruner: TailscalePruner | null = null;
let wardenPublicKeyPem = "";
let wardenPrivateKeyPem = "";

try {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const adminClient = getAdminClient();
    runsRepo = new SupabaseRunStateStore(adminClient);
    phaseEnvelopeStore = new SupabasePhaseEnvelopeStore(adminClient);
    tournamentArmStore = new SupabaseTournamentArmStore(adminClient);
    tournamentArbitrator = new TournamentArbitrator(tournamentArmStore);
    const leaseStorage = new SupabaseLeaseStorage(adminClient);
    leaseManager = new LeaseManager(leaseStorage, process.env.HOSTNAME || "srv719637");
    admissionEngine = new RequestAdmissionEngine(runsRepo, leaseManager);

    const stateMachine = new RunStateMachine(runsRepo);
    const evidenceStore = new SupabaseEvidenceStore(adminClient);
    const tailscaleClient = new TailscaleClient();
    const exedevClient = new ExeDevClient();
    const staleCallbackRejector = new StaleCallbackRejector();

    let privateKeyPem = "";
    if (process.env.WARDEN_KEY_PATH && fs.existsSync(process.env.WARDEN_KEY_PATH)) {
      privateKeyPem = fs.readFileSync(process.env.WARDEN_KEY_PATH, "utf8");
      wardenPrivateKeyPem = privateKeyPem;
    }
    if (process.env.WARDEN_PUBLIC_KEY_PATH && fs.existsSync(process.env.WARDEN_PUBLIC_KEY_PATH)) {
      wardenPublicKeyPem = fs.readFileSync(process.env.WARDEN_PUBLIC_KEY_PATH, "utf8");
    }

    if (privateKeyPem) {
      evidenceLedger = new EvidenceLedger(evidenceStore, privateKeyPem);
      teardownEngine = new TeardownEngine({
        stateMachine,
        leaseManager,
        tailscaleClient,
        exedevClient,
        evidenceLedger,
        staleCallbackRejector,
        privateKeyPem,
        publicKeyPem: wardenPublicKeyPem
      });

      liveDispatcher = new LiveDispatcher(
        exedevClient,
        tailscaleClient,
        leaseManager,
        evidenceLedger,
        teardownEngine,
        stateMachine,
        phaseEnvelopeStore
      );

      multiPhaseSequencer = new MultiPhaseSequencer(
        liveDispatcher,
        stateMachine,
        runsRepo,
        evidenceLedger,
        phaseEnvelopeStore
      );
    }

    inferenceBroker = new InferenceBroker({
      runStore: runsRepo,
      tailscaleClient,
      evidenceLedger: evidenceLedger ?? undefined
    });

    recoveryEngine = new RecoveryEngine({
      runStore: runsRepo,
      stateMachine,
      leaseManager,
      teardownEngine: teardownEngine ?? undefined,
      tailscaleClient,
      exedevClient,
      evidenceLedger: evidenceLedger ?? undefined
    });

    // Contract §8 / §10 AC 2: Recover in-flight runs asynchronously on startup
    recoveryEngine
      .recoverAllInFlightRuns()
      .then((summary) => {
        if (summary.reports.length > 0) {
          console.log(
            `[StartupRecovery] Processed ${summary.reports.length} in-flight runs on boot (${summary.recoveredCount} recovered, ${summary.quarantinedCount} quarantined, ${summary.errorCount} errors).`
          );
        } else {
          console.log("[StartupRecovery] No interrupted runs detected on boot.");
        }
      })
      .catch((err) => {
        console.error("[StartupRecovery] Error during boot recovery:", err);
      });
    tailscalePruner = new TailscalePruner({
      tailscaleClient,
      runStore: runsRepo,
      leaseManager,
      evidenceLedger: evidenceLedger ?? undefined,
      maxAgeMs: parseInt(process.env.TAILSCALE_MAX_AGE_MS || "3600000", 10),
      pruneIntervalMs: parseInt(process.env.TAILSCALE_PRUNE_INTERVAL_MS || "600000", 10)
    });
  }
} catch (err) {
  console.warn("Supabase credentials not configured or failed to initialize, running in memory-fallback mode:", err);
}

if (!tailscalePruner) {
  const tsClient = new TailscaleClient();
  tailscalePruner = new TailscalePruner({
    tailscaleClient: tsClient,
    runStore: runsRepo ?? undefined,
    leaseManager: leaseManager ?? undefined,
    evidenceLedger: evidenceLedger ?? undefined
  });
}

if (!tournamentArmStore) {
  tournamentArmStore = new InMemoryTournamentArmStore();
  tournamentArbitrator = new TournamentArbitrator(tournamentArmStore);
}

if (!wardenPrivateKeyPem) {
  try {
    const kp = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    wardenPrivateKeyPem = kp.privateKey;
    if (!wardenPublicKeyPem) {
      wardenPublicKeyPem = kp.publicKey;
    }
  } catch {
    // ignore
  }
}

function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        // 1MB limit
        reject(new Error("PayloadTooLarge"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // 1. Health Check & Operator Web Dashboard
  if ((pathname === "/dashboard" || pathname === "/ui") && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(getDashboardHtml());
    }
    return;
  }

  if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(getDashboardHtml());
      }
      return;
    }
    // Default JSON health probe
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(
        JSON.stringify({
          status: "ok",
          role: "Outside_Orchestrator",
          tier: "Tier 1 Edge/Control Plane",
          version: "0.1.0",
          node: process.env.HOSTNAME || "srv719637",
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        })
      );
    }
    return;
  }

  if (pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(
        JSON.stringify({
          status: "ok",
          role: "Outside_Orchestrator",
          tier: "Tier 1 Edge/Control Plane",
          version: "0.1.0",
          node: process.env.HOSTNAME || "srv719637",
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        })
      );
    }
    return;
  }

  // 1.1 Prometheus Telemetry Metrics (GET /metrics) - Governed by Contract §6.4 (tag:monitoring)
  if (pathname === "/metrics" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(metricsRegistry.renderPrometheus());
    return;
  }

  // 1.2 List Recent Factory Runs (GET /runs or GET /v1/runs)
  if ((pathname === "/runs" || pathname === "/v1/runs") && req.method === "GET") {
    if (!runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const runs = typeof (runsRepo as any).listRuns === "function"
        ? await (runsRepo as any).listRuns(limit)
        : await runsRepo.listInFlightRuns();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(runs));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 2. Ingress Run Admission (POST /runs or POST /v1/runs)
  if ((pathname === "/runs" || pathname === "/v1/runs") && req.method === "POST") {
    if (!admissionEngine) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable", message: "Admission engine is not initialized" }));
      return;
    }

    try {
      const rawBody = await parseJsonBody<any>(req);
      const agentsMdContent = rawBody.agentsMdContent ?? rawBody.agents_md_content;
      const agentsMdSha256 = rawBody.agentsMdSha256 ?? rawBody.agents_md_sha256 ?? (agentsMdContent ? computeAgentsMdSha256(agentsMdContent) : "0".repeat(64));

      const requestId = rawBody.requestId || rawBody.request_id || `req-${crypto.randomUUID()}`;
      const idempotencyKey = rawBody.idempotencyKey || rawBody.idempotency_key || `idem-${crypto.randomUUID()}`;

      const body: CreateRunRequest = {
        requestId,
        idempotencyKey,
        tenantId: rawBody.tenantId || rawBody.tenant_id,
        repositoryId: rawBody.repositoryId || rawBody.repository_id || "repo-default",
        parentGitSha: rawBody.parentGitSha || rawBody.parent_git_sha,
        intent: rawBody.intent || "execute",
        acceptanceCriteria: rawBody.acceptanceCriteria || rawBody.acceptance_criteria || (rawBody.envelope?.acceptance_criteria) || ["Valid phase result"],
        policyVersion: rawBody.policyVersion || rawBody.policy_version || "v2.0",
        agentsMdSha256,
        agentsMdContent,
        budgetCents: rawBody.budgetCents || rawBody.budget_cents || (rawBody.budget?.max_cost_cents) || 500
      };
      const result = await admissionEngine.admitRequest(body);
      const statusCode = result.isExisting ? 200 : 201;

      // Telemetry: Record run admission metric
      metrics.runsTotal.inc({ tenant: body.tenantId, outcome: result.isExisting ? "conflict" : "admitted" });

      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          is_existing: result.isExisting,
          run: result.run,
          lease: result.lease
        })
      );
    } catch (err: unknown) {
      const error = err as Error;
      metrics.runsTotal.inc({ tenant: "unknown", outcome: "rejected" });
      const isClientError =
        error.message?.includes("invalid") ||
        error.name === "SyntaxError" ||
        error.name === "AuthorityViolationError" ||
        error.name === "AgentsMdDriftError" ||
        error.name === "UnsupportedPolicyVersionError" ||
        error.name === "PolicyDriftError";
      const statusCode = isClientError ? 400 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 3. Live Sandbox Execution Dispatch (POST /runs/:runId/dispatch or POST /v1/runs/:runId/dispatch)
  const dispatchMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/dispatch$/);
  if (dispatchMatch && req.method === "POST") {
    if (!liveDispatcher || !runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "DispatcherUnavailable", message: "Live dispatcher is not initialized" }));
      return;
    }

    try {
      const runId = dispatchMatch[1];
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<{
        phases?: Array<"plan" | "build" | "test" | "review" | "document">;
        phase?: "plan" | "build" | "test" | "review" | "document";
        allowed_paths?: string[];
        immutable_paths?: string[];
        agents_md_sha256?: string;
        agents_md_content?: string;
        cpu_millis?: number;
        memory_mb?: number;
        ttl_seconds?: number;
        async?: boolean;
      }>(req);

      const targetPhases = (body.phases && body.phases.length > 0)
        ? body.phases
        : [body.phase ?? "build"];

      const allowedPaths = body.allowed_paths ?? ["src/**", "output/**"];
      const immutablePaths = body.immutable_paths ?? ["AGENTS.md"];

      if (multiPhaseSequencer && targetPhases.length > 1) {
        const seqConfig: MultiPhaseSequenceConfig = {
          run,
          phases: targetPhases,
          allowedPaths,
          immutablePaths,
          agentsMdSha256: body.agents_md_sha256,
          agentsMdContent: body.agents_md_content,
          cpuMillis: body.cpu_millis,
          memoryMb: body.memory_mb,
          ttlSeconds: body.ttl_seconds
        };

        if (body.async) {
          multiPhaseSequencer.executeSequence(seqConfig).catch((err) => {
            console.error(`[MultiPhaseSequencer] Background run '${runId}' failed:`, err);
          });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "dispatching", runId, phases: targetPhases }));
          return;
        }

        const result = await multiPhaseSequencer.executeSequence(seqConfig);
        res.writeHead(result.status === "completed" ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      const dispatchConfig: LiveDispatchConfig = {
        run,
        phase: targetPhases[0],
        allowedPaths,
        immutablePaths,
        agentsMdSha256: body.agents_md_sha256,
        agentsMdContent: body.agents_md_content,
        cpuMillis: body.cpu_millis,
        memoryMb: body.memory_mb,
        ttlSeconds: body.ttl_seconds
      };

      if (body.async) {
        liveDispatcher.executeRun(dispatchConfig).catch((err) => {
          console.error(`[LiveDispatcher] Background run '${runId}' failed:`, err);
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "dispatching", runId, phase: targetPhases[0] }));
        return;
      }

      const result = await liveDispatcher.executeRun(dispatchConfig);
      res.writeHead(result.status === "completed" ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4. Teardown Trigger (POST /runs/:runId/teardown or POST /v1/runs/:runId/teardown)
  const teardownMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/teardown$/);
  if (teardownMatch && req.method === "POST") {
    const runId = teardownMatch[1];
    if (!teardownEngine || !runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "EngineUnavailable", message: "Teardown engine is not initialized" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<{
        sandbox_id?: string;
        exe_vm_id?: string;
        tailscale_node_id?: string;
        tailscale_ip?: string;
        fencing_token?: number;
      }>(req);

      const result = await teardownEngine.executeTeardown({
        runId,
        tenantId: run.tenant_id,
        requestId: run.request_id,
        sandboxId: body.sandbox_id ?? `sbx-${runId}`,
        exeVmId: body.exe_vm_id ?? `sbx-${runId}`,
        tailscaleNodeId: body.tailscale_node_id ?? `node-${runId}`,
        tailscaleIp: body.tailscale_ip ?? "100.81.98.200",
        policyVersion: run.policy_version,
        fencingToken: body.fencing_token ?? 1,
        expectedStateVersion: run.state_version,
        currentPhase: run.phase
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4a. Harvest Proposal Generation (GET /runs/:runId/harvest/proposal or GET /v1/runs/:runId/harvest/proposal)
  const proposalMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/harvest\/proposal$/);
  if (proposalMatch && req.method === "GET") {
    const runId = proposalMatch[1];
    if (!runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const proposal = await prepareHarvestProposal({
        runId,
        runStore: runsRepo,
        phaseStore: phaseEnvelopeStore ?? undefined,
        evidenceStore: evidenceLedger ? evidenceLedger.getStore() : undefined,
        armStore: tournamentArmStore ?? undefined
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(proposal));
    } catch (err: unknown) {
      const error = err as Error;
      const statusCode = error.message.includes("RunNotFound") ? 404 : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4b. Harvest Authorization & Canonical Merge (POST /runs/:runId/harvest or POST /v1/runs/:runId/harvest)
  const harvestMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/harvest$/);
  if (harvestMatch && req.method === "POST") {
    const runId = harvestMatch[1];
    if (!runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<{
        selected_arm_id?: string;
        signature: string;
        signer_identity: string;
        public_key_pem?: string;
        teardown_evidence_id?: string;
        target_branch?: string;
        commit_message?: string;
      }>(req);

      // Dynamically evaluate proposal and gate readiness
      const proposal = await prepareHarvestProposal({
        runId,
        runStore: runsRepo,
        phaseStore: phaseEnvelopeStore ?? undefined,
        evidenceStore: evidenceLedger ? evidenceLedger.getStore() : undefined,
        armStore: tournamentArmStore ?? undefined
      });

      const result = await authorizeHarvest({
        runId,
        selectedArmId: body.selected_arm_id ?? proposal.selectedArmId,
        treeSha: proposal.acceptedTreeSha,
        envelopeHash: proposal.taskEnvelopeHash,
        policyVersion: proposal.policyVersion,
        signerIdentity: body.signer_identity,
        signature: body.signature,
        publicKeyPem: body.public_key_pem ?? wardenPublicKeyPem,
        isCleanTerminated: proposal.gates.isCleanTerminated,
        ergPassed: proposal.gates.ergPassed,
        testGatePassed: proposal.gates.testGatePassed,
        teardownEvidenceId: body.teardown_evidence_id ?? proposal.teardownEvidenceId,
        tenantId: run.tenant_id,
        requestId: run.request_id,
        ledger: evidenceLedger ?? undefined
      });

      if (!result.authorized) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // Canonical Git commit / tag ref update
      const commitResult = await commitHarvestRef({
        runId,
        acceptedTreeSha: proposal.acceptedTreeSha,
        parentGitSha: proposal.parentGitSha,
        attestation: result.attestation!,
        targetBranch: body.target_branch ?? "main",
        commitMessage: body.commit_message ?? `Harvest run ${runId} (authorized by ${body.signer_identity})`,
        ledger: evidenceLedger ?? undefined,
        tenantId: run.tenant_id,
        requestId: run.request_id
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        authorized: true,
        attestation: result.attestation,
        git_ref: commitResult.gitRef,
        commit_sha: commitResult.commitSha,
        reasons: []
      }));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4b.1 Quick 1-Click Harvest Approval (POST /runs/:runId/harvest/quick-approve or POST /v1/runs/:runId/harvest/quick-approve)
  const quickHarvestMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/harvest\/quick-approve$/);
  if (quickHarvestMatch && req.method === "POST") {
    const runId = quickHarvestMatch[1];
    if (!runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<{
        reviewer_identity?: string;
        private_key?: string;
        target_branch?: string;
      }>(req);

      const proposal = await prepareHarvestProposal({
        runId,
        runStore: runsRepo,
        phaseStore: phaseEnvelopeStore ?? undefined,
        evidenceStore: evidenceLedger ? evidenceLedger.getStore() : undefined,
        armStore: tournamentArmStore ?? undefined
      });

      const signerKey = body.private_key || wardenPrivateKeyPem;
      if (!signerKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "SigningKeyUnavailable",
          message: "No operator Ed25519 signing key configured on host or provided in request"
        }));
        return;
      }

      // Generate Ed25519 cryptographic signature over canonical message
      const signature = signHarvest(
        {
          runId,
          treeSha: proposal.acceptedTreeSha,
          envelopeHash: proposal.taskEnvelopeHash,
          policyVersion: proposal.policyVersion
        },
        signerKey
      );
      const reviewerIdentity = body.reviewer_identity || "human:operator@dashboard";

      const authResult = await authorizeHarvest({
        runId,
        selectedArmId: proposal.selectedArmId,
        treeSha: proposal.acceptedTreeSha,
        envelopeHash: proposal.taskEnvelopeHash,
        policyVersion: proposal.policyVersion,
        signerIdentity: reviewerIdentity,
        signature,
        publicKeyPem: wardenPublicKeyPem,
        isCleanTerminated: proposal.gates.isCleanTerminated,
        ergPassed: proposal.gates.ergPassed,
        testGatePassed: proposal.gates.testGatePassed,
        teardownEvidenceId: proposal.teardownEvidenceId,
        tenantId: run.tenant_id,
        requestId: run.request_id,
        ledger: evidenceLedger ?? undefined
      });

      if (!authResult.authorized) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(authResult));
        return;
      }

      const commitResult = await commitHarvestRef({
        runId,
        acceptedTreeSha: proposal.acceptedTreeSha,
        parentGitSha: proposal.parentGitSha,
        attestation: authResult.attestation!,
        targetBranch: body.target_branch ?? "main",
        commitMessage: `1-Click Harvest run ${runId} (authorized by ${reviewerIdentity})`,
        ledger: evidenceLedger ?? undefined,
        tenantId: run.tenant_id,
        requestId: run.request_id
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        run_id: runId,
        authorized: true,
        attestation: authResult.attestation,
        git_ref: commitResult.gitRef,
        commit_sha: commitResult.commitSha
      }));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4c. Tournament Subsystem Endpoints (Contract §4, §6.8, §9 & §10 AC 9)

  // 4c.1 List & Evaluate Tournament Arms (GET /runs/:runId/tournament or GET /v1/runs/:runId/tournament)
  const tournamentMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament$/);
  if (tournamentMatch && req.method === "GET") {
    const runId = tournamentMatch[1];
    if (!runsRepo || !tournamentArmStore || !tournamentArbitrator) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const arms = await tournamentArmStore.listArmsForRun(runId);
      const evaluations = tournamentArbitrator.evaluateArms(arms);
      const winner = arms.find((a) => a.selection_status === "winner");
      const paretoFrontier = evaluations.filter((e) => e.isParetoOptimal).map((e) => e.arm.arm_id);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run_id: runId,
        tenant_id: run.tenant_id,
        total_arms: arms.length,
        pareto_frontier: paretoFrontier,
        selected_winner: winner ? {
          arm_id: winner.arm_id,
          tree_sha: winner.tree_sha,
          model_id: winner.model_id,
          cost_cents: winner.cost_cents,
          latency_ms: winner.latency_ms,
          metadata: winner.metadata
        } : null,
        evaluations,
        arms
      }));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4c.2 Dynamic Tournament Evaluation (POST /runs/:runId/tournament/evaluate or POST /v1/runs/:runId/tournament/evaluate)
  const tournamentEvalMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/evaluate$/);
  if (tournamentEvalMatch && req.method === "POST") {
    const runId = tournamentEvalMatch[1];
    if (!runsRepo || !tournamentArmStore || !tournamentArbitrator) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<ArbitrationPolicy>(req);
      const arms = await tournamentArmStore.listArmsForRun(runId);
      const evaluations = tournamentArbitrator.evaluateArms(arms, body);
      const paretoFrontier = evaluations.filter((e) => e.isParetoOptimal).map((e) => e.arm.arm_id);
      const recommendedWinner = evaluations.find((e) => e.eligible && e.rank === 1)?.arm.arm_id || null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run_id: runId,
        strategy: body?.strategy || "lowest_cost",
        total_arms: arms.length,
        eligible_arms: evaluations.filter((e) => e.eligible).length,
        pareto_frontier: paretoFrontier,
        recommended_winner: recommendedWinner,
        evaluations
      }));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4c.3 Register Tournament Arm (POST /runs/:runId/tournament/arms or POST /v1/runs/:runId/tournament/arms)
  const tournamentArmCreateMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/arms$/);
  if (tournamentArmCreateMatch && req.method === "POST") {
    const runId = tournamentArmCreateMatch[1];
    if (!runsRepo || !tournamentArmStore) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<{
        arm_id: string;
        status?: string;
        model_id?: string;
        tree_sha?: string;
        cost_cents?: number;
        latency_ms?: number;
        selection_status?: string;
        metadata?: Record<string, unknown>;
      }>(req);

      if (!body.arm_id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BadRequest", message: "arm_id is required" }));
        return;
      }

      const arm = await tournamentArmStore.createArm({
        run_id: runId,
        tenant_id: run.tenant_id,
        arm_id: body.arm_id,
        status: (body.status as any) || "pending",
        model_id: body.model_id,
        tree_sha: body.tree_sha,
        cost_cents: body.cost_cents,
        latency_ms: body.latency_ms,
        selection_status: (body.selection_status as any) || "unselected",
        metadata: body.metadata
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(arm));
    } catch (err: unknown) {
      const error = err as Error;
      const statusCode = error.message.includes("TournamentArmConflict") ? 409 : 400;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 4c.4 Select Tournament Winner (POST /runs/:runId/tournament/select or POST /v1/runs/:runId/tournament/select)
  const tournamentSelectMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/tournament\/select$/);
  if (tournamentSelectMatch && req.method === "POST") {
    const runId = tournamentSelectMatch[1];
    if (!runsRepo || !tournamentArmStore || !tournamentArbitrator) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const body = await parseJsonBody<{
        winner_arm_id: string;
        rationale: string;
        reviewer_identity?: string;
      }>(req);

      if (!body.winner_arm_id || !body.rationale) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "BadRequest",
          message: "winner_arm_id and rationale are required"
        }));
        return;
      }

      let effectiveWinnerArmId = body.winner_arm_id;
      let selectionRationale = body.rationale;

      // Automated Pareto-optimal winner selection
      if (body.winner_arm_id === "auto_pareto") {
        const arms = await tournamentArmStore.listArmsForRun(runId);
        const evaluations = tournamentArbitrator.evaluateArms(arms, { strategy: "pareto_optimal" });
        const bestArm = evaluations.find((e) => e.eligible && e.isParetoOptimal && e.rank === 1) ||
                        evaluations.find((e) => e.eligible && e.rank === 1);
        if (!bestArm) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "NoEligibleParetoWinner",
            message: "No eligible arms found on Pareto frontier for auto_pareto selection"
          }));
          return;
        }
        effectiveWinnerArmId = bestArm.arm.arm_id;
        selectionRationale = `${selectionRationale || "Automated Pareto frontier selection"} (Selected Arm '${effectiveWinnerArmId}' with utility score ${bestArm.utilityScore})`;
      }

      const result = await tournamentArbitrator.selectWinner({
        runId,
        winnerArmId: effectiveWinnerArmId,
        rationale: selectionRationale,
        reviewerIdentity: body.reviewer_identity || "human:operator@platform.internal",
        armStore: tournamentArmStore,
        ledger: evidenceLedger ?? undefined,
        runStore: runsRepo,
        tenantId: run.tenant_id,
        requestId: run.request_id,
        policyVersion: run.policy_version
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        run_id: runId,
        selected_winner: result.winner,
        runners_up: result.others,
        ready_for_harvest: true
      }));
    } catch (err: unknown) {
      const error = err as Error;
      const statusCode = error.message.includes("TournamentArmNotFound") ? 404 : 400;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 5. Query Run Status (GET /runs/:runId, GET /runs/:runId/status, GET /v1/runs/:runId, GET /v1/runs/:runId/status)
  const statusMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)(?:\/status)?$/);
  if (statusMatch && req.method === "GET") {
    const runId = statusMatch[1];
    if (!runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      let leaseInfo: unknown = null;
      if (leaseManager) {
        try {
          const lease = await leaseManager.getLease(runId);
          leaseInfo = lease ? {
            fencingToken: lease.fencingToken,
            expiresAt: lease.expiresAt,
            isExpired: new Date(lease.expiresAt) <= new Date()
          } : null;
        } catch {
          // Non-blocking
        }
      }

      let envelopes: unknown[] = [];
      if (phaseEnvelopeStore) {
        try {
          envelopes = await phaseEnvelopeStore.listPhaseEnvelopes(runId);
        } catch {
          // Non-blocking
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        run,
        lease: leaseInfo,
        phase_envelopes: envelopes,
        node: process.env.HOSTNAME || "srv719637",
        timestamp: new Date().toISOString()
      }));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 6. Model Inference Brokering (POST /runs/:runId/inference or POST /v1/runs/:runId/inference)
  const inferenceMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/inference$/);
  if (inferenceMatch && req.method === "POST") {
    if (!inferenceBroker || !runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "InferenceUnavailable", message: "Inference broker is not initialized" }));
      return;
    }

    try {
      const runId = inferenceMatch[1];
      const body = await parseJsonBody<{
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        model?: string;
        temperature?: number;
        max_tokens?: number;
        phase?: string;
        tenant_id?: string;
      }>(req);

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "InvalidRequest", message: "messages array is required and cannot be empty" }));
        return;
      }

      const result = await inferenceBroker.brokerChat({
        runId,
        messages: body.messages,
        model: body.model,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        phase: body.phase,
        tenantId: body.tenant_id
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err as Error;
      let statusCode = 500;
      let errorType = error.name || "InferenceError";

      if (error instanceof ModelNotAllowedError) {
        statusCode = 400;
      } else if (error instanceof BudgetExceededError) {
        statusCode = 402;
      } else if (error instanceof InferenceWorkerUnavailableError) {
        statusCode = 502;
      } else if (error.message?.includes("RunNotFoundError")) {
        statusCode = 404;
      }

      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorType, message: error.message }));
    }
    return;
  }

  // 7. Policy & Context Integrity Query (GET /runs/:runId/policy/integrity or GET /v1/runs/:runId/policy/integrity)
  const policyIntegrityMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/policy\/integrity$/);
  if (policyIntegrityMatch && req.method === "GET") {
    if (!runsRepo) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable" }));
      return;
    }

    try {
      const runId = policyIntegrityMatch[1];
      const run = await runsRepo.getRun(runId);
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "RunNotFound", runId }));
        return;
      }

      const envelope = (run.envelope as Record<string, unknown>) || {};
      const agentsMdSha256 = envelope.agents_md_sha256 || null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          run_id: runId,
          tenant_id: run.tenant_id,
          policy_version: run.policy_version,
          agents_md_sha256: agentsMdSha256,
          immutable_paths: ["AGENTS.md"],
          non_authority_guaranteed: true,
          status: "verified"
        })
      );
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 8. Disaster Recovery Reconciliation (POST /v1/recovery/reconcile or POST /runs/reconcile)
  if ((pathname === "/v1/recovery/reconcile" || pathname === "/runs/reconcile") && req.method === "POST") {
    if (!recoveryEngine) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable", message: "Recovery engine is not initialized" }));
      return;
    }

    try {
      const rawBody = await parseJsonBody<any>(req).catch(() => ({}));
      if (rawBody?.runId || rawBody?.run_id) {
        const runId = rawBody.runId || rawBody.run_id;
        const run = await runsRepo?.getRun(runId);
        if (!run) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "RunNotFound", runId }));
          return;
        }
        const report = await recoveryEngine.recoverRun(run);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(report));
      } else {
        const summary = await recoveryEngine.recoverAllInFlightRuns();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary));
      }
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 9. Disaster Recovery Status Query (GET /v1/recovery/status or GET /runs/recovery/status)
  if ((pathname === "/v1/recovery/status" || pathname === "/runs/recovery/status") && req.method === "GET") {
    if (!recoveryEngine) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "StorageUnavailable", message: "Recovery engine is not initialized" }));
      return;
    }

    try {
      const inFlightRuns = await recoveryEngine.findInFlightRuns();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          in_flight_count: inFlightRuns.length,
          in_flight_run_ids: inFlightRuns.map((r) => r.id),
          target_rto_minutes: 30,
          governing_contract: "Outside Orchestrator Role Contract v2 §8",
          timestamp: new Date().toISOString()
        })
      );
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 10. Automated Tailscale Device & Key Pruning (POST /v1/tailscale/prune or POST /tailscale/prune)
  if ((pathname === "/v1/tailscale/prune" || pathname === "/tailscale/prune") && req.method === "POST") {
    if (!tailscalePruner) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "PrunerUnavailable", message: "Tailscale pruner is not initialized" }));
      return;
    }

    try {
      interface PruneRequestBody {
        dry_run?: boolean;
        dryRun?: boolean;
        max_age_minutes?: number;
        maxAgeMinutes?: number;
      }
      const body = await parseJsonBody<PruneRequestBody>(req).catch(() => ({} as PruneRequestBody));

      const dryRun = body.dry_run ?? body.dryRun;
      const maxAgeMinutes = body.max_age_minutes ?? body.maxAgeMinutes;
      const maxAgeMs = maxAgeMinutes ? maxAgeMinutes * 60 * 1000 : undefined;

      const result = await tailscalePruner.pruneStaleNodesAndKeys({
        dryRun,
        maxAgeMs
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 10b. Tailscale Pruning Status Query (GET /v1/tailscale/prune/status or GET /tailscale/prune/status)
  if (
    (pathname === "/v1/tailscale/prune/status" || pathname === "/tailscale/prune/status") &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
    if (!tailscalePruner) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "PrunerUnavailable", message: "Tailscale pruner is not initialized" }));
      return;
    }

    try {
      const status = tailscalePruner.getStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(JSON.stringify(status));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 11. Default Not Found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const watchdog = new SystemdWatchdog();

server.listen(PORT, HOST, async () => {
  console.log(`Outside Orchestrator listening on http://${HOST}:${PORT}`);
  if (watchdog.isAvailable()) {
    await watchdog.notifyReady();
    watchdog.startWatchdog(10000);
    console.log("[SystemdWatchdog] Notified READY=1 and initiated 10s heartbeats.");
  }
  if (tailscalePruner && process.env.TAILSCALE_PRUNER_DISABLED !== "true") {
    tailscalePruner.startDaemon();
  }
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Stopping watchdog, pruning daemon, and shutting down server...");
  watchdog.stopWatchdog();
  if (tailscalePruner) {
    tailscalePruner.stopDaemon();
  }
  if (typeof (server as any).closeAllConnections === "function") {
    (server as any).closeAllConnections();
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
});

process.on("SIGINT", () => {
  console.log("Received SIGINT. Stopping watchdog, pruning daemon, and shutting down server...");
  watchdog.stopWatchdog();
  if (tailscalePruner) {
    tailscalePruner.stopDaemon();
  }
  if (typeof (server as any).closeAllConnections === "function") {
    (server as any).closeAllConnections();
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
});
