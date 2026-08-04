import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runNode } from "../_helpers.mjs";
import { parseRefinementAuditCliArgs } from "../../scripts/loop/run-refinement-audit.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/loop/run-refinement-audit.mjs");
const runAudit = (args = [], options = {}) => runNode(scriptPath, args, options);

async function writeRepoFile(repoRoot, relativePath, content) {
  const filePath = path.join(repoRoot, relativePath);
  await writeFile(filePath, content);
}

async function initTrackedRepo(files, { chmodAfterTrack = [] } = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "run-refinement-audit-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });

    for (const [relativePath, content] of files) {
      const directory = path.dirname(path.join(repoRoot, relativePath));
      await mkdir(directory, { recursive: true });
      await writeRepoFile(repoRoot, relativePath, content);
    }

    await execFileAsync("git", ["add", "--", ...files.map(([relativePath]) => relativePath)], { cwd: repoRoot });

    for (const [relativePath, mode] of chmodAfterTrack) {
      await chmod(path.join(repoRoot, relativePath), mode);
    }

    return repoRoot;
  } catch (error) {
    await rm(repoRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupRepo(repoRoot, resetModes = []) {
  for (const [relativePath, mode] of resetModes) {
    try {
      await chmod(path.join(repoRoot, relativePath), mode);
    } catch {}
  }
  await rm(repoRoot, { recursive: true, force: true });
}

test("parseRefinementAuditCliArgs rejects missing bounded scope args", () => {
  assert.throws(() => parseRefinementAuditCliArgs([]), /exactly one of --paths or --paths-file/i);
});

test("parseRefinementAuditCliArgs rejects both --paths and --paths-file", () => {
  assert.throws(
    () => parseRefinementAuditCliArgs(["--paths", "AGENTS.md", "--paths-file", "paths.txt"]),
    /exactly one of --paths or --paths-file/i,
  );
});

test("parseRefinementAuditCliArgs parses numeric thresholds and output path", () => {
  const options = parseRefinementAuditCliArgs([
    "--paths",
    "AGENTS.md,skills/local-implementation/SKILL.md",
    "--max-lines",
    "50",
    "--duplicate-window-lines",
    "5",
    "--branch-threshold",
    "6",
    "--thin-wrapper-max-lines",
    "7",
    "--output",
    "tmp/audit.json",
  ]);

  assert.equal(options.paths, "AGENTS.md,skills/local-implementation/SKILL.md");
  assert.equal(options.maxLines, 50);
  assert.equal(options.duplicateWindowLines, 5);
  assert.equal(options.branchThreshold, 6);
  assert.equal(options.thinWrapperMaxLines, 7);
  assert.equal(options.output, "tmp/audit.json");
});

test("parseRefinementAuditCliArgs rejects invalid threshold values", () => {
  assert.throws(
    () => parseRefinementAuditCliArgs(["--paths", "AGENTS.md", "--max-lines", "0"]),
    /--max-lines must be a positive integer/i,
  );
});

test("missing scope args fail closed", async () => {
  const result = await runAudit([]);
  assert.equal(result.code, 1);

  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /exactly one of --paths or --paths-file/i);
  assert.equal(parsed.hint, "run with --help for usage");
});

test("unreadable --paths-file input fails closed with usage", async () => {
  const missingFile = path.join(os.tmpdir(), `missing-audit-paths-${Date.now()}.txt`);
  const result = await runAudit(["--paths-file", missingFile]);

  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Unreadable --paths-file input/i);
  assert.equal(parsed.hint, "run with --help for usage");
});

test("untracked-only scope fails closed after expansion", async () => {
  const repoRoot = await initTrackedRepo([["tracked.md", "tracked\n"]]);

  try {
    await writeRepoFile(repoRoot, "untracked.md", "untracked\n");
    const result = await runAudit(["--root", repoRoot, "--paths", "untracked.md"]);

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Zero auditable files remain after expansion/i);
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("repo-root path is rejected to preserve bounded audit scope", async () => {
  const repoRoot = await initTrackedRepo([["tracked.md", "tracked\n"]]);

  try {
    const result = await runAudit(["--root", repoRoot, "--paths", "."]);
    assert.equal(result.code, 1);

    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Repo root is not a valid bounded audit path/i);
    assert.equal(parsed.hint, "run with --help for usage");
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("directory expansion uses tracked files only", async () => {
  const repoRoot = await initTrackedRepo([["scope/tracked.md", "bounded\nscope\n"]]);

  try {
    await writeRepoFile(repoRoot, "scope/untracked.md", "should not appear\n");
    const result = await runAudit(["--root", repoRoot, "--paths", "scope"]);

    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepEqual(parsed.paths, ["scope"]);
    assert.deepEqual(parsed.auditedFiles.map((entry) => entry.path), ["scope/tracked.md"]);
    assert.deepEqual(parsed.findings, []);
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("oversized-file finding is emitted", async () => {
  const repoRoot = await initTrackedRepo([["big.md", "1\n2\n3\n4\n5\n6\n"]]);

  try {
    const result = await runAudit(["--root", repoRoot, "--paths", "big.md", "--max-lines", "5"]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    const finding = parsed.findings.find((entry) => entry.id === "oversized_file");
    assert.ok(finding, "expected oversized_file finding");
    assert.equal(finding.path, "big.md");
    assert.equal(finding.priority, "high");
    assert.deepEqual(finding.evidence, { lineCount: 6, threshold: 5 });
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("duplicate-block candidate is emitted", async () => {
  const repoRoot = await initTrackedRepo([[
    "dup.md",
    [
      "alpha section line one",
      "beta section line two",
      "gamma section line three",
      "delta section line four",
      "",
      "alpha section line one",
      "beta section line two",
      "gamma section line three",
      "delta section line four",
      "",
    ].join("\n"),
  ]]);

  try {
    const result = await runAudit(["--root", repoRoot, "--paths", "dup.md"]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    const finding = parsed.findings.find((entry) => entry.id === "duplicate_block_candidate");
    assert.ok(finding, "expected duplicate_block_candidate finding");
    assert.equal(finding.path, "dup.md");
    assert.equal(finding.evidence.duplicateWindowLines, 4);
    assert.ok(finding.evidence.duplicateBlockMatches >= 2);
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("branching-hotspot finding is emitted", async () => {
  const repoRoot = await initTrackedRepo([[
    "branch.js",
    [
      "if (a) {}",
      "if (b) {} else {}",
      "switch (value) { case 'x': break; case 'y': break; }",
      "for (const item of items) {}",
      "while (flag) { break; }",
      "try {} catch (error) {} finally {}",
      "ready && set() || fallback();",
    ].join("\n"),
  ]]);

  try {
    const result = await runAudit(["--root", repoRoot, "--paths", "branch.js", "--branch-threshold", "8"]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    const finding = parsed.findings.find((entry) => entry.id === "branching_hotspot");
    assert.ok(finding, "expected branching_hotspot finding");
    assert.equal(finding.path, "branch.js");
    assert.ok(finding.evidence.branchTokenCount > 8);
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("thin-wrapper candidate is emitted without misclassifying generator syntax as a comment", async () => {
  const repoRoot = await initTrackedRepo([
    [
      "index.js",
      [
        "import { api } from './api.js';",
        "export { api };",
        "export { createThing } from './create-thing.js';",
        "export * from './shared.js';",
      ].join("\n"),
    ],
    [
      "generator.js",
      [
        "export const hooks = {",
        "  *values() {",
        "    yield 1;",
        "  },",
        "};",
      ].join("\n"),
    ],
  ]);

  try {
    const result = await runAudit([
      "--root",
      repoRoot,
      "--paths",
      "index.js,generator.js",
      "--thin-wrapper-max-lines",
      "10",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    const wrapperFinding = parsed.findings.find((entry) => entry.id === "thin_wrapper_candidate" && entry.path === "index.js");
    const generatorFinding = parsed.findings.find((entry) => entry.id === "thin_wrapper_candidate" && entry.path === "generator.js");
    assert.ok(wrapperFinding, "expected thin_wrapper_candidate finding for index.js");
    assert.equal(generatorFinding, undefined);
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("binary and unreadable files are skipped deterministically", async () => {
  const repoRoot = await initTrackedRepo(
    [
      ["scope/text.md", "safe text\n"],
      ["scope/binary.bin", Buffer.from([0, 1, 2, 3])],
      ["scope/secret.txt", "hidden\n"],
    ],
    { chmodAfterTrack: [["scope/secret.txt", 0o000]] },
  );

  try {
    const result = await runAudit(["--root", repoRoot, "--paths", "scope"]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    const binaryEntry = parsed.auditedFiles.find((entry) => entry.path === "scope/binary.bin");
    const unreadableEntry = parsed.auditedFiles.find((entry) => entry.path === "scope/secret.txt");
    const textEntry = parsed.auditedFiles.find((entry) => entry.path === "scope/text.md");

    assert.equal(binaryEntry.skipped, true);
    assert.equal(binaryEntry.skipReason, "binary_file");
    assert.equal(unreadableEntry.skipped, true);
    assert.equal(unreadableEntry.skipReason, "unreadable_file");
    assert.equal(textEntry.skipped, false);
  } finally {
    await cleanupRepo(repoRoot, [["scope/secret.txt", 0o644]]);
  }
});

test("--paths-file is supported", async () => {
  const repoRoot = await initTrackedRepo([
    ["a.md", "alpha\n"],
    ["b.md", "beta\n"],
  ]);

  try {
    const pathsFile = path.join(repoRoot, "paths.txt");
    await writeFile(pathsFile, "a.md\nb.md\n", "utf8");

    const result = await runAudit(["--root", repoRoot, "--paths-file", pathsFile]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    assert.deepEqual(parsed.paths, ["a.md", "b.md"]);
    assert.deepEqual(parsed.auditedFiles.map((entry) => entry.path), ["a.md", "b.md"]);
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("--output writes the same JSON returned on stdout", async () => {
  const repoRoot = await initTrackedRepo([["clean.md", "simple\ncontent\n"]]);

  try {
    const outputPath = path.join(repoRoot, "tmp", "audit.json");
    const result = await runAudit(["--root", repoRoot, "--paths", "clean.md", "--output", outputPath]);
    assert.equal(result.code, 0, result.stderr);

    const written = await readFile(outputPath, "utf8");
    assert.equal(written.trim(), result.stdout.trim());
  } finally {
    await cleanupRepo(repoRoot);
  }
});

test("clean bounded scopes return ok true with empty findings", async () => {
  const repoRoot = await initTrackedRepo([["clean.md", "brief\ntext\n"]]);

  try {
    const result = await runAudit([
      "--root",
      repoRoot,
      "--paths",
      "clean.md",
      "--max-lines",
      "50",
      "--branch-threshold",
      "50",
      "--thin-wrapper-max-lines",
      "1",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.findings, []);
    assert.deepEqual(parsed.highestValueFollowUpCandidates, []);
    assert.deepEqual(parsed.scopeBoundary, { mode: "bounded_paths_only", fullRepoScan: false });
  } finally {
    await cleanupRepo(repoRoot);
  }
});
