import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";

const cliPath = path.resolve("scripts/refine/refine-plan-file.mjs");

const BASE_PLAN = [
  "# Plan",
  "",
  "## Status",
  "Draft.",
  "",
  "## Objective",
  "Do the thing.",
  "",
  "## In scope",
  "- the bounded slice",
  "",
  "## Explicit non-goals",
  "- no broad rewrite",
  "",
].join("\n");

const PAYLOAD = {
  acceptanceCriteria: "- The thing works.",
  definitionOfDone: "- Tests pass; CHANGELOG updated.",
  coverageMatrix: "| Item | Type | Status | Evidence | Notes |\n|---|---|---|---|---|\n| The thing works | AC | Met | test | |",
  sizeEstimate: { logicLoc: 90, tier: "default" },
  grillFindings: [{ kind: "drift", docOnly: false, summary: "claim contradicts contract" }],
};

async function setup(plan = BASE_PLAN, payload = PAYLOAD) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "refine-plan-file-"));
  const planPath = path.join(tempDir, "plan.md");
  const payloadPath = path.join(tempDir, "payload.json");
  await writeFile(planPath, plan, "utf8");
  await writeFile(payloadPath, JSON.stringify(payload), "utf8");
  // Stub gh with an empty scripted sequence and call logging on: any gh
  // invocation appends to the log, so an empty log proves zero tracker mutation.
  const ghStub = await writeGhStub(tempDir, [], { logCalls: true });
  return { tempDir, planPath, payloadPath, ghStub };
}

describe("refine-plan-file CLI", () => {
  test("refines a new plan in place, advances state, stops local, makes zero gh calls", async () => {
    const { tempDir, planPath, payloadPath, ghStub } = await setup();
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.planFileIntakeState, "plan_refined_ready_for_promotion");
      assert.equal(parsed.stop.kind, "local_human_review");

      // In-place write: the plan file now carries the refinement sections.
      const written = await readFile(planPath, "utf8");
      assert.match(written, /^## Acceptance criteria$/mu);
      assert.match(written, /^## Definition of done$/mu);
      assert.match(written, /^## Size estimate$/mu);
      assert.match(written, /- Estimated logic LOC: 90/u);
      assert.match(written, /^## Coverage matrix$/mu);
      assert.match(written, /^## Docs-grill findings$/mu);
      assert.match(written, /\[record_finding\] \(drift\) claim contradicts contract/u);
      assert.equal(parsed.sizeEstimate.overBudget, false);

      // Zero tracker mutation: the gh call log is empty.
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("idempotent: a second run reproduces the same file with no duplicate sections", async () => {
    const { tempDir, planPath, payloadPath, ghStub } = await setup();
    try {
      const first = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(first.code, 0, first.stderr);
      const afterFirst = await readFile(planPath, "utf8");

      // A re-run hits the already-refined state and fails closed without writing,
      // so the file is unchanged. Re-asserting the single-copy invariant proves no
      // duplicate sections were appended on the path that did write.
      const second = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(second.code, 1, "second run should fail closed on already-refined state");
      const afterSecond = await readFile(planPath, "utf8");
      assert.equal(afterSecond, afterFirst, "file unchanged on the fail-closed re-run");
      const count = (heading) => (afterSecond.match(new RegExp(`^## ${heading}$`, "gmu")) ?? []).length;
      assert.equal(count("Acceptance criteria"), 1);
      assert.equal(count("Definition of done"), 1);

      // Still zero gh calls across both runs.
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: missing payload pieces exits 1 without writing", async () => {
    const { tempDir, planPath, payloadPath, ghStub } = await setup(BASE_PLAN, {
      ...PAYLOAD,
      acceptanceCriteria: "",
    });
    try {
      const before = await readFile(planPath, "utf8");
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "missing_acceptance_criteria");
      const after = await readFile(planPath, "utf8");
      assert.equal(after, before, "plan file must be untouched on fail-closed");
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: an unclassifiable docs-grill finding fails the grill without writing", async () => {
    // The CLI owns finding classification; an unrecognized kind yields a null
    // disposition, which the core contract fails closed on (docs_grill_failed).
    const { tempDir, planPath, payloadPath, ghStub } = await setup(BASE_PLAN, {
      ...PAYLOAD,
      grillFindings: [{ kind: "not-a-real-kind", summary: "mystery" }],
    });
    try {
      const before = await readFile(planPath, "utf8");
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "docs_grill_failed");
      const after = await readFile(planPath, "utf8");
      assert.equal(after, before, "plan file must be untouched on fail-closed");
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: an over-softLoc size estimate with no oversizeJustification prompts a seam search", async () => {
    // No .devloops in the temp dir, so gates.size.tiers.default.softLoc falls back to
    // check-size-budget.mjs's own default of 400 — 900 is over it.
    const { tempDir, planPath, payloadPath, ghStub } = await setup(BASE_PLAN, {
      ...PAYLOAD,
      sizeEstimate: { logicLoc: 900, tier: "default" },
    });
    try {
      const before = await readFile(planPath, "utf8");
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "size_estimate_oversize_not_justified");
      const after = await readFile(planPath, "utf8");
      assert.equal(after, before, "plan file must be untouched on fail-closed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("a cohesive over-softLoc size estimate with oversizeJustification proceeds and the note flows into the file", async () => {
    const { tempDir, planPath, payloadPath, ghStub } = await setup(BASE_PLAN, {
      ...PAYLOAD,
      sizeEstimate: { logicLoc: 900, tier: "default", oversizeJustification: "one cohesive migration; no clean seam" },
    });
    try {
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.sizeEstimate.overBudget, true);
      assert.equal(parsed.sizeEstimate.oversizeNote, "one cohesive migration; no clean seam");
      const written = await readFile(planPath, "utf8");
      assert.match(written, /- Oversize: justified — one cohesive migration; no clean seam/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("a repo-configured gates.size.tiers.default.softLoc wins over the fallback at plan time", async () => {
    // logicLoc 900 is over check-size-budget.mjs's fallback softLoc (400) but
    // under a repo-configured 1000, so with the config in play it is NOT over
    // budget and needs no justification. This exercises the config-override arm
    // (the plan-time threshold must match the post-hoc gate's configured one).
    const { tempDir, planPath, payloadPath, ghStub } = await setup(BASE_PLAN, {
      ...PAYLOAD,
      sizeEstimate: { logicLoc: 900, tier: "default" },
    });
    try {
      await writeFile(
        path.join(tempDir, ".devloops"),
        "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        softLoc: 1000\n",
        "utf8",
      );
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.sizeEstimate.overBudget, false, "900 is under the configured softLoc of 1000");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("a broken .devloops surfaces config errors to stderr and falls back to the default softLoc", async () => {
    // logicLoc 90 stays under the fallback 400 so the refine still succeeds; the
    // point is that a config error is SURFACED (not silently swallowed) and the
    // plan-time threshold falls back to the default, matching the post-hoc gate.
    const { tempDir, planPath, payloadPath, ghStub } = await setup(BASE_PLAN, {
      ...PAYLOAD,
      sizeEstimate: { logicLoc: 90, tier: "default" },
    });
    try {
      // Missing `version: 1` — the config schema rejects it.
      await writeFile(
        path.join(tempDir, ".devloops"),
        "gates:\n  size:\n    tiers:\n      default:\n        softLoc: 1000\n",
        "utf8",
      );
      const result = await runNode(cliPath, ["--plan-file", planPath, "--payload", payloadPath, "--json"], {
        cwd: tempDir,
        env: ghStub.env,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /\.devloops config error/u);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects missing --plan-file / --payload", async () => {
    const result = await runNode(cliPath, ["--plan-file", "x.md"], {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires --payload/u);
  });
});
