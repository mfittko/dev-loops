import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runNode } from "../_helpers.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/loop/run-refinement-audit.mjs");
const runAudit = (args = [], options = {}) => runNode(scriptPath, args, options);

async function writeRepoFile(repoRoot, relativePath, content) {
  const filePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function initRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "refinement-audit-chain-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  return repoRoot;
}

test("refinement audit emits the deterministic handoff fields and key order expected by the refiner chain", async () => {
  const repoRoot = await initRepo();

  try {
    await writeRepoFile(
      repoRoot,
      "scope/dup.md",
      [
        "one alpha line",
        "two beta line",
        "three gamma line",
        "four delta line",
        "",
        "one alpha line",
        "two beta line",
        "three gamma line",
        "four delta line",
      ].join("\n"),
    );
    await execFileAsync("git", ["add", "--", "scope/dup.md"], { cwd: repoRoot });

    const result = await runAudit(["--root", repoRoot, "--paths", "scope"]);
    assert.equal(result.code, 0, result.stderr);

    const parsed = JSON.parse(result.stdout.trim());
    assert.deepEqual(Object.keys(parsed), [
      "ok",
      "repoRoot",
      "paths",
      "auditedFiles",
      "findings",
      "highestValueFollowUpCandidates",
      "scopeBoundary",
    ]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.paths, ["scope"]);
    assert.ok(Array.isArray(parsed.findings));
    assert.ok(Array.isArray(parsed.highestValueFollowUpCandidates));
    assert.deepEqual(parsed.scopeBoundary, { mode: "bounded_paths_only", fullRepoScan: false });
    assert.ok(parsed.findings.some((entry) => entry.id === "duplicate_block_candidate"));
    assert.ok(parsed.highestValueFollowUpCandidates.some((entry) => entry.path === "scope/dup.md"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
