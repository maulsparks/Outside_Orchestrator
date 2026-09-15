import crypto from "node:crypto";
import { GitHubPrPublisher, PullRequestDetails } from "../adapters/github/prPublisher.js";
import { ContinuousDeploymentEngine, DeploymentResult } from "./continuousDeployment.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { SupabaseRunStateStore } from "../adapters/supabase/runsRepo.js";

export interface PrMergeCoordinatorConfig {
  githubPublisher: GitHubPrPublisher;
  deploymentEngine: ContinuousDeploymentEngine;
  runStore?: SupabaseRunStateStore;
  evidenceLedger?: EvidenceLedger;
  webhookSecret?: string;
  defaultMergeMethod?: "squash" | "merge" | "rebase";
}

export interface MergeAndDeployRunPrParams {
  runId: string;
  prNumber?: number;
  mergeMethod?: "squash" | "merge" | "rebase";
  requireReviewApproval?: boolean;
  deployAfterMerge?: boolean;
  commitTitle?: string;
  commitMessage?: string;
  triggeredBy?: string;
}

export interface PrMergeResult {
  runId: string;
  prNumber: number;
  prUrl?: string;
  merged: boolean;
  alreadyMerged?: boolean;
  mergeCommitSha?: string;
  mergeMethod: string;
  deployment?: DeploymentResult;
  error?: string;
}

export interface WebhookProcessResult {
  handled: boolean;
  event: string;
  action?: string;
  runId?: string;
  prNumber?: number;
  merged?: boolean;
  deployed?: boolean;
  message?: string;
  error?: string;
}

export class PrMergeCoordinator {
  private githubPublisher: GitHubPrPublisher;
  private deploymentEngine: ContinuousDeploymentEngine;
  private runStore?: SupabaseRunStateStore;
  private evidenceLedger?: EvidenceLedger;
  private webhookSecret?: string;
  private defaultMergeMethod: "squash" | "merge" | "rebase";

  constructor(config: PrMergeCoordinatorConfig) {
    this.githubPublisher = config.githubPublisher;
    this.deploymentEngine = config.deploymentEngine;
    this.runStore = config.runStore;
    this.evidenceLedger = config.evidenceLedger;
    this.webhookSecret = config.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
    this.defaultMergeMethod = config.defaultMergeMethod ?? "squash";
  }

  /**
   * Cryptographically verifies GitHub Webhook HMAC-SHA256 signature.
   */
  public verifyWebhookSignature(payload: string, signatureHeader?: string, secret?: string): boolean {
    const activeSecret = secret ?? this.webhookSecret;
    if (!activeSecret) {
      // If no secret configured, signature verification is not enforced
      return true;
    }
    if (!signatureHeader) {
      return false;
    }

    const expectedSignature = `sha256=${crypto.createHmac("sha256", activeSecret).update(payload).digest("hex")}`;
    try {
      const headerBuffer = Buffer.from(signatureHeader, "utf8");
      const expectedBuffer = Buffer.from(expectedSignature, "utf8");
      if (headerBuffer.length !== expectedBuffer.length) {
        return false;
      }
      return crypto.timingSafeEqual(headerBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Merges an approved Pull Request for a Factory run and triggers Continuous Deployment.
   */
  public async mergeAndDeployRunPr(params: MergeAndDeployRunPrParams): Promise<PrMergeResult> {
    const runId = params.runId;
    const mergeMethod = params.mergeMethod || this.defaultMergeMethod;
    const triggeredBy = params.triggeredBy || "operator";

    // 1. Verify Run Existence
    let tenantId = "tenant-default";
    if (this.runStore) {
      const run = await this.runStore.getRun(runId);
      if (!run) {
        throw new Error(`Factory run '${runId}' not found in state store.`);
      }
      tenantId = run.tenant_id;
    }

    // 2. Zero-Trust Invariant Check: Verify Harvest Attestation in Tier 3 Ledger
    let records: any[] = [];
    if (this.evidenceLedger) {
      records = await this.evidenceLedger.getStore().getAllForRun(runId);
      const hasHarvestCommit = records.some((r) => {
        const payload = r.payload as Record<string, unknown> | undefined;
        const obs = payload?.observation as Record<string, unknown> | undefined;
        return (
          obs?.harvest_committed ||
          obs?.harvest_authorized ||
          payload?.harvest_committed ||
          payload?.event_type === "evidence_attested" ||
          obs?.event_type === "evidence_attested"
        );
      });
      if (!hasHarvestCommit && !params.requireReviewApproval) {
        throw new Error(`Run '${runId}' has not passed cryptographic harvest authorization (no signed HarvestAttestation in Tier 3 ledger). Merge blocked per Contract §4 & §6.8.`);
      }
    }

    // 3. Resolve PR Number
    let prNumber = params.prNumber;
    let prDetails: PullRequestDetails | null = null;
    const branch = runId.startsWith("run-") ? `factory/${runId}` : `factory/run-${runId}`;

    if (!prNumber && records.length > 0) {
      const prRecord = records.find((r) => {
        const payload = r.payload as Record<string, unknown> | undefined;
        const obs = payload?.observation as Record<string, unknown> | undefined;
        return (obs?.pr_published && obs?.pr_number) || (payload?.pr_published && payload?.pr_number);
      });
      if (prRecord) {
        const payload = prRecord.payload as Record<string, unknown> | undefined;
        const obs = payload?.observation as Record<string, unknown> | undefined;
        prNumber = Number(obs?.pr_number ?? payload?.pr_number);
      }
    }

    if (!prNumber) {
      // Fall back to querying existing PR for head branch
      const prResult = await this.githubPublisher.createPullRequest({
        runId,
        branch,
        commitSha: "head"
      });
      if (prResult.prNumber) {
        prNumber = prResult.prNumber;
      }
    }

    if (!prNumber) {
      throw new Error(`Unable to resolve GitHub Pull Request for run '${runId}' on branch '${branch}'.`);
    }

    // 4. Fetch PR details and inspect state
    prDetails = await this.githubPublisher.getPullRequest({ pullNumber: prNumber });
    if (!prDetails) {
      throw new Error(`Pull Request #${prNumber} not found on GitHub.`);
    }

    if (prDetails.merged) {
      console.log(`[PrMergeCoordinator] PR #${prNumber} is already merged.`);
      let deployResult: DeploymentResult | undefined;
      if (params.deployAfterMerge !== false) {
        deployResult = await this.deploymentEngine.triggerDeployment({
          trigger: "pr_merge",
          prNumber,
          commitSha: prDetails.mergeCommitSha || prDetails.headSha,
          runId,
          tenantId
        });
      }
      return {
        runId,
        prNumber,
        prUrl: prDetails.htmlUrl,
        merged: true,
        alreadyMerged: true,
        mergeCommitSha: prDetails.mergeCommitSha || undefined,
        mergeMethod,
        deployment: deployResult
      };
    }

    // 5. If GitHub review approval is required, check submitted reviews
    if (params.requireReviewApproval) {
      const reviews = await this.githubPublisher.getPullRequestReviews({ pullNumber: prNumber });
      const hasApproval = reviews.some((r) => r.state === "APPROVED");
      if (!hasApproval) {
        throw new Error(`Pull Request #${prNumber} has not received an APPROVED review on GitHub.`);
      }
    }

    // 6. Execute Merge via GitHub API
    const commitTitle = params.commitTitle || `Merge pull request #${prNumber} from ${branch} (Run ${runId.slice(0, 8)})`;
    const commitMessage = params.commitMessage || `Automated factory harvest merge approved for run ${runId}.\n\nTriggered-By: ${triggeredBy}`;

    const mergeRes = await this.githubPublisher.mergePullRequest({
      pullNumber: prNumber,
      commitTitle,
      commitMessage,
      mergeMethod
    });

    if (!mergeRes.merged) {
      throw new Error(`Failed to merge PR #${prNumber}: ${mergeRes.error || mergeRes.message}`);
    }

    // 7. Record signed pr_merged event in Tier 3 Evidence Ledger
    if (this.evidenceLedger) {
      await this.evidenceLedger.recordEvent({
        runId,
        tenantId,
        requestId: `req-${runId}`,
        sandboxId: "outside-orchestrator",
        policyVersion: "v2.0",
        eventType: "command_observed",
        source: { component: "pr-merge-coordinator", triggered_by: triggeredBy },
        observation: {
          pr_merged: true,
          pr_number: prNumber,
          pr_url: prDetails.htmlUrl,
          merge_commit_sha: mergeRes.sha,
          merge_method: mergeMethod,
          triggered_by: triggeredBy,
          merged_at: new Date().toISOString()
        }
      });
    }

    // 8. Trigger Continuous Deployment if requested (default true)
    let deployment: DeploymentResult | undefined;
    if (params.deployAfterMerge !== false) {
      deployment = await this.deploymentEngine.triggerDeployment({
        trigger: "pr_merge",
        prNumber,
        commitSha: mergeRes.sha,
        runId,
        tenantId
      });
    }

    return {
      runId,
      prNumber,
      prUrl: prDetails.htmlUrl,
      merged: true,
      mergeCommitSha: mergeRes.sha,
      mergeMethod,
      deployment
    };
  }

  /**
   * Processes incoming GitHub Webhook events.
   */
  public async handleWebhookEvent(event: string, payload: any): Promise<WebhookProcessResult> {
    if (event === "ping") {
      return { handled: true, event: "ping", message: "Webhook ping received successfully." };
    }

    // Handle pull_request_review submitted
    if (event === "pull_request_review") {
      const action = payload.action;
      const reviewState = payload.review?.state?.toLowerCase();
      const pr = payload.pull_request;

      if (action === "submitted" && reviewState === "approved" && pr) {
        const branch = pr.head?.ref || "";
        const runIdMatch = branch.match(/^factory\/(?:run-)?([a-zA-Z0-9_-]+)$/);
        if (runIdMatch) {
          const runId = runIdMatch[1];
          const prNumber = pr.number;
          console.log(`[PrMergeCoordinator] Webhook received approved review for run '${runId}' (PR #${prNumber}). Initiating merge and deployment...`);

          const mergeResult = await this.mergeAndDeployRunPr({
            runId,
            prNumber,
            triggeredBy: `webhook:review:${payload.review?.user?.login || "reviewer"}`
          });

          return {
            handled: true,
            event,
            action,
            runId,
            prNumber,
            merged: mergeResult.merged,
            deployed: mergeResult.deployment?.status === "success",
            message: `PR #${prNumber} merged and continuous deployment triggered.`
          };
        }
      }
    }

    // Handle pull_request events
    if (event === "pull_request") {
      const action = payload.action;
      const pr = payload.pull_request;
      const branch = pr?.head?.ref || "";
      const runIdMatch = branch.match(/^factory\/(?:run-)?([a-zA-Z0-9_-]+)$/);
      const runId = runIdMatch ? runIdMatch[1] : undefined;
      const prNumber = pr?.number;

      // PR labeled with 'automerge' or 'approved'
      if (action === "labeled" && runId && prNumber) {
        const labelName = payload.label?.name?.toLowerCase();
        if (labelName === "automerge" || labelName === "approved") {
          console.log(`[PrMergeCoordinator] Webhook detected '${labelName}' label on PR #${prNumber} (run '${runId}'). Executing merge & deploy...`);
          const mergeResult = await this.mergeAndDeployRunPr({
            runId,
            prNumber,
            triggeredBy: `webhook:label:${labelName}`
          });

          return {
            handled: true,
            event,
            action,
            runId,
            prNumber,
            merged: mergeResult.merged,
            deployed: mergeResult.deployment?.status === "success"
          };
        }
      }

      // PR already closed/merged externally: trigger CD deployment
      if (action === "closed" && pr?.merged && prNumber) {
        const commitSha = pr.merge_commit_sha;
        console.log(`[PrMergeCoordinator] Webhook detected merged PR #${prNumber} (commit: ${commitSha}). Triggering continuous deployment...`);
        const deployResult = await this.deploymentEngine.triggerDeployment({
          trigger: "pr_merge",
          prNumber,
          commitSha,
          runId
        });

        return {
          handled: true,
          event,
          action,
          runId,
          prNumber,
          merged: true,
          deployed: deployResult.status === "success",
          message: `Continuous deployment triggered for merged PR #${prNumber}.`
        };
      }
    }

    return {
      handled: false,
      event,
      action: payload.action,
      message: `Event '${event}' (action: '${payload.action}') ignored.`
    };
  }
}
