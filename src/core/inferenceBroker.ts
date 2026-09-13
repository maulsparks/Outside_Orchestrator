/**
 * Private Model Inference Broker (Tier 1 Edge/Control Plane)
 *
 * Governed by Tier1_Edge_Control §4 and Contract §3.1 & §4.
 *
 * Enforces:
 * 1. Model Allowlist Enforcement (rejects unapproved models)
 * 2. Per-Run Token Budgeting & Cost Tracking (rejects requests exceeding run budget)
 * 3. Worker Discovery via Tailscale tags (tag:private-compute-prod) or MODEL_INFERENCE_ENDPOINT
 * 4. OpenAI-compatible /v1/chat/completions proxy to vLLM, Ollama, or private compute nodes
 * 5. Immutable boundary audit trail in evidence_ledger
 */

import crypto from "node:crypto";
import { FactoryRunRecord, RunStateStore } from "./stateMachine.js";
import { TailscaleClient, TailscaleDevice } from "../adapters/tailscale/client.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { metrics } from "./metrics.js";

export class ModelNotAllowedError extends Error {
  constructor(model: string, allowed: string[]) {
    super(`ModelNotAllowedError: Model '${model}' is not in approved allowlist: [${allowed.join(", ")}]`);
    this.name = "ModelNotAllowedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(runId: string, currentCostCents: number, maxCostCents: number) {
    super(`BudgetExceededError: Run '${runId}' has exhausted its budget. Current: ${currentCostCents}¢, Max: ${maxCostCents}¢`);
    this.name = "BudgetExceededError";
  }
}

export class InferenceWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(`InferenceWorkerUnavailableError: ${message}`);
    this.name = "InferenceWorkerUnavailableError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceRequest {
  runId: string;
  tenantId?: string;
  phase?: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface InferenceResponse {
  id: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  latencyMs: number;
  remainingBudgetCents: number;
}

export interface ModelPricing {
  promptCentsPerMillion: number;
  completionCentsPerMillion: number;
}

export interface ModelPolicyConfig {
  allowedModels: string[];
  defaultModel: string;
  pricing: Record<string, ModelPricing>;
  maxTokensPerRequest: number;
  defaultEndpoint?: string;
}

export const DEFAULT_MODEL_POLICY: ModelPolicyConfig = {
  allowedModels: [
    "qwen2.5-coder:32b",
    "qwen2.5-coder:7b",
    "deepseek-coder-v2",
    "claude-3-5-sonnet",
    "llama3.1:70b",
    "llama3.1:8b"
  ],
  defaultModel: "qwen2.5-coder:32b",
  pricing: {
    "qwen2.5-coder:32b": { promptCentsPerMillion: 20, completionCentsPerMillion: 40 },
    "qwen2.5-coder:7b": { promptCentsPerMillion: 10, completionCentsPerMillion: 20 },
    "deepseek-coder-v2": { promptCentsPerMillion: 25, completionCentsPerMillion: 50 },
    "claude-3-5-sonnet": { promptCentsPerMillion: 300, completionCentsPerMillion: 1500 },
    "llama3.1:70b": { promptCentsPerMillion: 40, completionCentsPerMillion: 80 },
    "llama3.1:8b": { promptCentsPerMillion: 15, completionCentsPerMillion: 30 }
  },
  maxTokensPerRequest: 8192
};

export class InferenceBroker {
  private readonly runStore: RunStateStore;
  private readonly tailscaleClient?: TailscaleClient;
  private readonly evidenceLedger?: EvidenceLedger;
  private readonly policy: ModelPolicyConfig;
  private readonly fetchFn: typeof fetch;

  constructor(options: {
    runStore: RunStateStore;
    tailscaleClient?: TailscaleClient;
    evidenceLedger?: EvidenceLedger;
    policy?: Partial<ModelPolicyConfig>;
    fetchFn?: typeof fetch;
  }) {
    this.runStore = options.runStore;
    this.tailscaleClient = options.tailscaleClient;
    this.evidenceLedger = options.evidenceLedger;
    this.policy = {
      ...DEFAULT_MODEL_POLICY,
      ...options.policy,
      pricing: { ...DEFAULT_MODEL_POLICY.pricing, ...(options.policy?.pricing || {}) }
    };
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Resolves the private model worker endpoint URL.
   * Priority:
   * 1. Explicit defaultEndpoint in policy
   * 2. MODEL_INFERENCE_ENDPOINT environment variable
   * 3. Tailscale device inventory tagged with tag:private-compute-prod
   */
  async resolveWorkerEndpoint(): Promise<string> {
    if (this.policy.defaultEndpoint) {
      return this.policy.defaultEndpoint.replace(/\/$/, "");
    }

    if (process.env.MODEL_INFERENCE_ENDPOINT) {
      return process.env.MODEL_INFERENCE_ENDPOINT.replace(/\/$/, "");
    }

    if (this.tailscaleClient) {
      try {
        const devices = await this.tailscaleClient.getDevices();
        const worker = devices.find((d: TailscaleDevice) =>
          (d.tags?.includes("tag:private-compute-prod") ?? false) &&
          d.authorized &&
          d.addresses.length > 0
        );

        if (worker) {
          const ip = worker.addresses[0];
          const port = ip.includes(":") ? "" : ":8000";
          return `http://${ip}${port}`;
        }
      } catch (err: any) {
        console.warn("[InferenceBroker] Failed to query Tailscale for private compute worker:", err.message);
      }
    }

    // Default fallback to local or private compute default
    return "http://127.0.0.1:8000";
  }

  /**
   * Calculates cost in cents based on token consumption.
   */
  calculateCostCents(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = this.policy.pricing[model] ?? {
      promptCentsPerMillion: 20,
      completionCentsPerMillion: 40
    };

    const promptCost = (promptTokens / 1_000_000) * pricing.promptCentsPerMillion;
    const completionCost = (completionTokens / 1_000_000) * pricing.completionCentsPerMillion;
    const totalCost = promptCost + completionCost;

    // Minimum 1 cent if tokens were actually processed, otherwise ceiling to 2 decimals
    if (totalCost > 0 && totalCost < 0.01) {
      return 0.01;
    }
    return Math.round(totalCost * 100) / 100;
  }

  /**
   * Brokers a chat completion request to the private model worker.
   */
  async brokerChat(req: InferenceRequest): Promise<InferenceResponse> {
    const model = req.model ?? this.policy.defaultModel;

    try {
      // 1. Model Allowlist Enforcement
      if (!this.policy.allowedModels.includes(model)) {
        throw new ModelNotAllowedError(model, this.policy.allowedModels);
      }

      // 2. Run Verification & Budget Check
      const run = await this.runStore.getRun(req.runId);
      if (!run) {
        throw new Error(`RunNotFoundError: Run '${req.runId}' not found`);
      }

      const budget = (run.budget as Record<string, any>) || {};
      const maxCostCents = Number(budget.max_cost_cents ?? 500);
      const currentCostCents = Number(budget.current_cost_cents ?? 0);

      if (currentCostCents >= maxCostCents) {
        throw new BudgetExceededError(req.runId, currentCostCents, maxCostCents);
      }

      // 3. Resolve Worker Endpoint
      const workerEndpoint = await this.resolveWorkerEndpoint();
      const apiUrl = `${workerEndpoint}/v1/chat/completions`;

      console.log(`[InferenceBroker:${req.runId}] Routing model request for '${model}' to ${apiUrl}...`);

      const requestPayload = {
        model,
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: Math.min(req.max_tokens ?? 2048, this.policy.maxTokensPerRequest),
        stream: false
      };

      const startTime = Date.now();
      let res: Response;

      try {
        res = await this.fetchFn(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: AbortSignal.timeout(120000) // 2-minute inference timeout
        });
      } catch (err: any) {
        throw new InferenceWorkerUnavailableError(`Failed to reach inference worker at ${workerEndpoint}: ${err.message}`);
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`InferenceWorkerError (${res.status}): ${errText}`);
      }

      const latencyMs = Date.now() - startTime;
      const data = (await res.json()) as any;

      const content = data.choices?.[0]?.message?.content ?? "";
      const promptTokens = Number(data.usage?.prompt_tokens ?? 0);
      const completionTokens = Number(data.usage?.completion_tokens ?? 0);
      const totalTokens = Number(data.usage?.total_tokens ?? (promptTokens + completionTokens));

      // 4. Calculate cost & update run budget
      const costCents = this.calculateCostCents(model, promptTokens, completionTokens);
      const newCurrentCostCents = Math.round((currentCostCents + costCents) * 100) / 100;
      const remainingBudgetCents = Math.max(0, Math.round((maxCostCents - newCurrentCostCents) * 100) / 100);

      const updatedBudget = {
        ...budget,
        current_cost_cents: newCurrentCostCents,
        total_tokens_consumed: Number(budget.total_tokens_consumed ?? 0) + totalTokens,
        last_model_used: model,
        last_latency_ms: latencyMs
      };

      // Commit updated budget to state store if supported
      if (typeof (this.runStore as any).updateBudget === "function") {
        await (this.runStore as any).updateBudget(req.runId, updatedBudget);
      } else if (typeof (this.runStore as any).updateRunBudget === "function") {
        await (this.runStore as any).updateRunBudget(req.runId, updatedBudget);
      }

      // 5. Record boundary evidence in ledger
      if (this.evidenceLedger) {
        const responseSha = crypto.createHash("sha256").update(content, "utf8").digest("hex");
        await this.evidenceLedger.recordEvent({
          tenantId: req.tenantId || run.tenant_id,
          requestId: run.request_id,
          runId: req.runId,
          sandboxId: req.phase ? `sbx-${req.runId}-${req.phase}` : `sbx-${req.runId}`,
          policyVersion: run.policy_version || "v2.0",
          eventType: "network_decision_observed",
          source: { role: "Outside_Orchestrator", host: "srv719637" },
          observation: {
            action: "brokered_inference",
            model,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            cost_cents: costCents,
            latency_ms: latencyMs,
            remaining_budget_cents: remainingBudgetCents,
            response_sha256: responseSha
          }
        }).catch((e) => console.warn(`[InferenceBroker:${req.runId}] Evidence ledger recording failed:`, e.message));
      }

      // Telemetry: Record metrics
      metrics.inferenceRequestsTotal.inc({ model, status: "success" });
      metrics.tokensConsumedTotal.inc({ model, type: "prompt" }, promptTokens);
      metrics.tokensConsumedTotal.inc({ model, type: "completion" }, completionTokens);
      metrics.inferenceCostCentsTotal.inc({ tenant: run.tenant_id, model }, costCents);

      console.log(
        `[InferenceBroker:${req.runId}] Completed inference: ${totalTokens} tokens, ${costCents}¢ (${latencyMs}ms). Remaining: ${remainingBudgetCents}¢`
      );

      return {
        id: data.id || `chatcmpl-${crypto.randomBytes(4).toString("hex")}`,
        model,
        content,
        promptTokens,
        completionTokens,
        totalTokens,
        costCents,
        latencyMs,
        remainingBudgetCents
      };
    } catch (err) {
      metrics.inferenceRequestsTotal.inc({ model, status: "error" });
      throw err;
    }
  }
}
