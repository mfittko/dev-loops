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
      assert.match(written, /^## Coverage matrix$/mu);
      assert.match(written, /^## Docs-grill findings$/mu);
      assert.match(written, /\[record_finding\] \(drift\) claim contradicts contract/u);

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

  test("rejects missing --plan-file / --payload", async () => {
    const result = await runNode(cliPath, ["--plan-file", "x.md"], {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires --payload/u);
  });
});
