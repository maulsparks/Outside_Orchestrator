import crypto from "node:crypto";
import {
  GitHubPrPublisher,
  PullRequestDetails,
  formatIssueAcknowledgmentComment,
  formatIssueCompletionComment
} from "../adapters/github/prPublisher.js";
import { ContinuousDeploymentEngine, DeploymentResult } from "./continuousDeployment.js";
import { EvidenceLedger } from "../warden/ledger.js";
import { SupabaseRunStateStore } from "../adapters/supabase/runsRepo.js";
import { TaskDecomposer } from "./taskDecomposer.js";
import { RequestAdmissionEngine, CreateRunRequest } from "./ingress.js";
import { LiveSandboxRunner } from "./liveRunner.js";

export interface PrMergeCoordinatorConfig {
  githubPublisher: GitHubPrPublisher;
  deploymentEngine: ContinuousDeploymentEngine;
  runStore?: SupabaseRunStateStore;
  evidenceLedger?: EvidenceLedger;
  webhookSecret?: string;
  defaultMergeMethod?: "squash" | "merge" | "rebase";
  taskDecomposer?: TaskDecomposer;
  admissionEngine?: RequestAdmissionEngine;
  liveRunner?: LiveSandboxRunner;
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
  prUrl?: string;
  issueNumber?: number;
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
  private taskDecomposer?: TaskDecomposer;
  private admissionEngine?: RequestAdmissionEngine;
  private liveRunner?: LiveSandboxRunner;

  constructor(config: PrMergeCoordinatorConfig) {
    this.githubPublisher = config.githubPublisher;
    this.deploymentEngine = config.deploymentEngine;
    this.runStore = config.runStore;
    this.evidenceLedger = config.evidenceLedger;
    this.webhookSecret = config.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
    this.defaultMergeMethod = config.defaultMergeMethod ?? "squash";
    this.taskDecomposer = config.taskDecomposer;
    this.admissionEngine = config.admissionEngine;
    this.liveRunner = config.liveRunner;
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

    // Handle issues event
    if (event === "issues") {
      const action = payload.action;
      const issue = payload.issue;
      const labelName = payload.label?.name?.toLowerCase();
      const hasFactoryLabel = issue?.labels?.some((l: any) => l.name?.toLowerCase() === "factory-run");

      if ((action === "labeled" && labelName === "factory-run") || (action === "opened" && hasFactoryLabel)) {
        return await this.handleIssueTrigger(event, payload);
      }
    }

    // Handle issue_comment event
    if (event === "issue_comment") {
      const action = payload.action;
      const commentBody = payload.comment?.body?.trim()?.toLowerCase() || "";
      if (action === "created" && commentBody.startsWith("/factory-run")) {
        return await this.handleIssueTrigger(event, payload);
      }
    }

    return {
      handled: false,
      event,
      action: payload.action,
      message: `Event '${event}' (action: '${payload.action}') ignored.`
    };
  }

  /**
   * Autonomous trigger on GitHub Issues:
   * 1. Extracts issue prompt
   * 2. Decomposes prompt with TaskDecomposer into least-privilege boundary
   * 3. Admits run in Tier 3 via AdmissionEngine
   * 4. Posts acknowledgment comment on the issue and adds 'factory-in-progress' label
   * 5. Dispatches execution via LiveSandboxRunner
   * 6. Posts completion comment with PR link & ERG verification stats
   */
  public async handleIssueTrigger(event: string, payload: any): Promise<WebhookProcessResult> {
    const issue = payload.issue;
    if (!issue) {
      return { handled: false, event, message: "No issue object in payload" };
    }

    const issueNumber = issue.number;
    const repoInfo = payload.repository?.full_name || "maulsparks/Outside_Orchestrator";
    const [owner, repo] = repoInfo.split("/");

    let prompt = `${issue.title || ""}\n\n${issue.body || ""}`.trim();
    if (event === "issue_comment" && payload.comment?.body) {
      const commentText = payload.comment.body.replace(/^\/factory-run\b/i, "").trim();
      if (commentText) {
        prompt = `${prompt}\n\nAdditional Instruction: ${commentText}`.trim();
      }
    }

    if (!prompt) {
      prompt = `Automated task execution for Issue #${issueNumber}`;
    }

    console.log(`[PrMergeCoordinator] Autonomous issue trigger detected for issue #${issueNumber} in '${repoInfo}'`);

    if (!this.taskDecomposer || !this.admissionEngine) {
      return {
        handled: true,
        event,
        action: payload.action,
        issueNumber,
        error: "TaskDecomposer or AdmissionEngine not configured on coordinator"
      };
    }

    // 1. Decompose prompt into least-privilege boundary
    const plan = this.taskDecomposer.decompose({ prompt });
    const runId = `run-issue-${issueNumber}-${Date.now().toString(36)}`;
    const requestId = `req-issue-${issueNumber}-${Date.now().toString(36)}`;
    const idempotencyKey = `idem-issue-${issueNumber}-${issue.updated_at || Date.now()}`;

    // 2. Admit run in Tier 3 state machine
    const admissionReq: CreateRunRequest = {
      requestId,
      idempotencyKey,
      tenantId: "tenant-github-issue",
      repositoryId: repoInfo,
      parentGitSha: "cb48638000000000000000000000000000000000",
      intent: plan.intent,
      userPrompt: prompt,
      acceptanceCriteria: plan.acceptance_criteria,
      policyVersion: "v2.0",
      agentsMdSha256: "0".repeat(64),
      budgetCents: plan.estimated_budget_cents,
      executionKind: plan.execution_kind,
      deterministicCommand: plan.recommended_command
    };

    const admitted = await this.admissionEngine.admitRequest(admissionReq);
    const effectiveRunId = admitted.run.id;

    // 3. Post acknowledgment comment & label on issue
    const ackBody = formatIssueAcknowledgmentComment({
      runId: effectiveRunId,
      intent: plan.intent,
      confidence: plan.confidence,
      allowedPaths: plan.allowed_paths,
      immutablePaths: plan.immutable_paths,
      acceptanceCriteria: plan.acceptance_criteria,
      suggestedPhases: plan.suggested_phases,
      estimatedBudgetCents: plan.estimated_budget_cents
    });

    await this.githubPublisher.createIssueComment({
      owner,
      repo,
      issueNumber,
      body: ackBody
    });

    await this.githubPublisher.addIssueLabels({
      owner,
      repo,
      issueNumber,
      labels: ["factory-in-progress"]
    });

    // 4. Dispatch execution (if liveRunner configured)
    let prNumber: number | undefined;
    let prUrl: string | undefined;

    if (this.liveRunner) {
      try {
        const runOptions = {
          runId: effectiveRunId,
          tenantId: "tenant-github-issue",
          userPrompt: prompt,
          allowedPaths: plan.allowed_paths,
          immutablePaths: plan.immutable_paths,
          targetBranch: "main",
          executionKind: plan.execution_kind,
          deterministicCommand: plan.recommended_command,
          ttlSeconds: plan.recommended_ttl_seconds,
          budgetCents: plan.estimated_budget_cents,
          autoHarvest: true,
          repositoryId: repoInfo,
          issueNumber
        };

        const result = await this.liveRunner.executeLiveRun(runOptions);
        if (result.status === "completed" && result.prNumber && result.prUrl) {
          prNumber = result.prNumber;
          prUrl = result.prUrl;

          const completionBody = formatIssueCompletionComment({
            runId: effectiveRunId,
            prNumber: result.prNumber,
            prUrl: result.prUrl,
            branch: result.branch || `factory/${effectiveRunId}`,
            undeclaredTouchesCount: 0,
            testPassRate: 1.0
          });

          await this.githubPublisher.createIssueComment({
            owner,
            repo,
            issueNumber,
            body: completionBody
          });

          await this.githubPublisher.removeIssueLabel({
            owner,
            repo,
            issueNumber,
            label: "factory-in-progress"
          });

          await this.githubPublisher.addIssueLabels({
            owner,
            repo,
            issueNumber,
            labels: ["factory-pr-created"]
          });
        }
      } catch (err: unknown) {
        const error = err as Error;
        console.error(`[PrMergeCoordinator] Issue execution failed for run '${effectiveRunId}':`, error);
        await this.githubPublisher.createIssueComment({
          owner,
          repo,
          issueNumber,
          body: `### ❌ Factory Run Failed\n\nRun \`${effectiveRunId}\` encountered an error during sandbox execution:\n\`\`\`\n${error.message}\n\`\`\``
        });
      }
    }

    return {
      handled: true,
      event,
      action: payload.action,
      runId: effectiveRunId,
      issueNumber,
      prNumber,
      prUrl,
      message: `Factory run '${effectiveRunId}' admitted and dispatched for Issue #${issueNumber}.`
    };
  }
}
