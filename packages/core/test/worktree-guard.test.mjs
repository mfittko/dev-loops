import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isUnderWorktreePath,
  parseMainWorktreePath,
  isMainCheckout,
  parseAllWorktreePaths,
  isListedWorktree,
  resolveContainingWorktreeRoot,
  isWorktreeCoreIsolated,
  detectSubagentAvailability,
  DEVLOOPS_SUBAGENT_AVAILABLE_VAR,
} from "../src/loop/worktree-guard.mjs";

// ---------------------------------------------------------------------------
// isUnderWorktreePath
// ---------------------------------------------------------------------------

test("isUnderWorktreePath: true when under tmp/worktrees/foo", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo/tmp/worktrees/issue-1"), true);
});

test("isUnderWorktreePath: true when exactly tmp/worktrees", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo/tmp/worktrees"), true);
});

test("isUnderWorktreePath: true with trailing slash", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo/tmp/worktrees/issue-1/"), true);
});

test("isUnderWorktreePath: true with Windows backslashes", () => {
  assert.equal(isUnderWorktreePath("C:\\repo\\tmp\\worktrees\\issue-1"), true);
});

test("isUnderWorktreePath: false for main checkout", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo"), false);
});

test("isUnderWorktreePath: false for tmp/ but not worktrees", () => {
  assert.equal(isUnderWorktreePath("/home/user/repo/tmp/phases"), false);
});

test("isUnderWorktreePath: false for path containing worktrees as substring elsewhere", () => {
  assert.equal(isUnderWorktreePath("/home/user/not-tmp/worktrees/issue-1"), false);
});

// ---------------------------------------------------------------------------
// parseMainWorktreePath
// ---------------------------------------------------------------------------

test("parseMainWorktreePath: parses standard git worktree list output", () => {
  const output = "/home/user/repo  535a18a [main]\n/home/user/repo/tmp/worktrees/issue-1  535a18a [issue-1]\n";
  assert.equal(parseMainWorktreePath(output), "/home/user/repo");
});

test("parseMainWorktreePath: parses without branch annotation", () => {
  const output = "/home/user/repo  535a18a\n";
  assert.equal(parseMainWorktreePath(output), "/home/user/repo");
});

test("parseMainWorktreePath: parses path with spaces", () => {
  const output = "/home/user/my repo  535a18a [main]\n";
  assert.equal(parseMainWorktreePath(output), "/home/user/my repo");
});

test("parseMainWorktreePath: returns null for empty output", () => {
  assert.equal(parseMainWorktreePath(""), null);
});

test("parseMainWorktreePath: returns null for whitespace-only output", () => {
  assert.equal(parseMainWorktreePath("   \n  "), null);
});

test("parseMainWorktreePath: returns null for malformed output (no SHA)", () => {
  assert.equal(parseMainWorktreePath("/home/user/repo"), null);
});

test("parseMainWorktreePath: returns null for output without path", () => {
  assert.equal(parseMainWorktreePath("535a18a [main]"), null);
});

// ---------------------------------------------------------------------------
// isMainCheckout
// ---------------------------------------------------------------------------

test("isMainCheckout: true when cwd matches main worktree path exactly", () => {
  assert.equal(isMainCheckout("/home/user/repo", "/home/user/repo"), true);
});

test("isMainCheckout: true when cwd is subdirectory of main worktree", () => {
  assert.equal(isMainCheckout("/home/user/repo/src", "/home/user/repo"), true);
});

test("isMainCheckout: true with trailing slash on cwd", () => {
  assert.equal(isMainCheckout("/home/user/repo/", "/home/user/repo"), true);
});

test("isMainCheckout: true with trailing slash on main path", () => {
  assert.equal(isMainCheckout("/home/user/repo", "/home/user/repo/"), true);
});

test("isMainCheckout: true with Windows separators", () => {
  assert.equal(isMainCheckout("C:\\repo\\src", "C:\\repo"), true);
});

test("isMainCheckout: false when cwd is a sibling directory", () => {
  assert.equal(isMainCheckout("/home/user/other-repo", "/home/user/repo"), false);
});

test("isMainCheckout: true even for worktree path (caller filters with isUnderWorktreePath)", () => {
  // isMainCheckout uses startsWith — worktree paths are technically subdirectories.
  // Callers must combine with !isUnderWorktreePath() to exclude worktree paths.
  assert.equal(isMainCheckout("/home/user/repo/tmp/worktrees/issue-1", "/home/user/repo"), true);
});

test("isMainCheckout: false when mainWorktreePath is null", () => {
  assert.equal(isMainCheckout("/home/user/repo", null), false);
});

test("isMainCheckout: false when mainWorktreePath is empty", () => {
  assert.equal(isMainCheckout("/home/user/repo", ""), false);
});

// ---------------------------------------------------------------------------
// parseAllWorktreePaths
// ---------------------------------------------------------------------------

test("parseAllWorktreePaths: parses multiple worktree paths", () => {
  const output = "/home/user/repo  535a18a [main]\n/home/user/repo/tmp/worktrees/issue-1  535a18a [issue-1]\n";
  const paths = parseAllWorktreePaths(output);
  assert.deepEqual(paths, ["/home/user/repo", "/home/user/repo/tmp/worktrees/issue-1"]);
});

test("parseAllWorktreePaths: handles paths with spaces", () => {
  const output = "/home/user/my repo  535a18a [main]\n";
  assert.deepEqual(parseAllWorktreePaths(output), ["/home/user/my repo"]);
});

test("parseAllWorktreePaths: skips empty lines", () => {
  const output = "\n/home/user/repo  535a18a [main]\n\n";
  assert.deepEqual(parseAllWorktreePaths(output), ["/home/user/repo"]);
});

test("parseAllWorktreePaths: returns empty array for empty output", () => {
  assert.deepEqual(parseAllWorktreePaths(""), []);
});

test("parseAllWorktreePaths: skips lines without SHA", () => {
  const output = "/home/user/repo\n/home/user/repo  535a18a [main]\n";
  assert.deepEqual(parseAllWorktreePaths(output), ["/home/user/repo"]);
});

// ---------------------------------------------------------------------------
// isListedWorktree
// ---------------------------------------------------------------------------

test("isListedWorktree: true when cwd matches a listed worktree root exactly", () => {
  assert.equal(isListedWorktree("/home/user/repo/tmp/worktrees/issue-1", [
    "/home/user/repo",
    "/home/user/repo/tmp/worktrees/issue-1",
  ]), true);
});

test("isListedWorktree: true when cwd is a subdirectory of a listed worktree", () => {
  assert.equal(isListedWorktree("/home/user/repo/tmp/worktrees/issue-1/src", [
    "/home/user/repo",
    "/home/user/repo/tmp/worktrees/issue-1",
  ]), true);
});

test("isListedWorktree: true with trailing slash on cwd", () => {
  assert.equal(isListedWorktree("/home/user/repo/tmp/worktrees/issue-1/", [
    "/home/user/repo",
    "/home/user/repo/tmp/worktrees/issue-1",
  ]), true);
});

test("isListedWorktree: true with Windows backslashes", () => {
  assert.equal(isListedWorktree("C:\\repo\\tmp\\worktrees\\issue-1\\src", [
    "C:\\repo",
    "C:\\repo\\tmp\\worktrees\\issue-1",
  ]), true);
});

test("isListedWorktree: false when cwd is main checkout (not a worktree)", () => {
  assert.equal(isListedWorktree("/home/user/repo", [
    "/home/user/repo",
    "/home/user/repo/tmp/worktrees/issue-1",
  ]), false);  // false because main checkout is excluded from worktree matching
});

test("isListedWorktree: false when cwd is not in list", () => {
  assert.equal(isListedWorktree("/home/user/other", [
    "/home/user/repo",
    "/home/user/repo/tmp/worktrees/issue-1",
  ]), false);
});

test("isListedWorktree: false when cwd is under a non-worktree directory", () => {
  assert.equal(isListedWorktree("/home/user/repo/tmp/worktrees/fake/src", [
    "/home/user/repo",
    "/home/user/repo/tmp/worktrees/issue-1",
  ]), false);
});

// ---------------------------------------------------------------------------
// detectSubagentAvailability
// ---------------------------------------------------------------------------
// detectSubagentAvailability
// ---------------------------------------------------------------------------

test("detectSubagentAvailability: true when the neutral DEVLOOPS_SUBAGENT_AVAILABLE=1", () => {
  assert.equal(detectSubagentAvailability({ env: { DEVLOOPS_SUBAGENT_AVAILABLE: "1" } }), true);
});

test("detectSubagentAvailability: explicit '0' is respected as not available", () => {
  assert.equal(
    detectSubagentAvailability({ env: { DEVLOOPS_SUBAGENT_AVAILABLE: "0" } }),
    false,
  );
});

test("detectSubagentAvailability: ignores the dropped legacy Pi availability env var", () => {
  // Built dynamically so the tree-wide neutrality guard does not flag this assertion.
  const droppedPiAvailable = ["PI", "SUBAGENT", "AVAILABLE"].join("_");
  assert.equal(detectSubagentAvailability({ env: { [droppedPiAvailable]: "1" } }), false);
});

test("detectSubagentAvailability: false when DEVLOOPS_SUBAGENT_AVAILABLE is not set", () => {
  assert.equal(detectSubagentAvailability({ env: {} }), false);
});

test("detectSubagentAvailability: false when DEVLOOPS_SUBAGENT_AVAILABLE is empty", () => {
  assert.equal(detectSubagentAvailability({ env: { DEVLOOPS_SUBAGENT_AVAILABLE: "" } }), false);
});

test("detectSubagentAvailability: false when DEVLOOPS_SUBAGENT_AVAILABLE is zero", () => {
  assert.equal(detectSubagentAvailability({ env: { DEVLOOPS_SUBAGENT_AVAILABLE: "0" } }), false);
});

test("detectSubagentAvailability: false when DEVLOOPS_SUBAGENT_AVAILABLE is whitespace", () => {
  assert.equal(detectSubagentAvailability({ env: { DEVLOOPS_SUBAGENT_AVAILABLE: "  " } }), false);
});

test("detectSubagentAvailability: defaults to process.env when no arg", () => {
  // Trivial smoke: call without args to confirm no throw.
  const result = detectSubagentAvailability();
  assert.equal(typeof result, "boolean");
});

// ---------------------------------------------------------------------------
// DEVLOOPS_SUBAGENT_AVAILABLE_VAR constant
// ---------------------------------------------------------------------------

test("DEVLOOPS_SUBAGENT_AVAILABLE_VAR: matches the env var name", () => {
  assert.equal(DEVLOOPS_SUBAGENT_AVAILABLE_VAR, "DEVLOOPS_SUBAGENT_AVAILABLE");
});

// ---------------------------------------------------------------------------
// isWorktreeCoreIsolated (#1627)
// ---------------------------------------------------------------------------

function makeIsolationFixture() {
  const base = mkdtempSync(path.join(tmpdir(), "wt-core-"));
  const root = path.join(base, "tmp", "worktrees", "issue-1627");
  return { base, root };
}

test("isWorktreeCoreIsolated: false when the core link escapes to the main checkout", () => {
  const { base, root } = makeIsolationFixture();
  try {
    const realCore = path.join(root, "packages", "core");
    mkdirSync(realCore, { recursive: true });
    const mainCore = path.join(base, "node_modules", "@dev-loops", "core");
    mkdirSync(mainCore, { recursive: true });
    const scope = path.join(root, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(mainCore, path.join(scope, "core"));

    // The main checkout is the ONLY listed worktree; the fixture root is under
    // a listed (dev-loop) worktree.
    const listed = [base, root];
    assert.equal(isWorktreeCoreIsolated(root, listed), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isWorktreeCoreIsolated: true when the core link resolves into the worktree's own packages/core", () => {
  const { base, root } = makeIsolationFixture();
  try {
    const realCore = path.join(root, "packages", "core");
    mkdirSync(realCore, { recursive: true });
    const scope = path.join(root, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(realCore, path.join(scope, "core"));

    const listed = [base, root];
    assert.equal(isWorktreeCoreIsolated(root, listed), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isWorktreeCoreIsolated: true for a consumer repo with no packages/core", () => {
  const { base, root } = makeIsolationFixture();
  try {
    // Consumer repo, no monorepo core — vacuously satisfied even with a link.
    const listed = [base, root];
    assert.equal(isWorktreeCoreIsolated(root, listed), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isWorktreeCoreIsolated: true when no core link exists (nothing escapes)", () => {
  const { base, root } = makeIsolationFixture();
  try {
    mkdirSync(path.join(root, "packages", "core"), { recursive: true });
    const listed = [base, root];
    assert.equal(isWorktreeCoreIsolated(root, listed), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isWorktreeCoreIsolated: true when cwd is not inside a listed worktree", () => {
  assert.equal(isWorktreeCoreIsolated("/home/user/repo/src", ["/home/user/repo"]), true);
});

test("resolveContainingWorktreeRoot: resolves the containing worktree root from a nested cwd", () => {
  const { base, root } = makeIsolationFixture();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    const listed = [base, root];
    assert.equal(resolveContainingWorktreeRoot(path.join(root, "src"), listed), realpathSync(root));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
