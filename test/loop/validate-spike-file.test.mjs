import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode } from "../_helpers.mjs";
import {
  validateSpikeFile,
  SPIKE_FILE_BASE_SECTIONS,
} from "../../scripts/refine/validate-spike-file.mjs";

const cliPath = path.resolve("scripts/refine/validate-spike-file.mjs");

function buildSpike({ omit = [], empty = [] } = {}) {
  const bodies = {
    Question: "Can we use approach X to solve Y?",
    Approach: "- prototype the call path",
    Findings: "- X works but is slow",
    Recommendation: "- adopt X with a cache",
  };
  const omitSet = new Set(omit);
  const emptySet = new Set(empty);
  const parts = [];
  for (const heading of SPIKE_FILE_BASE_SECTIONS) {
    if (omitSet.has(heading)) continue;
    const body = emptySet.has(heading) ? "" : bodies[heading];
    parts.push(`## ${heading}\n\n${body}\n`);
  }
  return `# my spike\n\n${parts.join("\n")}`;
}

describe("validateSpikeFile (pure)", () => {
  test("valid spike with all base sections is ok", () => {
    const result = validateSpikeFile(buildSpike());
    assert.equal(result.checker, "validate-spike-file");
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  test("each missing base section yields a distinct missing_* code", () => {
    const expected = {
      Question: "missing_question",
      Approach: "missing_approach",
      Findings: "missing_findings",
      Recommendation: "missing_recommendation",
    };
    for (const heading of SPIKE_FILE_BASE_SECTIONS) {
      const result = validateSpikeFile(buildSpike({ omit: [heading] }));
      assert.equal(result.ok, false, `${heading} missing should fail`);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].code, expected[heading]);
    }
  });

  test("empty-body section is malformed (same missing_* code)", () => {
    const result = validateSpikeFile(buildSpike({ empty: ["Findings"] }));
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "missing_findings");
  });

  test("all-missing reports one error per base section", () => {
    const result = validateSpikeFile("# empty spike\n");
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, SPIKE_FILE_BASE_SECTIONS.length);
  });

  test("non-string input is rejected", () => {
    const result = validateSpikeFile(null);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, SPIKE_FILE_BASE_SECTIONS.length);
  });
});

describe("validate-spike-file CLI", () => {
  let dir;
  test.before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "validate-spike-file-"));
  });
  test.after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("--json prints the verdict and exits 0 even when invalid", async () => {
    const spikePath = path.join(dir, "bad.md");
    await writeFile(spikePath, "# bad\n", "utf8");
    const { code, stdout } = await runNode(cliPath, ["--input", spikePath, "--json"]);
    assert.equal(code, 0, "validation verdict is in the payload, not the exit code");
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.checker, "validate-spike-file");
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
