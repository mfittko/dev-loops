import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSuppressionMarkerPath,
  readSuppressionMarker,
  writeSuppressionMarker,
} from "../../scripts/loop/_post-convergence-review-suppression.mjs";
import { initGitFixture } from "../_helpers.mjs";

// #1441 follow-up: the default (non-injected) marker path used to be plain
// process.cwd()-relative (tmp/copilot-loop/...), so a marker written from one
// checkout of this repo (the human-run withdrawal tool) was invisible to a
// reader running from a different checkout (the loop, in a PR worktree) — the
// escape hatch would silently no-op. These tests exercise the DEFAULT path
// (no checkpointDir override), the one every production caller actually uses,
// via REAL git checkouts rather than an injected cwd, mirroring
// test/loop/repo-root-resolver.test.mjs.
function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

async function makeRepo() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-suppression-repo-")));
  initGitFixture(dir);
  return dir;
}

test("the default marker path: written from the main checkout, still found reading from a different worktree (#1441)", async () => {
  const repo = await makeRepo();
  const wtParent = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-suppression-wt-")));
  const worktree = path.join(wtParent, "worktree");
  const originalCwd = process.cwd();
  try {
    git(repo, ["worktree", "add", "-q", "-b", "feature", worktree]);
    const worktreeReal = await realpath(worktree);

    // Write from the MAIN checkout with NO explicit checkpointDir — the exact
    // default path an operator's shell uses when running the withdrawal tool.
    process.chdir(repo);
    const { filePath: writtenPath } = await writeSuppressionMarker({
      repo: "owner/repo",
      pr: 42,
      headSha: "newsha",
      lastReviewedHeadSha: "oldsha",
      reason: "pure doc/prose bump",
    });
    assert.ok(
      writtenPath.startsWith(repo),
      "the default write anchors under the writer's own checkout root, not an ambient subdirectory",
    );

    // Read from a DIFFERENT checkout (the worktree the loop actually runs
    // in) — the exact writer/reader divergence that made the plain
    // cwd-relative default silently inert.
    process.chdir(worktreeReal);
    const marker = await readSuppressionMarker({ repo: "owner/repo", pr: 42 });
    assert.ok(marker, "a marker written in the main checkout must still be found reading from the worktree");
    assert.equal(marker.headSha, "newsha");
    assert.equal(marker.lastReviewedHeadSha, "oldsha");
  } finally {
    process.chdir(originalCwd);
    await rm(wtParent, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("a stale marker in the reader's own checkout does not shadow a fresh head-matching one written elsewhere", async () => {
  const repo = await makeRepo();
  const wtParent = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-suppression-shadow-")));
  const worktree = path.join(wtParent, "worktree");
  const originalCwd = process.cwd();
  try {
    git(repo, ["worktree", "add", "-q", "-b", "feature", worktree]);
    const worktreeReal = await realpath(worktree);

    // Stale marker written in the worktree (the reader's own checkout, which
    // the scan may enumerate first) …
    process.chdir(worktreeReal);
    await writeSuppressionMarker({
      repo: "owner/repo",
      pr: 42,
      headSha: "stalehead",
      lastReviewedHeadSha: "olderhead",
      reason: "pure doc/prose bump",
    });
    // … then a fresh head-matching marker written from the main checkout.
    process.chdir(repo);
    await writeSuppressionMarker({
      repo: "owner/repo",
      pr: 42,
      headSha: "freshhead",
      lastReviewedHeadSha: "stalehead",
      reason: "pure doc/prose bump",
    });

    process.chdir(worktreeReal);
    const marker = await readSuppressionMarker({ repo: "owner/repo", pr: 42, headSha: "freshhead" });
    assert.ok(marker, "a head-matching marker must be found");
    assert.equal(marker.headSha, "freshhead", "the head-matching marker wins over the stale first-enumerated one");

    // Without a headSha the first valid marker still returns (previous behavior).
    const anyMarker = await readSuppressionMarker({ repo: "owner/repo", pr: 42 });
    assert.ok(anyMarker, "scan without a headSha still finds a marker");
  } finally {
    process.chdir(originalCwd);
    await rm(wtParent, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("readSuppressionMarker returns null for a marker recorded under a different repo/pr identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-suppression-identity-"));
  try {
    await writeSuppressionMarker(
      { repo: "owner/other-repo", pr: 99, headSha: "newsha", lastReviewedHeadSha: "oldsha", reason: "pure doc/prose bump" },
      { checkpointDir: dir },
    );
    const marker = await readSuppressionMarker({ repo: "owner/repo", pr: 42 }, { checkpointDir: dir });
    assert.equal(marker, null, "a marker recorded for a different repo/pr must not be mistaken for this one's");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildSuppressionMarkerPath: an explicit checkpointDir always wins over the anchored default", () => {
  const explicit = buildSuppressionMarkerPath("owner/repo", 42, { checkpointDir: "/tmp/explicit-dir" });
  assert.equal(explicit, path.join("/tmp/explicit-dir", "post-convergence-review-suppression.json"));
});
