import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initGitFixture } from "../_helpers.mjs";

import {
  cleanupWorktree,
  parseCleanupWorktreeCliArgs,
} from "../../scripts/loop/cleanup-worktree.mjs";

// A git stub that logs its args to a file and exits with `exitCode`. With
// `failSubcommand`, that subcommand fails and every other call runs real git.
// With `emptySubcommand`, that subcommand prints nothing and exits 0 and every
// other call runs real git.
// With `sleepOn`, a call whose args start with that string sleeps 5 s instead
// (exec, so a timeout kill reaches the sleep) and every other call runs real git.
function writeGitStub(dir, { exitCode = 0, logFile, failSubcommand, emptySubcommand, sleepOn } = {}) {
  const gitPath = path.join(dir, "git");
  const tail = sleepOn !== undefined
    ? [`case "$*" in ${JSON.stringify(sleepOn)}*) exec sleep 5;; esac`, 'exec git "$@"']
    : emptySubcommand !== undefined
    ? [`if [ "$1" = ${JSON.stringify(emptySubcommand)} ]; then exit 0; fi`, 'exec git "$@"']
    : failSubcommand === undefined
      ? [`exit ${exitCode}`]
      : [`if [ "$1" = ${JSON.stringify(failSubcommand)} ]; then echo "fatal: stub ${failSubcommand} failure" >&2; exit 1; fi`, 'exec git "$@"'];
  const lines = [
    "#!/usr/bin/env sh",
    `echo "$@" >> ${JSON.stringify(logFile)}`,
    ...tail,
  ];
  writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });
  return gitPath;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseCleanupWorktreeCliArgs: requires a selector", () => {
  assert.throws(() => parseCleanupWorktreeCliArgs(["--repo-root", "/r"]), /issue|pr|path/);
});

test("parseCleanupWorktreeCliArgs: rejects multiple selectors", () => {
  assert.throws(
    () => parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--issue", "1", "--pr", "2"]),
    /exactly one/,
  );
});

test("parseCleanupWorktreeCliArgs: parses --issue", () => {
  const o = parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--issue", "909"]);
  assert.equal(o.issue, 909);
});

// ---------------------------------------------------------------------------
// Removal under the namespace
// ---------------------------------------------------------------------------

test("cleanup: removes a path under the namespace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = writeGitStub(dir, { logFile });
    const res = cleanupWorktree(
      { repoRoot: dir, issue: 909 },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, true);
    assert.equal(res.removed, path.join(dir, "tmp/worktrees/dev-loops/issue-909"));
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /worktree remove --force .*issue-909/);
    assert.match(log, /worktree prune/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup: remove and prune drop an inherited GIT_DIR/GIT_WORK_TREE", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = path.join(dir, "git");
    writeFileSync(gitPath, `#!/usr/bin/env sh\necho "$1 $2 dir=\${GIT_DIR-unset} tree=\${GIT_WORK_TREE-unset}" >> ${JSON.stringify(logFile)}\n`, { mode: 0o755 });
    process.env.GIT_DIR = "/elsewhere/.git";
    process.env.GIT_WORK_TREE = "/elsewhere";
    cleanupWorktree({ repoRoot: dir, issue: 909 }, { gitCommand: gitPath });
    assert.equal(readFileSync(logFile, "utf8"), "worktree remove dir=unset tree=unset\nworktree prune dir=unset tree=unset\n");
  } finally {
    for (const [k, v] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Safety invariant: refuse paths outside the namespace
// ---------------------------------------------------------------------------

test("cleanup: refuses a path outside tmp/worktrees/dev-loops/", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = writeGitStub(dir, { logFile });
    const res = cleanupWorktree(
      { repoRoot: dir, path: path.join(dir, "tmp/worktrees/my-experiment") },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, false);
    assert.equal(res.removed, null);
    assert.match(res.reason, /refused/);
    // git must not have been invoked
    assert.equal(existsSync(logFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Safety invariant: refuse a symlinked namespace that resolves outside repo-root
// ---------------------------------------------------------------------------

test("cleanup: refuses when the namespace dir is a symlink escaping repo-root", () => {
  const base = mkdtempSync(path.join(tmpdir(), "wt-clean-sym-"));
  try {
    const repoRoot = path.join(base, "repo");
    const outside = path.join(base, "outside");
    mkdirSync(path.join(repoRoot, "tmp/worktrees"), { recursive: true });
    // Real target sits OUTSIDE the repo; the namespace dir is a symlink to it.
    mkdirSync(path.join(outside, "issue-909"), { recursive: true });
    symlinkSync(outside, path.join(repoRoot, "tmp/worktrees/dev-loops"));

    const logFile = path.join(base, "git.log");
    const gitPath = writeGitStub(base, { logFile });
    // The lexical path is under the namespace, but its realpath escapes repo-root.
    const res = cleanupWorktree(
      { repoRoot, path: path.join(repoRoot, "tmp/worktrees/dev-loops/issue-909") },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, false);
    assert.equal(res.removed, null);
    assert.match(res.reason, /refused/);
    // git must NOT have been invoked — nothing outside the namespace removed.
    assert.equal(existsSync(logFile), false);
    assert.ok(existsSync(path.join(outside, "issue-909")), "outside dir untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-soft on git error
// ---------------------------------------------------------------------------

test("cleanup: fails soft on a git error (ok true, removed null)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = writeGitStub(dir, { logFile, exitCode: 1 });
    const res = cleanupWorktree(
      { repoRoot: dir, pr: 908 },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, true);
    assert.equal(res.removed, null);
    assert.match(res.reason, /git error/);
    assert.match(readFileSync(logFile, "utf8"), /worktree prune/, "prune still runs after a failed remove");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --branch selector against a real repo with linked worktrees
// ---------------------------------------------------------------------------

test("parseCleanupWorktreeCliArgs: parses --branch and counts it as a selector", () => {
  assert.equal(parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--branch", "issue-7"]).branch, "issue-7");
  assert.throws(() => parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--branch", "b", "--pr", "2"]), /exactly one/);
});

// An ambient GIT_DIR/GIT_WORK_TREE (git hook, rebase --exec) would redirect fixture git into the real checkout.
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
}

// A main checkout with one linked worktree per `{ dir, branch }` under the
// namespace. Returns realpath'd paths.
function makeRepo(worktrees = []) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-branch-")));
  const main = path.join(base, "main");
  mkdirSync(main);
  initGitFixture(main, { branch: "main" });
  const paths = {};
  for (const { dir, branch } of worktrees) {
    const wt = path.join(main, "tmp/worktrees/dev-loops", dir);
    git(main, ["worktree", "add", "-q", "-b", branch, wt]);
    paths[dir] = wt;
  }
  return { base, main, paths };
}

function listedPaths(main) {
  return git(main, ["worktree", "list", "--porcelain"]).split("\n")
    .filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

test("cleanup --branch: resolves issue-<n>, pr-<n>, and a variant-branch worktree by checked-out branch", () => {
  const layouts = [
    { dir: "issue-7", branch: "issue-7" },
    { dir: "pr-12", branch: "feature/pr-work" },
    { dir: "issue-7-b", branch: "issue-7-variant-b" },
  ];
  const { base, main, paths } = makeRepo(layouts);
  try {
    for (const { dir, branch } of layouts) {
      const res = cleanupWorktree({ repoRoot: main, branch });
      assert.equal(res.ok, true, dir);
      assert.equal(res.removed, paths[dir], dir);
      assert.equal(existsSync(paths[dir]), false, `${dir} is gone`);
      assert.ok(!listedPaths(main).includes(paths[dir]), `${dir} is no longer listed`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: no matching worktree is a stated skip that removes nothing", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const before = listedPaths(main);
    const res = cleanupWorktree({ repoRoot: main, branch: "no-such-branch" });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.match(res.reason, /no linked worktree .*no-such-branch/);
    assert.deepEqual(listedPaths(main), before);
    assert.ok(existsSync(paths["issue-7"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: never selects the main checkout or a worktree outside the namespace", () => {
  const { base, main } = makeRepo();
  try {
    const outside = path.join(main, "tmp/worktrees/my-experiment");
    git(main, ["worktree", "add", "-q", "-b", "experiment", outside]);
    const before = listedPaths(main);
    for (const branch of ["main", "experiment"]) {
      const res = cleanupWorktree({ repoRoot: main, branch });
      assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null }, branch);
      assert.match(res.reason, /skipped/, branch);
    }
    assert.deepEqual(listedPaths(main), before);
    assert.ok(existsSync(outside));
    assert.ok(existsSync(path.join(main, ".git")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup: skips a worktree holding gate findings ledgers, for every selector", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const ledgerDir = path.join(paths["issue-7"], "tmp/gate-findings");
    const ledger = path.join(ledgerDir, "owner-repo/pr-7/pre_approval_gate-abc.json");
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, "{}\n");
    for (const selector of [{ branch: "issue-7" }, { issue: 7 }, { path: paths["issue-7"] }]) {
      const res = cleanupWorktree({ repoRoot: main, ...selector });
      assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null }, JSON.stringify(selector));
      assert.ok(res.reason.includes(ledgerDir), res.reason);
    }
    assert.ok(existsSync(ledger), "the ledger survives");
    assert.ok(listedPaths(main).includes(paths["issue-7"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup: a gate-findings tree with only empty directories holds no ledger and is removed", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    mkdirSync(path.join(paths["issue-7"], "tmp/gate-findings/owner-repo/pr-7"), { recursive: true });
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7" });
    assert.equal(res.removed, paths["issue-7"]);
    assert.equal(existsSync(paths["issue-7"]), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup: an unreadable gate-findings dir counts as holding ledgers and names the error", () => {
  if (process.getuid?.() === 0) return; // root bypasses file perms
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  const ledgerDir = path.join(paths["issue-7"], "tmp/gate-findings");
  try {
    mkdirSync(ledgerDir, { recursive: true });
    chmodSync(ledgerDir, 0o000);
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7" });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.match(res.reason, /EACCES/);
    assert.ok(existsSync(paths["issue-7"]));
  } finally {
    chmodSync(ledgerDir, 0o755);
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseCleanupWorktreeCliArgs: --head-sha needs --branch and a full SHA", () => {
  const sha = "a".repeat(40);
  assert.equal(parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--branch", "b", "--head-sha", sha]).headSha, sha);
  assert.throws(() => parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--issue", "1", "--head-sha", sha]), /requires --branch/);
  assert.throws(() => parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--branch", "b", "--head-sha", "abc1234"]), /FULL head commit SHA/);
});

test("cleanup --branch --head-sha: removes on a HEAD match, skips a worktree whose HEAD moved on", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }, { dir: "issue-8", branch: "issue-8" }]);
  try {
    const merged7 = git(paths["issue-7"], ["rev-parse", "HEAD"]).trim();
    const res7 = cleanupWorktree({ repoRoot: main, branch: "issue-7", headSha: merged7 });
    assert.equal(res7.removed, paths["issue-7"]);

    const merged8 = git(paths["issue-8"], ["rev-parse", "HEAD"]).trim();
    git(paths["issue-8"], ["commit", "-q", "--allow-empty", "-m", "unpushed"]);
    const res8 = cleanupWorktree({ repoRoot: main, branch: "issue-8", headSha: merged8 });
    assert.deepEqual({ ok: res8.ok, removed: res8.removed }, { ok: true, removed: null });
    assert.match(res8.reason, /does not match the merged head/);
    assert.ok(existsSync(paths["issue-8"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch --head-sha: an uncommitted edit at the merged head skips the removal and survives", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const merged = git(paths["issue-7"], ["rev-parse", "HEAD"]).trim();
    const edit = path.join(paths["issue-7"], "wip.txt");
    writeFileSync(edit, "local work\n");
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7", headSha: merged });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.ok(res.reason.includes(paths["issue-7"]), res.reason);
    assert.match(res.reason, /uncommitted changes/);
    assert.equal(readFileSync(edit, "utf8"), "local work\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: status.showUntrackedFiles=no does not hide an untracked file from the dirty-tree guard", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    git(main, ["config", "status.showUntrackedFiles", "no"]);
    const edit = path.join(paths["issue-7"], "untracked.txt");
    writeFileSync(edit, "local work\n");
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7" });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.match(res.reason, /uncommitted changes/);
    assert.equal(readFileSync(edit, "utf8"), "local work\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: a failed git status skips the removal (fail safe)", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const logFile = path.join(base, "git.log");
    const gitPath = writeGitStub(base, { logFile, failSubcommand: "status" });
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7" }, { gitCommand: gitPath });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.match(res.reason, /cannot read git status/);
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /^status --porcelain --untracked-files=normal --ignore-submodules=none$/m, "the status call ran");
    assert.doesNotMatch(log, /worktree remove/);
    assert.ok(existsSync(paths["issue-7"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A 1500 ms budget leaves the real git calls before the hung one ample time on a
// loaded machine, and each reason names the call that timed out.
for (const [sleepOn, reason] of [
  ["status", /^skipped: git status of .* timed out/],
  ["worktree remove", /^git worktree remove .* timed out .*worktree state unknown/],
  ["worktree list", /^skipped: git worktree list timed out/],
]) {
  test(`cleanup --branch: a hung git ${sleepOn} times out within the cleanup budget`, () => {
    const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
    try {
      const logFile = path.join(base, "git.log");
      const gitPath = writeGitStub(base, { logFile, sleepOn });
      const started = Date.now();
      const res = cleanupWorktree({ repoRoot: main, branch: "issue-7" }, { gitCommand: gitPath, timeoutMs: 1500 });
      assert.ok(Date.now() - started < 4500, "the budget bounded the hung call");
      assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
      assert.match(res.reason, reason);
      assert.ok(existsSync(paths["issue-7"]));
      if (sleepOn === "worktree remove") {
        assert.doesNotMatch(readFileSync(logFile, "utf8"), /worktree prune/, "no prune after a killed remove");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("cleanup --branch: removes without --force, so git refuses an untracked file the pre-check missed", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const logFile = path.join(base, "git.log");
    const gitPath = writeGitStub(base, { logFile, emptySubcommand: "status" });
    const edit = path.join(paths["issue-7"], "untracked.txt");
    writeFileSync(edit, "local work\n");
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7" }, { gitCommand: gitPath });
    assert.equal(res.ok, true);
    assert.equal(res.removed, null);
    assert.match(res.reason, /^skipped:/);
    assert.ok(existsSync(paths["issue-7"]), "the worktree stays");
    assert.ok(listedPaths(main).includes(paths["issue-7"]));
    assert.equal(readFileSync(edit, "utf8"), "local work\n");
    const removeLine = readFileSync(logFile, "utf8").split("\n").find((l) => l.startsWith("worktree remove"));
    assert.equal(removeLine, `worktree remove ${paths["issue-7"]}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: gitignored content under tmp/ does not block the removal", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const wt = paths["issue-7"];
    writeFileSync(path.join(wt, ".gitignore"), "tmp/\n");
    git(wt, ["add", ".gitignore"]);
    git(wt, ["commit", "-q", "-m", "ignore tmp"]);
    mkdirSync(path.join(wt, "tmp/scratch"), { recursive: true });
    writeFileSync(path.join(wt, "tmp/scratch/notes.txt"), "scratch\n");
    const merged = git(wt, ["rev-parse", "HEAD"]).trim();
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7", headSha: merged });
    assert.equal(res.removed, wt, res.reason);
    assert.equal(existsSync(wt), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup: skips a target that contains a protected path", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const inside = path.join(paths["issue-7"], "scripts/github/merge-pr.mjs");
    const res = cleanupWorktree({ repoRoot: main, branch: "issue-7", protectedPaths: [main, inside] });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.ok(res.reason.includes(inside), res.reason);
    assert.ok(existsSync(paths["issue-7"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
