import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    assert.match(text, /`\.adjacentCode\.expansion\.files`/);
    assert.match(text, /reading those files is expected/);
    assert.match(text, /never re-read a hunk interior/);
    assert.doesNotMatch(text, /open a source file only to widen PAST a hunk's edges/);
  }
});

const FNS = (names) => names.map((n) => `export function ${n}(a) {\n  return a;\n}\n`).join("\n");

test("a zero cap disables expansion: no files and no dropped list", async () => {
  await withRepo(repoFiles, async (root) => {
    for (const expansion of [{ maxFiles: 0 }, { maxBytes: 0 }]) {
      const bundle = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion });
      assert.deepEqual([bundle.expansion.files, bundle.expansion.dropped], [[], []]);
    }
  });
});

test("the changed file's siblings entry is kept ahead of importers under a tight cap", async () => {
  await withRepo({ ...repoFiles, "a/early.mjs": 'import { writeState } from "../src/shared.mjs";\n' }, async (root) => {
    const bundle = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion: { maxFiles: 1 } });
    assert.deepEqual(bundle.expansion.files.map((f) => f.kind), ["siblings"]);
  });
});

test("a private resetX / formatOffset change selects nothing; a writeX / set_x change does", async () => {
  const src = "function resetX() {\n  return 1;\n}\nfunction formatOffset() {\n  return 2;\n}\nfunction settings() {\n  return 3;\n}\nfunction isRequired() {\n  return 4;\n}\nfunction set_x() {\n  return 5;\n}\n";
  await withRepo({ "src/p.mjs": src }, async (root) => {
    for (const line of [2, 5, 8, 11]) {
      const b = await buildAdjacentBundle({ changedFiles: ["src/p.mjs"], repoRoot: root, diffText: diffFor("src/p.mjs", line) });
      assert.deepEqual(b.expansion.files, [], `line ${line}`);
    }
    const b = await buildAdjacentBundle({ changedFiles: ["src/p.mjs"], repoRoot: root, diffText: diffFor("src/p.mjs", 14) });
    assert.equal(b.expansion.files.length, 1);
  });
});

test("export lists and export default function mark functions exported", async () => {
  const src = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\nexport default function c() {\n  return 3;\n}\nexport { a };\n";
  await withRepo({ "src/e.mjs": src }, async (root) => {
    for (const line of [2, 8]) {
      const b = await buildAdjacentBundle({ changedFiles: ["src/e.mjs"], repoRoot: root, diffText: diffFor("src/e.mjs", line) });
      assert.equal(b.expansion.files.length, 1, `line ${line}`);
    }
    const priv = await buildAdjacentBundle({ changedFiles: ["src/e.mjs"], repoRoot: root, diffText: diffFor("src/e.mjs", 5) });
    assert.deepEqual(priv.expansion.files, []);
  });
});

test("module-level code after an exported function is not attributed to it", async () => {
  const src = "export function f() {\n  return 1;\n}\nconst table = {\n  a: 1,\n};\n";
  await withRepo({ "src/m.mjs": src }, async (root) => {
    const b = await buildAdjacentBundle({ changedFiles: ["src/m.mjs"], repoRoot: root, diffText: diffFor("src/m.mjs", 5) });
    assert.deepEqual(b.expansion.files, []);
  });
});

test("a removal at a function tail is credited to that function, not the next one", async () => {
  const src = "function p() {\n  return 1;\n}\nexport function q() {\n  return 2;\n}\n";
  const diff = ["diff --git a/src/t.mjs b/src/t.mjs", "--- a/src/t.mjs", "+++ b/src/t.mjs", "@@ -1,5 +1,4 @@", " function p() {", "   return 1;", " }", "-", " export function q() {", ""].join("\n");
  await withRepo({ "src/t.mjs": src }, async (root) => {
    const b = await buildAdjacentBundle({ changedFiles: ["src/t.mjs"], repoRoot: root, diffText: diff });
    assert.deepEqual(b.expansion.files, []);
  });
});

test("a quoted non-ASCII diff path is decoded", async () => {
  const diff = ['diff --git "a/src/\\303\\244.mjs" "b/src/\\303\\244.mjs"', '--- "a/src/\\303\\244.mjs"', '+++ "b/src/\\303\\244.mjs"', "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
  await withRepo({ "src/\u00e4.mjs": FNS(["writeState", "other"]) }, async (root) => {
    const b = await buildAdjacentBundle({ changedFiles: ["src/\u00e4.mjs"], repoRoot: root, diffText: diff });
    assert.deepEqual(b.expansion.files.map((f) => f.path), ["src/\u00e4.mjs"]);
  });
});

test("generated importers are never selected; symlinked importers are excluded by the repo listing", async () => {
  await withRepo({ ...repoFiles, "dist/gen.mjs": 'import { writeState } from "../src/shared.mjs";\n' }, async (root) => {
    await symlink("use-a.mjs", path.join(root, "src/link.mjs"));
    const bundle = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2) });
    const paths = bundle.expansion.files.map((f) => f.path);
    assert.ok(!paths.includes("dist/gen.mjs"));
    assert.ok(!paths.includes("src/link.mjs"), "symlink excluded by the repo listing (the lstat guard is defense in depth)");
  });
});

test("a scoped variant lists the expansion files and the dropped files", async () => {
  await withRepo(repoFiles, async (root) => {
    const adjacentCode = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion: { maxFiles: 2, maxBytes: 1000 } });
    for (const scope of GATE_ANGLE_SCOPES.filter((s) => s !== "full")) {
      const { text } = renderScopedBriefingVariant(scope, {
        repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", evidencePath: "tmp/x.txt", adjacentCode,
        diffOutput: "diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n",
      });
      assert.match(text, /Dropped by the expansion cap \(1\)/);
      assert.match(text, /src\/use-b\.mjs \(importer\)/);
      assert.match(text, /src\/use-a\.mjs \(importer\)/);
    }
  });
});

const declDiff = (src, line) => ({ src, diff: diffFor("src/d.mjs", line) });

test("DECL_RE accepts function and arrow-const declaration forms and rejects parenthesized constants", async () => {
  const accepted = [
    "export const f = (a, b) => a + b;",
    "export const g = async (x) => x;",
    "export function h(x) {",
    "export const k = function (x) {",
    "export const m = x => x;",
  ];
  const rejected = ["export const LIMIT = (1 << 20);", "export const r = (await f());"];
  for (const [forms, expected] of [[accepted, 1], [rejected, 0]]) {
    for (const form of forms) {
      const { src, diff } = declDiff(`${form}\n  body\n}\n`, 1);
      await withRepo({ "src/d.mjs": src, "src/use.mjs": 'import { x } from "./d.mjs";\n' }, async (root) => {
        const b = await buildAdjacentBundle({ changedFiles: ["src/d.mjs"], repoRoot: root, diffText: diff });
        assert.equal(b.expansion.files.filter((f) => f.kind === "importer").length, expected, form);
      });
    }
  }
});

const removalDiff = (removed) => [
  "diff --git a/src/s.mjs b/src/s.mjs", "--- a/src/s.mjs", "+++ b/src/s.mjs", "@@ -1,7 +1,3 @@",
  " function p() {", "   return 1;", " }", ...removed.map((l) => `-${l}`), "",
].join("\n");

test("removing an exported function or an export-list entry selects the importers", async () => {
  const files = { "src/s.mjs": "function p() {\n  return 1;\n}\n", "src/use.mjs": 'import { gone } from "./s.mjs";\ngone();\n' };
  for (const removed of [["", "export function gone() {", "  return 2;", "}"], ["export { gone };"]]) {
    await withRepo(files, async (root) => {
      const b = await buildAdjacentBundle({ changedFiles: ["src/s.mjs"], repoRoot: root, diffText: removalDiff(removed) });
      assert.deepEqual(b.expansion.files.map((f) => f.path), ["src/use.mjs"], removed.join("|"));
    });
  }
});

test("a dropped siblings entry keeps its names and the briefing renders them", async () => {
  await withRepo(repoFiles, async (root) => {
    const adjacentCode = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 2), expansion: { maxFiles: 6, maxBytes: 20 } });
    assert.deepEqual(adjacentCode.expansion.files, []);
    const siblings = adjacentCode.expansion.dropped.find((d) => d.kind === "siblings");
    assert.deepEqual(siblings.names, ["helper", "readState"]);
    const text = renderBriefingEvidence({ repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", prBody: "", changedFiles: ["src/shared.mjs"], adjacentCode }).text;
    assert.match(text, /src\/shared\.mjs \(siblings: helper, readState\)/);
  });
});

test("two changed exported-function files sharing one importer yield a single importer entry with merged relatedTo", async () => {
  const fn = (n) => `export function ${n}(a) {\n  return a;\n}\n`;
  const files = {
    "src/a.mjs": fn("fa"),
    "src/b.mjs": fn("fb"),
    "src/use.mjs": 'import { fa } from "./a.mjs";\nimport { fb } from "./b.mjs";\nfa(fb(1));\n',
  };
  await withRepo(files, async (root) => {
    const bundle = await buildAdjacentBundle({
      changedFiles: ["src/a.mjs", "src/b.mjs"], repoRoot: root, diffText: `${diffFor("src/a.mjs", 2)}${diffFor("src/b.mjs", 2)}`,
    });
    const importers = bundle.expansion.files.filter((f) => f.kind === "importer");
    assert.deepEqual(importers.map((f) => f.path), ["src/use.mjs"]);
    assert.deepEqual(importers[0].relatedTo, ["src/a.mjs", "src/b.mjs"]);
  });
});

test("a replaced private declaration line after an exported function adds no expansion", async () => {
  await withRepo(repoFiles, async (root) => {
    const b = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diffFor("src/shared.mjs", 5) });
    assert.deepEqual(b.expansion.files, []);
  });
});

test("a deleted private function after an exported function adds no expansion", async () => {
  const src = "export function writeState(x) {\n  return x;\n}\n\nexport function readState(z) {\n  return z;\n}\n";
  const diff = [
    "diff --git a/src/shared.mjs b/src/shared.mjs", "--- a/src/shared.mjs", "+++ b/src/shared.mjs", "@@ -1,8 +1,4 @@",
    " export function writeState(x) {", "   return x;", " }", " ",
    "-function helper(y) {", "-  return y + 1;", "-}", "-", " export function readState(z) {", "",
  ].join("\n");
  await withRepo({ ...repoFiles, "src/shared.mjs": src }, async (root) => {
    const b = await buildAdjacentBundle({ changedFiles: ["src/shared.mjs"], repoRoot: root, diffText: diff });
    assert.deepEqual(b.expansion.files, []);
  });
});
