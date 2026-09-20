import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { captureChangedFilesBetween, captureMainRelativeChangedFilesSince } from "../../scripts/lib/git-delta.mjs";

// Scrub inherited git config / leaked repo pointers so host-side signing, hooks,
// or an exported GIT_DIR cannot steer these fixtures (same convention as the
// other CLI git-fixture tests).
const GIT_FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_FIXTURE_ENV });
}

async function write(root, rel, content) {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

// Build a repo that mimics a base-move re-gate. main and the PR branch touch
// DIFFERENT files, so the base-move merge is a clean integrate-only advance:
//   fork:      foo.mjs=v1, other.mjs=v1, docs/guide.md
//   prevHead:  PR edits docs/guide.md only (reviewed there); foo/other stay v1
//   main:      another PR merges other.mjs=v2 (already-merged main commit)
//   base-move: PR branch merges origin/main → head has other.mjs=v2 (== main)
// So the ONLY file changed since prevHead is other.mjs, which is already on main
// at head → the main-relative delta is empty (integrate-only).
// `prExtra` mutates the branch AFTER the merge to add a genuine PR-own change.
async function makeBaseMoveRepo({ prExtra } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-delta-basemove-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  // Fork point on main.
  await write(root, "src/foo.mjs", "export const foo = 1;\n");
  await write(root, "src/other.mjs", "export const other = 1;\n");
  await write(root, "docs/guide.md", "# Guide\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fork"]);
  const fork = git(root, ["rev-parse", "HEAD"]).trim();

  // PR branch reviewed at prevHead: touches docs/guide.md only.
  git(root, ["checkout", "-q", "-b", "pr", fork]);
  await write(root, "docs/guide.md", "# Guide\n\nPR edit.\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "PR round 1 (reviewed)"]);
  const prevHead = git(root, ["rev-parse", "HEAD"]).trim().toLowerCase();

  // main advances: another PR merged other.mjs=v2 (a file the PR never touched).
  git(root, ["checkout", "-q", "main"]);
  await write(root, "src/other.mjs", "export const other = 2;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "other PR merged to main"]);
  // Simulate the remote-tracking ref the resolver excludes against.
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  // Base-move: PR branch merges origin/main. Clean (disjoint files), auto-commit.
  git(root, ["checkout", "-q", "pr"]);
  git(root, ["merge", "-q", "--no-edit", "origin/main"]);

  if (prExtra) await prExtra(root);
  const headSha = git(root, ["rev-parse", "HEAD"]).trim().toLowerCase();
  return { root, prevHead, headSha };
}

test("integrate-only base-move: main-relative delta drops already-merged main files (empty, reduced)", async () => {
  const { root, prevHead } = await makeBaseMoveRepo();
  try {
    // Raw two-dot delta wrongly includes other.mjs (a merged-main file) → would
    // force code angles to re-run and deadlock.
    const twoDot = await captureChangedFilesBetween({ base: prevHead, repoRoot: root });
    assert.ok(twoDot.changedFiles.includes("src/other.mjs"), "two-dot delta includes the merged-main file (the bug)");

    // Main-relative delta excludes it: other.mjs's HEAD blob == origin/main's.
    const mainRel = await captureMainRelativeChangedFilesSince({ base: prevHead, mainRef: "origin/main", repoRoot: root });
    assert.equal(mainRel.reduced, true, "origin/main resolved → reduction ran");
    assert.deepEqual(mainRel.changedFiles, [], "integrate-only base-move contributes no PR-own surface");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("genuine PR-own commit after the base-move still appears in the main-relative delta (fail closed)", async () => {
  const { root, prevHead } = await makeBaseMoveRepo({
    prExtra: async (r) => {
      await write(r, "src/bar.mjs", "export const bar = 1;\n");
      git(r, ["add", "-A"]);
      git(r, ["commit", "-q", "-m", "PR-own new code"]);
    },
  });
  try {
    const mainRel = await captureMainRelativeChangedFilesSince({ base: prevHead, mainRef: "origin/main", repoRoot: root });
    assert.equal(mainRel.reduced, true);
    assert.ok(mainRel.changedFiles.includes("src/bar.mjs"), "a real PR-own change is kept → its angle re-runs");
    assert.ok(!mainRel.changedFiles.includes("src/other.mjs"), "the merged-main file stays excluded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delta stays INCREMENTAL, not absolute: a file the PR touched BEFORE prevHead is not re-surfaced", async () => {
  // AC#4: the delta must be incremental (since prevHead), not the absolute PR
  // diff. docs/guide.md was edited in PR round 1 (at prevHead) and never again;
  // the absolute origin/main...HEAD diff would still show it, but the
  // incremental main-relative delta must not.
  const { root, prevHead } = await makeBaseMoveRepo();
  try {
    const mainRel = await captureMainRelativeChangedFilesSince({ base: prevHead, mainRef: "origin/main", repoRoot: root });
    assert.ok(!mainRel.changedFiles.includes("docs/guide.md"), "a file untouched SINCE prevHead is not re-surfaced (proves incremental, not absolute)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to the plain two-dot delta when origin/main does not resolve (reduced: false)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-delta-nomain-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await write(root, "src/foo.mjs", "export const foo = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);
    const prevHead = git(root, ["rev-parse", "HEAD"]).trim().toLowerCase();
    await write(root, "src/foo.mjs", "export const foo = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "delta"]);

    const mainRel = await captureMainRelativeChangedFilesSince({ base: prevHead, mainRef: "origin/main", repoRoot: root });
    assert.equal(mainRel.reduced, false, "no origin/main → cannot reduce");
    assert.deepEqual(mainRel.changedFiles, ["src/foo.mjs"], "falls back to the raw two-dot incremental delta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
