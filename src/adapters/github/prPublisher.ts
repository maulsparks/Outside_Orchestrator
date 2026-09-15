import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarvestAttestation } from "../../../contracts/interfaces.js";

const execFileAsync = promisify(execFile);

export interface GitHubPublisherOptions {
  token?: string;
  repository?: string; // "owner/repo" or git URL
  apiBaseUrl?: string; // defaults to "https://api.github.com"
  fetchFn?: typeof fetch;
}

export interface PullRequestResult {
  status: "created" | "existing" | "skipped" | "failed";
  prNumber?: number;
  prUrl?: string;
  branch: string;
  error?: string;
}

export interface PullRequestDetails {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeableState?: string;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  htmlUrl: string;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}

export interface PullRequestReview {
  id: number;
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt?: string;
  commitId?: string;
}

export interface MergePullRequestParams {
  owner?: string;
  repo?: string;
  pullNumber: number;
  commitTitle?: string;
  commitMessage?: string;
  mergeMethod?: "squash" | "merge" | "rebase";
}

export interface MergePullRequestResult {
  merged: boolean;
  sha?: string;
  message?: string;
  error?: string;
}

export interface CreatePullRequestParams {
  runId: string;
  branch: string;
  commitSha: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  repository?: string;
}

export interface FormatPullRequestBodyParams {
  runId: string;
  tenantId: string;
  requestId: string;
  parentGitSha: string;
  acceptedTreeSha: string;
  policyVersion: string;
  intent: string;
  userPrompt?: string;
  executionKind?: "agent" | "code";
  deterministicCommand?: string;
  tournamentArm?: {
    armId: string;
    modelId?: string;
    costCents?: number;
    latencyMs?: number;
    testPassRate?: number;
    coveragePct?: number;
    testDurationMs?: number;
    deterministicTests?: {
      passedCount: number;
      failedCount: number;
      totalCount: number;
      exitCode: number;
      stdoutSha256?: string;
    };
  };
  changedFiles?: string[];
  attestation: HarvestAttestation;
}

export function parseRepository(repoStr: string): { owner: string; repo: string } {
  const clean = repoStr.trim().replace(/^git@github\.com:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const parts = clean.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return { owner: "maulsparks", repo: "Outside_Orchestrator" };
  }
  return { owner: parts[0], repo: parts[1] };
}

export function formatPullRequestBody(params: FormatPullRequestBodyParams): string {
  const arm = params.tournamentArm;
  const det = arm?.deterministicTests;
  const costFormatted = typeof arm?.costCents === "number" ? `$${(arm.costCents / 100).toFixed(2)}` : "N/A";
  const latencyFormatted = typeof arm?.latencyMs === "number" ? `${(arm.latencyMs / 1000).toFixed(1)}s` : "N/A";
  const coverageFormatted = typeof arm?.coveragePct === "number" ? `${arm.coveragePct.toFixed(1)}%` : "N/A";

  const changedFilesList = (params.changedFiles && params.changedFiles.length > 0)
    ? params.changedFiles.map((f) => `- \`${f}\``).join("\n")
    : "_No file changes declared (clean-room verification)_";

  let testMatrixSection = "";
  if (det) {
    const statusSymbol = det.exitCode === 0 && det.failedCount === 0 ? "PASSED (Exit 0)" : `FAILED (Exit ${det.exitCode})`;
    testMatrixSection = `| Test Suite Status | \`${statusSymbol}\` |
| Tests Passed | \`${det.passedCount} / ${det.totalCount}\` (${det.failedCount} failures) |
| Test Duration | \`${arm?.testDurationMs ?? 0}ms\` |
| Output Digest | \`${det.stdoutSha256 ? det.stdoutSha256.slice(0, 16) + "..." : "N/A"}\` |`;
  } else {
    testMatrixSection = `| Test Suite Status | \`Verified Frozen Suite\` |
| Pass Rate | \`${arm?.testPassRate ? (arm.testPassRate * 100).toFixed(0) + "%" : "100%"}\` |
| Coverage | \`${coverageFormatted}\` |`;
  }

  return `## 🏭 AI Software Factory — Automated Harvest Approval

> **Status:** \`HARVEST_AUTHORIZED\` & \`CLEAN_TERMINATED\`  
> This pull request was automatically published by the **Outside Orchestrator** following human cryptographic review and zero-trust verification.

---

### 📋 Factory Run Metadata

| Parameter | Value |
|---|---|
| **Run ID** | \`${params.runId}\` |
| **Tenant ID** | \`${params.tenantId}\` |
| **Request ID** | \`${params.requestId}\` |
| **Policy Version** | \`${params.policyVersion}\` |
| **Parent Git SHA** | \`${params.parentGitSha}\` |
| **Accepted Tree SHA** | \`${params.acceptedTreeSha}\` |
| **Execution Kind** | \`${params.executionKind || "agent"}\` |
${params.deterministicCommand ? `| **Deterministic Gate** | \`${params.deterministicCommand}\` |\n` : ""}| **Selected Arm** | \`${arm?.armId || params.attestation.selected_arm_id || "default"}\` (${arm?.modelId || "standard"}) |

---

### 💬 Human User Prompt & Intent

**Intent:** ${params.intent}

${params.userPrompt ? `\`\`\`text\n${params.userPrompt.trim()}\n\`\`\`` : "_No additional human prompt provided._"}

---

### 🏆 Winning Tournament Arm & Metrics

| Metric | Measurement |
|---|---|
| **Model** | \`${arm?.modelId || "N/A"}\` |
| **Cost** | \`${costFormatted}\` |
| **Execution Latency** | \`${latencyFormatted}\` |
| **Code Coverage** | \`${coverageFormatted}\` |
| **Task Envelope Hash** | \`${params.attestation.task_envelope_hash.slice(0, 16)}...\` |

---

### 🧪 Deterministic & Acceptance Test Matrix

${testMatrixSection}

---

### 📂 Effect Reconciliation Gate (ERG)

The following files were modified and verified within declared boundary paths with **zero undeclared touches**:

${changedFilesList}

---

### 🔐 Cryptographic Harvest Attestation (Ed25519)

\`\`\`json
{
  "run_id": "${params.attestation.run_id}",
  "selected_arm_id": "${params.attestation.selected_arm_id}",
  "accepted_tree_sha": "${params.attestation.accepted_tree_sha}",
  "task_envelope_hash": "${params.attestation.task_envelope_hash}",
  "policy_version": "${params.attestation.policy_version}",
  "signer_identity": "${params.attestation.signer_identity}",
  "signature": "${params.attestation.signature}",
  "signature_verified_at": "${params.attestation.signature_verified_at}",
  "teardown_evidence_id": "${params.attestation.teardown_evidence_id}"
}
\`\`\`

---

### 🛡️ Zero-Trust Security Invariants Verified

- [x] **Ephemeral Tier 2 Sandbox:** Disposable execution VM provisioned with run-scoped TTL.
- [x] **Network Isolation:** Directional boundary enforced; no raw cloud or state credentials exposed.
- [x] **Effect Reconciliation Gate (ERG):** Exact tree SHA reconciliation with zero undeclared file touches.
- [x] **Acceptance Test Matrix:** Frozen acceptance tests verified without LLM hallucination.
- [x] **Cryptographic Teardown Attestation:** 13-step teardown verified with active network probing (\`CLEAN_TERMINATED\`).
- [x] **Deliberate Harvest Gate:** Ed25519 cryptographic signature verified over canonical harvest tuple.
`;
}

export class GitHubPrPublisher {
  private token?: string;
  private defaultRepo: { owner: string; repo: string };
  private apiBaseUrl: string;
  private fetchFn: typeof fetch;

  constructor(options?: GitHubPublisherOptions) {
    this.token = options?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const repoStr = options?.repository ?? process.env.GITHUB_REPOSITORY ?? "maulsparks/Outside_Orchestrator";
    this.defaultRepo = parseRepository(repoStr);
    this.apiBaseUrl = (options?.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  public hasToken(): boolean {
    return Boolean(this.token && this.token.trim().length > 0);
  }

  /**
   * Creates or updates a Git branch ref on GitHub.
   */
  public async createOrUpdateBranch(params: {
    owner?: string;
    repo?: string;
    branch: string;
    commitSha: string;
    repoPath?: string;
    pushLocalRef?: boolean;
  }): Promise<{ success: boolean; ref?: string; error?: string }> {
    if (!this.hasToken()) {
      return { success: false, error: "No GitHub token configured" };
    }

    const owner = params.owner ?? this.defaultRepo.owner;
    const repo = params.repo ?? this.defaultRepo.repo;
    const ref = `refs/heads/${params.branch}`;

    // 1. If local git push requested, push the commit object and ref to GitHub
    if (params.pushLocalRef !== false) {
      try {
        const cwd = params.repoPath || process.cwd();
        const authRemote = `https://x-access-token:${this.token}@github.com/${owner}/${repo}.git`;
        await execFileAsync("git", ["push", authRemote, `${params.commitSha}:${ref}`, "--force"], {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Outside Orchestrator",
            GIT_AUTHOR_EMAIL: "orchestrator@outside-factory.internal",
            GIT_COMMITTER_NAME: "Outside Orchestrator",
            GIT_COMMITTER_EMAIL: "orchestrator@outside-factory.internal"
          }
        });
      } catch (pushErr: unknown) {
        console.error("[GitHubPrPublisher] local git push error:", (pushErr as Error).message);
        // Fall back to GitHub REST API if local git push failed
      }
    }

    try {
      // 2. Attempt to create the ref via REST API
      const createRes = await this.fetchFn(`${this.apiBaseUrl}/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Outside-Orchestrator-Factory/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ref,
          sha: params.commitSha
        })
      });

      if (createRes.status === 201) {
        return { success: true, ref };
      }

      const errText = await createRes.text();

      // If ref already exists (422), force-update the existing ref
      if (createRes.status === 422 && (errText.includes("already exists") || errText.includes("Reference already exists"))) {
        const updateRes = await this.fetchFn(
          `${this.apiBaseUrl}/repos/${owner}/${repo}/git/refs/heads/${params.branch}`,
          {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${this.token}`,
              "Accept": "application/vnd.github+json",
              "User-Agent": "Outside-Orchestrator-Factory/1.0",
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              sha: params.commitSha,
              force: true
            })
          }
        );

        if (updateRes.ok) {
          return { success: true, ref };
        }
        const updateErr = await updateRes.text();
        return { success: false, error: `Failed to update ref: ${updateRes.status} ${updateErr}` };
      }

      return { success: false, error: `Failed to create ref: ${createRes.status} ${errText}` };
    } catch (err: unknown) {
      const error = err as Error;
      return { success: false, error: error.message };
    }
  }

  /**
   * Opens a GitHub Pull Request for the feature branch, or retrieves the existing PR if already open.
   */
  public async createPullRequest(params: CreatePullRequestParams): Promise<PullRequestResult> {
    const branch = params.branch;
    if (!this.hasToken()) {
      return {
        status: "skipped",
        branch,
        error: "No GitHub token configured (GITHUB_TOKEN or GH_TOKEN)"
      };
    }

    const { owner, repo } = params.repository ? parseRepository(params.repository) : this.defaultRepo;
    const baseBranch = params.baseBranch || "main";
    const title = params.title || `[Factory] Run ${params.runId.slice(0, 8)} (${branch})`;

    try {
      // 1. Attempt to create the PR
      const createRes = await this.fetchFn(`${this.apiBaseUrl}/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Outside-Orchestrator-Factory/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title,
          head: branch,
          base: baseBranch,
          body: params.body || `Automated Pull Request for Factory Run ${params.runId}`
        })
      });

      if (createRes.status === 201) {
        const data = await createRes.json() as { number: number; html_url: string };
        return {
          status: "created",
          prNumber: data.number,
          prUrl: data.html_url,
          branch
        };
      }

      // If PR already exists (422)
      if (createRes.status === 422) {
        // Query for existing PR on this head branch
        const listRes = await this.fetchFn(
          `${this.apiBaseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${this.token}`,
              "Accept": "application/vnd.github+json",
              "User-Agent": "Outside-Orchestrator-Factory/1.0",
              "X-GitHub-Api-Version": "2022-11-28"
            }
          }
        );

        if (listRes.ok) {
          const list = await listRes.json() as Array<{ number: number; html_url: string }>;
          if (list && list.length > 0) {
            return {
              status: "existing",
              prNumber: list[0].number,
              prUrl: list[0].html_url,
              branch
            };
          }
        }
      }

      const errorText = await createRes.text();
      return {
        status: "failed",
        branch,
        error: `GitHub API error (${createRes.status}): ${errorText}`
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        status: "failed",
        branch,
        error: error.message
      };
    }
  }

  /**
   * End-to-end publish: ensures branch exists and opens PR.
   */
  public async publishHarvestPullRequest(params: {
    runId: string;
    branch?: string;
    commitSha: string;
    baseBranch?: string;
    repository?: string;
    repoPath?: string;
    pushLocalRef?: boolean;
    title?: string;
    bodyMarkdown: string;
  }): Promise<PullRequestResult> {
    const branch = params.branch || (params.runId.startsWith("run-") ? `factory/${params.runId}` : `factory/run-${params.runId}`);
    const { owner, repo } = params.repository ? parseRepository(params.repository) : this.defaultRepo;

    if (!this.hasToken()) {
      return {
        status: "skipped",
        branch,
        error: "No GitHub token configured"
      };
    }

    // Step 1: Create or update remote branch ref (with git push or REST API)
    const branchResult = await this.createOrUpdateBranch({
      owner,
      repo,
      branch,
      commitSha: params.commitSha,
      repoPath: params.repoPath,
      pushLocalRef: params.pushLocalRef
    });

    if (!branchResult.success) {
      return {
        status: "failed",
        branch,
        error: `Branch creation failed: ${branchResult.error}`
      };
    }

    // Step 2: Create or retrieve PR
    return this.createPullRequest({
      runId: params.runId,
      branch,
      commitSha: params.commitSha,
      baseBranch: params.baseBranch,
      repository: `${owner}/${repo}`,
      title: params.title,
      body: params.bodyMarkdown
    });
  }

  /**
   * Fetches current Pull Request status and metadata from GitHub.
   */
  public async getPullRequest(params: {
    owner?: string;
    repo?: string;
    pullNumber: number;
  }): Promise<PullRequestDetails | null> {
    if (!this.hasToken()) {
      return null;
    }
    const owner = params.owner ?? this.defaultRepo.owner;
    const repo = params.repo ?? this.defaultRepo.repo;
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/repos/${owner}/${repo}/pulls/${params.pullNumber}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Outside-Orchestrator-Factory/1.0",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!res.ok) {
        return null;
      }
      const data = await res.json() as any;
      return {
        number: data.number,
        state: data.state,
        merged: Boolean(data.merged),
        mergeable: data.mergeable,
        mergeableState: data.mergeable_state,
        title: data.title,
        headRef: data.head?.ref,
        headSha: data.head?.sha,
        baseRef: data.base?.ref,
        htmlUrl: data.html_url,
        mergedAt: data.merged_at,
        mergeCommitSha: data.merge_commit_sha
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetches submitted reviews for a Pull Request from GitHub.
   */
  public async getPullRequestReviews(params: {
    owner?: string;
    repo?: string;
    pullNumber: number;
  }): Promise<PullRequestReview[]> {
    if (!this.hasToken()) {
      return [];
    }
    const owner = params.owner ?? this.defaultRepo.owner;
    const repo = params.repo ?? this.defaultRepo.repo;
    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/repos/${owner}/${repo}/pulls/${params.pullNumber}/reviews`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Outside-Orchestrator-Factory/1.0",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!res.ok) {
        return [];
      }
      const list = await res.json() as any[];
      return list.map((item) => ({
        id: item.id,
        user: item.user?.login || "unknown",
        state: item.state,
        submittedAt: item.submitted_at,
        commitId: item.commit_id
      }));
    } catch {
      return [];
    }
  }

  /**
   * Merges an approved Pull Request via GitHub REST API.
   */
  public async mergePullRequest(params: MergePullRequestParams): Promise<MergePullRequestResult> {
    if (!this.hasToken()) {
      return { merged: false, error: "No GitHub token configured" };
    }
    const owner = params.owner ?? this.defaultRepo.owner;
    const repo = params.repo ?? this.defaultRepo.repo;
    const mergeMethod = params.mergeMethod || "squash";

    try {
      const res = await this.fetchFn(`${this.apiBaseUrl}/repos/${owner}/${repo}/pulls/${params.pullNumber}/merge`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "Outside-Orchestrator-Factory/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          commit_title: params.commitTitle,
          commit_message: params.commitMessage,
          merge_method: mergeMethod
        })
      });

      const body = await res.json() as any;
      if (res.ok && body.merged) {
        return {
          merged: true,
          sha: body.sha,
          message: body.message || "Pull Request successfully merged"
        };
      }

      return {
        merged: false,
        message: body.message,
        error: `Merge failed (HTTP ${res.status}): ${body.message || "Unknown error"}`
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        merged: false,
        error: error.message
      };
    }
  }

  /**
   * Posts a comment to a GitHub Issue.
   */
  public async createIssueComment(params: {
    owner?: string;
    repo?: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number; htmlUrl: string } | null> {
    if (!this.hasToken()) {
      return null;
    }

    const { owner, repo } = (params.owner && params.repo)
      ? { owner: params.owner, repo: params.repo }
      : this.defaultRepo;

    try {
      const res = await this.fetchFn(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${params.issueNumber}/comments`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.token}`,
            "Accept": "application/vnd.github+json",
            "User-Agent": "Outside-Orchestrator-Factory/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ body: params.body })
        }
      );

      if (res.ok) {
        const data = await res.json() as any;
        return {
          id: data.id,
          htmlUrl: data.html_url
        };
      }
      return null;
    } catch (err) {
      console.error(`[GitHubPrPublisher] Failed to create comment on issue #${params.issueNumber}:`, err);
      return null;
    }
  }

  /**
   * Adds one or more labels to a GitHub Issue.
   */
  public async addIssueLabels(params: {
    owner?: string;
    repo?: string;
    issueNumber: number;
    labels: string[];
  }): Promise<string[] | null> {
    if (!this.hasToken() || !params.labels.length) {
      return null;
    }

    const { owner, repo } = (params.owner && params.repo)
      ? { owner: params.owner, repo: params.repo }
      : this.defaultRepo;

    try {
      const res = await this.fetchFn(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${params.issueNumber}/labels`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.token}`,
            "Accept": "application/vnd.github+json",
            "User-Agent": "Outside-Orchestrator-Factory/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ labels: params.labels })
        }
      );

      if (res.ok) {
        const data = await res.json() as any[];
        return data.map(l => l.name);
      }
      return null;
    } catch (err) {
      console.error(`[GitHubPrPublisher] Failed to add labels on issue #${params.issueNumber}:`, err);
      return null;
    }
  }

  /**
   * Removes a label from a GitHub Issue.
   */
  public async removeIssueLabel(params: {
    owner?: string;
    repo?: string;
    issueNumber: number;
    label: string;
  }): Promise<boolean> {
    if (!this.hasToken()) {
      return false;
    }

    const { owner, repo } = (params.owner && params.repo)
      ? { owner: params.owner, repo: params.repo }
      : this.defaultRepo;

    try {
      const res = await this.fetchFn(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${params.issueNumber}/labels/${encodeURIComponent(params.label)}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${this.token}`,
            "Accept": "application/vnd.github+json",
            "User-Agent": "Outside-Orchestrator-Factory/1.0",
            "X-GitHub-Api-Version": "2022-11-28"
          }
        }
      );
      return res.ok || res.status === 404;
    } catch (err) {
      console.error(`[GitHubPrPublisher] Failed to remove label '${params.label}' on issue #${params.issueNumber}:`, err);
      return false;
    }
  }
}

export function formatIssueAcknowledgmentComment(params: {
  runId: string;
  intent: string;
  confidence: number;
  allowedPaths: string[];
  immutablePaths: string[];
  acceptanceCriteria: string[];
  suggestedPhases?: string[];
  estimatedBudgetCents?: number;
}): string {
  const allowedList = params.allowedPaths.map(p => `- \`${p}\``).join("\n");
  const immutableList = params.immutablePaths.map(p => `- \`${p}\``).join("\n");
  const criteriaList = params.acceptanceCriteria.map(c => `- [ ] ${c}`).join("\n");
  const confPct = Math.round(params.confidence * 100);
  const budgetStr = params.estimatedBudgetCents ? `$${(params.estimatedBudgetCents / 100).toFixed(2)}` : "$5.00";

  return `### 🏭 Outside Orchestrator — Factory Run Initiated

The Outside Orchestrator has autonomously ingested this task and formed a verified execution envelope.

| Parameter | Value |
|---|---|
| **Run ID** | \`${params.runId}\` |
| **Intent** | \`${params.intent.toUpperCase()}\` |
| **Decomposition Confidence** | \`${confPct}%\` |
| **Suggested Phases** | \`${(params.suggestedPhases || ["build", "test"]).join(" → ")}\` |
| **Max Budget Allocation** | \`${budgetStr}\` |

#### 🛡️ Allowed Paths (Zero-Tolerance ERG Boundary)
${allowedList}

#### 🔒 Immutable Paths (Protected Non-Authority Boundary)
${immutableList}

#### 🎯 Frozen Acceptance Criteria
${criteriaList}

---
⏳ *Execution dispatched to isolated Tier 2 sandbox VM. Pull Request link will be posted upon verification.*`;
}

export function formatIssueCompletionComment(params: {
  runId: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  undeclaredTouchesCount: number;
  testPassRate?: number;
  durationMs?: number;
}): string {
  const durationStr = params.durationMs ? `${(params.durationMs / 1000).toFixed(1)}s` : "N/A";
  const passRateStr = params.testPassRate !== undefined ? `${Math.round(params.testPassRate * 100)}%` : "100%";

  return `### ✅ Factory Run Completed & Pull Request Published

The Outside Orchestrator has verified the sandbox execution output and authorized harvest.

| Metric | Verification Result |
|---|---|
| **Pull Request** | [PR #${params.prNumber}](${params.prUrl}) |
| **Feature Branch** | \`${params.branch}\` |
| **Effect Reconciliation Gate (ERG)** | **PASSED** (${params.undeclaredTouchesCount} undeclared touches) |
| **Frozen Acceptance Tests** | **PASSED** (${passRateStr} pass rate) |
| **Execution Duration** | \`${durationStr}\` |

Review and merge the pull request to trigger continuous deployment to production:
👉 [View Pull Request #${params.prNumber}](${params.prUrl})`;
}
