import { test, describe, it } from "node:test";
import assert from "node:assert";
import http from "node:http";
import {
  parseUnifiedDiff,
  alignSideBySideRows,
  computeLineDiff,
  DiffChunk
} from "../src/core/diffParser.js";
import { getRunDiffAndErg } from "../src/core/diffEngine.js";
import { RunStateStore, FactoryRunRecord } from "../src/core/stateMachine.js";
import { PhaseEnvelopeStore, PhaseEnvelopeRecord } from "../src/core/dispatcher.js";

describe("Milestone 22: Granular File Diff & ERG Visualizer", () => {
  describe("DiffParser Unit Tests", () => {
    it("parses single-file unified diff with additions, deletions, and context", () => {
      const rawDiff = `diff --git a/src/core/jwt.ts b/src/core/jwt.ts
index 1234567..89abcdef 100644
--- a/src/core/jwt.ts
+++ b/src/core/jwt.ts
@@ -10,4 +10,5 @@ export function verifyToken(token: string) {
   if (!token) return false;
-  return true;
+  const isExpired = checkExpiration(token);
+  return !isExpired;
 }
`;

      const files = parseUnifiedDiff(rawDiff);
      assert.strictEqual(files.length, 1);

      const f = files[0];
      assert.strictEqual(f.filename, "src/core/jwt.ts");
      assert.strictEqual(f.status, "modified");
      assert.strictEqual(f.additions, 2);
      assert.strictEqual(f.deletions, 1);
      assert.strictEqual(f.chunks.length, 1);

      const chunk = f.chunks[0];
      assert.strictEqual(chunk.oldStart, 10);
      assert.strictEqual(chunk.newStart, 10);

      // Check side-by-side row pairing
      assert.ok(f.sideBySideRows.length >= 4);
      const replacedRow = f.sideBySideRows.find(
        (r) => r.left.type === "delete" && r.right.type === "add"
      );
      assert.ok(replacedRow, "Expected an aligned delete/add row pair");
      assert.ok(replacedRow?.left.content.includes("return true"));
      assert.ok(replacedRow?.right.content.includes("checkExpiration"));
    });

    it("parses multiple files including added and deleted files", () => {
      const multiDiff = `diff --git a/src/newFile.ts b/src/newFile.ts
new file mode 100644
--- /dev/null
+++ b/src/newFile.ts
@@ -0,0 +1,2 @@
+export const alpha = 1;
+export const beta = 2;
diff --git a/src/oldFile.ts b/src/oldFile.ts
deleted file mode 100644
--- a/src/oldFile.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const deprecated = true;
-export const deadCode = 100;
`;

      const files = parseUnifiedDiff(multiDiff);
      assert.strictEqual(files.length, 2);

      assert.strictEqual(files[0].filename, "src/newFile.ts");
      assert.strictEqual(files[0].status, "added");
      assert.strictEqual(files[0].additions, 2);
      assert.strictEqual(files[0].deletions, 0);

      assert.strictEqual(files[1].filename, "src/oldFile.ts");
      assert.strictEqual(files[1].status, "deleted");
      assert.strictEqual(files[1].additions, 0);
      assert.strictEqual(files[1].deletions, 2);
    });

    it("alignSideBySideRows balances consecutive deletes and adds with empty cells", () => {
      const chunk: DiffChunk = {
        header: "@@ -1,3 +1,4 @@",
        oldStart: 1,
        oldLinesCount: 3,
        newStart: 1,
        newLinesCount: 4,
        lines: [
          { type: "context", content: "common line", oldLineNumber: 1, newLineNumber: 1 },
          { type: "delete", content: "removed line 1", oldLineNumber: 2 },
          { type: "add", content: "added line 1", newLineNumber: 2 },
          { type: "add", content: "added line 2", newLineNumber: 3 },
          { type: "add", content: "added line 3", newLineNumber: 4 }
        ]
      };

      const rows = alignSideBySideRows([chunk]);
      assert.strictEqual(rows.length, 4); // 1 context + 3 changes

      // Row 0: context
      assert.strictEqual(rows[0].left.type, "context");
      assert.strictEqual(rows[0].right.type, "context");

      // Row 1: delete 1 aligned with add 1
      assert.strictEqual(rows[1].left.type, "delete");
      assert.strictEqual(rows[1].right.type, "add");

      // Row 2: empty left, add 2 on right
      assert.strictEqual(rows[2].left.type, "empty");
      assert.strictEqual(rows[2].right.type, "add");

      // Row 3: empty left, add 3 on right
      assert.strictEqual(rows[3].left.type, "empty");
      assert.strictEqual(rows[3].right.type, "add");
    });

    it("computeLineDiff generates clean unified diff between two text versions", () => {
      const oldCode = `function test() {\n  return false;\n}`;
      const newCode = `function test() {\n  // updated logic\n  return true;\n}`;

      const diff = computeLineDiff(oldCode, newCode, "test.js");
      assert.ok(diff.includes("diff --git a/test.js b/test.js"));
      assert.ok(diff.includes("-  return false;"));
      assert.ok(diff.includes("+  return true;"));
      assert.ok(diff.includes("+  // updated logic"));

      const parsed = parseUnifiedDiff(diff);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].filename, "test.js");
      assert.strictEqual(parsed[0].additions, 2);
      assert.strictEqual(parsed[0].deletions, 1);
    });
  });

  describe("DiffEngine Unit Tests", () => {
    it("evaluates clean compliant run against ERG rules and annotates files", async () => {
      const mockRun: any = {
        id: "run-clean-diff",
        tenant_id: "tenant-prod",
        request_id: "req-clean",
        parent_git_sha: "cb48638000000000000000000000000000000000",
        policy_version: "v2.0",
        phase: "clean_terminated",
        state_version: 1,
        envelope: {
          allowed_paths: ["src/core/**", "tests/**", "output/**"],
          immutable_paths: ["AGENTS.md", ".github/**"]
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const mockEnvelope: any = {
        id: "env-clean",
        run_id: "run-clean-diff",
        phase: "build",
        attempt: 1,
        created_at: new Date().toISOString(),
        inputs: {},
        outputs: {
          output_tree_sha: "7a91bf2000000000000000000000000000000000",
          declared_changed_files: ["src/core/auth.ts", "tests/auth.test.ts"],
          diff: `diff --git a/src/core/auth.ts b/src/core/auth.ts
--- a/src/core/auth.ts
+++ b/src/core/auth.ts
@@ -1,2 +1,3 @@
 export function authenticate() {
+  console.log("auth check");
   return true;
 }
`
        }
      };

      const mockRunStore = {
        getRun: async (id: string) => (id === "run-clean-diff" ? mockRun : null)
      } as unknown as RunStateStore;

      const mockPhaseStore = {
        listPhaseEnvelopes: async (id: string) => (id === "run-clean-diff" ? [mockEnvelope] : [])
      } as unknown as PhaseEnvelopeStore;

      const result = await getRunDiffAndErg({
        runId: "run-clean-diff",
        runStore: mockRunStore,
        phaseStore: mockPhaseStore
      });

      assert.strictEqual(result.runId, "run-clean-diff");
      assert.strictEqual(result.erg.passed, true);
      assert.strictEqual(result.readyForHarvest, true);
      assert.strictEqual(result.erg.undeclaredTouches.length, 0);

      // Check annotated files
      assert.ok(result.files.length >= 1);
      const authFile = result.files.find((f) => f.filename === "src/core/auth.ts");
      assert.ok(authFile);
      assert.strictEqual(authFile?.isDeclared, true);
      assert.strictEqual(authFile?.isAllowed, true);
      assert.strictEqual(authFile?.isImmutableViolation, false);
      assert.strictEqual(authFile?.ergStatus, "compliant");
    });

    it("flags undeclared file touches as ERG violations", async () => {
      const mockRun: any = {
        id: "run-undeclared-diff",
        tenant_id: "tenant-prod",
        request_id: "req-undec",
        parent_git_sha: "cb48638000000000000000000000000000000000",
        policy_version: "v2.0",
        phase: "clean_terminated",
        state_version: 1,
        envelope: {
          allowed_paths: ["src/**"],
          immutable_paths: ["AGENTS.md"]
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const mockEnvelope: any = {
        id: "env-undec",
        run_id: "run-undeclared-diff",
        phase: "build",
        attempt: 1,
        created_at: new Date().toISOString(),
        inputs: {},
        outputs: {
          output_tree_sha: "9999bf2000000000000000000000000000000000",
          declared_changed_files: ["src/declared.ts"],
          diff: `diff --git a/src/declared.ts b/src/declared.ts
--- a/src/declared.ts
+++ b/src/declared.ts
@@ -1 +1,2 @@
+// ok
diff --git a/src/surpriseSecret.ts b/src/surpriseSecret.ts
--- a/src/surpriseSecret.ts
+++ b/src/surpriseSecret.ts
@@ -1 +1,2 @@
+// rogue file touch
`
        }
      };

      const result = await getRunDiffAndErg({
        runId: "run-undeclared-diff",
        runStore: { getRun: async () => mockRun } as any,
        phaseStore: { listPhaseEnvelopes: async () => [mockEnvelope] } as any
      });

      assert.strictEqual(result.erg.passed, false);
      assert.strictEqual(result.readyForHarvest, false);
      assert.ok(result.erg.undeclaredTouches.includes("src/surpriseSecret.ts"));

      const rogueFile = result.files.find((f) => f.filename === "src/surpriseSecret.ts");
      assert.ok(rogueFile);
      assert.strictEqual(rogueFile?.isDeclared, false);
      assert.strictEqual(rogueFile?.ergStatus, "undeclared_touch");
    });

    it("flags immutable path violations (e.g. AGENTS.md touch)", async () => {
      const mockRun: any = {
        id: "run-immutable-diff",
        tenant_id: "tenant-prod",
        request_id: "req-imm",
        parent_git_sha: "cb48638000000000000000000000000000000000",
        policy_version: "v2.0",
        phase: "clean_terminated",
        state_version: 1,
        envelope: {
          allowed_paths: ["**"],
          immutable_paths: ["AGENTS.md", ".github/**"]
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const mockEnvelope: any = {
        id: "env-imm",
        run_id: "run-immutable-diff",
        phase: "build",
        attempt: 1,
        created_at: new Date().toISOString(),
        inputs: {},
        outputs: {
          declared_changed_files: ["AGENTS.md"],
          diff: `diff --git a/AGENTS.md b/AGENTS.md
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1 +1,2 @@
+# Malicious Authority Expansion
`
        }
      };

      const result = await getRunDiffAndErg({
        runId: "run-immutable-diff",
        runStore: { getRun: async () => mockRun } as any,
        phaseStore: { listPhaseEnvelopes: async () => [mockEnvelope] } as any
      });

      assert.strictEqual(result.erg.passed, false);
      assert.ok(result.erg.immutableViolations.includes("AGENTS.md"));

      const agentsFile = result.files.find((f) => f.filename === "AGENTS.md");
      assert.ok(agentsFile);
      assert.strictEqual(agentsFile?.isImmutableViolation, true);
      assert.strictEqual(agentsFile?.ergStatus, "immutable_violation");
    });
  });

  describe("HTTP REST API (GET /v1/runs/:runId/diff)", () => {
    it("serves diff and ERG analysis over HTTP API", async () => {
      const mockRun: any = {
        id: "run-http-diff",
        tenant_id: "tenant-http",
        request_id: "req-http",
        parent_git_sha: "0000000000000000000000000000000000000000",
        policy_version: "v2.0",
        phase: "clean_terminated",
        state_version: 2,
        envelope: {
          allowed_paths: ["src/**"],
          immutable_paths: ["AGENTS.md"]
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const mockEnvelope: any = {
        id: "env-1",
        run_id: "run-http-diff",
        phase: "build",
        attempt: 1,
        created_at: new Date().toISOString(),
        inputs: {},
        outputs: {
          declared_changed_files: ["src/index.ts"],
          diff: `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1,2 @@
+// added
`
        }
      };

      const localServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);
        const diffMatch = url.pathname.match(/^\/(?:v1\/)?runs\/([^/]+)\/diff$/);
        if (diffMatch && req.method === "GET") {
          const runId = diffMatch[1];
          try {
            const diffResult = await getRunDiffAndErg({
              runId,
              runStore: {
                getRun: async (id: string) => (id === "run-http-diff" ? mockRun : null)
              } as any,
              phaseStore: {
                listPhaseEnvelopes: async (id: string) => (id === "run-http-diff" ? [mockEnvelope] : [])
              } as any
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(diffResult));
          } catch (err: any) {
            if (err.message && err.message.includes("RunNotFound")) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", () => resolve()));
      const port = (localServer.address() as any).port;

      try {
        // Query non-existent run
        const notFoundRes = await fetch(`http://127.0.0.1:${port}/v1/runs/nonexistent-run-xyz/diff`);
        assert.strictEqual(notFoundRes.status, 404);
        const notFoundJson = (await notFoundRes.json()) as any;
        assert.ok(notFoundJson.error.includes("RunNotFound"));

        // Query existent run
        const okRes = await fetch(`http://127.0.0.1:${port}/v1/runs/run-http-diff/diff`);
        assert.strictEqual(okRes.status, 200);
        const okJson = (await okRes.json()) as any;
        assert.strictEqual(okJson.run_id, "run-http-diff");
        assert.strictEqual(okJson.erg.passed, true);
        assert.strictEqual(okJson.files.length, 1);
        assert.strictEqual(okJson.files[0].filename, "src/index.ts");
      } finally {
        await new Promise<void>((resolve) => localServer.close(() => resolve()));
      }
    });
  });
});
