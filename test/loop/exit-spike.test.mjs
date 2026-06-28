import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";

const cliPath = path.resolve("scripts/refine/exit-spike.mjs");

const READY_SPIKE = [
  "# Spike",
  "",
  "## Question",
  "Can we cache the slow API responses to cut p95 latency?",
  "",
  "## Approach",
  "Prototyped an in-process LRU in front of the fetch path.",
  "",
  "## Findings",
  "An LRU(1000) cut p95 by 60% with no correctness regressions.",
  "",
  "## Recommendation",
  "Adopt the in-process LRU on the fetch path behind a config flag.",
  "",
].join("\n");

const IN_PROGRESS_SPIKE = [
  "# Spike",
  "",
  "## Question",
  "Can we cache the slow API responses?",
  "",
  "## Approach",
  "Prototyping an LRU.",
  "",
  "## Findings",
  "Still measuring.",
  "",
].join("\n");

async function setup(spike = READY_SPIKE) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "exit-spike-"));
  const stubDir = path.join(tempDir, "stub");
  await mkdir(stubDir, { recursive: true });
  // logCalls so we can assert ZERO gh calls on the discard/graduate exits.
  const ghStub = await writeGhStub(stubDir, [], { logCalls: true });
  const spikePath = path.join(tempDir, "spike-cache.md");
  await writeFile(spikePath, spike, "utf8");
  return { tempDir, spikePath, ghStub };
}

describe("exit-spike CLI", () => {
  test("discard: leaves zero tracker artifacts (empty gh log) and exits 0", async () => {
    const { tempDir, spikePath, ghStub } = await setup();
    try {
      const result = await runNode(
        cliPath,
        ["--spike-file", spikePath, "--disposition", "discard", "--json"],
        { cwd: tempDir, env: ghStub.env },
      );
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.action, "discard");

      // Zero tracker mutation.
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("graduate: writes a base-valid plan file and makes zero gh calls", async () => {
    const { tempDir, spikePath, ghStub } = await setup();
    try {
      const planPath = path.join(tempDir, "graduated-plan.md");
      const result = await runNode(
        cliPath,
        [
          "--spike-file", spikePath,
          "--disposition", "graduate",
          "--plan-file", planPath,
          "--json",
        ],
        { cwd: tempDir, env: ghStub.env },
      );
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.action, "graduate");
      assert.equal(parsed.planFile, planPath);

      // The emitted plan file carries the base sections and the spike content.
      const written = await readFile(planPath, "utf8");
      assert.match(written, /## Status/u);
      assert.match(written, /## Objective/u);
      assert.match(written, /## In scope/u);
      assert.match(written, /## Explicit non-goals/u);
      assert.match(written, /Adopt the in-process LRU/u);

      // Graduation emits a plan file only; it opens nothing on the tracker.
      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("graduate is idempotent: re-running reproduces the same plan file", async () => {
    const { tempDir, spikePath, ghStub } = await setup();
    try {
      const planPath = path.join(tempDir, "graduated-plan.md");
      const args = [
        "--spike-file", spikePath,
        "--disposition", "graduate",
        "--plan-file", planPath,
        "--json",
      ];
      const first = await runNode(cliPath, args, { cwd: tempDir, env: ghStub.env });
      assert.equal(first.code, 0, first.stderr);
      const after1 = await readFile(planPath, "utf8");
      const second = await runNode(cliPath, args, { cwd: tempDir, env: ghStub.env });
      assert.equal(second.code, 0, second.stderr);
      const after2 = await readFile(planPath, "utf8");
      assert.equal(after1, after2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: a not-ready spike makes zero gh calls and exits 1", async () => {
    const { tempDir, spikePath, ghStub } = await setup(IN_PROGRESS_SPIKE);
    try {
      const result = await runNode(
        cliPath,
        ["--spike-file", spikePath, "--disposition", "discard", "--json"],
        { cwd: tempDir, env: ghStub.env },
      );
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "not_ready_for_exit");
      assert.equal(parsed.spikeIntakeState, "spike_in_progress");

      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fail closed: an unknown disposition exits 1 with zero gh calls", async () => {
    const { tempDir, spikePath, ghStub } = await setup();
    try {
      const result = await runNode(
        cliPath,
        ["--spike-file", spikePath, "--disposition", "promote-to-prod", "--json"],
        { cwd: tempDir, env: ghStub.env },
      );
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "unknown_disposition");

      const ghLog = await readFile(ghStub.ghLogPath, "utf8");
      assert.equal(ghLog.trim(), "", `expected zero gh calls, got: ${ghLog}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects missing --spike-file", async () => {
    const result = await runNode(cliPath, ["--disposition", "discard"], {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires --spike-file/u);
  });

  test("graduate requires --plan-file", async () => {
    const { tempDir, spikePath, ghStub } = await setup();
    try {
      const result = await runNode(
        cliPath,
        ["--spike-file", spikePath, "--disposition", "graduate"],
        { cwd: tempDir, env: ghStub.env },
      );
      assert.equal(result.code, 1);
      assert.match(result.stderr, /requires --plan-file/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
