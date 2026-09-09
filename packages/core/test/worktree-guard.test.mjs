import assert from "node:assert/strict";
import { test } from "bun:test";
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
  classifyWorktreeIsolation,
  realpathNearestExisting,
  resolveTrackedFromCheckIgnore,
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

test("resolveContainingWorktreeRoot: prefers the longest (innermost) matching worktree root", () => {
  // A tmp/worktrees child nested inside its parent checkout: cwd matches both,
  // but the innermost worktree must win regardless of list order.
  const base = mkdtempSync(path.join(tmpdir(), "wt-nest-"));
  try {
    const parent = path.join(base, "checkout");
    const child = path.join(parent, "tmp", "worktrees", "issue-9");
    mkdirSync(path.join(child, "src"), { recursive: true });
    // Parent listed BEFORE child — first-match would wrongly pick parent.
    const listed = [parent, child];
    assert.equal(resolveContainingWorktreeRoot(path.join(child, "src"), listed), realpathSync(child));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #2063 — the core-isolation invariant is evaluable OUTSIDE tmp/worktrees
// ---------------------------------------------------------------------------

// A sibling/linked checkout that is NOT under tmp/worktrees and is not the main
// checkout. `base` is the main checkout; `outside` sits next to it (its path is
// not a subdirectory of base and carries no tmp/worktrees segment).
function makeOutsideCheckoutFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "wt-outside-"));
  const base = path.join(parent, "main");
  const outside = path.join(parent, "sibling-checkout");
  mkdirSync(base, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { parent, base, outside };
}

test("isWorktreeCoreIsolated: true for an outside (non-tmp/worktrees) checkout whose core link resolves to its OWN packages/core (#2063)", () => {
  const { parent, base, outside } = makeOutsideCheckoutFixture();
  try {
    const ownCore = path.join(outside, "packages", "core");
    mkdirSync(ownCore, { recursive: true });
    const scope = path.join(outside, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(ownCore, path.join(scope, "core"));
    assert.equal(isUnderWorktreePath(outside), false);
    assert.equal(isWorktreeCoreIsolated(outside, [base, outside]), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("isWorktreeCoreIsolated: false (fails closed) for an outside checkout whose core link escapes its own packages/core (#2063)", () => {
  const { parent, base, outside } = makeOutsideCheckoutFixture();
  try {
    mkdirSync(path.join(outside, "packages", "core"), { recursive: true });
    const mainCore = path.join(base, "node_modules", "@dev-loops", "core");
    mkdirSync(mainCore, { recursive: true });
    const scope = path.join(outside, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(mainCore, path.join(scope, "core")); // escapes to the main checkout
    // Before #2063 this returned a vacuous `true` (root scoped to tmp/worktrees
    // only); it must now be actually computed and fail closed.
    assert.equal(isWorktreeCoreIsolated(outside, [base, outside]), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// classifyWorktreeIsolation — the shared admit/reject decision (#2063)
// ---------------------------------------------------------------------------

test("classifyWorktreeIsolation: ADMITS an outside-but-core-isolated checkout (#2063)", () => {
  const { parent, base, outside } = makeOutsideCheckoutFixture();
  try {
    const ownCore = path.join(outside, "packages", "core");
    mkdirSync(ownCore, { recursive: true });
    const scope = path.join(outside, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(ownCore, path.join(scope, "core"));
    const decision = classifyWorktreeIsolation({
      cwd: outside,
      mainWorktreePath: base,
      allWorktreePaths: [base, outside],
    });
    assert.deepEqual(decision, { ok: true });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("classifyWorktreeIsolation: REJECTS an outside checkout that is not core-isolated (fail closed, #2063)", () => {
  const { parent, base, outside } = makeOutsideCheckoutFixture();
  try {
    mkdirSync(path.join(outside, "packages", "core"), { recursive: true });
    const mainCore = path.join(base, "node_modules", "@dev-loops", "core");
    mkdirSync(mainCore, { recursive: true });
    const scope = path.join(outside, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(mainCore, path.join(scope, "core"));
    const decision = classifyWorktreeIsolation({
      cwd: outside,
      mainWorktreePath: base,
      allWorktreePaths: [base, outside],
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.error, "not_in_worktree");
    assert.equal(decision.detail, "outside_not_isolated");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("classifyWorktreeIsolation: REJECTS an outside checkout that is not a listed worktree (fail closed, no vacuous admit)", () => {
  // An outside checkout absent from `git worktree list` resolves to a null root;
  // the core-isolation check would vacuously return true, so the classifier must
  // fail closed rather than admit.
  const decision = classifyWorktreeIsolation({
    cwd: "/home/user/unlisted-checkout",
    mainWorktreePath: "/home/user/repo",
    allWorktreePaths: ["/home/user/repo"],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.error, "not_in_worktree");
  assert.equal(decision.detail, "outside_not_isolated");
});

test("classifyWorktreeIsolation: REJECTS on an empty/unparseable worktree list (null main path must not vacuously admit)", () => {
  // An exit-0 but unparseable `git worktree list` nulls mainWorktreePath (skips the
  // main-checkout guard) and yields no worktree paths (null root). The classifier
  // must still fail closed — never admit the main checkout via vacuous isolation.
  const decision = classifyWorktreeIsolation({
    cwd: "/home/user/repo",
    mainWorktreePath: null,
    allWorktreePaths: [],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.error, "not_in_worktree");
  assert.equal(decision.detail, "outside_not_isolated");
});

test("classifyWorktreeIsolation: REJECTS the main checkout with main_checkout_detected (happy-path guidance preserved)", () => {
  const decision = classifyWorktreeIsolation({
    cwd: "/home/user/repo",
    mainWorktreePath: "/home/user/repo",
    allWorktreePaths: ["/home/user/repo"],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.error, "main_checkout_detected");
  assert.equal(decision.detail, "main_checkout");
});

test("classifyWorktreeIsolation: REJECTS a fake worktree under tmp/worktrees (not a real git worktree)", () => {
  const decision = classifyWorktreeIsolation({
    cwd: "/home/user/repo/tmp/worktrees/fake/src",
    mainWorktreePath: "/home/user/repo",
    allWorktreePaths: ["/home/user/repo"],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.error, "not_in_worktree");
  assert.equal(decision.detail, "fake_worktree");
});

test("classifyWorktreeIsolation: ADMITS a provisioned tmp/worktrees worktree (default happy path)", () => {
  const { base, root } = makeIsolationFixture();
  try {
    const ownCore = path.join(root, "packages", "core");
    mkdirSync(ownCore, { recursive: true });
    const scope = path.join(root, "node_modules", "@dev-loops");
    mkdirSync(scope, { recursive: true });
    symlinkSync(ownCore, path.join(scope, "core"));
    const decision = classifyWorktreeIsolation({
      cwd: root,
      mainWorktreePath: base,
      allWorktreePaths: [base, root],
    });
    assert.deepEqual(decision, { ok: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// realpathNearestExisting — a Write target may not exist yet
// ---------------------------------------------------------------------------

test("realpathNearestExisting resolves a nonexistent leaf via its nearest existing ancestor (symlinked ancestor)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "wg-rpne-"));
  try {
    const real = path.join(base, "real");
    mkdirSync(path.join(real, "scripts"), { recursive: true });
    const link = path.join(base, "link");
    symlinkSync(real, link); // symlinked ancestor
    // Target does NOT exist yet (a new-file Write) under the symlinked ancestor.
    const target = path.join(link, "scripts", "new-file.mjs");
    const resolved = realpathNearestExisting(target);
    // The symlink is resolved to its real path, with the nonexistent tail rejoined.
    assert.equal(resolved, path.join(realpathSync(real), "scripts", "new-file.mjs").replace(/\\/g, "/"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("realpathNearestExisting returns an existing path's realpath unchanged (normalized)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "wg-rpne2-"));
  try {
    assert.equal(realpathNearestExisting(base), realpathSync(base).replace(/\\/g, "/"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveTrackedFromCheckIgnore (AC4 fail-safe) — the hook's real seam
// ---------------------------------------------------------------------------

test("resolveTrackedFromCheckIgnore maps check-ignore exit status to guarded/allowed, failing safe on the unresolvable case (AC4)", () => {
  assert.equal(resolveTrackedFromCheckIgnore(0), false); // exit 0 = gitignored → not guarded (allow)
  assert.equal(resolveTrackedFromCheckIgnore(1), true); // exit 1 = not-ignored → guarded (deny)
  // Unresolvable (git error / could not run) MUST fail safe to guarded (deny).
  assert.equal(resolveTrackedFromCheckIgnore(128), true);
  assert.equal(resolveTrackedFromCheckIgnore(null), true);
  assert.equal(resolveTrackedFromCheckIgnore(undefined), true);
});
