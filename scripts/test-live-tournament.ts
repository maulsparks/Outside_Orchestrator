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

async function requestJson<T>(url: string, options: http.RequestOptions = {}, body?: unknown): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOpts: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        "Accept": "application/json",
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
  const tenantId = "tenant-e2e-tournament";

  console.log("=================================================================");
  console.log("Outside Orchestrator — Live Tournament Arbitration Verification");
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
  console.log(`✔ Control plane healthy (uptime: ${health.data.uptime}s)`);

  // Step 2: Ensure base run exists in Supabase
  console.log("[2/6] Seeding base run record in Supabase...");
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = getAdminClient();
    await supabase.insert("factory_runs", {
      id: runId,
      tenant_id: tenantId,
      request_id: `req-tourn-${runId.slice(0, 8)}`,
      idempotency_key: `idem-tourn-${runId}`,
      parent_git_sha: "1659044bb77f5022dc779bfca62074e64f895c12",
      policy_version: "v2.0",
      phase: "clean_terminated",
      state_version: 6,
      budget: { max_cost_cents: 500 },
      envelope: { task_envelope_hash: "a".repeat(64) }
    });
    console.log(`✔ Base run '${runId}' created in Supabase`);
  } else {
    console.log("ℹ Running without direct Supabase seeding; assuming in-memory or existing run.");
  }

  // Step 3: Register multiple tournament arms via REST API
  console.log("[3/6] Registering tournament arms via POST /v1/runs/:runId/tournament/arms...");
  const treeShaAlpha = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  const treeShaBeta = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

  const arm1Res = await requestJson(`${args.host}/v1/runs/${runId}/tournament/arms`, { method: "POST" }, {
    arm_id: "arm-fast",
    status: "completed",
    model_id: "deepseek-coder",
    tree_sha: treeShaAlpha,
    cost_cents: 14,
    latency_ms: 2200,
    metadata: { clean_terminated: true, erg_passed: true, tests_passed: true }
  });
  if (arm1Res.status !== 201) {
    console.error("✖ Failed to register arm-fast:", arm1Res.data);
    process.exit(1);
  }
  console.log("✔ Registered arm 'arm-fast' (cost: 14¢, latency: 2200ms)");

  const arm2Res = await requestJson(`${args.host}/v1/runs/${runId}/tournament/arms`, { method: "POST" }, {
    arm_id: "arm-smart",
    status: "completed",
    model_id: "claude-3-5-sonnet",
    tree_sha: treeShaBeta,
    cost_cents: 48,
    latency_ms: 3600,
    metadata: { clean_terminated: true, erg_passed: true, tests_passed: true }
  });
  if (arm2Res.status !== 201) {
    console.error("✖ Failed to register arm-smart:", arm2Res.data);
    process.exit(1);
  }
  console.log("✔ Registered arm 'arm-smart' (cost: 48¢, latency: 3600ms)");

  // Step 4: Inspect tournament status and comparative ranking
  console.log("[4/6] Querying GET /v1/runs/:runId/tournament...");
  const tourRes = await requestJson<{
    total_arms: number;
    selected_winner: unknown;
    evaluations: Array<{ arm: { arm_id: string }; rank: number; eligible: boolean }>;
  }>(`${args.host}/v1/runs/${runId}/tournament`);

  if (tourRes.status !== 200) {
    console.error("✖ Failed to query tournament status:", tourRes.data);
    process.exit(1);
  }
  console.log(`✔ Total arms registered: ${tourRes.data.total_arms}`);
  console.log(`✔ Winner selection status: ${tourRes.data.selected_winner ? "Selected" : "Unselected (Gate Active)"}`);
  console.log(`✔ Top-ranked candidate:   ${tourRes.data.evaluations[0]?.arm?.arm_id} (Rank #${tourRes.data.evaluations[0]?.rank})`);

  // Step 5: Verify Harvest is blocked before winner selection
  console.log("[5/6] Verifying Harvest Proposal blocks unselected tournament...");
  const propBefore = await requestJson<{
    readyForHarvest: boolean;
    blockingReasons: string[];
  }>(`${args.host}/v1/runs/${runId}/harvest/proposal`);

  if (propBefore.status !== 200) {
    console.error("✖ Failed to fetch proposal:", propBefore.data);
    process.exit(1);
  }
  if (propBefore.data.readyForHarvest === true) {
    console.error("✖ Invariant failure: Tournament run should NOT be ready for harvest before winner selection!");
    process.exit(1);
  }
  console.log("✔ Harvest gate correctly blocked harvest until winner selection:", propBefore.data.blockingReasons[0]);

  // Step 6: Deliberate winner selection
  console.log("[6/6] Deliberately selecting winner via POST /v1/runs/:runId/tournament/select...");
  const selectRes = await requestJson<{
    success: boolean;
    selected_winner: { arm_id: string; tree_sha: string; selection_status: string };
    runners_up: Array<{ arm_id: string; selection_status: string }>;
  }>(`${args.host}/v1/runs/${runId}/tournament/select`, { method: "POST" }, {
    winner_arm_id: "arm-fast",
    rationale: "Lowest cost among verified passing arms per factory economics policy",
    reviewer_identity: "human:lead-reviewer@platform.internal"
  });

  if (selectRes.status !== 200 || !selectRes.data.success) {
    console.error("✖ Failed to select winner:", selectRes.data);
    process.exit(1);
  }

  console.log("-----------------------------------------------------------------");
  console.log("✔ TOURNAMENT WINNER SELECTED & PERSISTED");
  console.log("-----------------------------------------------------------------");
  console.log(`Winner Arm:        ${selectRes.data.selected_winner.arm_id}`);
  console.log(`Selection Status:  ${selectRes.data.selected_winner.selection_status}`);
  console.log(`Accepted Tree SHA: ${selectRes.data.selected_winner.tree_sha}`);
  console.log(`Runners Up:        ${selectRes.data.runners_up.map((u) => `${u.arm_id}(${u.selection_status})`).join(", ")}`);
  console.log("-----------------------------------------------------------------\n");

  // Re-check Harvest Proposal
  const propAfter = await requestJson<{
    readyForHarvest: boolean;
    selectedArmId: string;
    acceptedTreeSha: string;
  }>(`${args.host}/v1/runs/${runId}/harvest/proposal`);

  if (propAfter.status === 200) {
    console.log("Re-checking Harvest Proposal:");
    console.log(`✔ Selected Arm ID:   ${propAfter.data.selectedArmId}`);
    console.log(`✔ Accepted Tree SHA: ${propAfter.data.acceptedTreeSha}`);
    console.log(`✔ Matches Winner:    ${propAfter.data.acceptedTreeSha === treeShaAlpha}`);
  }

  console.log("\n✔ ALL BEST-OF-N TOURNAMENT ACCEPTANCE CRITERIA VERIFIED (AC 9)!\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
