import http from "node:http";
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
import { authorizeHarvest } from "./core/harvest.js";
import { LiveDispatcher, LiveDispatchConfig } from "./core/liveDispatcher.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

// Initialize repositories and engines
let admissionEngine: RequestAdmissionEngine | null = null;
let runsRepo: SupabaseRunStateStore | null = null;
let leaseManager: LeaseManager | null = null;
let teardownEngine: TeardownEngine | null = null;
let evidenceLedger: EvidenceLedger | null = null;
let liveDispatcher: LiveDispatcher | null = null;
let wardenPublicKeyPem = "";

try {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const adminClient = getAdminClient();
    runsRepo = new SupabaseRunStateStore(adminClient);
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
        stateMachine
      );
    }
  }
} catch (err) {
  console.warn("Supabase credentials not configured or failed to initialize, running in memory-fallback mode:", err);
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

  // 1. Health Check
  if ((pathname === "/health" || pathname === "/") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        role: "Outside_Orchestrator",
        tier: "Tier 1 Edge/Control Plane",
        version: "0.1.0",
        node: process.env.HOSTNAME || "srv719637",
        timestamp: new Date().toISOString()
      })
    );
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
      const body = await parseJsonBody<CreateRunRequest>(req);
      const result = await admissionEngine.admitRequest(body);
      const statusCode = result.isExisting ? 200 : 201;

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
      const statusCode = error.message?.includes("invalid") || error.name === "SyntaxError" ? 400 : 500;
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
        phase?: "plan" | "build" | "test" | "review" | "document";
        allowed_paths?: string[];
        immutable_paths?: string[];
        cpu_millis?: number;
        memory_mb?: number;
        ttl_seconds?: number;
        async?: boolean;
      }>(req);

      const dispatchConfig: LiveDispatchConfig = {
        run,
        phase: body.phase ?? "build",
        allowedPaths: body.allowed_paths ?? ["src/**", "output/**"],
        immutablePaths: body.immutable_paths ?? ["AGENTS.md"],
        cpuMillis: body.cpu_millis,
        memoryMb: body.memory_mb,
        ttlSeconds: body.ttl_seconds
      };

      if (body.async) {
        liveDispatcher.executeRun(dispatchConfig).catch((err) => {
          console.error(`[LiveDispatcher] Background run '${runId}' failed:`, err);
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "dispatching", runId }));
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

  // 4. Harvest Authorization (POST /runs/:runId/harvest or POST /v1/runs/:runId/harvest)
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
        selected_arm_id: string;
        signature: string;
        signer_identity: string;
        public_key_pem?: string;
        teardown_evidence_id?: string;
      }>(req);

      const isClean = run.phase === "clean_terminated";
      const result = await authorizeHarvest({
        runId,
        selectedArmId: body.selected_arm_id ?? "default",
        treeSha: run.parent_git_sha,
        envelopeHash: String((run.envelope as Record<string, unknown>)?.task_envelope_hash ?? "0".repeat(64)),
        policyVersion: run.policy_version,
        signerIdentity: body.signer_identity,
        signature: body.signature,
        publicKeyPem: body.public_key_pem ?? wardenPublicKeyPem,
        isCleanTerminated: isClean,
        ergPassed: true,
        testGatePassed: true,
        teardownEvidenceId: body.teardown_evidence_id ?? "evt-clean-term",
        tenantId: run.tenant_id,
        requestId: run.request_id,
        ledger: evidenceLedger ?? undefined
      });

      const statusCode = result.authorized ? 200 : 403;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 5. Query Run Status (GET /runs/:runId or GET /v1/runs/:runId)
  const statusMatch = pathname.match(/^\/(?:v1\/)?runs\/([^/]+)$/);
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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ run }));
    } catch (err: unknown) {
      const error = err as Error;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.name || "Error", message: error.message }));
    }
    return;
  }

  // 6. Default Not Found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`Outside Orchestrator listening on http://${HOST}:${PORT}`);
});
