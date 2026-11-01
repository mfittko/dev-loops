import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildAdjacentBundle } from "../../scripts/github/build-adjacent-bundle.mjs";
import { renderBriefingEvidence, renderBriefingPrefix, renderScopedBriefingVariant } from "../../scripts/github/write-gate-context.mjs";
import { GATE_ANGLE_SCOPES } from "@dev-loops/core/config";

const SHARED = [
  "export function writeState(x) {",
  "  return x;",
  "}",
  "",
  "function helper(y) {",
  "  return y + 1;",
  "}",
  "",
  "export function readState(z) {",
  "  return z;",
  "}",
  "",
].join("\n");

const diffFor = (file, line) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  "@@ -1,1 +1,1 @@",
  ...Array.from({ length: line - 1 }, () => " ctx"),
  "-old",
  "+new",
  "",
].join("\n");

async function withRepo(files, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctx-expansion-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), content);
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const repoFiles = {
  "src/shared.mjs": SHARED,
  "src/use-b.mjs": 'import { writeState } from "./shared.mjs";\nwriteState(1);\n',
  "src/use-a.mjs": 'import { writeState } from "./shared.mjs";\nwriteState(2);\n',
};

test("exported-function change adds its importers and sibling functions, sorted by path", async () => {
  await withRepo(repoFiles, async (root) => {
    const bundle = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2) });
    assert.deepEqual(bundle.expansion.files.map((f) => [f.path, f.kind]), [
      ["src/shared.mjs", "siblings"],
      ["src/use-a.mjs", "importer"],
      ["src/use-b.mjs", "importer"],
    ]);
    assert.deepEqual(bundle.expansion.files[0].names, ["helper", "readState"]);
    assert.deepEqual(bundle.expansion.dropped, []);
  });
});

test("a change confined to a private function adds no expansion", async () => {
  await withRepo(repoFiles, async (root) => {
    const bundle = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 6) });
    assert.deepEqual(bundle.expansion.files, []);
    assert.deepEqual(bundle.expansion.dropped, []);
  });
});

test("over-cap expansion truncates deterministically and lists the dropped files; the cap is an input", async () => {
  await withRepo(repoFiles, async (root) => {
    const run = () => buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion: { maxFiles: 2, maxBytes: 1000 } });
    const bundle = await run();
    assert.deepEqual(bundle.expansion.files.map((f) => f.path), ["src/shared.mjs", "src/use-a.mjs"]);
    assert.deepEqual(bundle.expansion.dropped.map((f) => f.path), ["src/use-b.mjs"]);
    assert.equal(bundle.expansion.maxFiles, 2);
    assert.deepEqual((await run()).expansion, bundle.expansion);
    const byBytes = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion: { maxFiles: 6, maxBytes: 70 } });
    assert.ok(byBytes.expansion.files.reduce((n, f) => n + f.bytes, 0) <= 70);
    assert.ok(byBytes.expansion.dropped.length > 0);
  });
});

test("the evidence file lists expansion files and the files the cap dropped", async () => {
  await withRepo(repoFiles, async (root) => {
    const adjacentCode = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion: { maxFiles: 2, maxBytes: 1000 } });
    const text = renderBriefingEvidence({
      repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", prBody: "", changedFiles: ["src/shared.mjs"], adjacentCode,
    }).text;
    assert.match(text, /Expansion files \(2; cap 2 files, 1000 bytes\)/);
    assert.match(text, /src\/use-a\.mjs \(importer\)/);
    assert.match(text, /Dropped by the expansion cap \(1\)/);
    assert.match(text, /src\/use-b\.mjs/);
  });
});

test("the brief says expansion reading is expected and narrows the widening wording, in the full prefix and every scoped variant", () => {
  const prefixInput = {
    repo: "o/r", pr: 9, gate: "draft_gate", headSha: "abc1234567890", worktreeRoot: "/wt",
    contextPath: "tmp/gate-context/o-r/pr-9/draft_gate-abc.json", requiredReads: [],
  };
  const texts = [renderBriefingPrefix(prefixInput).text];
  for (const scope of GATE_ANGLE_SCOPES.filter((s) => s !== "full")) {
    texts.push(renderScopedBriefingVariant(scope, {
      repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", evidencePath: "tmp/x.txt", contextPath: prefixInput.contextPath,
      diffOutput: "diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n",
    }).text);
  }
  for (const text of texts) {
    assert.match(text, /`\.adjacentCode\.expansion`/);
    assert.match(text, /reading those files is expected/);
    assert.match(text, /never re-read a hunk interior/);
    assert.doesNotMatch(text, /open a source file only to widen PAST a hunk's edges/);
  }
});
