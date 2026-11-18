import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";

import { isTrustedCommentAuthor, setCommentTrustConfig } from "@dev-loops/core/github/comment-trust";
import { CommentTrustConfigError, loadCommentTrustConfig, loadCommentTrustConfigOrExit } from "../../scripts/github/_comment-trust-config.mjs";

afterEach(() => setCommentTrustConfig());

const ghUser = (login) => ({ login, type: "User", association: "NONE" });

function repoWithDefaultBranch(devloops) {
  const dir = mkdtempSync(join(tmpdir(), "trust-cfg-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
  git("init", "-q", "-b", "main");
  if (devloops !== null) {
    writeFileSync(join(dir, ".devloops"), devloops);
    git("add", ".devloops");
  }
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { dir, git };
}

test("the default-branch list is trusted; a worktree-only reviewer is not", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - from-default\n");
  try {
    writeFileSync(join(dir, ".devloops"), "version: 1\ntrust:\n  reviewers:\n    - from-worktree\n");
    loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main" });
    assert.equal(isTrustedCommentAuthor(ghUser("from-default")), true);
    assert.equal(isTrustedCommentAuthor(ghUser("from-worktree")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("githubActionsBot false from the default branch turns the bot trust off", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  githubActionsBot: false\n");
  try {
    loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main" });
    assert.equal(isTrustedCommentAuthor({ login: "github-actions[bot]", type: "Bot", association: "NONE" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no .devloops and no trust key apply the built-in defaults", () => {
  for (const devloops of [null, "version: 1\n"]) {
    const { dir } = repoWithDefaultBranch(devloops);
    try {
      assert.deepEqual(loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main" }), {});
      assert.equal(isTrustedCommentAuthor({ login: "github-actions[bot]", type: "Bot", association: "NONE" }), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Each refusal outcome runs against a fixture whose default-branch trust block is valid, so only the outcome under test can refuse.
test("each load outcome refuses with its own typed state", () => {
  const valid = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - fine-login\n");
  const invalid = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - 'bad login'\n");
  const noRef = mkdtempSync(join(tmpdir(), "trust-cfg-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: noRef });
  const state = (dir, options) => {
    try {
      loadCommentTrustConfig({ repoRoot: dir, ...options });
    } catch (error) {
      assert.ok(error instanceof CommentTrustConfigError);
      return error.state;
    }
    return "loaded";
  };
  try {
    const gitFailingOn = (needle) => (args) => {
      if (args.includes(needle)) throw new Error("boom");
      return execFileSync("git", args, { cwd: valid.dir }).toString();
    };
    assert.equal(state(valid.dir, { git: () => { throw new Error("no origin/HEAD"); } }), "default_branch_unresolved");
    assert.equal(state(noRef, { defaultBranch: "main" }), "missing");
    assert.equal(state(valid.dir, { defaultBranch: "main", git: gitFailingOn("show") }), "malformed");
    assert.equal(state(invalid.dir, { defaultBranch: "main" }), "invalid");
    assert.equal(state(valid.dir, { defaultBranch: "main" }), "loaded");
  } finally {
    for (const dir of [valid.dir, invalid.dir, noRef]) rmSync(dir, { recursive: true, force: true });
  }
});

test("the load never fetches: a throwing fetchOrigin option is ignored and the local ref is read", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - from-local-ref\n");
  try {
    loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main", fetchOrigin: () => { throw new Error("network used"); } });
    assert.equal(isTrustedCommentAuthor(ghUser("from-local-ref")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCommentTrustConfigOrExit reads the config from the repoRoot option", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - from-root\n");
  try {
    loadCommentTrustConfigOrExit({ repoRoot: dir, defaultBranch: "main" });
    assert.equal(isTrustedCommentAuthor(ghUser("from-root")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry script with an invalid default-branch trust block prints one JSON refusal with the typed state and exits 2", () => {
  const { dir, git } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - 'bad login'\n");
  try {
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const script = new URL("../../scripts/github/list-review-threads.mjs", import.meta.url).pathname;
    const run = spawnSync(process.execPath, [script, "--help"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, "");
    const refusal = JSON.parse(run.stderr.trim());
    assert.equal(refusal.ok, false);
    assert.equal(refusal.state, "invalid");
    assert.match(refusal.error, /^comment trust config: invalid: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
