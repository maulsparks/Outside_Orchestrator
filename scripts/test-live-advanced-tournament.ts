import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { getAdminClient } from "../src/adapters/supabase/client.js";

// Auto-load host environment if present
if (fs.existsSync("/etc/outside-orchestrator.env")) {
  const envContent = fs.readFileSync("/etc/outside-orchestrator.env", "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

interface Args {
  host: string;
  runId?: string;
}

function parseArgs(): Args {
  const args: Args = {
    host: "http://127.0.0.1:3000"
  };
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--host" && raw[i + 1]) {
      args.host = raw[++i];
    } else if (raw[i] === "--run" && raw[i + 1]) {
      args.runId = raw[++i];
    }
  }
  return args;
}

async function requestJson<T>(
  url: string,
  options: http.RequestOptions = {},
  body?: unknown
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOpts: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers
      }
    };

    const req = http.request(reqOpts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}") as T;
          resolve({ status: res.statusCode || 500, data: parsed });
        } catch {
          resolve({ status: res.statusCode || 500, data: data as unknown as T });
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  const args = parseArgs();
  const runId = args.runId || crypto.randomUUID();
  const tenantId = "tenant-e2e-adv-tournament";

  console.log("=================================================================");
  console.log("Outside Orchestrator — Live Advanced Tournament Arbitration");
  console.log("=================================================================");
  console.log(`Target Host:       ${args.host}`);
  console.log(`Run ID:            ${runId}`);
  console.log(`Tenant ID:         ${tenantId}`);
  console.log("=================================================================\n");

  // Step 1: Health check
  console.log("[1/6] Probing Control Plane health...");
  const health = await requestJson<{ status: string; uptime: number }>(`${args.host}/health`);
  if (health.status !== 200 || health.data.status !== "ok") {
    console.error(`✖ Control plane unhealthy at ${args.host}:`, health.data);
    process.exit(1);
  }
  console.log(`✔ Control plane healthy (uptime: ${health.data.uptime.toFixed(1)}s)\n`);

  // Step 2: Ensure Run exists in Supabase
  console.log("[2/6] Ensuring factory run exists in durable state...");
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = getAdminClient();
    await supabase.insert("factory_runs", {
      id: runId,
      tenant_id: tenantId,
      request_id: `req-adv-${runId.slice(0, 8)}`,
      idempotency_key: `idem-adv-${runId}`,
      parent_git_sha: "1659044bb77f5022dc779bfca62074e64f895c12",
      policy_version: "v2.0",
      phase: "clean_terminated",
      state_version: 6,
      budget: { max_cost_cents: 1000 },
      envelope: { task_envelope_hash: "3".repeat(64) }
    });
    console.log(`✔ Created factory run '${runId}' in clean_terminated phase.`);
  } else {
    console.log("ℹ Running without direct Supabase seeding; assuming in-memory or existing run.");
  }

  // Step 3: Register Candidate Tournament Arms
  console.log("\n[3/6] Registering 3 candidate tournament arms (Contract §10 AC 9)...");
  const armsPayload = [
    {
      arm_id: "arm-pareto-cost",
      status: "completed",
      model_id: "deepseek-coder",
      tree_sha: "1111111111111111111111111111111111111111",
      cost_cents: 10,
      latency_ms: 2200,
      metadata: {
        clean_terminated: true,
        erg_passed: true,
        tests_passed: true,
        quality_score: 96,
        declared_changed_files: ["src/index.ts"]
      }
    },
    {
      arm_id: "arm-pareto-speed",
      status: "completed",
      model_id: "claude-3-5-sonnet",
      tree_sha: "2222222222222222222222222222222222222222",
      cost_cents: 42,
      latency_ms: 380,
      metadata: {
        clean_terminated: true,
        erg_passed: true,
        tests_passed: true,
        quality_score: 98,
        declared_changed_files: ["src/index.ts"]
      }
    },
    {
      arm_id: "arm-pareto-dominated",
      status: "completed",
      model_id: "fallback-llama-3",
      tree_sha: "3333333333333333333333333333333333333333",
      cost_cents: 65,
      latency_ms: 3100,
      metadata: {
        clean_terminated: true,
        erg_passed: true,
        tests_passed: true,
        quality_score: 80,
        declared_changed_files: ["src/index.ts", "src/extra.ts", "src/unused.ts"]
      }
    }
  ];

  for (const arm of armsPayload) {
    const regRes = await requestJson<{ arm_id: string }>(
      `${args.host}/v1/runs/${runId}/tournament/arms`,
      { method: "POST" },
      arm
    );
    if (regRes.status !== 201) {
      console.error(`✖ Failed to register arm '${arm.arm_id}':`, regRes.data);
      process.exit(1);
    }
    console.log(`  ✔ Registered arm '${arm.arm_id}' (cost: ${arm.cost_cents}¢, latency: ${arm.latency_ms}ms)`);
  }

  // Step 4: Call Dynamic Evaluation Endpoint (POST /tournament/evaluate)
  console.log("\n[4/6] Evaluating tournament arms with multi-criteria Pareto arbitration...");
  const evalRes = await requestJson<{
    strategy: string;
    total_arms: number;
    eligible_arms: number;
    pareto_frontier: string[];
    recommended_winner: string;
    evaluations: Array<{
      arm_id?: string;
      arm: { arm_id: string; cost_cents: number; latency_ms: number };
      isParetoOptimal: boolean;
      dominatedBy: string[];
      utilityScore: number;
      rank: number;
    }>;
  }>(
    `${args.host}/v1/runs/${runId}/tournament/evaluate`,
    { method: "POST" },
    {
      strategy: "pareto_optimal",
      weights: { cost: 0.5, latency: 0.3, quality: 0.1, churn: 0.1 }
    }
  );

  if (evalRes.status !== 200) {
    console.error("✖ Dynamic tournament evaluation failed:", evalRes.data);
    process.exit(1);
  }

  console.log(`✔ Strategy:          ${evalRes.data.strategy}`);
  console.log(`✔ Total Arms:        ${evalRes.data.total_arms}`);
  console.log(`✔ Eligible Arms:     ${evalRes.data.eligible_arms}`);
  console.log(`✔ Pareto Frontier:   [${evalRes.data.pareto_frontier.join(", ")}]`);
  console.log(`✔ Recommended Win:   ${evalRes.data.recommended_winner}`);

  if (!evalRes.data.pareto_frontier.includes("arm-pareto-cost") ||
      !evalRes.data.pareto_frontier.includes("arm-pareto-speed") ||
      evalRes.data.pareto_frontier.includes("arm-pareto-dominated")) {
    console.error("✖ Pareto frontier calculation invariant violated!", evalRes.data.pareto_frontier);
    process.exit(1);
  }
  console.log("✔ Multi-criteria Pareto dominance invariant verified: dominated arm excluded from frontier!");

  // Step 5: Select Winner with auto_pareto
  console.log("\n[5/6] Executing automated Pareto winner selection (winner_arm_id: 'auto_pareto')...");
  const selectRes = await requestJson<{
    success: boolean;
    selected_winner: {
      arm_id: string;
      selection_status: string;
      cost_cents: number;
      latency_ms: number;
      metadata: Record<string, unknown>;
    };
    runners_up: Array<{ arm_id: string; selection_status: string }>;
  }>(
    `${args.host}/v1/runs/${runId}/tournament/select`,
    { method: "POST" },
    {
      winner_arm_id: "auto_pareto",
      rationale: "Live Automated Pareto Frontier Arbitration Verification",
      reviewer_identity: "system:pareto-arbitrator"
    }
  );

  if (selectRes.status !== 200 || !selectRes.data.success) {
    console.error("✖ Failed auto_pareto selection:", selectRes.data);
    process.exit(1);
  }

  console.log(`✔ Successfully selected Pareto winner: '${selectRes.data.selected_winner.arm_id}'`);
  console.log(`  - Status:    ${selectRes.data.selected_winner.selection_status}`);
  console.log(`  - Cost:      ${selectRes.data.selected_winner.cost_cents}¢`);
  console.log(`  - Latency:   ${selectRes.data.selected_winner.latency_ms}ms`);
  console.log(`  - Rationale: ${selectRes.data.selected_winner.metadata?.selection_rationale}`);
  console.log(`✔ Runners up:  [${selectRes.data.runners_up.map((r) => r.arm_id).join(", ")}]`);

  // Step 6: Query Tournament Endpoint to Confirm Durable State & Frontier
  console.log("\n[6/6] Verifying persisted tournament state via GET /tournament...");
  const getRes = await requestJson<{
    total_arms: number;
    pareto_frontier: string[];
    selected_winner: { arm_id: string; selection_status: string };
  }>(`${args.host}/v1/runs/${runId}/tournament`);

  if (getRes.status !== 200) {
    console.error("✖ GET /tournament query failed:", getRes.data);
    process.exit(1);
  }

  console.log(`✔ Persisted Pareto Frontier: [${getRes.data.pareto_frontier.join(", ")}]`);
  console.log(`✔ Persisted Selected Winner:  '${getRes.data.selected_winner?.arm_id}'`);

  console.log("\n=================================================================");
  console.log("✔ MILESTONE 10 ADVANCED TOURNAMENT ARBITRATION VERIFIED SUCCESSFULLY!");
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
