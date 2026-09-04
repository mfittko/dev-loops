import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMainCheckoutFastForwardCommand,
  buildWorktreeCleanupCommand,
  MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
  WORKTREE_CLEANUP_TIMEOUT_MS,
} from "../src/loop/main-checkout-ff.mjs";

test("buildMainCheckoutFastForwardCommand emits the exact guarded ff-only command (path single-quoted)", () => {
  assert.equal(
    buildMainCheckoutFastForwardCommand("/Users/x/dev-loops"),
    "git -C '/Users/x/dev-loops' fetch origin main && [ \"$(git -C '/Users/x/dev-loops' rev-parse --abbrev-ref HEAD)\" = main ] && git -C '/Users/x/dev-loops' merge --ff-only origin/main",
  );
});

test("buildMainCheckoutFastForwardCommand quotes a path containing a space", () => {
  assert.equal(
    buildMainCheckoutFastForwardCommand("/Users/My User/dev-loops"),
    "git -C '/Users/My User/dev-loops' fetch origin main && [ \"$(git -C '/Users/My User/dev-loops' rev-parse --abbrev-ref HEAD)\" = main ] && git -C '/Users/My User/dev-loops' merge --ff-only origin/main",
  );
});

test("buildMainCheckoutFastForwardCommand escapes a single quote in the path", () => {
  const cmd = buildMainCheckoutFastForwardCommand("/a'b");
  assert.ok(cmd.startsWith("git -C '/a'\\''b' fetch"), `unexpected command prefix: ${cmd}`);
  assert.ok(
    cmd.includes("[ \"$(git -C '/a'\\''b' rev-parse --abbrev-ref HEAD)\" = main ] &&"),
    `expected the guarded rev-parse form in command: ${cmd}`,
  );
});

test("the ff timeouts are finite numbers", () => {
  assert.equal(Number.isFinite(MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS), true);
  assert.equal(Number.isFinite(MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS), true);
  assert.ok(MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS > 0);
  assert.ok(MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS > 0);
});

test("buildWorktreeCleanupCommand: runs cleanup-worktree.mjs from the main checkout for the PR", () => {
  const cmd = buildWorktreeCleanupCommand("/Users/My User/dev-loops", "1234");
  // Runs from the main checkout (hook cwd can be inside the worktree being removed).
  assert.ok(cmd.includes("node '/Users/My User/dev-loops/scripts/loop/cleanup-worktree.mjs'"), cmd);
  assert.ok(cmd.includes("--repo-root '/Users/My User/dev-loops'"), cmd);
  assert.ok(cmd.includes('--pr "1234"'), cmd);
  // Non-fatal: a failure must not break the merge-completion flow.
  assert.ok(cmd.includes("|| true"), cmd);
  // Consumer no-op when the checkout lacks the dev-loops cleanup script.
  assert.ok(cmd.includes("if [ -f '"), cmd);
});

test("buildWorktreeCleanupCommand: returns empty string when no PR number", () => {
  assert.equal(buildWorktreeCleanupCommand("/Users/x/dev-loops"), "");
  assert.equal(buildWorktreeCleanupCommand("/Users/x/dev-loops", null), "");
  assert.equal(buildWorktreeCleanupCommand("/Users/x/dev-loops", "  "), "");
});

test("WORKTREE_CLEANUP_TIMEOUT_MS is a positive finite number", () => {
  assert.equal(Number.isFinite(WORKTREE_CLEANUP_TIMEOUT_MS), true);
  assert.ok(WORKTREE_CLEANUP_TIMEOUT_MS > 0);
});
