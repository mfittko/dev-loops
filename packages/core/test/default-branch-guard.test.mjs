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
//
// The fixture env is scrubbed, not inherited: an ambient GUARD_OVERRIDE_ENV
// (this suite's own documented release/reconcile escape hatch — an operator
// or a parent test runner may well have it exported) would make the override
// tests indistinguishable from a broken guard, and a host-global
// `core.hooksPath`/`commit.gpgsign=true` would break commits here for reasons
// that have nothing to do with the guard under test.
const BASE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
delete BASE_GIT_ENV[GUARD_OVERRIDE_ENV];

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...BASE_GIT_ENV, ...env },
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
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
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
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    const result = commitAttempt(dir, "release.txt", { [GUARD_OVERRIDE_ENV]: "1" });
    assert.equal(result.blocked, false, `expected the override to allow it: ${result.stderr}`);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The comparison is `= "1"`, deliberately not `-n` (non-empty): the design
// point is that DEVLOOPS_ALLOW_MAIN=0 must NOT silently disable the guard.
// Mutating the hook back to `[ -n "$VAR" ]` would keep every other test green
// while breaking exactly this.
test(`${GUARD_OVERRIDE_ENV}=0 (or any value other than "1") does NOT disable the guard`, async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    for (const value of ["0", "false", "true", " 1"]) {
      const result = commitAttempt(dir, `still-blocked-${value}.txt`, { [GUARD_OVERRIDE_ENV]: value });
      assert.equal(result.blocked, true, `${GUARD_OVERRIDE_ENV}=${JSON.stringify(value)} must still be refused`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${GUARD_OVERRIDE_ENV}=1 permits pushing to the default branch too — the release runbook's own prescribed command`, async () => {
  const { dir, gitDir, remote } = await repoFixture({ withRemote: true });
  try {
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    fs.writeFileSync(path.join(dir, "release-commit.txt"), "release\n");
    git(dir, ["add", "release-commit.txt"]);
    git(dir, ["commit", "--quiet", "-m", "release commit"], { [GUARD_OVERRIDE_ENV]: "1" });
    const localHead = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["push", "--quiet", "origin", "main"], { [GUARD_OVERRIDE_ENV]: "1" });
    assert.equal(git(remote, ["rev-parse", "refs/heads/main"]).trim(), localHead, "the override must let the push actually move the remote ref");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("a non-default branch commits freely — the loop's own path is untouched", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    git(dir, ["checkout", "--quiet", "-b", "issue-42"]);
    const result = commitAttempt(dir, "work.txt");
    assert.equal(result.blocked, false, `expected a branch commit to pass: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a linked worktree DOES run the hook — a commit on the default branch there is refused", async () => {
  const { dir, gitDir } = await repoFixture();
  const linked = path.join(dir, "..", `${path.basename(dir)}-linked`);
  try {
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    // A branch can only be checked out in one worktree at a time, so move the
    // primary off `main` first to free it for the linked worktree — that is
    // what actually exercises "the hook fires in a linked worktree", as
    // opposed to a passing commit on a non-default branch, which would pass
    // identically whether or not the hook ran at all.
    git(dir, ["checkout", "--quiet", "-b", "primary-holder"]);
    git(dir, ["worktree", "add", "--quiet", linked, "main"]);
    const result = commitAttempt(linked, "on-main-in-worktree.txt");
    assert.equal(result.blocked, true, `expected the default-branch commit from the linked worktree to be refused: ${result.stderr}`);
    assert.match(result.stderr, /refusing to commit on the default branch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});

test("a linked worktree on a non-default branch commits freely", async () => {
  const { dir, gitDir } = await repoFixture();
  const linked = path.join(dir, "..", `${path.basename(dir)}-linked`);
  try {
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    git(dir, ["worktree", "add", "--quiet", "-b", "issue-7", linked]);
    const result = commitAttempt(linked, "in-worktree.txt");
    assert.equal(result.blocked, false, `expected the worktree commit to pass: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});

// `git symbolic-ref --short` DISAMBIGUATES to "heads/main" when a tag also
// named "main" exists — comparing that short form against the bare branch
// name would then never match, letting the commit land while the install
// still reports success. Comparing the FULL ref is what pre-push already did.
test("a tag sharing the default branch's name does not defeat the commit guard", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    git(dir, ["tag", "main"]);
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    const result = commitAttempt(dir, "on-main-with-tag.txt");
    assert.equal(result.blocked, true, "a same-named tag must not defeat the guard");
    assert.match(result.stderr, /refusing to commit on the default branch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install is idempotent — a re-run refreshes its own hooks rather than duplicating them", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const first = installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    assert.deepEqual(first.installed, [...GUARDED_HOOKS]);
    assert.deepEqual(first.refreshed, []);

    const second = installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
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

    const result = installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
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
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
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

// renderGuardHook is the function that actually interpolates the branch name
// into shell, so it — not just its installDefaultBranchGuard caller — is the
// trust boundary: it must refuse on its own, since nothing stops a direct
// caller from skipping installDefaultBranchGuard's own pre-check.
test("renderGuardHook refuses to interpolate a branch name the shell would expand", () => {
  for (const hostile of ["main$(id)", "main$HOME", "release`echo x`", 'main";id;#']) {
    assert.throws(() => renderGuardHook("pre-commit", hostile), /shell would expand/);
    assert.throws(() => renderGuardHook("pre-push", hostile), /shell would expand/);
  }
  // Ordinary names still render.
  assert.doesNotThrow(() => renderGuardHook("pre-commit", "release/v1.0-rc"));
});

// hookName is the SIBLING interpolation renderGuardHook forgot: it lands in
// the generated script's own comment line unvalidated. A newline in it breaks
// out of the comment and executes; any other unknown name silently falls
// through to the pre-push body instead of being rejected.
test("renderGuardHook refuses an unknown or injected hook name", () => {
  for (const badName of ["pre-comit", "pre-commit\nid; echo PWNED", ""]) {
    assert.throws(() => renderGuardHook(badName, "main"), /unknown hook/);
  }
  assert.doesNotThrow(() => renderGuardHook("pre-commit", "main"));
  assert.doesNotThrow(() => renderGuardHook("pre-push", "main"));
});

// Two guarded branches (the repo's real default AND an explicit --base) is
// the actual shape ensure-worktree now bakes in — a stray commit on EITHER
// must be refused, and a commit on neither must pass.
test("a hook guards MULTIPLE branches when given an array", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    git(dir, ["branch", "develop"]);
    installDefaultBranchGuard({ gitDir, defaultBranches: ["main", "develop"] });

    assert.equal(commitAttempt(dir, "on-main.txt").blocked, true, "the first guarded branch must be refused");

    git(dir, ["checkout", "--quiet", "develop"]);
    assert.equal(commitAttempt(dir, "on-develop.txt").blocked, true, "the second guarded branch must be refused");

    git(dir, ["checkout", "--quiet", "-b", "issue-1"]);
    assert.equal(commitAttempt(dir, "on-branch.txt").blocked, false, "a branch that is neither guarded name must pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The finding that mattered most: checking the CURRENT branch let every
// explicit refspec through, and a probe confirmed `push origin HEAD:main` from
// a feature branch actually moved the remote default.
test("blocks a push to the default branch via an explicit refspec from another branch", async () => {
  const { dir, gitDir, remote } = await repoFixture({ withRemote: true });
  try {
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
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
    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
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
    const result = installDefaultBranchGuard({ gitDir, defaultBranches: "main", hooksPathOverride: ".husky" });
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

    installDefaultBranchGuard({ gitDir, defaultBranches: "main" });
    assert.equal(
      commitAttempt(dir, "on-trunk.txt").blocked,
      false,
      "a guard baked with the wrong branch cannot protect the real default — hence the ref-existence check before install",
    );

    // Baked with the branch that IS the default, the same repo is protected.
    installDefaultBranchGuard({ gitDir, defaultBranches: "trunk" });
    assert.equal(commitAttempt(dir, "on-trunk-2.txt").blocked, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unresolvable default branch installs INERT hooks rather than guessing which branch to protect", async () => {
  const { dir, gitDir } = await repoFixture();
  try {
    const result = installDefaultBranchGuard({ gitDir, defaultBranches: null });
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
      const res = installDefaultBranchGuard({ gitDir, defaultBranches: hostile });
      assert.equal(res.ok, false, `${hostile} must be refused`);
      assert.match(res.reason, /shell would expand/);
      assert.equal(fs.existsSync(path.join(gitDir, "hooks", "pre-commit")), false);
    }
    // Ordinary names with slashes, dots and dashes still install.
    assert.equal(installDefaultBranchGuard({ gitDir, defaultBranches: "release/v1.0-rc" }).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install: refuses a relative or empty gitDir instead of writing hooks/ into the cwd", () => {
  for (const bad of ["", "hooks/..", ".git", undefined, null, 42]) {
    const res = installDefaultBranchGuard({ gitDir: bad, defaultBranches: "main" });
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.match(res.reason, /absolute path/);
  }
});

// Absolute is necessary but not sufficient: an absolute path to something
// that is NOT a git directory (the easy caller slip — the worktree root
// instead of its .git) must not pass. Left unguarded, this would mkdirSync a
// stray hooks/ tree at that path and still report ok:true.
test("install: refuses an absolute gitDir that is not actually a git directory", async () => {
  const notARepo = await mkdtemp(path.join(tmpdir(), "default-branch-guard-not-a-repo-"));
  try {
    const res = installDefaultBranchGuard({ gitDir: notARepo, defaultBranches: "main" });
    assert.equal(res.ok, false);
    assert.match(res.reason, /does not look like a git directory/);
    assert.equal(fs.existsSync(path.join(notARepo, "hooks")), false, "must not write a stray hooks/ tree");
  } finally {
    await rm(notARepo, { recursive: true, force: true });
  }
});
