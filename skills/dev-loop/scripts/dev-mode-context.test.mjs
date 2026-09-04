import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectDevModeContext,
  parseCliArgs,
  parseJsonLines,
  writeDevModeContext,
} from "./dev-mode-context.mjs";

test("dev-mode-context parses json lines deterministically", () => {
  assert.deepEqual(parseJsonLines('{"command":"npm test"}\n{"command":"npm run check"}\n'), [
    { command: "npm test" },
    { command: "npm run check" },
  ]);
  assert.deepEqual(parseJsonLines(""), []);
});

test("dev-mode-context collects context for an existing phase directory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-dev-mode-"));
  const phaseDir = path.join(tempDir, "tmp", "phases", "phase-3");

  try {
    await mkdir(phaseDir, { recursive: true });
    await writeFile(path.join(phaseDir, "manifest.json"), JSON.stringify({ phase: "phase-3", status: "completed" }), { encoding: "utf8", flag: "w" });
    await writeFile(path.join(phaseDir, "summary.md"), "# Summary\nline\n", { encoding: "utf8", flag: "w" });
    await writeFile(path.join(phaseDir, "retrospective.md"), "# Retro\n", { encoding: "utf8", flag: "w" });
    await writeFile(path.join(phaseDir, "review.md"), "# Review\n", { encoding: "utf8", flag: "w" });
    await writeFile(path.join(phaseDir, "merged-plan.md"), "# Plan\n", { encoding: "utf8", flag: "w" });
    await writeFile(
      path.join(phaseDir, "bash-exit-1.jsonl"),
      '{"command":"npm test","exitCode":1}\n{"command":"npm run test:coverage","exitCode":1}\n',
      { encoding: "utf8", flag: "w" },
    );

    const context = await collectDevModeContext(tempDir, "phase-3");

    assert.equal(context.phase, "phase-3");
    assert.deepEqual(context.manifest, { phase: "phase-3", status: "completed" });
    assert.deepEqual(context.artifactPresence, {
      summary: true,
      retrospective: true,
      review: true,
      mergedPlan: true,
      bashExitOneLog: true,
    });
    assert.equal(context.bashExitOne.count, 2);
    assert.deepEqual(context.bashExitOne.commands, ["npm run test:coverage", "npm test"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dev-mode-context writes collected context to disk", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-dev-mode-write-"));
  const outputPath = path.join(tempDir, "dev-mode-context.json");

  try {
    await writeDevModeContext(outputPath, { phase: "phase-1", ok: true });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(written, { phase: "phase-1", ok: true });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dev-mode-context parses cli args", () => {
  assert.deepEqual(parseCliArgs(["--project-root", "/repo", "--phase", "phase-4", "--output", "tmp/x.json"]), {
    projectRoot: "/repo",
    phase: "phase-4",
    output: "tmp/x.json",
  });
});

test("dev-mode-context requires phase arg", () => {
  assert.throws(() => parseCliArgs(["--output", "tmp/x.json"]), /missing required --phase/i);
});
