import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode } from "../_helpers.mjs";
import { buildSpikeScaffold, main } from "../../scripts/refine/scaffold-spike-file.mjs";
import {
  validateSpikeExplorationSections,
  validateSpikeFile,
} from "../../scripts/refine/validate-spike-file.mjs";

const cliPath = path.resolve("scripts/refine/scaffold-spike-file.mjs");

describe("scaffold-spike-file (#988 P2)", () => {
  test("scaffold from a question is a STARTABLE artifact (exploration scaffold valid)", () => {
    const body = buildSpikeScaffold("Would an LRU cache cut p95 latency?");
    // Question carries the operator's text verbatim.
    assert.match(body, /## Question\n\nWould an LRU cache cut p95 latency\?/);
    // Startup gates on the exploration scaffold — it must pass.
    assert.equal(validateSpikeExplorationSections(body).ok, true);
    // It is in-progress, not ready-for-exit: no Recommendation yet.
    const full = validateSpikeFile(body);
    assert.equal(full.ok, false);
    assert.deepEqual(full.errors.map((e) => e.code), ["missing_recommendation"]);
  });

  test("empty question fails closed", () => {
    assert.throws(() => buildSpikeScaffold("   "), /non-empty/);
  });

  test("CLI writes the scaffold to --out and reports the absolute path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "spike-scaffold-"));
    try {
      const out = path.join(dir, "nested", "my-spike.md");
      const result = await main({ question: "Investigate flaky test X", out });
      assert.equal(result.ok, true);
      assert.equal(result.path, out);
      assert.equal(result.question, "Investigate flaky test X");
      const written = await readFile(out, "utf8");
      assert.equal(validateSpikeExplorationSections(written).ok, true);
      assert.match(written, /Investigate flaky test X/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("CLI emits JSON and the file is startable end-to-end", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "spike-scaffold-cli-"));
    try {
      const out = path.join(dir, "q.md");
      const { stdout, code } = await runNode(cliPath, ["--question", "Try thing?", "--out", out, "--json"]);
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.path, out);
      const written = await readFile(out, "utf8");
      assert.equal(validateSpikeExplorationSections(written).ok, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("CLI requires --question and --out", async () => {
    const missingOut = await runNode(cliPath, ["--question", "x"]);
    assert.equal(missingOut.code, 1);
    const missingQ = await runNode(cliPath, ["--out", "x.md"]);
    assert.equal(missingQ.code, 1);
  });
});
