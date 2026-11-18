import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";

import { isTrustedCommentAuthor, setCommentTrustConfig } from "@dev-loops/core/github/comment-trust";
import { CommentTrustConfigError, loadCommentTrustConfig, loadCommentTrustConfigOrExit } from "../../scripts/github/_comment-trust-config.mjs";
import { initGitFixture, runGitFixture } from "../_helpers.mjs";

afterEach(() => setCommentTrustConfig());

const ghUser = (login) => ({ login, type: "User", association: "NONE" });

function repoWithDefaultBranch(devloops) {
  const dir = mkdtempSync(join(tmpdir(), "trust-cfg-"));
  const git = (...args) => runGitFixture(dir, args);
  initGitFixture(dir, { branch: "main", commit: null });
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
  initGitFixture(noRef, { branch: "main", commit: null });
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
      return runGitFixture(valid.dir, args);
    };
    const detail = (dir, options) => {
      try {
        loadCommentTrustConfig({ repoRoot: dir, ...options });
      } catch (error) {
        return error.message;
      }
      return "";
    };
    assert.equal(state(valid.dir, { git: () => { throw new Error("no origin/HEAD"); } }), "default_branch_unresolved");
    assert.match(detail(valid.dir, { git: () => { throw new Error("no origin/HEAD"); } }), /run: git remote set-head origin --auto$/);
    assert.equal(state(noRef, { defaultBranch: "main" }), "missing");
    assert.match(detail(noRef, { defaultBranch: "main" }), /refusing to run: the local origin\/main ref is absent.*run: git fetch origin$/);
    assert.match(detail(invalid.dir, { defaultBranch: "main" }), /then run: git fetch origin$/);
    assert.equal(state(valid.dir, { defaultBranch: "main", git: gitFailingOn("show") }), "malformed");
    assert.match(detail(valid.dir, { defaultBranch: "main", git: gitFailingOn("show") }), /fix \.devloops on origin\/main, then run: git fetch origin$/);
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

test("an entry script with an invalid default-branch trust block prints one JSON refusal with the typed state and exits 3, while --help still exits 0", () => {
  const { dir, git } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - 'bad login'\n");
  try {
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const script = new URL("../../scripts/github/list-review-threads.mjs", import.meta.url).pathname;
    const help = spawnSync(process.execPath, [script, "--help"], { cwd: dir, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /3 {2}Comment trust config refused/);
    assert.equal(spawnSync(process.execPath, [script, "-h"], { cwd: dir, encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [script, "--unresolved-only", "--help"], { cwd: dir, encoding: "utf8" }).status, 0);
    const run = spawnSync(process.execPath, [script, "--repo", "o/r", "--pr", "1"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 3);
    assert.equal(run.stdout, "");
    const refusal = JSON.parse(run.stderr.trim());
    assert.equal(refusal.ok, false);
    assert.equal(refusal.state, "invalid");
    assert.match(refusal.error, /^comment trust config: invalid: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a load run from a checkout subdirectory still reads the root .devloops", () => {
  const { dir } = repoWithDefaultBranch("version: 1\ntrust:\n  githubActionsBot: false\n");
  try {
    mkdirSync(join(dir, "sub"));
    loadCommentTrustConfig({ repoRoot: join(dir, "sub"), defaultBranch: "main" });
    assert.equal(isTrustedCommentAuthor({ login: "github-actions[bot]", type: "Bot", association: "NONE" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a help token that is an option value does not skip the trust load, while a real help flag does", () => {
  const { dir, git } = repoWithDefaultBranch("version: 1\ntrust:\n  reviewers:\n    - 'bad login'\n");
  try {
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const script = new URL("../../scripts/github/capture-review-threads.mjs", import.meta.url).pathname;
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(run("--repo", "o/r", "--pr", "1", "--output", "-h").status, 3);
    assert.equal(run("--repo", "o/r", "--pr", "1", "--output", "--help").status, 3);
    assert.equal(run("--repo", "o/r", "-h").status, 0);
    assert.equal(run("--repo", "o/r", "--help").status, 0);
    assert.equal(run("--repo=o/r", "--help").status, 0);
    const listScript = new URL("../../scripts/github/list-review-threads.mjs", import.meta.url).pathname;
    assert.equal(spawnSync(process.execPath, [listScript, "--unresolved-only", "--help"], { cwd: dir, encoding: "utf8" }).status, 0);
    const title = spawnSync(process.execPath, [new URL("../../scripts/github/waive-adr-tripwire.mjs", import.meta.url).pathname, "--repo", "o/r", "--pr", "1", "--output", "--help"], { cwd: dir, encoding: "utf8" });
    assert.equal(title.status, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
