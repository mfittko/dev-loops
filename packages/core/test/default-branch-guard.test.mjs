import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GUARDED_HOOKS,
  GUARD_MARKER,
  GUARD_OVERRIDE_ENV,
  installDefaultBranchGuard,
  renderGuardHook,
} from "../src/loop/default-branch-guard.mjs";

// The hooks are shell, and the whole point is that they fire inside real git —
// asserting on their text would pass while the guard silently never ran. So
// these drive an actual repository and let git invoke them.
function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function repoFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "default-branch-guard-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@example.test"]);
  git(dir, ["config", "user.name", "Guard Test"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "seed.txt"]);
  // --no-verify: seed the history BEFORE the guard exists, so later commits are
  // the thing under test rather than this one.
  git(dir, ["commit", "--quiet", "--no-verify", "-m", "seed"]);
  const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();
  return { dir, gitDir };
}

function commitAttempt(dir, file, env = {}) {
  fs.writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, ["add", file]);
  try {
    git(dir, ["commit", "--quiet", "-m", `add ${file}`], env);
    return { blocked: false, stderr: "" };
  } catch (err) {
    return { blocked: true, stderr: String(err.stderr ?? "") };
  }
}

test("blocks a commit on the default branch in the primary checkout", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installDefaultBranchGuard({ gitDir });
    const result = commitAttempt(dir, "on-main.txt");
    assert.equal(result.blocked, true, "expected the commit to be refused");
    assert.match(result.stderr, /refusing pre-commit on the default branch/);
    assert.match(result.stderr, new RegExp(GUARD_OVERRIDE_ENV));
    // The refusal must be the ONLY effect: nothing may have been recorded.
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${GUARD_OVERRIDE_ENV}=1 permits the same commit — the sanctioned release path`, async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installDefaultBranchGuard({ gitDir });
    const result = commitAttempt(dir, "release.txt", { [GUARD_OVERRIDE_ENV]: "1" });
    assert.equal(result.blocked, false, `expected the override to allow it: ${result.stderr}`);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-default branch commits freely — the loop's own path is untouched", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installDefaultBranchGuard({ gitDir });
    git(dir, ["checkout", "--quiet", "-b", "issue-42"]);
    const result = commitAttempt(dir, "work.txt");
    assert.equal(result.blocked, false, `expected a branch commit to pass: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a linked worktree is unaffected even on a branch named like the default elsewhere", async () => {
  const { dir, gitDir } = await repoFixture();
  const linked = path.join(dir, "..", `${path.basename(dir)}-linked`);
  try {
    installDefaultBranchGuard({ gitDir });
    git(dir, ["worktree", "add", "--quiet", "-b", "issue-7", linked]);
    const result = commitAttempt(linked, "in-worktree.txt");
    assert.equal(result.blocked, false, `expected the worktree commit to pass: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});

test("install is idempotent — a re-run refreshes its own hooks rather than duplicating them", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const first = installDefaultBranchGuard({ gitDir });
    assert.deepEqual(first.installed, [...GUARDED_HOOKS]);
    assert.deepEqual(first.refreshed, []);

    const second = installDefaultBranchGuard({ gitDir });
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.refreshed, [...GUARDED_HOOKS]);

    for (const hook of GUARDED_HOOKS) {
      const contents = fs.readFileSync(path.join(gitDir, "hooks", hook), "utf8");
      assert.equal(contents.split(GUARD_MARKER).length - 1, 1, `${hook} must carry the marker exactly once`);
    }
    // Still enforcing after the second install.
    assert.equal(commitAttempt(dir, "after-reinstall.txt").blocked, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-existing foreign hook is preserved, never silently clobbered", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const hooksDir = path.join(gitDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const foreign = "#!/bin/sh\n# someone else's hook\nexit 0\n";
    fs.writeFileSync(path.join(hooksDir, "pre-commit"), foreign, { mode: 0o755 });

    const result = installDefaultBranchGuard({ gitDir });
    assert.deepEqual(result.installed, ["pre-push"], "the free hook slot should still be taken");
    assert.deepEqual(result.skipped.map((entry) => entry.hook), ["pre-commit"]);
    assert.equal(fs.readFileSync(path.join(hooksDir, "pre-commit"), "utf8"), foreign);
    // And the un-clobbered slot means main is NOT guarded for commits — the
    // report is the only warning an operator gets, so it must be honest.
    assert.equal(commitAttempt(dir, "unguarded.txt").blocked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hook is executable, or git would ignore it entirely", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installDefaultBranchGuard({ gitDir });
    for (const hook of GUARDED_HOOKS) {
      const mode = fs.statSync(path.join(gitDir, "hooks", hook)).mode;
      assert.ok(mode & 0o111, `${hook} must be executable`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderGuardHook names the hook it guards, so its refusal message is not generic", () => {
  for (const hook of GUARDED_HOOKS) {
    const body = renderGuardHook(hook);
    assert.match(body, new RegExp(`refusing ${hook} on the default branch`));
    assert.ok(body.startsWith("#!/bin/sh"), "must be a runnable shell script");
  }
});
