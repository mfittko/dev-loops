import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode } from "../_helpers.mjs";
import {
  validatePlanFile,
  PLAN_FILE_BASE_SECTIONS,
} from "../../scripts/refine/validate-plan-file.mjs";

const cliPath = path.resolve("scripts/refine/validate-plan-file.mjs");

function buildPlan({ omit = [], empty = [] } = {}) {
  const bodies = {
    Status: "in progress",
    Objective: "Prove the thing works.",
    "In scope": "- the bounded slice",
    "Explicit non-goals": "- no broad rewrite",
  };
  const omitSet = new Set(omit);
  const emptySet = new Set(empty);
  const parts = [];
  for (const heading of PLAN_FILE_BASE_SECTIONS) {
    if (omitSet.has(heading)) continue;
    const body = emptySet.has(heading) ? "" : bodies[heading];
    parts.push(`## ${heading}\n\n${body}\n`);
  }
  return `# my plan\n\n${parts.join("\n")}`;
}

describe("validatePlanFile (pure)", () => {
  test("valid plan with all base sections is ok", () => {
    const result = validatePlanFile(buildPlan());
    assert.equal(result.checker, "validate-plan-file");
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  test("each missing base section yields a distinct missing_* code", () => {
    const expected = {
      Status: "missing_status",
      Objective: "missing_objective",
      "In scope": "missing_in_scope",
      "Explicit non-goals": "missing_explicit_non_goals",
    };
    for (const heading of PLAN_FILE_BASE_SECTIONS) {
      const result = validatePlanFile(buildPlan({ omit: [heading] }));
      assert.equal(result.ok, false, `${heading} missing should fail`);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].code, expected[heading]);
    }
  });

  test("empty-body section is malformed (same missing_* code)", () => {
    const result = validatePlanFile(buildPlan({ empty: ["Objective"] }));
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "missing_objective");
  });

  test("all-missing reports one error per base section", () => {
    const result = validatePlanFile("# empty plan\n");
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, PLAN_FILE_BASE_SECTIONS.length);
  });

  test("non-string input is rejected", () => {
    const result = validatePlanFile(null);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, PLAN_FILE_BASE_SECTIONS.length);
  });
});

describe("validate-plan-file CLI", () => {
  let dir;
  test.before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "validate-plan-file-"));
  });
  test.after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("--json prints the verdict and exits 0 even when invalid", async () => {
    const planPath = path.join(dir, "bad.md");
    await writeFile(planPath, "# bad\n", "utf8");
    const { code, stdout } = await runNode(cliPath, ["--input", planPath, "--json"]);
    assert.equal(code, 0, "validation verdict is in the payload, not the exit code");
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.checker, "validate-plan-file");
    assert.equal(parsed.ok, false);
  });

  test("--help exits 0 and prints usage", async () => {
    const { code, stdout } = await runNode(cliPath, ["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage:/u);
  });

  test("missing --input exits non-zero (arg error)", async () => {
    const { code } = await runNode(cliPath, []);
    assert.equal(code, 1);
  });

  test("unreadable path exits non-zero (path error)", async () => {
    const { code } = await runNode(cliPath, ["--input", path.join(dir, "nope.md")]);
    assert.equal(code, 1);
  });
});
