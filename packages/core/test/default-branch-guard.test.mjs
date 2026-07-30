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

async function repoFixture({ withRemote = false } = {}) {
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
  let remote = null;
  if (withRemote) {
    remote = await mkdtemp(path.join(tmpdir(), "default-branch-guard-remote-"));
    git(remote, ["init", "--quiet", "--bare", "--initial-branch=main"]);
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["push", "--quiet", "--no-verify", "origin", "main"]);
  }
  return { dir, gitDir, remote };
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
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    const result = commitAttempt(dir, "on-main.txt");
    assert.equal(result.blocked, true, "expected the commit to be refused");
    assert.match(result.stderr, /refusing to commit on the default branch/);
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
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
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
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    git(dir, ["checkout", "--quiet", "-b", "issue-42"]);
    const result = commitAttempt(dir, "work.txt");
    assert.equal(result.blocked, false, `expected a branch commit to pass: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a linked worktree DOES run the hook — its non-default branch is what lets the commit through", async () => {
  const { dir, gitDir } = await repoFixture();
  const linked = path.join(dir, "..", `${path.basename(dir)}-linked`);
  try {
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
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
    const first = installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    assert.deepEqual(first.installed, [...GUARDED_HOOKS]);
    assert.deepEqual(first.refreshed, []);

    const second = installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
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

    const result = installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
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
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    for (const hook of GUARDED_HOOKS) {
      const mode = fs.statSync(path.join(gitDir, "hooks", hook)).mode;
      assert.ok(mode & 0o111, `${hook} must be executable`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderGuardHook emits a runnable script that names what it refused", () => {
  assert.match(renderGuardHook("pre-commit", "main"), /refusing to commit on the default branch/);
  assert.match(renderGuardHook("pre-push", "main"), /refusing to push to the default branch/);
  for (const hook of GUARDED_HOOKS) {
    assert.ok(renderGuardHook(hook, "main").startsWith("#!/bin/sh"), "must be a runnable shell script");
  }
});

// The finding that mattered most: checking the CURRENT branch let every
// explicit refspec through, and a probe confirmed `push origin HEAD:main` from
// a feature branch actually moved the remote default.
test("blocks a push to the default branch via an explicit refspec from another branch", async () => {
  const { dir, gitDir, remote } = await repoFixture({ withRemote: true });
  try {
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    git(dir, ["checkout", "--quiet", "-b", "issue-9"]);
    fs.writeFileSync(path.join(dir, "sneaky.txt"), "sneaky\n");
    git(dir, ["add", "sneaky.txt"]);
    git(dir, ["commit", "--quiet", "-m", "work on a branch"]);

    const before = git(remote, ["rev-parse", "refs/heads/main"]).trim();
    let blocked = false;
    try {
      git(dir, ["push", "--quiet", "origin", "HEAD:main"]);
    } catch {
      blocked = true;
    }
    assert.equal(blocked, true, "expected HEAD:main to be refused");
    assert.equal(git(remote, ["rev-parse", "refs/heads/main"]).trim(), before, "remote default must not have moved");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("allows a push to a non-default remote ref", async () => {
  const { dir, gitDir, remote } = await repoFixture({ withRemote: true });
  try {
    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    git(dir, ["checkout", "--quiet", "-b", "issue-9"]);
    fs.writeFileSync(path.join(dir, "work.txt"), "work\n");
    git(dir, ["add", "work.txt"]);
    git(dir, ["commit", "--quiet", "-m", "work"]);
    git(dir, ["push", "--quiet", "origin", "issue-9"]);
    assert.ok(git(remote, ["rev-parse", "refs/heads/issue-9"]).trim());
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("refuses to install when core.hooksPath points elsewhere — a guard that cannot fire must not report success", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const result = installDefaultBranchGuard({ gitDir, defaultBranch: "main", hooksPathOverride: ".husky" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.installed, []);
    assert.match(result.reason, /core\.hooksPath/);
    assert.equal(fs.existsSync(path.join(gitDir, "hooks", "pre-commit")), false, "must not write a hook git will never run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Why ensure-worktree verifies the name resolves to a real ref before baking it
// in: resolveBaseBranch falls back to the literal "main", and a hook guarding a
// branch that does not exist protects nothing while reporting success.
test("a hook baked with a branch that does not exist leaves the real default unguarded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "default-branch-guard-trunk-"));
  try {
    git(dir, ["init", "--quiet", "--initial-branch=trunk"]);
    git(dir, ["config", "user.email", "t@example.test"]);
    git(dir, ["config", "user.name", "Guard Test"]);
    fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
    git(dir, ["add", "seed.txt"]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", "seed"]);
    const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();

    installDefaultBranchGuard({ gitDir, defaultBranch: "main" });
    assert.equal(
      commitAttempt(dir, "on-trunk.txt").blocked,
      false,
      "a guard baked with the wrong branch cannot protect the real default — hence the ref-existence check before install",
    );

    // Baked with the branch that IS the default, the same repo is protected.
    installDefaultBranchGuard({ gitDir, defaultBranch: "trunk" });
    assert.equal(commitAttempt(dir, "on-trunk-2.txt").blocked, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unresolvable default branch installs INERT hooks rather than guessing which branch to protect", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const result = installDefaultBranchGuard({ gitDir, defaultBranch: null });
    assert.equal(result.ok, true);
    assert.match(result.reason, /could not be resolved/);
    // Inert, not wrong: guessing `main` in a `master` repo would guard the
    // wrong branch and leave the real default open.
    assert.equal(commitAttempt(dir, "unresolved.txt").blocked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install: refuses a default branch the generated shell would expand", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    // Git accepts every one of these as a ref name, and sh expands each inside
    // the double-quoted assignment — so the hook would either execute the
    // payload or compare against a name that never matches the real default.
    for (const hostile of ["main$(id)", "main$HOME", "release`echo x`", 'main";id;#']) {
      const res = installDefaultBranchGuard({ gitDir, defaultBranch: hostile });
      assert.equal(res.ok, false, `${hostile} must be refused`);
      assert.match(res.reason, /shell would expand/);
      assert.equal(fs.existsSync(path.join(gitDir, "hooks", "pre-commit")), false);
    }
    // Ordinary names with slashes, dots and dashes still install.
    assert.equal(installDefaultBranchGuard({ gitDir, defaultBranch: "release/v1.0-rc" }).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install: refuses a relative or empty gitDir instead of writing hooks/ into the cwd", () => {
  for (const bad of ["", "hooks/..", ".git", undefined, null, 42]) {
    const res = installDefaultBranchGuard({ gitDir: bad, defaultBranch: "main" });
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.match(res.reason, /absolute path/);
  }
});
