/**
 * Zero-Dependency Unified Diff Parser & Side-by-Side Aligner (Milestone 22)
 *
 * Implements granular diff parsing, side-by-side row alignment, additions/deletions
 * metrics, and lightweight Myers-LCS line diff generation with zero external dependencies.
 */

export interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffChunk {
  header: string;
  oldStart: number;
  oldLinesCount: number;
  newStart: number;
  newLinesCount: number;
  lines: DiffLine[];
}

export interface SideBySideCell {
  lineNumber?: number;
  type: "add" | "delete" | "context" | "empty";
  content: string;
}

export interface SideBySideRow {
  left: SideBySideCell;
  right: SideBySideCell;
}

export interface DiffFile {
  filename: string;
  oldFilename?: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
  sideBySideRows: SideBySideRow[];
}

/**
 * Aligns DiffChunks into paired Side-by-Side rows (Left = Base/Old, Right = Sandbox/New).
 */
export function alignSideBySideRows(chunks: DiffChunk[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];

  for (const chunk of chunks) {
    let i = 0;
    const lines = chunk.lines;

    while (i < lines.length) {
      const line = lines[i];

      if (line.type === "context") {
        rows.push({
          left: {
            lineNumber: line.oldLineNumber,
            type: "context",
            content: line.content
          },
          right: {
            lineNumber: line.newLineNumber,
            type: "context",
            content: line.content
          }
        });
        i++;
      } else {
        // Collect consecutive deletes and adds
        const deletes: DiffLine[] = [];
        const adds: DiffLine[] = [];

        while (i < lines.length && (lines[i].type === "delete" || lines[i].type === "add")) {
          if (lines[i].type === "delete") {
            deletes.push(lines[i]);
          } else {
            adds.push(lines[i]);
          }
          i++;
        }

        const maxLen = Math.max(deletes.length, adds.length);
        for (let j = 0; j < maxLen; j++) {
          const d = deletes[j];
          const a = adds[j];

          rows.push({
            left: d
              ? {
                  lineNumber: d.oldLineNumber,
                  type: "delete",
                  content: d.content
                }
              : {
                  type: "empty",
                  content: ""
                },
            right: a
              ? {
                  lineNumber: a.newLineNumber,
                  type: "add",
                  content: a.content
                }
              : {
                  type: "empty",
                  content: ""
                }
          });
        }
      }
    }
  }

  return rows;
}

/**
 * Parses raw git unified diff output into structured DiffFile[] representations.
 */
export function parseUnifiedDiff(rawDiff: string): DiffFile[] {
  if (!rawDiff || !rawDiff.trim()) {
    return [];
  }

  const files: DiffFile[] = [];
  const lines = rawDiff.split(/\r?\n/);
  let currentFile: Partial<DiffFile> | null = null;
  let currentChunk: DiffChunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  function finalizeFile() {
    if (currentFile && currentFile.filename) {
      if (currentChunk) {
        currentFile.chunks = currentFile.chunks || [];
        currentFile.chunks.push(currentChunk);
        currentChunk = null;
      }
      currentFile.chunks = currentFile.chunks || [];
      currentFile.sideBySideRows = alignSideBySideRows(currentFile.chunks);
      files.push(currentFile as DiffFile);
      currentFile = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect file boundary
    if (line.startsWith("diff --git ")) {
      finalizeFile();

      const match = line.match(/^diff --git a\/(.+?)\s+b\/(.+?)$/);
      const filename = match ? match[2] : line.replace("diff --git ", "").trim();
      const oldFilename = match ? match[1] : filename;

      currentFile = {
        filename,
        oldFilename,
        status: "modified",
        additions: 0,
        deletions: 0,
        chunks: []
      };
      continue;
    }

    if (!currentFile) {
      // If diff starts without "diff --git" (e.g. standard patch), infer from --- and +++
      if (line.startsWith("--- ")) {
        const rawName = line.slice(4).trim().replace(/^[ab]\//, "");
        currentFile = {
          filename: rawName === "/dev/null" ? "unknown" : rawName,
          oldFilename: rawName,
          status: "modified",
          additions: 0,
          deletions: 0,
          chunks: []
        };
      } else {
        continue;
      }
    }

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      continue;
    }

    if (line.startsWith("--- ")) {
      const name = line.slice(4).trim();
      if (name === "/dev/null") {
        currentFile.status = "added";
      } else {
        currentFile.oldFilename = name.replace(/^[ab]\//, "");
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trim();
      if (name === "/dev/null") {
        currentFile.status = "deleted";
      } else {
        currentFile.filename = name.replace(/^[ab]\//, "");
      }
      continue;
    }

    // Detect chunk header: @@ -1,5 +1,6 @@
    const chunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (chunkMatch) {
      if (currentChunk) {
        currentFile.chunks = currentFile.chunks || [];
        currentFile.chunks.push(currentChunk);
      }

      oldLineNum = parseInt(chunkMatch[1], 10);
      const oldLinesCount = chunkMatch[2] !== undefined ? parseInt(chunkMatch[2], 10) : 1;
      newLineNum = parseInt(chunkMatch[3], 10);
      const newLinesCount = chunkMatch[4] !== undefined ? parseInt(chunkMatch[4], 10) : 1;

      currentChunk = {
        header: line,
        oldStart: oldLineNum,
        oldLinesCount,
        newStart: newLineNum,
        newLinesCount,
        lines: []
      };
      continue;
    }

    // Inside a chunk
    if (currentChunk) {
      if (line.startsWith("+")) {
        currentFile.additions = (currentFile.additions || 0) + 1;
        currentChunk.lines.push({
          type: "add",
          content: line.slice(1),
          newLineNumber: newLineNum++
        });
      } else if (line.startsWith("-")) {
        currentFile.deletions = (currentFile.deletions || 0) + 1;
        currentChunk.lines.push({
          type: "delete",
          content: line.slice(1),
          oldLineNumber: oldLineNum++
        });
      } else if (line.startsWith(" ")) {
        currentChunk.lines.push({
          type: "context",
          content: line.slice(1),
          oldLineNumber: oldLineNum++,
          newLineNumber: newLineNum++
        });
      } else if (line.startsWith("\\ No newline at end of file")) {
        // Ignore git indicator
      }
    }
  }

  finalizeFile();
  return files;
}

/**
 * Lightweight Myers-LCS line differ to generate unified diff text between two strings.
 */
export function computeLineDiff(oldStr: string, newStr: string, filename: string): string {
  const oldLines = oldStr ? oldStr.split(/\r?\n/) : [];
  const newLines = newStr ? newStr.split(/\r?\n/) : [];

  const n = oldLines.length;
  const m = newLines.length;

  if (n === 0 && m === 0) {
    return "";
  }

  if (n === 0) {
    // Pure added file
    let diff = `diff --git a/${filename} b/${filename}\n`;
    diff += `new file mode 100644\n`;
    diff += `--- /dev/null\n`;
    diff += `+++ b/${filename}\n`;
    diff += `@@ -0,0 +1,${m} @@\n`;
    for (const line of newLines) {
      diff += `+${line}\n`;
    }
    return diff;
  }

  if (m === 0) {
    // Pure deleted file
    let diff = `diff --git a/${filename} b/${filename}\n`;
    diff += `deleted file mode 100644\n`;
    diff += `--- a/${filename}\n`;
    diff += `+++ /dev/null\n`;
    diff += `@@ -1,${n} +0,0 @@\n`;
    for (const line of oldLines) {
      diff += `-${line}\n`;
    }
    return diff;
  }

  // Classic LCS DP matrix
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find edits
  const edits: Array<{ type: "add" | "delete" | "context"; text: string }> = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      edits.push({ type: "context", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ type: "add", text: newLines[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      edits.push({ type: "delete", text: oldLines[i - 1] });
      i--;
    }
  }

  edits.reverse();

  // If no additions and no deletions, files are identical
  const hasChanges = edits.some((e) => e.type !== "context");
  if (!hasChanges) {
    return "";
  }

  let diff = `diff --git a/${filename} b/${filename}\n`;
  diff += `--- a/${filename}\n`;
  diff += `+++ b/${filename}\n`;
  diff += `@@ -1,${n} +1,${m} @@\n`;

  for (const e of edits) {
    if (e.type === "add") diff += `+${e.text}\n`;
    else if (e.type === "delete") diff += `-${e.text}\n`;
    else diff += ` ${e.text}\n`;
  }

  return diff;
}
