import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";

import { isTrustedCommentAuthor, setCommentTrustConfig } from "@dev-loops/core/github/comment-trust";
import { CommentTrustConfigError, loadCommentTrustConfig, loadCommentTrustConfigOrExit } from "../../scripts/github/_comment-trust-config.mjs";

afterEach(() => setCommentTrustConfig());

const noFetch = () => {};
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
    loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main", fetchOrigin: noFetch });
    assert.equal(isTrustedCommentAuthor(ghUser("from-default")), true);
    assert.equal(isTrustedCommentAuthor(ghUser("from-worktree")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("githubActionsBot false from the default branch turns the bot trust off", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  githubActionsBot: false\n");
  try {
    loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main", fetchOrigin: noFetch });
    assert.equal(isTrustedCommentAuthor({ login: "github-actions[bot]", type: "Bot", association: "NONE" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no .devloops and no trust key apply the built-in defaults", () => {
  for (const devloops of [null, "version: 1\n"]) {
    const { dir } = repoWithDefaultBranch(devloops);
    try {
      assert.deepEqual(loadCommentTrustConfig({ repoRoot: dir, defaultBranch: "main", fetchOrigin: noFetch }), {});
      assert.equal(isTrustedCommentAuthor({ login: "github-actions[bot]", type: "Bot", association: "NONE" }), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an unresolved default branch, a failed fetch, an unreadable file and an invalid trust block refuse with a typed error", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - 'bad login'\n");
  const refusal = (options) => assert.throws(() => loadCommentTrustConfig({ repoRoot: dir, fetchOrigin: noFetch, ...options }), CommentTrustConfigError);
  try {
    const gitFailingOn = (needle) => (args) => {
      if (args.includes(needle)) throw new Error("boom");
      return execFileSync("git", args, { cwd: dir }).toString();
    };
    refusal({ git: () => { throw new Error("no origin/HEAD"); } });
    refusal({ defaultBranch: "main", fetchOrigin: () => { throw new Error("offline"); } });
    refusal({ defaultBranch: "main", git: gitFailingOn("show") });
    refusal({ defaultBranch: "main" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCommentTrustConfigOrExit reads the config from the repoRoot option, not the cwd", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - from-root\n");
  try {
    loadCommentTrustConfigOrExit({ repoRoot: dir, defaultBranch: "main", fetchOrigin: noFetch });
    assert.equal(isTrustedCommentAuthor(ghUser("from-root")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
