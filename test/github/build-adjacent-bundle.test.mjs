import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  buildAdjacentBundle,
  classifyStripReason,
  extractImportSpecifiers,
  listRepoFiles,
  resolveRelativeImport,
  resolveSafeRepoPath,
} from "../../scripts/github/build-adjacent-bundle.mjs";

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

function fileByPath(bundle, p) {
  return bundle.files.find((f) => f.path === p);
}

// ---------------------------------------------------------------------------
// classifyStripReason
// ---------------------------------------------------------------------------

test("classifyStripReason flags lockfiles, generated trees, binary, minified", () => {
  assert.equal(classifyStripReason("bun.lock"), "lockfile");
  assert.equal(classifyStripReason("package-lock.json"), "lockfile");
  assert.equal(classifyStripReason("pnpm-lock.yaml"), "lockfile");
  assert.equal(classifyStripReason(".claude/agents/review.md"), null);
  assert.equal(classifyStripReason("dist/bundle.js"), "generated");
  assert.equal(classifyStripReason("lib/core.js"), null);
  assert.equal(classifyStripReason("scripts/lib/audit-pi-session.mjs"), null);
  assert.equal(classifyStripReason("node_modules/x/index.js"), "generated");
  assert.equal(classifyStripReason("coverage/lcov.info"), "generated");
  assert.equal(classifyStripReason(".git/config"), "generated");
  assert.equal(classifyStripReason("assets/logo.png"), "binary");
  assert.equal(classifyStripReason("public/app.min.js"), "minified");
  assert.equal(classifyStripReason("scripts/github/write-gate-context.mjs"), null);
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers
// ---------------------------------------------------------------------------

test("extractImportSpecifiers captures import/from, bare, dynamic, require", () => {
  const src = [
    'import { a } from "./a.mjs";',
    'import "./side-effect.mjs";',
    'export { b } from "./b.mjs";',
    'const x = await import("./dyn.mjs");',
    'const y = require("./legacy.cjs");',
    'import pkg from "some-package";',
  ].join("\n");
  const specs = extractImportSpecifiers(src);
  assert.deepEqual(specs, [
    "./a.mjs",
    "./b.mjs",
    "some-package",
    "./side-effect.mjs",
    "./dyn.mjs",
    "./legacy.cjs",
  ]);
});

test("extractImportSpecifiers returns empty for non-string / empty", () => {
  assert.deepEqual(extractImportSpecifiers(""), []);
  assert.deepEqual(extractImportSpecifiers(undefined), []);
});

// ---------------------------------------------------------------------------
// resolveRelativeImport
// ---------------------------------------------------------------------------

test("resolveRelativeImport resolves extensions and index files, ignores bare specifiers", () => {
  const existing = new Set(["src/a.mjs", "src/util/index.mjs", "src/b.mjs"]);
  assert.equal(resolveRelativeImport("src/main.mjs", "./a.mjs", existing), "src/a.mjs");
  assert.equal(resolveRelativeImport("src/main.mjs", "./a", existing), "src/a.mjs");
  assert.equal(resolveRelativeImport("src/main.mjs", "./util", existing), "src/util/index.mjs");
  assert.equal(resolveRelativeImport("src/main.mjs", "react", existing), null);
  assert.equal(resolveRelativeImport("src/main.mjs", "../../../etc/passwd", existing), null);
});

// ---------------------------------------------------------------------------
// buildAdjacentBundle — adjacency for a changed symbol
// ---------------------------------------------------------------------------

test("buildAdjacentBundle includes imports (out-edges) and importers (in-edges) of a changed file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    await writeFiles(root, {
      "src/changed.mjs": 'import { helper } from "./dep.mjs";\nexport function changed() { return helper(); }\n',
      "src/dep.mjs": "export function helper() { return 1; }\n",
      "src/caller.mjs": 'import { changed } from "./changed.mjs";\nchanged();\n',
      "src/unrelated.mjs": "export const z = 1;\n",
    });

    const bundle = await buildAdjacentBundle({ changedFiles: ["src/changed.mjs"], repoRoot: root });

    const changed = fileByPath(bundle, "src/changed.mjs");
    const dep = fileByPath(bundle, "src/dep.mjs");
    const caller = fileByPath(bundle, "src/caller.mjs");

    assert.ok(changed, "changed file present");
    assert.equal(changed.role, "changed");

    assert.ok(dep, "imported dep present (out-edge)");
    assert.equal(dep.role, "imports");
    assert.deepEqual(dep.relatedTo, ["src/changed.mjs"]);
    assert.deepEqual(Object.keys(dep), ["path", "role", "relatedTo", "bytes"]);
    assert.equal(dep.bytes, Buffer.byteLength("export function helper() { return 1; }\n"));
    assert.ok(!JSON.stringify(bundle).includes("function helper"), "no file contents in the bundle");
    assert.deepEqual(bundle.truncated, []);
    assert.ok(!("maxFileBytes" in bundle));

    assert.ok(caller, "importer present (in-edge)");
    assert.equal(caller.role, "importedBy");
    assert.deepEqual(caller.relatedTo, ["src/changed.mjs"]);

    // Unrelated file is NOT pulled in.
    assert.equal(fileByPath(bundle, "src/unrelated.mjs"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle is deterministic for identical input (sorted, stable)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    await writeFiles(root, {
      "src/a.mjs": 'import "./b.mjs";\nimport "./c.mjs";\n',
      "src/b.mjs": "export const b = 1;\n",
      "src/c.mjs": "export const c = 1;\n",
    });
    const b1 = await buildAdjacentBundle({ changedFiles: ["src/a.mjs"], repoRoot: root });
    const b2 = await buildAdjacentBundle({ changedFiles: ["src/a.mjs"], repoRoot: root });
    assert.equal(JSON.stringify(b1), JSON.stringify(b2));
    // files are sorted by path.
    const paths = b1.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle strips lockfile/generated/binary adjacents WITH a recorded manifest entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    await writeFiles(root, {
      // changed file is a top-level lockfile (changed dir, so it appears as the
      // changed entry but must be stripped with a reason).
      "package-lock.json": '{"lockfileVersion":3}\n',
    });
    const bundle = await buildAdjacentBundle({ changedFiles: ["package-lock.json"], repoRoot: root });
    assert.equal(fileByPath(bundle, "package-lock.json"), undefined, "lockfile not included as content");
    const entry = bundle.stripped.find((s) => s.path === "package-lock.json");
    assert.ok(entry, "lockfile recorded in stripped manifest");
    assert.equal(entry.reason, "lockfile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("buildAdjacentBundle strips a binary adjacent (NUL-byte content sniff)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    await writeFiles(root, {
      "src/changed.mjs": 'import "./blob.dat";\n',
      // .dat is not in SOURCE_EXTENSIONS so it won't resolve as an import edge;
      // instead make a changed binary file to exercise the content sniff.
      "data.payload": Buffer.from([0x00, 0x01, 0x02, 0x03]),
    });
    const bundle = await buildAdjacentBundle({ changedFiles: ["data.payload"], repoRoot: root });
    assert.equal(fileByPath(bundle, "data.payload"), undefined);
    const entry = bundle.stripped.find((s) => s.path === "data.payload");
    assert.ok(entry);
    assert.equal(entry.reason, "binary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle detects a binary whose first NUL is past the first bytes of the file", async () => {
  // Regression: the sniff window covers more than the first bytes, so a binary
  // with text-looking bytes before a NUL is not misclassified as text.
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    const blob = Buffer.concat([Buffer.alloc(5000, 0x61 /* 'a' */), Buffer.from([0x00])]);
    await writeFiles(root, { "late-nul.payload": blob });
    const bundle = await buildAdjacentBundle({ changedFiles: ["late-nul.payload"], repoRoot: root });
    assert.equal(fileByPath(bundle, "late-nul.payload"), undefined);
    const entry = bundle.stripped.find((s) => s.path === "late-nul.payload");
    assert.ok(entry, "binary with a late NUL must be stripped, not included as text");
    assert.equal(entry.reason, "binary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSafeRepoPath rejects absolute, parent-escaping, and out-of-root paths", () => {
  const root = "/repo/root";
  assert.equal(resolveSafeRepoPath(root, "src/a.mjs").ok, true);
  assert.equal(resolveSafeRepoPath(root, "/etc/passwd").ok, false);
  assert.equal(resolveSafeRepoPath(root, "../escape.mjs").ok, false);
  assert.equal(resolveSafeRepoPath(root, "src/../../escape.mjs").ok, false);
  assert.equal(resolveSafeRepoPath(root, "").ok, false);
});

test("buildAdjacentBundle skips an unsafe changed path and records it in stripped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    // Stash a file OUTSIDE the repo root that an unsafe relPath would reach.
    const outside = path.join(root, "..", `secret-${path.basename(root)}.mjs`);
    await writeFile(outside, "export const SECRET = 1;\n");
    await writeFiles(root, { "src/kept.mjs": "export const k = 1;\n" });
    const unsafe = `../secret-${path.basename(root)}.mjs`;
    const bundle = await buildAdjacentBundle({
      changedFiles: [unsafe, "src/kept.mjs"],
      repoRoot: root,
    });
    // Not read as content, not leaked.
    assert.equal(fileByPath(bundle, unsafe), undefined);
    assert.ok(
      !JSON.stringify(bundle).includes("SECRET"),
      "unsafe out-of-root file content must not leak into the bundle",
    );
    const entry = bundle.stripped.find((s) => s.path === unsafe);
    assert.ok(entry, "unsafe path recorded in stripped manifest");
    assert.equal(entry.reason, "unsafe-path");
    await rm(outside, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle records a deleted changed file as missing, not an error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    await writeFiles(root, { "src/kept.mjs": "export const k = 1;\n" });
    const bundle = await buildAdjacentBundle({ changedFiles: ["src/deleted.mjs", "src/kept.mjs"], repoRoot: root });
    assert.ok(bundle.missing.includes("src/deleted.mjs"));
    assert.ok(fileByPath(bundle, "src/kept.mjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listRepoFiles indexes scripts/lib/ and .claude/ but skips node_modules/ and dist/", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    await writeFiles(root, {
      "scripts/lib/util.mjs": "export const u = 1;\n",
      ".claude/hooks/guard.mjs": "export const g = 1;\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "dist/out.js": "export const d = 1;\n",
      ".claude/worktrees/x/a.mjs": "export const a = 1;\n",
      ".venv/lib/m.py": "x = 1\n",
    });
    const files = await listRepoFiles(root);
    assert.ok(files.includes("scripts/lib/util.mjs"));
    assert.ok(files.includes(".claude/hooks/guard.mjs"));
    assert.ok(!files.some((f) => f.startsWith("node_modules/") || f.startsWith("dist/")));
    assert.ok(!files.includes(".claude/worktrees/x/a.mjs"));
    assert.ok(!files.some((f) => f.startsWith(".venv/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle returns empty structures for no changed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adj-bundle-"));
  try {
    const bundle = await buildAdjacentBundle({ changedFiles: [], repoRoot: root });
    assert.deepEqual(bundle.files, []);
    assert.deepEqual(bundle.stripped, []);
    assert.deepEqual(bundle.missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle strips a changed symlink, a path under a symlinked dir and a dangling symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bundle-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "bundle-outside-"));
  try {
    await writeFile(path.join(outside, "t.mjs"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(outside, "a.mjs"), "export const a = 1;\n");
    await symlink(path.join(outside, "t.mjs"), path.join(root, "link.mjs"));
    await symlink(outside, path.join(root, "dir"));
    await symlink(path.join(outside, "nope.mjs"), path.join(root, "dangling.mjs"));
    const changedFiles = ["link.mjs", "dir/a.mjs", "dangling.mjs"];
    const bundle = await buildAdjacentBundle({ changedFiles, repoRoot: root });
    for (const p of changedFiles) {
      assert.equal(bundle.stripped.find((s) => s.path === p)?.reason, "symlink", p);
      assert.equal(fileByPath(bundle, p), undefined, p);
    }
    assert.deepEqual(bundle.missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("buildAdjacentBundle keeps a regular file reached through a backslash relPath", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bundle-backslash-"));
  try {
    await mkdir(path.join(root, "dir"));
    await writeFile(path.join(root, "dir", "a.mjs"), "export const a = 1;\n");
    const bundle = await buildAdjacentBundle({ changedFiles: ["dir\\a.mjs"], repoRoot: root });
    assert.equal(bundle.stripped.length, 0);
    assert.equal(bundle.files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
