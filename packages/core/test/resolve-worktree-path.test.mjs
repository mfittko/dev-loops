import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWorktreePath,
  WORKTREE_NAMESPACE,
} from "../src/loop/handoff-envelope.mjs";

test("resolveWorktreePath: issue → namespaced no-suffix path", () => {
  assert.equal(
    resolveWorktreePath({ repoRoot: "/repo", kind: "issue", number: 909 }),
    "/repo/tmp/worktrees/dev-loops/issue-909",
  );
});

test("resolveWorktreePath: pr → namespaced no-suffix path", () => {
  assert.equal(
    resolveWorktreePath({ repoRoot: "/repo", kind: "pr", number: 908 }),
    "/repo/tmp/worktrees/dev-loops/pr-908",
  );
});

test("resolveWorktreePath: normalizes kind case", () => {
  assert.equal(
    resolveWorktreePath({ repoRoot: "/repo", kind: "ISSUE", number: 1 }),
    "/repo/tmp/worktrees/dev-loops/issue-1",
  );
});

test("resolveWorktreePath: namespace constant matches path", () => {
  const p = resolveWorktreePath({ repoRoot: "/repo", kind: "issue", number: 1 });
  assert.ok(p.includes(`/${WORKTREE_NAMESPACE}/`));
});

test("resolveWorktreePath: rejects missing repoRoot", () => {
  assert.throws(() => resolveWorktreePath({ kind: "issue", number: 1 }), /repoRoot/);
});

test("resolveWorktreePath: rejects bad kind", () => {
  assert.throws(() => resolveWorktreePath({ repoRoot: "/r", kind: "branch", number: 1 }), /kind/);
});

test("resolveWorktreePath: rejects non-positive number", () => {
  assert.throws(() => resolveWorktreePath({ repoRoot: "/r", kind: "issue", number: 0 }), /number/);
});
