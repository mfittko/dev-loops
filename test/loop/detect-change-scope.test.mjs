import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { detectScope } from "../../scripts/loop/detect-change-scope.mjs";

// GATE-EXEC-PROPORTIONALITY: detectScope feeds the primer's light-mode size
// cap (resolve-gate-dispatch.mjs) and MUST diff the `cwd` repo regardless of
// an ambient GIT_DIR/GIT_WORK_TREE — a poisoned env pointing at a DIFFERENT
// (possibly clean) repo must never silently under-report scope, which would
// fail-OPEN the non-overridable size cap.

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-scope-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("detectScope reports the base..head diff scope for the head", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const result = detectScope({ base, head, cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(result.filesChanged, 1);
    assert.equal(result.linesChanged, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectScope ignores an ambient GIT_DIR/GIT_WORK_TREE pointing at a DIFFERENT repo", async () => {
  const realRepo = await makeRepo();
  const poisonRepo = await makeRepo();
  const savedGitDir = process.env.GIT_DIR;
  const savedGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    // Poison repo: a clean, empty history — if the env override leaked
    // through, the diff would resolve HERE and report zero changed files,
    // fail-OPENing the size cap this scope feeds.
    await writeFile(path.join(poisonRepo, "clean.txt"), "clean\n", "utf8");
    git(poisonRepo, "add", "-A");
    git(poisonRepo, "commit", "-qm", "poison base");

    // Real repo: the actual diff we want measured, well over any light-mode cap.
    await writeFile(path.join(realRepo, "a.txt"), "one\n", "utf8");
    git(realRepo, "add", "-A");
    git(realRepo, "commit", "-qm", "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: realRepo, encoding: "utf8" }).trim();
    for (let i = 0; i < 5; i += 1) {
      await writeFile(path.join(realRepo, `risky-${i}.txt`), "two\nthree\n", "utf8");
    }
    git(realRepo, "add", "-A");
    git(realRepo, "commit", "-qm", "head");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: realRepo, encoding: "utf8" }).trim();

    process.env.GIT_DIR = path.join(poisonRepo, ".git");
    process.env.GIT_WORK_TREE = poisonRepo;
    const result = detectScope({ base, head, cwd: realRepo });
    assert.equal(result.ok, true);
    assert.equal(result.filesChanged, 5, "must measure the real repo's diff, not the poisoned/clean one");
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
    if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedGitWorkTree;
    await rm(realRepo, { recursive: true, force: true });
    await rm(poisonRepo, { recursive: true, force: true });
  }
});
