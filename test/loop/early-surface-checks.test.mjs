import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { initSizeBudgetFixtureRepo, runGitFixture } from "../_helpers.mjs";
import { evaluateEarlySurface } from "../../scripts/loop/early-surface-checks.mjs";
import { buildGateCoordinationEvaluatorInput } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { evaluatePrGateCoordination } from "@dev-loops/core/loop/pr-gate-coordination";

const git = (cwd, ...args) => runGitFixture(cwd, args);

test("a decision-shaped change pushed after PR creation is reported as a tripwire block before any ready flip", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-early-surface-"));
  try {
    await initSizeBudgetFixtureRepo(tempDir);
    const first = await evaluateEarlySurface({ baseRefName: "main", head: "HEAD", repoRoot: tempDir });
    assert.equal(first.adrTripwire.outcome, "pass");

    await mkdir(path.join(tempDir, "skills/docs"), { recursive: true });
    await writeFile(path.join(tempDir, "skills/docs/sample-contract.md"), "# Sample\n", "utf8");
    git(tempDir, "add", ".");
    git(tempDir, "commit", "-q", "-m", "decision-shaped");
    const head = git(tempDir, "rev-parse", "HEAD");

    const earlySurface = await evaluateEarlySurface({ baseRefName: "main", head, prBody: "", repoRoot: tempDir });
    assert.equal(earlySurface.adrTripwire.outcome, "block");
    assert.equal(earlySurface.adrTripwire.remedies.length, 2);

    const input = buildGateCoordinationEvaluatorInput({
      context: {
        repo: "owner/repo", pr: 1, currentHeadSha: head, prData: { isDraft: true, state: "OPEN" },
        interpretation: { state: "pr_draft" }, disposition: { loopDisposition: "action_required" },
        gateEvidence: {}, refinementArtifact: null,
      },
      maxCopilotRounds: 1,
      draftGateConfig: { requireCi: false },
      preApprovalGateConfig: { requireCi: false },
      postConvergenceSignificantChange: false,
      earlySurface,
    });
    const result = evaluatePrGateCoordination(input);
    assert.equal(result.adrTripwire.outcome, "block");
    assert.equal(result.nextAction, "run_draft_gate");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("an unresolvable base yields unknown outcomes naming git fetch origin", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-early-surface-unknown-"));
  try {
    await initSizeBudgetFixtureRepo(tempDir);
    const result = await evaluateEarlySurface({ baseRefName: "no-such-branch", head: "HEAD", repoRoot: tempDir });
    assert.equal(result.adrTripwire.outcome, "unknown");
    assert.equal(result.sizeBudget.outcome, "unknown");
    assert.match(result.adrTripwire.reasons.join(" "), /git fetch origin/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
