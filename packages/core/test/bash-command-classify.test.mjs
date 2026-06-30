import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_REPO_SLUG,
  normalizeGitHubRepoSlug,
  isMergeCapableCommand,
  isGhPrReadyCommand,
  extractPrNumberFromGhPrReady,
  extractRepoFlagFromGhPrReady,
  isGhPrMergeCommand,
  extractPrNumberFromGhPrMerge,
  extractRepoFlagFromGhPrMerge,
} from "../src/loop/bash-command-classify.mjs";

test("TARGET_REPO_SLUG is the dev-loops repo", () => {
  assert.equal(TARGET_REPO_SLUG, "mfittko/dev-loops");
});

test("normalizeGitHubRepoSlug handles ssh/https/http/git/git+ssh forms", () => {
  assert.equal(normalizeGitHubRepoSlug("git@github.com:mfittko/dev-loops.git"), "mfittko/dev-loops");
  assert.equal(normalizeGitHubRepoSlug("https://github.com/mfittko/dev-loops"), "mfittko/dev-loops");
  assert.equal(normalizeGitHubRepoSlug("http://github.com/mfittko/dev-loops.git"), "mfittko/dev-loops");
  assert.equal(normalizeGitHubRepoSlug("git://github.com/mfittko/dev-loops.git"), "mfittko/dev-loops");
  assert.equal(normalizeGitHubRepoSlug("ssh://git@github.com/mfittko/dev-loops.git"), "mfittko/dev-loops");
  assert.equal(normalizeGitHubRepoSlug("git:github.com/MFITTKO/Dev-Loops"), "mfittko/dev-loops");
  assert.equal(normalizeGitHubRepoSlug("not a url"), null);
});

test("isGhPrReadyCommand recognizes gh pr ready and ignores --help", () => {
  assert.equal(isGhPrReadyCommand("gh pr ready 17"), true);
  assert.equal(isGhPrReadyCommand("gh pr ready"), true);
  assert.equal(isGhPrReadyCommand("gh pr ready --help"), false);
  assert.equal(isGhPrReadyCommand("gh pr view 17"), false);
});

test("extractPrNumberFromGhPrReady skips value-flags and returns the PR number", () => {
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready 17"), 17);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready --repo mfittko/dev-loops 42"), 42);
  assert.equal(extractPrNumberFromGhPrReady("gh pr ready"), null);
});

test("extractRepoFlagFromGhPrReady reads -r/--repo and --repo=value", () => {
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready --repo other/repo 1"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready --repo=other/repo 1"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrReady("gh pr ready 1"), null);
});

test("isGhPrMergeCommand recognizes gh pr merge (first segment) and ignores --help", () => {
  assert.equal(isGhPrMergeCommand("gh pr merge 1023 --squash"), true);
  assert.equal(isGhPrMergeCommand("gh pr merge"), true);
  assert.equal(isGhPrMergeCommand("gh pr merge --help"), false);
  assert.equal(isGhPrMergeCommand("gh pr ready 17"), false);
});

test("extractPrNumber/RepoFlag FromGhPrMerge mirror the ready extractors", () => {
  assert.equal(extractPrNumberFromGhPrMerge("gh pr merge 1023 --squash"), 1023);
  assert.equal(extractPrNumberFromGhPrMerge("gh pr merge --repo mfittko/dev-loops 42"), 42);
  assert.equal(extractPrNumberFromGhPrMerge("gh pr merge --squash"), null);
  assert.equal(extractRepoFlagFromGhPrMerge("gh pr merge --repo other/repo 1"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrMerge("gh pr merge --repo=other/repo 1"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrMerge("gh pr merge 1"), null);
});

test("isMergeCapableCommand detects gh pr merge / git merge, ignores aborts and help", () => {
  assert.equal(isMergeCapableCommand("gh pr merge 17 --squash"), true);
  assert.equal(isMergeCapableCommand("git merge origin/main"), true);
  assert.equal(isMergeCapableCommand("echo hi && gh pr merge 1"), true);
  assert.equal(isMergeCapableCommand("git merge --abort"), false);
  assert.equal(isMergeCapableCommand("gh pr merge --help"), false);
  assert.equal(isMergeCapableCommand("npm test"), false);
});
