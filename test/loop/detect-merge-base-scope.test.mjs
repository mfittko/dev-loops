import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectMergeBaseScope } from "../../scripts/loop/detect-change-scope.mjs";

// #1174: the merge-base scope re-derivation used to accept a light inline verdict
// at merge time. It MUST fail CLOSED — any missing input or git failure yields
// { ok: false } so the caller rejects rather than treating it as under-threshold.

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-mbscope-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("detectMergeBaseScope fails closed without base or head", () => {
  assert.equal(detectMergeBaseScope({ base: null, head: "HEAD" }).ok, false);
  assert.equal(detectMergeBaseScope({ base: "HEAD", head: null }).ok, false);
  assert.equal(detectMergeBaseScope({}).ok, false);
});

test("detectMergeBaseScope fails closed on an unresolvable ref (git error)", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const result = detectMergeBaseScope({ base: "HEAD", head: "does-not-exist", cwd: dir });
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectMergeBaseScope reports the merge-base diff scope for the head", async () => {
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
    const result = detectMergeBaseScope({ base, head, cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(result.filesChanged, 1);
    assert.equal(result.linesChanged, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
