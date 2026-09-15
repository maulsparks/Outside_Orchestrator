/**
 * Diff & ERG Coordination Engine (Milestone 22)
 *
 * Reconciles sandbox tree changes with host-side Effect Reconciliation Gate (ERG)
 * and generates structured, granular file diffs with side-by-side rows for operator review.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reconcileTreeEffects, matchesPathPattern, ErgResult } from "./erg.js";
import { parseUnifiedDiff, computeLineDiff, DiffFile } from "./diffParser.js";
import { RunStateStore } from "./stateMachine.js";
import { PhaseEnvelopeStore, PhaseEnvelopeRecord } from "./dispatcher.js";
import { EvidenceStore, EvidenceRecord } from "../warden/ledger.js";
import { TournamentArmStore } from "./tournament.js";

const execFileAsync = promisify(execFile);

export interface GetRunDiffParams {
  runId: string;
  runStore?: RunStateStore;
  phaseStore?: PhaseEnvelopeStore;
  evidenceStore?: EvidenceStore;
  armStore?: TournamentArmStore;
  repoPath?: string;
}

export interface AnnotatedDiffFile extends DiffFile {
  isDeclared: boolean;
  isAllowed: boolean;
  isImmutableViolation: boolean;
  ergStatus: "compliant" | "undeclared_touch" | "immutable_violation" | "unallowed_touch";
}

export interface RunDiffResult {
  runId: string;
  run_id?: string;
  tenantId: string;
  tenant_id?: string;
  baseTreeSha: string;
  acceptedTreeSha: string;
  parentGitSha: string;
  allowedPaths: string[];
  immutablePaths: string[];
  erg: ErgResult;
  files: AnnotatedDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  readyForHarvest: boolean;
  rawDiff?: string;
}

/**
 * Retrieves and reconciles granular file diffs and ERG compliance for a given run.
 */
export async function getRunDiffAndErg(params: GetRunDiffParams): Promise<RunDiffResult> {
  const runId = params.runId;
  let tenantId = "tenant-default";
  let parentGitSha = "cb48638000000000000000000000000000000000";
  let allowedPaths: string[] = ["src/**", "tests/**", "output/**"];
  let immutablePaths: string[] = ["AGENTS.md", ".github/**", "package.json"];
  let acceptedTreeSha = parentGitSha;

  // 1. Interrogate Run State Store
  if (params.runStore) {
    const run = await params.runStore.getRun(runId);
    if (!run) {
      throw new Error(`RunNotFound: Run '${runId}' not found in state store`);
    }
    tenantId = run.tenant_id;
    parentGitSha = run.parent_git_sha;
    acceptedTreeSha = parentGitSha;

    const env = run.envelope as Record<string, unknown> | undefined;
    if (Array.isArray(env?.allowed_paths) && env.allowed_paths.length > 0) {
      allowedPaths = env.allowed_paths as string[];
    }
    if (Array.isArray(env?.immutable_paths) && env.immutable_paths.length > 0) {
      immutablePaths = env.immutable_paths as string[];
    }
  }

  // 2. Check Tournament Winner Arm (if applicable)
  if (params.armStore) {
    try {
      const arms = await params.armStore.listArmsForRun(runId);
      const winner = arms.find((a) => a.selection_status === "winner");
      if (winner && winner.tree_sha) {
        acceptedTreeSha = winner.tree_sha;
      }
    } catch {
      // Non-blocking fallback
    }
  }

  // 3. Inspect Phase Envelopes for Declared Changes and Output Tree SHA
  const declaredSet = new Set<string>();
  const actualSet = new Set<string>();
  let recordedDiffText = "";
  let envelopes: PhaseEnvelopeRecord[] = [];

  if (params.phaseStore) {
    try {
      envelopes = await params.phaseStore.listPhaseEnvelopes(runId);
      for (const env of envelopes) {
        const out = env.outputs as Record<string, unknown> | undefined;
        if (typeof out?.output_tree_sha === "string" && out.output_tree_sha.length > 0) {
          acceptedTreeSha = out.output_tree_sha;
        }
        if (Array.isArray(out?.declared_changed_files)) {
          for (const f of out.declared_changed_files) {
            if (typeof f === "string") {
              declaredSet.add(f);
              actualSet.add(f);
            }
          }
        }
        if (typeof out?.diff === "string" && out.diff.trim().length > 0) {
          recordedDiffText = out.diff;
        }
      }
    } catch {
      // Non-blocking
    }
  }

  // 4. Inspect Evidence Ledger for Host-Observed Touches
  if (params.evidenceStore) {
    try {
      const records: EvidenceRecord[] = await params.evidenceStore.getAllForRun(runId);
      for (const rec of records) {
        const payload = rec.payload as Record<string, unknown> | undefined;
        const obs = payload?.observation as Record<string, unknown> | undefined;
        const ergResult = (obs?.erg_result || payload?.erg_result) as ErgResult | undefined;
        if (ergResult) {
          if (Array.isArray(ergResult.actualChangedFiles)) {
            for (const f of ergResult.actualChangedFiles) actualSet.add(f);
          }
          if (Array.isArray(ergResult.declaredChangedFiles)) {
            for (const f of ergResult.declaredChangedFiles) declaredSet.add(f);
          }
          if (Array.isArray(ergResult.undeclaredTouches)) {
            for (const f of ergResult.undeclaredTouches) actualSet.add(f);
          }
        }

        if (typeof obs?.diff === "string" && obs.diff.trim().length > 0) {
          recordedDiffText = obs.diff;
        }
      }
    } catch {
      // Non-blocking
    }
  }

  // 5. Attempt Live Git Diff
  let rawDiff = recordedDiffText;
  const cwd = params.repoPath || process.cwd();

  if (!rawDiff) {
    try {
      if (acceptedTreeSha && acceptedTreeSha !== parentGitSha) {
        // Try git diff baseTree postTree
        const { stdout } = await execFileAsync("git", ["diff", "--no-color", parentGitSha, acceptedTreeSha], { cwd });
        rawDiff = stdout.trim();
      } else {
        const branchName = runId.startsWith("run-") ? `factory/${runId}` : `factory/run-${runId}`;
        const { stdout } = await execFileAsync("git", ["diff", "--no-color", `${parentGitSha}...${branchName}`], { cwd });
        rawDiff = stdout.trim();
      }
    } catch {
      // Fall back to synthetic diff if git objects not found locally
    }
  }

  // 6. Parse Diff or Synthesize if Raw Diff Absent
  let parsedFiles = parseUnifiedDiff(rawDiff);

  if (parsedFiles.length === 0 && actualSet.size > 0) {
    // Generate synthetic diffs for actual touched files
    for (const filename of actualSet) {
      const isUndeclared = !declaredSet.has(filename);
      const isImmutable = immutablePaths.some((pat) => matchesPathPattern(filename, pat));
      
      let syntheticOld = `// Base state for ${filename}\n// Parent SHA: ${parentGitSha.slice(0, 8)}\n`;
      let syntheticNew = `// Sandbox changes for ${filename}\n// Accepted Tree: ${acceptedTreeSha.slice(0, 8)}\n`;
      
      if (isImmutable) {
        syntheticNew += `// [SECURITY VIOLATION] Immutable authority file modified in sandbox\n`;
      }
      if (isUndeclared) {
        syntheticNew += `// [ERG VIOLATION] Undeclared touch detected by host observation\n`;
      }
      syntheticNew += `export const updated = true;\n`;

      const fileDiffStr = computeLineDiff(syntheticOld, syntheticNew, filename);
      const filesFromSynthetic = parseUnifiedDiff(fileDiffStr);
      if (filesFromSynthetic.length > 0) {
        parsedFiles.push(...filesFromSynthetic);
      }
    }
  }

  // Populate actualSet from parsed files
  for (const f of parsedFiles) {
    actualSet.add(f.filename);
  }

  const declaredChangedFiles = Array.from(declaredSet).sort();
  const actualChangedFiles = Array.from(actualSet).sort();

  // 7. Execute Effect Reconciliation Gate (ERG)
  const erg = reconcileTreeEffects({
    baseTreeSha: parentGitSha,
    postTreeSha: acceptedTreeSha,
    declaredChangedFiles,
    allowedPaths,
    immutablePaths,
    actualChangedFiles
  });

  // 8. Annotate Each DiffFile with ERG Compliance Metadata
  let totalAdditions = 0;
  let totalDeletions = 0;

  const annotatedFiles: AnnotatedDiffFile[] = parsedFiles.map((file) => {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    const isDeclared = declaredSet.has(file.filename);
    const isImmutableViolation = immutablePaths.some((pat) => matchesPathPattern(file.filename, pat));
    const isAllowed = allowedPaths.some((pat) => matchesPathPattern(file.filename, pat));

    let ergStatus: AnnotatedDiffFile["ergStatus"] = "compliant";
    if (isImmutableViolation) {
      ergStatus = "immutable_violation";
    } else if (!isDeclared) {
      ergStatus = "undeclared_touch";
    } else if (!isAllowed) {
      ergStatus = "unallowed_touch";
    }

    return {
      ...file,
      isDeclared,
      isAllowed,
      isImmutableViolation,
      ergStatus
    };
  });

  return {
    runId,
    run_id: runId,
    tenantId,
    tenant_id: tenantId,
    baseTreeSha: parentGitSha,
    acceptedTreeSha,
    parentGitSha,
    allowedPaths,
    immutablePaths,
    erg,
    files: annotatedFiles,
    totalAdditions,
    totalDeletions,
    readyForHarvest: erg.passed,
    rawDiff: rawDiff || undefined
  };
}
