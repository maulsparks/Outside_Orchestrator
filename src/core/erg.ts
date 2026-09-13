export interface ErgOptions {
  baseTreeSha: string;
  postTreeSha: string;
  declaredChangedFiles: string[];
  allowedPaths: string[];
  immutablePaths: string[];
  actualChangedFiles: string[];
}

export interface ErgResult {
  passed: boolean;
  baseTreeSha: string;
  postTreeSha: string;
  actualChangedFiles: string[];
  declaredChangedFiles: string[];
  undeclaredTouches: string[];
  immutableViolations: string[];
  unallowedTouches: string[];
  rejectionReason?: string;
}

/**
 * Matches a relative file path against glob patterns (supporting *, **, and literal paths).
 */
export function matchesPathPattern(filePath: string, pattern: string): boolean {
  // Normalize Windows/Unix path separators
  const normPath = filePath.replace(/\\/g, "/");
  const normPattern = pattern.replace(/\\/g, "/");

  if (normPattern === "**" || normPattern === normPath) {
    return true;
  }

  // Exact prefix or directory match: "src/" matches "src/foo.ts"
  if (normPattern.endsWith("/") && normPath.startsWith(normPattern)) {
    return true;
  }

  // Convert simple glob pattern to RegExp
  const regexPattern = normPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex specials except * and ?
    .replace(/\*\*/g, ".*") // ** -> match anything across directories
    .replace(/(?<!\.)\*/g, "[^/]*"); // * -> match within directory

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normPath);
}

/**
 * Host-Side Effect Reconciliation Gate (ERG) (ISSUE-08 / AC 5, AC 10)
 * Reconciles actual git tree diffs against declared files, allowed paths, and immutable paths.
 */
export function reconcileTreeEffects(options: ErgOptions): ErgResult {
  const actualSet = new Set(options.actualChangedFiles);
  const declaredSet = new Set(options.declaredChangedFiles);

  const undeclaredTouches: string[] = [];
  const immutableViolations: string[] = [];
  const unallowedTouches: string[] = [];

  for (const file of actualSet) {
    // 1. Zero tolerance for undeclared touches
    if (!declaredSet.has(file)) {
      undeclaredTouches.push(file);
    }

    // 2. Check immutable paths
    const isImmutable = options.immutablePaths.some((pattern) => matchesPathPattern(file, pattern));
    if (isImmutable) {
      immutableViolations.push(file);
    }

    // 3. Check allowed paths
    const isAllowed = options.allowedPaths.some((pattern) => matchesPathPattern(file, pattern));
    if (!isAllowed) {
      unallowedTouches.push(file);
    }
  }

  const passed =
    undeclaredTouches.length === 0 &&
    immutableViolations.length === 0 &&
    unallowedTouches.length === 0;

  let rejectionReason: string | undefined;
  if (!passed) {
    const reasons: string[] = [];
    if (undeclaredTouches.length > 0) {
      reasons.push(`Undeclared file touches: [${undeclaredTouches.join(", ")}]`);
    }
    if (immutableViolations.length > 0) {
      reasons.push(`Immutable path violations: [${immutableViolations.join(", ")}]`);
    }
    if (unallowedTouches.length > 0) {
      reasons.push(`Unallowed path touches: [${unallowedTouches.join(", ")}]`);
    }
    rejectionReason = reasons.join("; ");
  }

  return {
    passed,
    baseTreeSha: options.baseTreeSha,
    postTreeSha: options.postTreeSha,
    actualChangedFiles: options.actualChangedFiles,
    declaredChangedFiles: options.declaredChangedFiles,
    undeclaredTouches,
    immutableViolations,
    unallowedTouches,
    rejectionReason
  };
}
