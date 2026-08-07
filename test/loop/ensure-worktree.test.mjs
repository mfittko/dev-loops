import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ensureWorktree,
  parseEnsureWorktreeCliArgs,
} from "../../scripts/loop/ensure-worktree.mjs";

// Scrubbed at the PROCESS level, not just the test's own git() helper: the
// module under test (ensureWorktree's installGuard) spawns its own git
// subprocesses with no env override, inheriting process.env — so a
// host-global core.hooksPath/commit.gpgsign=true reaches the SUBJECT, not
// just this file's assertions, and flips guard installation itself.
const PRIOR_GIT_CONFIG = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
// Restore after this file's tests: node:test runs files in their own process,
// but restoring keeps the mutation contained if that ever changes.
after(() => {
  for (const [key, value] of Object.entries(PRIOR_GIT_CONFIG)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Scrubbed, not inherited: an ambient DEVLOOPS_ALLOW_MAIN (the guard's own
// documented release/reconcile override) would make the guard-refusal
// assertions below pass for the wrong reason.
const REPO_GIT_ENV = { ...process.env };
delete REPO_GIT_ENV.DEVLOOPS_ALLOW_MAIN;

// A real (tiny) git repo with one commit on `main`, so `git worktree add` works.
function makeRepo({ devloops, branch = "main" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wt-ensure-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: REPO_GIT_ENV });
  git("init", "-q", "-b", branch);
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  if (devloops) writeFileSync(path.join(root, ".devloops"), devloops);
  else writeFileSync(path.join(root, "README"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // A self-referential "origin" so `git fetch origin` succeeds offline.
  git("remote", "add", "origin", root);
  git("fetch", "-q", "origin");
  // Explicit set-head: on git < 2.49 a plain fetch does not create
  // refs/remotes/origin/HEAD, and the guard resolves the default from it.
  git("remote", "set-head", "origin", "--auto");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A real, SEPARATE origin repo + a clone of it — unlike makeRepo()'s
// self-referential single-repo trick. Needed whenever a test must keep a
// remote branch's ref (or a divergent state) independent of the local repo's
// own history: ensureWorktree's own internal `git fetch --prune` resyncs
// refs/remotes/origin/* from wherever "origin" physically is, and a
// self-referential origin IS the same repo — deleting a local branch there
// deletes it from "origin" too, and re-fetching resyncs (or prunes) any
// remote-only or diverged state a test set up instead of preserving it.
function makeOriginRepo() {
  const tmp = mkdtempSync(path.join(tmpdir(), "wt-ensure-clone-"));
  const originDir = path.join(tmp, "origin");
  const originGit = (...args) => execFileSync("git", args, { cwd: originDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: REPO_GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", originDir], { encoding: "utf8", env: REPO_GIT_ENV });
  originGit("config", "user.email", "t@t.t");
  originGit("config", "user.name", "t");
  originGit("commit", "-q", "--allow-empty", "-m", "init");
  return { tmp, originDir, originGit, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// Clone `originDir` into `<tmp>/<name>`; a plain clone fetches every branch
// into refs/remotes/origin/* but checks out only the default branch locally —
// exactly the shape "a remote branch exists, no local branch does" needs.
function cloneRepo(tmp, originDir, name = "root") {
  const root = path.join(tmp, name);
  execFileSync("git", ["clone", "-q", originDir, root], { encoding: "utf8", env: REPO_GIT_ENV });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: REPO_GIT_ENV });
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  return { root, git };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseEnsureWorktreeCliArgs: requires a selector", () => {
  assert.throws(() => parseEnsureWorktreeCliArgs(["--repo-root", "/r"]), /issue|pr/);
});

test("parseEnsureWorktreeCliArgs: rejects both selectors", () => {
  assert.throws(
    () => parseEnsureWorktreeCliArgs(["--repo-root", "/r", "--issue", "1", "--pr", "2"]),
    /exactly one/,
  );
});

test("parseEnsureWorktreeCliArgs: leaves base undefined when --base is omitted (ensureWorktree auto-detects it)", () => {
  const o = parseEnsureWorktreeCliArgs(["--repo-root", "/r", "--issue", "909"]);
  assert.equal(o.base, undefined);
  assert.equal(o.issue, 909);
});

test("parseEnsureWorktreeCliArgs: an explicit --base always wins", () => {
  const o = parseEnsureWorktreeCliArgs(["--repo-root", "/r", "--issue", "909", "--base", "origin/develop"]);
  assert.equal(o.base, "origin/develop");
});

// ---------------------------------------------------------------------------
// Create at the canonical namespaced path + provisioning invoked
// ---------------------------------------------------------------------------

test("ensure: creates at the canonical namespaced path and provisions", async () => {
  const repo = makeRepo({ devloops: "version: 1\nworktree:\n  entries:\n    - path: secret.env\n      mode: copy\n" });
  try {
    // secret.env is GITIGNORED (untracked) — only provisioning can bring it into
    // the fresh worktree, so a non-zero copied count proves provision ran.
    writeFileSync(path.join(repo.root, ".gitignore"), "secret.env\n");
    writeFileSync(path.join(repo.root, "secret.env"), "hi");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "ignore");
    repo.git("fetch", "-q", "origin");

    const res = await ensureWorktree({ repoRoot: repo.root, issue: 909, base: "origin/main" });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.reused, false);
    assert.equal(res.path, path.join(repo.root, "tmp/worktrees/dev-loops/issue-909"));
    assert.ok(existsSync(res.path), "worktree dir exists");
    // provision summary present; copyOnInit brought the gitignored file in.
    assert.ok(res.provision && typeof res.provision.summary === "object");
    assert.equal(res.provision.summary.copied, 1);
    assert.equal(readFileSync(path.join(res.path, "secret.env"), "utf8"), "hi");
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Base branch resolution (#1368): unset --base auto-detects the repo's real
// default branch instead of a hardcoded "origin/main"; an explicit --base
// (as the resolver/skill injects for a configured workflow.baseBranch) wins.
// ---------------------------------------------------------------------------

test("ensure: no --base auto-detects the repo's real default branch (unset-config no-regression)", async () => {
  const repo = makeRepo();
  try {
    // makeRepo() creates the repo on "main" — auto-detect must land on
    // "origin/main", the same value the old hardcoded default always used.
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1368 });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    // Regression-catch the missing origin/ prefix: the auto-detected default must
    // be the origin/-prefixed ref, not a bare local "main". (A self-referential
    // origin re-syncs origin/main to local main on every fetch, so a SHA compare
    // can't distinguish them — assert the resolved base ref directly.)
    assert.equal(res.base, "origin/main", "auto-detected default base must be origin/-prefixed");
  } finally {
    repo.cleanup();
  }
});

test("ensure: an explicit --base (a configured workflow.baseBranch) wins over auto-detect", async () => {
  const repo = makeRepo();
  try {
    // A second branch simulating a configured integration branch, distinct
    // from the repo's actual default ("main") that auto-detect would pick.
    // Re-fetch so origin/spike/... exists, mirroring the real `origin/<baseBranch>`
    // ref the resolver injects via an explicit --base.
    repo.git("branch", "spike/shakapacker-to-vite");
    repo.git("fetch", "-q", "origin");
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1369, base: "origin/spike/shakapacker-to-vite" });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    // Confirm the worktree was actually created off the explicit base, not
    // the auto-detected default.
    const log = repo.git("-C", res.path, "log", "-1", "--format=%H");
    const baseLog = repo.git("log", "-1", "--format=%H", "spike/shakapacker-to-vite");
    assert.equal(log, baseLog);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Reuse is idempotent
// ---------------------------------------------------------------------------

test("ensure: reuse is idempotent (second call reuses, no error)", async () => {
  const repo = makeRepo();
  try {
    const first = await ensureWorktree({ repoRoot: repo.root, issue: 5 });
    assert.equal(first.created, true);
    const second = await ensureWorktree({ repoRoot: repo.root, issue: 5 });
    assert.equal(second.created, false);
    assert.equal(second.reused, true);
    assert.equal(second.path, first.path);
    // `guard` is documented as always present on BOTH the create and reuse
    // paths — deleting installGuard's call on the reuse branch would leave
    // this whole suite green while breaking that contract.
    assert.equal(second.guard.ok, true);
    assert.deepEqual(second.guard.refreshed, ["pre-commit", "pre-merge-commit", "pre-push"]);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Branch conflict at the canonical path is a hard error (no clobber)
// ---------------------------------------------------------------------------

test("ensure: reports a conflict when a different branch occupies the path", async () => {
  const repo = makeRepo();
  try {
    const target = path.join(repo.root, "tmp/worktrees/dev-loops/issue-7");
    // Occupy the canonical path with an unrelated branch.
    repo.git("worktree", "add", "-b", "someone-else", target, "main");
    await assert.rejects(
      ensureWorktree({ repoRoot: repo.root, issue: 7 }),
      /conflict.*someone-else/,
    );
    // The occupying worktree must remain untouched.
    assert.ok(existsSync(target));
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Branch already exists (worktree removed but ref left behind) → reuse the branch
// ---------------------------------------------------------------------------

test("ensure: reuses an existing branch when no worktree occupies it", async () => {
  const repo = makeRepo();
  try {
    // Leave a branch behind without a worktree (the common removed-worktree case):
    // create it, add+remove a worktree so the branch ref survives.
    const stale = path.join(repo.root, "tmp/worktrees/dev-loops/issue-11");
    repo.git("worktree", "add", "-b", "issue-11", stale, "main");
    repo.git("worktree", "remove", "--force", stale);
    repo.git("worktree", "prune");
    assert.ok(!existsSync(stale), "worktree dir gone");
    // Branch ref still exists.
    assert.match(repo.git("rev-parse", "--verify", "--quiet", "refs/heads/issue-11"), /\w/);

    // ensure must attach to the existing branch (no -b), not fail.
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 11 }, { provision: () => ({ ok: true, summary: {} }) });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.path, stale);
    assert.ok(existsSync(stale), "worktree recreated on the existing branch");
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Branch provisioning origin: reuse an existing `origin/<branch>` instead of
// forking a fresh branch off base when no LOCAL branch of that name exists.
// A worktree created off base with a matching remote branch left behind used
// to sit at base with none of the branch's commits, upstream set to base —
// one `git push` away from replacing the remote branch's commits with a copy
// of base.
// ---------------------------------------------------------------------------

test("ensure: neither local nor remote branch exists — created off resolved base (unchanged)", async () => {
  const repo = makeRepo();
  try {
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 2001 });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.branchOrigin, "created-from-base");
    assert.equal(res.base, "origin/main");
    assert.equal(res.diverged, undefined);
  } finally {
    repo.cleanup();
  }
});

test("ensure: local branch already exists — re-attached (unchanged), even alongside a same-SHA origin ref", async () => {
  const repo = makeRepo();
  try {
    const stale = path.join(repo.root, "tmp/worktrees/dev-loops/issue-2002");
    repo.git("worktree", "add", "-b", "issue-2002", stale, "main");
    repo.git("worktree", "remove", "--force", stale);
    repo.git("worktree", "prune");

    const res = await ensureWorktree({ repoRoot: repo.root, issue: 2002 });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.branchOrigin, "reused-local");
    assert.equal(res.base, "issue-2002");
    // makeRepo()'s origin is self-referential, so ensureWorktree's own fetch
    // pulls the just-created local branch into refs/remotes/origin/issue-2002
    // at the SAME sha — same-SHA is not divergence, so this must read undefined
    // rather than proving the origin ref never existed (it does).
    assert.equal(res.diverged, undefined);
  } finally {
    repo.cleanup();
  }
});

test("ensure: origin/<branch> exists, no local branch — tracks the remote tip instead of forking off base", async () => {
  const origin = makeOriginRepo();
  try {
    origin.originGit("branch", "issue-2003");
    origin.originGit("checkout", "-q", "issue-2003");
    origin.originGit("commit", "-q", "--allow-empty", "-m", "remote-only work");
    origin.originGit("checkout", "-q", "main");
    const remoteSha = origin.originGit("rev-parse", "issue-2003").trim();

    const { root, git } = cloneRepo(origin.tmp, origin.originDir);
    assert.equal(branchExistsAt(git, "issue-2003"), false, "clone must not check out the non-default branch locally");

    const res = await ensureWorktree({ repoRoot: root, issue: 2003 });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.branchOrigin, "tracked-remote");
    assert.equal(res.base, "origin/issue-2003");
    assert.equal(res.diverged, undefined);

    // The worktree carries the remote branch's own commit — not a fork off base.
    const worktreeSha = git("-C", res.path, "rev-parse", "HEAD").trim();
    assert.equal(worktreeSha, remoteSha, "worktree tip must be the remote branch's commit, not base");

    // Upstream is the remote branch, never the base branch.
    const upstream = git("-C", res.path, "rev-parse", "--abbrev-ref", "issue-2003@{upstream}").trim();
    assert.equal(upstream, "origin/issue-2003");
  } finally {
    origin.cleanup();
  }
});

// MUST-FIX regression: a slashed --base whose first segment is NOT a real
// remote (the shape workflow.baseBranch documents — "release/1.0") used to
// resolve remoteRef via the UNVALIDATED first segment ("release/<branch>"),
// which never matches anything, so the tracked-remote path was skipped even
// though origin/<branch> genuinely exists — silently reinstating the
// fork-off-base hazard this whole fix exists to close.
test("ensure: a slashed non-remote --base still tracks an existing origin/<branch> (never mis-resolves the remote)", async () => {
  const origin = makeOriginRepo();
  try {
    origin.originGit("branch", "issue-2006");
    origin.originGit("checkout", "-q", "issue-2006");
    origin.originGit("commit", "-q", "--allow-empty", "-m", "remote-only work");
    origin.originGit("checkout", "-q", "main");
    origin.originGit("branch", "release/1.0");
    const remoteSha = origin.originGit("rev-parse", "issue-2006").trim();

    const { root, git } = cloneRepo(origin.tmp, origin.originDir);

    const res = await ensureWorktree({ repoRoot: root, issue: 2006, branch: "issue-2006", base: "release/1.0" });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.branchOrigin, "tracked-remote");
    assert.equal(res.base, "origin/issue-2006");
    const worktreeSha = git("-C", res.path, "rev-parse", "HEAD").trim();
    assert.equal(worktreeSha, remoteSha);
  } finally {
    origin.cleanup();
  }
});

test("ensure: --pr resolving a branch behaves identically to --branch for the tracked-remote case", async () => {
  const origin = makeOriginRepo();
  try {
    origin.originGit("branch", "feature-x");
    origin.originGit("checkout", "-q", "feature-x");
    origin.originGit("commit", "-q", "--allow-empty", "-m", "pr work");
    origin.originGit("checkout", "-q", "main");
    const remoteSha = origin.originGit("rev-parse", "feature-x").trim();

    const { root, git } = cloneRepo(origin.tmp, origin.originDir, "root-pr");
    const viaPr = await ensureWorktree({ repoRoot: root, pr: 2004, branch: "feature-x" });
    assert.equal(viaPr.ok, true);
    assert.equal(viaPr.branchOrigin, "tracked-remote");
    assert.equal(viaPr.base, "origin/feature-x");
    assert.equal(git("-C", viaPr.path, "rev-parse", "HEAD").trim(), remoteSha);
    assert.equal(git("-C", viaPr.path, "rev-parse", "--abbrev-ref", "feature-x@{upstream}").trim(), "origin/feature-x");

    // Same branch, resolved via --issue + --branch instead of --pr's default
    // naming: the two selectors only affect the CANONICAL PATH/default branch
    // NAME, never the branch-resolution algorithm itself. Proven directly by
    // running the identical branch through the --issue entrypoint against a
    // second clone (git refuses two worktrees on the same branch at once).
    const { root: root2, git: git2 } = cloneRepo(origin.tmp, origin.originDir, "root-issue");
    const viaIssue = await ensureWorktree({ repoRoot: root2, issue: 2005, branch: "feature-x" });
    assert.equal(viaIssue.branchOrigin, viaPr.branchOrigin, "--pr and --issue+--branch take the same branchOrigin path");
    assert.equal(viaIssue.base, viaPr.base);
    assert.equal(git2("-C", viaIssue.path, "rev-parse", "HEAD").trim(), remoteSha);
    assert.equal(git2("-C", viaIssue.path, "rev-parse", "--abbrev-ref", "feature-x@{upstream}").trim(), "origin/feature-x");
  } finally {
    origin.cleanup();
  }
});

// WORTH-FIXING-NOW: --branch is a NAME, not a ref. "origin/feature-x" (a
// caller pasting a remote-ref shape by habit) used to build a literal
// "origin/origin/feature-x" local branch, missing the real remote branch
// (origin/feature-x) and forking an ambiguous new one off base instead.
test("ensure: --branch normalizes a remote-ref-shaped value to the bare branch name", async () => {
  const origin = makeOriginRepo();
  try {
    origin.originGit("branch", "feature-y");
    origin.originGit("checkout", "-q", "feature-y");
    origin.originGit("commit", "-q", "--allow-empty", "-m", "feature work");
    origin.originGit("checkout", "-q", "main");
    const remoteSha = origin.originGit("rev-parse", "feature-y").trim();

    const { root, git } = cloneRepo(origin.tmp, origin.originDir);
    // Rejected form: "origin/feature-y" must normalize to "feature-y", not
    // build a nested "origin/origin/feature-y" local branch off base.
    const res = await ensureWorktree({ repoRoot: root, issue: 3001, branch: "  origin/feature-y  " });
    assert.equal(res.ok, true);
    assert.equal(res.branchOrigin, "tracked-remote");
    assert.equal(res.base, "origin/feature-y");
    assert.equal(git("-C", res.path, "rev-parse", "HEAD").trim(), remoteSha);
    assert.equal(git("-C", res.path, "rev-parse", "--abbrev-ref", "HEAD").trim(), "feature-y");
  } finally {
    origin.cleanup();
  }
});

test("ensure: --branch accepts a plain bare branch name unchanged", async () => {
  const repo = makeRepo();
  try {
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 3002, branch: "plain-name" });
    assert.equal(res.ok, true);
    assert.equal(res.branchOrigin, "created-from-base");
    assert.equal(repo.git("-C", res.path, "rev-parse", "--abbrev-ref", "HEAD").trim(), "plain-name");
  } finally {
    repo.cleanup();
  }
});

test("ensure: local branch diverged from origin/<branch> — reported, not silently resolved", async () => {
  const origin = makeOriginRepo();
  try {
    const baseSha = origin.originGit("rev-parse", "HEAD").trim();

    // Fork the remote branch and the local branch from the SAME base commit
    // so neither is an ancestor of the other — a genuine fork, not just
    // "local is ahead", the ordinary harmless state of an in-progress branch.
    origin.originGit("branch", "issue-2005");
    origin.originGit("checkout", "-q", "issue-2005");
    origin.originGit("commit", "-q", "--allow-empty", "-m", "remote-side work");
    const remoteSha = origin.originGit("rev-parse", "HEAD").trim();
    origin.originGit("checkout", "-q", "main");

    const { root, git } = cloneRepo(origin.tmp, origin.originDir);
    git("branch", "issue-2005", baseSha);
    git("checkout", "-q", "issue-2005");
    git("commit", "-q", "--allow-empty", "-m", "local-side work");
    const localSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "main");
    assert.notEqual(localSha, remoteSha);

    const res = await ensureWorktree({ repoRoot: root, issue: 2005 });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    // Fail-closed on WHICH side wins: local is still re-attached (unchanged
    // existing behavior for an already-existing local branch)...
    assert.equal(res.branchOrigin, "reused-local");
    assert.equal(res.base, "issue-2005");
    // ...but the divergence is surfaced, not silently swallowed.
    assert.deepEqual(res.diverged, { remoteRef: "origin/issue-2005", local: localSha, remote: remoteSha });
  } finally {
    origin.cleanup();
  }
});

// WORTH-FIXING-NOW regression: an ahead/behind local branch (one side is a
// strict ancestor of the other) is the ORDINARY state of an in-progress
// branch — it must never be reported as "diverged", which used to be
// conflated with a genuine fork whenever any error (not just is-ancestor's
// documented "false") escaped the merge-base check.
test("ensure: local branch merely ahead of origin/<branch> is NOT reported as diverged", async () => {
  const origin = makeOriginRepo();
  try {
    origin.originGit("branch", "issue-2007");
    const remoteSha = origin.originGit("rev-parse", "issue-2007").trim();

    const { root, git } = cloneRepo(origin.tmp, origin.originDir);
    git("branch", "issue-2007");
    git("checkout", "-q", "issue-2007");
    git("commit", "-q", "--allow-empty", "-m", "local-only follow-up work");
    const localSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "main");
    assert.notEqual(localSha, remoteSha, "local must be strictly ahead, not identical");

    const res = await ensureWorktree({ repoRoot: root, issue: 2007 });
    assert.equal(res.ok, true);
    assert.equal(res.branchOrigin, "reused-local");
    assert.equal(res.diverged, undefined, "ahead-of-remote is not a fork");
  } finally {
    origin.cleanup();
  }
});

function branchExistsAt(git, branch) {
  try {
    git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspace self-link (#1144): node_modules/@dev-loops/core resolves to the
// fresh worktree's OWN packages/core, not the main checkout's — and the link
// stays untracked (git-ignored).
// ---------------------------------------------------------------------------

test("ensure: node_modules/@dev-loops/core resolves to the worktree's OWN packages/core, untracked", async () => {
  const repo = makeRepo();
  try {
    // A tracked packages/core in main — git worktree add checks out its own
    // on-disk copy, so main's and the worktree's copies are distinct
    // directories even though both are tracked at the same path.
    mkdirSync(path.join(repo.root, "packages/core/src"), { recursive: true });
    writeFileSync(path.join(repo.root, "packages/core/package.json"), '{"name":"@dev-loops/core"}\n');
    writeFileSync(path.join(repo.root, ".gitignore"), "node_modules/\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "add packages/core");
    repo.git("fetch", "-q", "origin");

    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1144, base: "origin/main" });
    assert.equal(res.ok, true);

    const linkPath = path.join(res.path, "node_modules/@dev-loops/core");
    assert.ok(existsSync(linkPath), "self-link exists");
    const { realpathSync, lstatSync } = await import("node:fs");
    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(
      realpathSync(linkPath),
      realpathSync(path.join(res.path, "packages/core")),
      "resolves to the worktree's OWN packages/core",
    );
    assert.notEqual(
      realpathSync(linkPath),
      realpathSync(path.join(repo.root, "packages/core")),
      "must NOT resolve to the main checkout's packages/core",
    );

    // Untracked: node_modules is gitignored repo-wide (asserted, not changed).
    const ignored = repo.git("-C", res.path, "check-ignore", "-q", "node_modules/@dev-loops/core");
    // execFileSync throws on non-zero exit; reaching here means exit 0 (ignored).
    assert.equal(ignored, "");
    const statusInWorktree = execFileSync("git", ["status", "--porcelain"], {
      cwd: res.path,
      encoding: "utf8",
    });
    assert.ok(
      !statusInWorktree.includes("node_modules"),
      `node_modules must not show up in git status, got: ${statusInWorktree}`,
    );
  } finally {
    repo.cleanup();
  }
});

test("ensure: workspace self-link survives re-provisioning an existing worktree (idempotent)", async () => {
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo.root, "packages/core"), { recursive: true });
    writeFileSync(path.join(repo.root, "packages/core/package.json"), '{"name":"@dev-loops/core"}\n');
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "add packages/core");
    repo.git("fetch", "-q", "origin");

    const first = await ensureWorktree({ repoRoot: repo.root, issue: 42, base: "origin/main" });
    const linkPath = path.join(first.path, "node_modules/@dev-loops/core");
    assert.ok(existsSync(linkPath));

    // Re-provision (reuse path) must not fail and must keep the link valid.
    const second = await ensureWorktree({ repoRoot: repo.root, issue: 42, base: "origin/main" });
    assert.equal(second.reused, true);
    const { realpathSync } = await import("node:fs");
    assert.equal(realpathSync(linkPath), realpathSync(path.join(second.path, "packages/core")));
  } finally {
    repo.cleanup();
  }
});

test("ensure: a real node process resolves @dev-loops/core to the worktree's OWN packages/core (#1432)", async () => {
  const repo = makeRepo();
  try {
    // "main" with the `exports` field omitted entirely, so a bare
    // `import.meta.resolve("@dev-loops/core")` resolves via Node's legacy
    // main fallback. (The real @dev-loops/core ships an `exports` map; this
    // fixture only needs SOME resolvable entry to prove which copy wins.)
    mkdirSync(path.join(repo.root, "packages/core"), { recursive: true });
    writeFileSync(
      path.join(repo.root, "packages/core/package.json"),
      '{"name":"@dev-loops/core","type":"module","main":"./index.mjs"}\n',
    );
    writeFileSync(path.join(repo.root, "packages/core/index.mjs"), "export const marker = \"root\";\n");
    writeFileSync(path.join(repo.root, ".gitignore"), "node_modules/\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "add resolvable packages/core");
    repo.git("fetch", "-q", "origin");

    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1432, base: "origin/main" });
    assert.equal(res.ok, true);

    // Diverge the worktree's OWN copy from the checkout's, simulating an
    // in-progress edit — proves resolution follows the worktree, not a copy
    // that merely happens to start out identical.
    writeFileSync(path.join(res.path, "packages/core/index.mjs"), "export const marker = \"worktree\";\n");

    const script = [
      "const resolved = import.meta.resolve('@dev-loops/core');",
      "const mod = await import(resolved);",
      "console.log(JSON.stringify({ resolved, marker: mod.marker }));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: res.path,
      encoding: "utf8",
    });
    const { resolved, marker } = JSON.parse(out);
    const { fileURLToPath } = await import("node:url");
    const resolvedPath = fileURLToPath(resolved);
    const { realpathSync } = await import("node:fs");
    assert.equal(realpathSync(path.dirname(resolvedPath)), realpathSync(path.join(res.path, "packages/core")));
    assert.equal(marker, "worktree", "resolved module content is the worktree's OWN edit, not the checkout's");
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Provisioning is invoked (injected core) and fails soft
// ---------------------------------------------------------------------------

test("ensure: invokes the provision core and never aborts on a provision warning", async () => {
  const repo = makeRepo();
  try {
    let called = false;
    const provision = ({ worktreePath, repoRoot }) => {
      called = true;
      assert.equal(repoRoot, repo.root);
      assert.equal(worktreePath, path.join(repo.root, "tmp/worktrees/dev-loops/issue-3"));
      return { ok: true, actions: [], summary: { warnings: 1 } }; // a warning — must not abort
    };
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 3 }, { provision });
    assert.equal(called, true);
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.provision.summary.warnings, 1);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Default-branch guard wiring. These drive the real ensureWorktree end to end:
// the guard module's own suite proves the hooks behave, but only these prove
// ensure-worktree installs them into the right directory with the right branch.
// ---------------------------------------------------------------------------

test("ensure: installs the guard into the PRIMARY checkout, baking in the real default branch", async () => {
  const repo = makeRepo();
  try {
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1452 });
    assert.equal(res.ok, true);
    assert.equal(res.guard.ok, true);
    assert.deepEqual(res.guard.defaultBranches, ["main"]);

    // The PRIMARY checkout's hook dir is the target — a worktree-local install
    // would leave this path missing while still reporting success.
    const hook = path.join(repo.root, ".git", "hooks", "pre-commit");
    assert.ok(existsSync(hook), "guard installed in the primary checkout's hook dir");
    const body = readFileSync(hook, "utf8");
    assert.match(body, /dev-loops:default-branch-guard/);
    assert.match(body, /^defaults="main"$/m);
    assert.ok(statSync(hook).mode & 0o111, "hook is executable");

    // And it actually fires: a commit on the default branch is refused.
    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on main"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
    );
  } finally {
    repo.cleanup();
  }
});

test("ensure: a repo whose default ref is not `main` gets `master` baked in, unconditionally, and enforces it", async () => {
  const repo = makeRepo({ branch: "master" });
  try {
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1452 });
    assert.equal(res.ok, true);
    // No refs/remotes/origin/main here, so the main-or-master guess must be
    // rejected rather than protecting a branch this repo does not have —
    // asserted unconditionally, not "if it resolved": a hedge here would stay
    // green even if resolution silently degraded to inert on every non-main repo.
    assert.deepEqual(res.guard.defaultBranches, ["master"]);
    const body = readFileSync(path.join(repo.root, ".git", "hooks", "pre-commit"), "utf8");
    assert.doesNotMatch(body, /^defaults="main"$/m);
    assert.match(body, /^defaults="master"$/m);
    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on master"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
    );
  } finally {
    repo.cleanup();
  }
});

// The guard is a REPO-WIDE shared resource (one hook directory), not
// per-invocation state — so it must protect the repo's real default AND an
// explicit --base (an operator's flag, or the resolver-injected
// workflow.baseBranch) at once, and a later call on a DIFFERENT explicit
// --base must never strip protection from the real default that an earlier
// call already established.
test("ensure: an explicit --base guards ALONGSIDE the real default, never instead of it", async () => {
  const repo = makeRepo();
  try {
    repo.git("branch", "release/1.0");
    repo.git("fetch", "-q", "origin");
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 42, base: "origin/release/1.0" });
    assert.equal(res.ok, true);
    assert.deepEqual([...res.guard.defaultBranches].sort(), ["main", "release/1.0"]);

    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on main"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
      "the real default must still be refused",
    );
    repo.git("checkout", "-q", "release/1.0");
    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on release/1.0"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
      "the explicit base must be refused too",
    );
  } finally {
    repo.cleanup();
  }
});

test("ensure: a later call with a DIFFERENT explicit --base never un-guards the real default", async () => {
  const repo = makeRepo();
  try {
    repo.git("branch", "spike/a");
    repo.git("branch", "spike/b");
    repo.git("fetch", "-q", "origin");
    await ensureWorktree({ repoRoot: repo.root, issue: 1, base: "origin/spike/a" });
    const second = await ensureWorktree({ repoRoot: repo.root, issue: 2, base: "origin/spike/b" });
    assert.ok(second.guard.defaultBranches.includes("main"), "the real default survives across differing --base calls");
    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on main"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
    );
  } finally {
    repo.cleanup();
  }
});

// Regression for the bug this fixes: guardedBranches() used to resolve the
// repo's OWN default from the --base's remote, so a --base whose first
// segment was NOT a real remote name (a bare slashed branch, exactly the
// shape `workflow.baseBranch` documents — "main" or "spike/foo") misparsed
// as remote="release", found no such remote, and rewrote the shared hooks to
// defaults="" — silently un-guarding the real default while guard.ok stayed
// true.
test("ensure: a bare slashed --base (no matching remote) never un-guards the real default", async () => {
  const repo = makeRepo();
  try {
    await ensureWorktree({ repoRoot: repo.root, issue: 1 });
    repo.git("branch", "release/1.0");
    repo.git("fetch", "-q", "origin");
    const second = await ensureWorktree({ repoRoot: repo.root, issue: 2, base: "release/1.0" });
    assert.equal(second.guard.ok, true);
    assert.ok(second.guard.defaultBranches.includes("main"), "the real default survives a bare slashed --base");
    assert.ok(second.guard.defaultBranches.includes("release/1.0"), "the explicit base is still guarded too");
    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on main"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
    );
  } finally {
    repo.cleanup();
  }
});

// Same defect, different trigger: a --base on a SECOND real remote (a fork's
// "upstream") must not make the repo's OWN default track THAT remote's HEAD
// either — the repo default is always origin's, independent of --base.
test("ensure: a --base on a different real remote never un-guards the real default", async () => {
  const repo = makeRepo();
  try {
    await ensureWorktree({ repoRoot: repo.root, issue: 1 });
    // A second, genuinely-configured remote whose HEAD is not "main" — the
    // pre-fix code used THIS remote to resolve the repo's own default too.
    repo.git("branch", "develop");
    repo.git("remote", "add", "upstream", repo.root);
    repo.git("fetch", "-q", "upstream");
    const second = await ensureWorktree({ repoRoot: repo.root, issue: 2, base: "upstream/develop" });
    assert.equal(second.guard.ok, true);
    assert.ok(second.guard.defaultBranches.includes("main"), "the real default (origin's) survives a --base on a different remote");
    assert.throws(
      () => repo.git("commit", "-q", "--allow-empty", "-m", "on main"),
      (err) => /refusing to commit on the default branch/.test(String(err.stderr)),
    );
  } finally {
    repo.cleanup();
  }
});

// An empty-but-SET core.hooksPath ("" — git runs NO hooks at all in that
// case) used to collapse to the same `null` as unset, so the guard installed
// hooks git would never execute and reported guard.ok: true anyway.
test("ensure: refuses to install when core.hooksPath is set to an empty string", async () => {
  const repo = makeRepo();
  try {
    repo.git("config", "core.hooksPath", "");
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1452 });
    assert.equal(res.ok, true, "worktree still created — the guard is best-effort");
    assert.equal(res.guard.ok, false);
    assert.match(res.guard.reason, /core\.hooksPath/);
    assert.ok(
      !existsSync(path.join(repo.root, ".git", "hooks", "pre-commit")),
      "no hook written where git would never read it",
    );
  } finally {
    repo.cleanup();
  }
});

// Must-fix regression: an explicit --base naming a live working branch used
// to permanently guard that branch (installDefaultBranchGuard unioned every
// explicit-base candidate forever), so the linked worktree that OWNS the
// stacked-off branch could never commit again, and a later base-free call
// could not drop it either — contradicting AC "Commits and pushes in linked
// worktrees are unaffected". Reproduced end to end: stack issue-101 off
// issue-100's branch, prove issue-100's own commits are refused while
// stacked, then reinstall without --base and prove the slot is dropped.
test("ensure: stacking --base on a live worktree branch does not permanently guard it — a later base-free call drops the slot", async () => {
  const repo = makeRepo();
  try {
    const owner = await ensureWorktree({ repoRoot: repo.root, issue: 100 });
    assert.equal(owner.ok, true);
    repo.git("fetch", "-q", "origin"); // publish the freshly-created issue-100 branch as origin/issue-100

    const stacked = await ensureWorktree({ repoRoot: repo.root, issue: 101, base: "origin/issue-100" });
    assert.equal(stacked.ok, true);
    assert.ok(stacked.guard.defaultBranches.includes("issue-100"), "the explicit base is guarded while stacked");

    // The owning worktree's OWN branch is refused while stacked.
    assert.throws(
      () => execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "own work"], { cwd: owner.path, encoding: "utf8", env: REPO_GIT_ENV }),
      (err) => /refusing to commit on the default branch \(issue-100\)/.test(String(err.stderr)),
      "issue-100's own commit must be refused while its branch is a stacked explicit base",
    );

    // A later, base-free call must drop the explicit-base slot entirely —
    // never merely add to the set that a later --base-free reinstall can't
    // strip.
    const freed = await ensureWorktree({ repoRoot: repo.root, issue: 102 });
    assert.equal(freed.ok, true);
    assert.ok(!freed.guard.defaultBranches.includes("issue-100"), "the stacked explicit base must be dropped once nothing requests it");
    assert.ok(freed.guard.defaultBranches.includes("main"), "the real default must still be guarded");

    // issue-100's own commits now pass.
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "own work after drop"], { cwd: owner.path, encoding: "utf8", env: REPO_GIT_ENV });
  } finally {
    repo.cleanup();
  }
});

// Coverage gap the reviewer flagged at the module level: seeding the reported
// `defaultBranches` before the write loop claimed enforcement even when every
// guarded slot was occupied by a foreign hook and nothing was written.
test("ensure: with every guarded hook slot foreign, guard reports nothing enforced (not a false ok:true main)", async () => {
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo.root, ".git", "hooks"), { recursive: true });
    for (const hook of ["pre-commit", "pre-merge-commit", "pre-push"]) {
      writeFileSync(path.join(repo.root, ".git", "hooks", hook), "#!/bin/sh\n# someone else's hook\nexit 0\n", { mode: 0o755 });
    }
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1452 });
    assert.equal(res.ok, true);
    assert.equal(res.guard.ok, true);
    assert.deepEqual(res.guard.installed, []);
    assert.deepEqual(res.guard.defaultBranches, [], "nothing was written, so nothing may read as enforced");
    // And the commit actually passes — the report matches reality.
    repo.git("commit", "-q", "--allow-empty", "-m", "on main, unguarded by foreign hooks");
  } finally {
    repo.cleanup();
  }
});

test("ensure: refuses to install when core.hooksPath points git elsewhere", async () => {
  const repo = makeRepo();
  try {
    repo.git("config", "core.hooksPath", ".husky");
    const res = await ensureWorktree({ repoRoot: repo.root, issue: 1452 });
    assert.equal(res.ok, true, "worktree still created — the guard is best-effort");
    assert.equal(res.guard.ok, false);
    assert.match(res.guard.reason, /core\.hooksPath/);
    assert.ok(
      !existsSync(path.join(repo.root, ".git", "hooks", "pre-commit")),
      "no hook written where git would never read it",
    );
  } finally {
    repo.cleanup();
  }
});
