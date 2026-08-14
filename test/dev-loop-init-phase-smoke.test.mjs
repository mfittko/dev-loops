import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { initializePhase, parseCliArgs } from "../skills/dev-loop/scripts/init-phase.mjs";

test("init-phase parses cli args via the shared phase-file parser", () => {
  assert.deepEqual(
    parseCliArgs(["--project-root", "/repo", "--phase", "phase-2", "--patch", '{"status":"planning"}']),
    {
      projectRoot: "/repo",
      phase: "phase-2",
      patch: { status: "planning" },
    },
  );
});

test("init-phase materializes DoD-enabled planning artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-init-phase-"));
  const skillDir = path.join(tempDir, ".pi", "skills", "dev-loop");

  try {
    await rm(skillDir, { recursive: true, force: true });
    await initializePhase(tempDir, "phase-2", {
      status: "planning",
      notes: ["created by root smoke test"],
    });

    const manifest = JSON.parse(
      await readFile(path.join(tempDir, "tmp", "phases", "phase-2", "manifest.json"), "utf8"),
    );
    const phaseDoc = await readFile(path.join(tempDir, "docs", "phases", "phase-2.md"), "utf8");
    const variantA = await readFile(path.join(tempDir, "tmp", "phases", "phase-2", "variant-a.md"), "utf8");
    const mergedPlan = await readFile(path.join(tempDir, "tmp", "phases", "phase-2", "merged-plan.md"), "utf8");
    const review = await readFile(path.join(tempDir, "tmp", "phases", "phase-2", "review.md"), "utf8");

    assert.equal(manifest.status, "planning");
    assert.deepEqual(manifest.artifacts, [
      "../../../docs/phases/phase-2.md",
      "manifest.json",
      "merged-plan.md",
      "review.md",
      "variant-a.md",
      "variant-b.md",
    ]);
    assert.match(phaseDoc, /# phase-2 durable plan/);
    assert.match(phaseDoc, /## Definition of done/);
    assert.match(variantA, /# Phase phase-2 variant a/);
    assert.match(mergedPlan, /# Phase phase-2 merged plan/);
    assert.match(mergedPlan, /## Definition of done/);
    assert.match(review, /## Definition-of-done clarity check/);
    assert.match(review, /review-surface completeness/);
    assert.match(review, /RFC-escalation sanity/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("init-phase refuses the durable phase-doc mint for an issue-keyed (tracker) worktree (ARTIFACT-TRACKER-FIRST-NO-DUP)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-init-phase-"));
  // Issue-keyed worktree layout: tmp/worktrees/dev-loops/issue-<n>.
  const wtRoot = path.join(tempDir, "tmp", "worktrees", "dev-loops", "issue-42");

  try {
    await mkdir(wtRoot, { recursive: true });
    const result = await initializePhase(wtRoot, "phase-2", {
      status: "planning",
      notes: ["tracker-backed session"],
    });

    assert.equal(result.trackerBacked, true, "issue-keyed worktree is detected as tracker-backed");
    // No durable phase doc is minted.
    await assert.rejects(
      readFile(path.join(wtRoot, "docs", "phases", "phase-2.md"), "utf8"),
      /ENOENT/,
    );
    // The ephemeral tmp/ scaffold is still created.
    const manifest = JSON.parse(
      await readFile(path.join(wtRoot, "tmp", "phases", "phase-2", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "planning");
    // The durable phase-doc artifact is not advertised in the manifest.
    assert.ok(!manifest.artifacts.some((a) => a.includes("docs/phases/phase-2.md")), "no phase-doc artifact in manifest");
    // The ephemeral tmp/ artifacts are still advertised (issue #1713 finding).
    for (const ephemeral of ["variant-a.md", "variant-b.md", "merged-plan.md", "review.md", "manifest.json"]) {
      assert.ok(manifest.artifacts.includes(ephemeral), `ephemeral artifact ${ephemeral} advertised in tracker-backed manifest`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
