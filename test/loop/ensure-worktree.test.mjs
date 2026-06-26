import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ensureWorktree,
  parseEnsureWorktreeCliArgs,
} from "../../scripts/loop/ensure-worktree.mjs";

// A real (tiny) git repo with one commit on `main`, so `git worktree add` works.
function makeRepo({ devloops } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wt-ensure-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  if (devloops) writeFileSync(path.join(root, ".devloops"), devloops);
  else writeFileSync(path.join(root, "README"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // A self-referential "origin" so `git fetch origin` succeeds offline.
  git("remote", "add", "origin", root);
  git("fetch", "-q", "origin");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

test("parseEnsureWorktreeCliArgs: defaults base to origin/main", () => {
  const o = parseEnsureWorktreeCliArgs(["--repo-root", "/r", "--issue", "909"]);
  assert.equal(o.base, "origin/main");
  assert.equal(o.issue, 909);
});

// ---------------------------------------------------------------------------
// Create at the canonical namespaced path + provisioning invoked
// ---------------------------------------------------------------------------

test("ensure: creates at the canonical namespaced path and provisions", async () => {
  const repo = makeRepo({ devloops: "version: 1\nworktree:\n  copyOnInit:\n    - secret.env\n" });
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
