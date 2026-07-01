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
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  extractPrNumberFromGhPrMergeAnywhere,
  extractRepoFlagFromGhPrMergeAnywhere,
  extractRepoFlagFromGhPrCreateAnywhere,
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

test("isGhPrMergeCommand (first-segment, Pi extension) recognizes gh pr merge and ignores --help", () => {
  assert.equal(isGhPrMergeCommand("gh pr merge 1023 --squash"), true);
  assert.equal(isGhPrMergeCommand("gh pr merge"), true);
  assert.equal(isGhPrMergeCommand("gh pr merge --help"), false);
  assert.equal(isGhPrMergeCommand("gh pr ready 17"), false);
  // First-segment-only: merge in later segment is NOT detected (correct for post-execute use).
  assert.equal(isGhPrMergeCommand("echo ok && gh pr merge 1 --squash"), false);
});

test("commandContainsGhPrReady (all-segments, PreToolUse gate) detects ready in any segment", () => {
  assert.equal(commandContainsGhPrReady("gh pr ready 17"), true);
  assert.equal(commandContainsGhPrReady("echo ok && gh pr ready 17"), true);
  assert.equal(commandContainsGhPrReady("false && gh pr ready 42"), true);
  assert.equal(commandContainsGhPrReady("gh pr merge 1"), false);
});

test("commandContainsGhPrMerge (all-segments, PreToolUse gate) detects merge in any segment", () => {
  assert.equal(commandContainsGhPrMerge("gh pr merge 1 --squash"), true);
  assert.equal(commandContainsGhPrMerge("echo ok && gh pr merge 1 --squash"), true);
  assert.equal(commandContainsGhPrMerge("gh pr ready 1 && gh pr merge 1"), true);
  assert.equal(commandContainsGhPrMerge("gh pr ready 17"), false);
});

test("extractPrNumberFromGhPrMergeAnywhere finds merge PR number in any segment", () => {
  assert.equal(extractPrNumberFromGhPrMergeAnywhere("echo ok && gh pr merge 42 --squash"), 42);
  assert.equal(extractRepoFlagFromGhPrMergeAnywhere("echo ok && gh pr merge --repo other/repo 1"), "other/repo");
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

test("commandContainsGhPrCreate (all-segments, PreToolUse gate) detects create in any segment", () => {
  assert.equal(commandContainsGhPrCreate("gh pr create --fill"), true);
  assert.equal(commandContainsGhPrCreate("gh pr create --draft --title x"), true);
  assert.equal(commandContainsGhPrCreate("git push && gh pr create --fill"), true);
  assert.equal(commandContainsGhPrCreate("gh pr create --help"), false);
  // The canonical wrapper runs `gh pr create` inside node, so its Bash string never matches.
  assert.equal(commandContainsGhPrCreate("node scripts/github/create-pr.mjs --fill"), false);
  assert.equal(commandContainsGhPrCreate("gh pr merge 1"), false);
  assert.equal(commandContainsGhPrCreate("gh pr ready 1"), false);
});

test("extractRepoFlagFromGhPrCreateAnywhere reads --repo across segments", () => {
  assert.equal(extractRepoFlagFromGhPrCreateAnywhere("gh pr create --repo other/repo --fill"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrCreateAnywhere("git push && gh pr create --repo=other/repo"), "other/repo");
  assert.equal(extractRepoFlagFromGhPrCreateAnywhere("gh pr create --fill"), null);
});

test("gate detects gh pr create behind a newline separator", () => {
  assert.equal(commandContainsGhPrCreate("echo hi\ngh pr create --fill"), true);
  assert.equal(commandContainsGhPrCreate("echo hi\r\ngh pr create --fill"), true);
  // shared root cause: newline separator also caught for ready/merge
  assert.equal(commandContainsGhPrReady("echo hi\ngh pr ready 5"), true);
  assert.equal(commandContainsGhPrMerge("echo hi\ngh pr merge 5 --squash"), true);
});

test("gate detects gh pr create behind env-assignment/wrapper/path prefixes", () => {
  assert.equal(commandContainsGhPrCreate("GH_TOKEN=x gh pr create --fill"), true);
  assert.equal(commandContainsGhPrCreate("command gh pr create"), true);
  assert.equal(commandContainsGhPrCreate("env gh pr create"), true);
  assert.equal(commandContainsGhPrCreate("exec gh pr create"), true);
  assert.equal(commandContainsGhPrCreate("/usr/bin/gh pr create"), true);
  // remainder extraction stays consistent through the normalized prefix
  assert.equal(extractRepoFlagFromGhPrCreateAnywhere("GH_TOKEN=x gh pr create --repo other/repo"), "other/repo");
  // shared root cause: prefixes also caught for ready/merge
  assert.equal(commandContainsGhPrReady("GH_TOKEN=x gh pr ready 5"), true);
  assert.equal(commandContainsGhPrMerge("/usr/bin/gh pr merge 5"), true);
});

test("gate normalization does not over-match the wrapper or --help", () => {
  // wrapper must never match — first token `node` is neither env-assign nor `gh`
  assert.equal(commandContainsGhPrCreate("node scripts/github/create-pr.mjs --fill"), false);
  assert.equal(commandContainsGhPrCreate("GH_TOKEN=x node scripts/github/create-pr.mjs --fill"), false);
  // --help still exempts even behind a prefix
  assert.equal(commandContainsGhPrCreate("gh pr create --help"), false);
  assert.equal(commandContainsGhPrCreate("command gh pr create --help"), false);
});
