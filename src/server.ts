import http from "node:http";
import { getAdminClient } from "./adapters/supabase/client.js";
import { SupabaseRunStateStore } from "./adapters/supabase/runsRepo.js";
import { LeaseManager, SupabaseLeaseStorage, InMemoryLeaseStorage } from "./core/leaseManager.js";
import { RequestAdmissionEngine, CreateRunRequest } from "./core/ingress.js";
import { InMemoryRunStateStore } from "./core/stateMachine.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

// Initialize repositories and engines
let admissionEngine: RequestAdmissionEngine | null = null;
let runsRepo: SupabaseRunStateStore | null = null;

try {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const adminClient = getAdminClient();
    runsRepo = new SupabaseRunStateStore(adminClient);
    const leaseStorage = new SupabaseLeaseStorage(adminClient);
    const leaseManager = new LeaseManager(leaseStorage, process.env.HOSTNAME || "srv719637");
    admissionEngine = new RequestAdmissionEngine(runsRepo, leaseManager);
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
        resolve(JSON.parse(body) as T);
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

  // 2. Ingress Run Admission (POST /runs)
  if (pathname === "/runs" && req.method === "POST") {
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

  // 3. Query Run Status (GET /runs/:runId)
  if (pathname.startsWith("/runs/") && req.method === "GET") {
    const runId = pathname.slice("/runs/".length);
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

  // 4. Default Not Found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`Outside Orchestrator listening on http://${HOST}:${PORT}`);
});
