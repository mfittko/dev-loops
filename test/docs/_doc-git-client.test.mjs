import assert from "node:assert/strict";
import { test } from "bun:test";

import { resolveBaseRef } from "../../scripts/docs/_doc-git-client.mjs";

// Shared-owner coverage for the base-ref candidate order used by BOTH doc
// validators (validate-changelog-completeness.mjs, validate-decision-records.mjs).
// The per-validator caller suites keep only their distinct diffNameOnly + policy
// behavior; candidate order lives here so the two cannot drift.

function fakeGit({ symbolicRef, mergeBase } = {}) {
  const mergeBaseCalls = [];
  return {
    mergeBaseCalls,
    async symbolicRef() {
      if (symbolicRef === undefined) throw new Error("no origin/HEAD");
      return symbolicRef;
    },
    async mergeBase(a, b) {
      mergeBaseCalls.push([a, b]);
      if (typeof mergeBase === "function") return mergeBase(a, b);
      if (typeof mergeBase === "string") return mergeBase;
      throw new Error("fatal: Not a valid object name");
    },
  };
}

test("resolveBaseRef uses origin/HEAD's default branch first", async () => {
  const git = fakeGit({ symbolicRef: "refs/remotes/origin/main", mergeBase: "abc123" });
  assert.equal(await resolveBaseRef(git, {}), "abc123");
  assert.deepEqual(git.mergeBaseCalls, [["origin/main", "HEAD"]]);
});

test("resolveBaseRef falls back to GITHUB_BASE_REF before main/master when origin/HEAD is unavailable", async () => {
  const git = fakeGit({ mergeBase: (a) => (a === "origin/feature-base" ? "def456" : "") });
  assert.equal(await resolveBaseRef(git, { GITHUB_BASE_REF: "feature-base" }), "def456");
  assert.deepEqual(git.mergeBaseCalls, [["origin/feature-base", "HEAD"]]);
});

test("resolveBaseRef tries origin/main then origin/master when no origin/HEAD or GITHUB_BASE_REF", async () => {
  const git = fakeGit({ mergeBase: (a) => (a === "origin/master" ? "aa11" : "") });
  assert.equal(await resolveBaseRef(git, {}), "aa11");
  assert.deepEqual(git.mergeBaseCalls, [["origin/main", "HEAD"], ["origin/master", "HEAD"]]);
});

test("resolveBaseRef returns null when no candidate resolves (degrade path)", async () => {
  const git = fakeGit({}); // symbolicRef + every mergeBase throw
  assert.equal(await resolveBaseRef(git, {}), null);
  assert.ok(git.mergeBaseCalls.some(([a]) => a === "origin/main"), "candidates were attempted");
});
