import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  applyManifestPatch,
  buildPhasePaths,
  createDefaultPhaseIndex,
  createDefaultPhaseManifest,
  ensurePhaseFiles,
  normalizePhaseName,
  parseCliArgs,
  uniqueSortedStrings,
  upsertPhaseIndex,
} from "../src/loop/phase-files.mjs";

function runNode(scriptPath, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    if (options.stdin) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("normalizePhaseName validates expected phase format", () => {
  assert.equal(normalizePhaseName("phase-0"), "phase-0");
  assert.throws(() => normalizePhaseName("phase-zero"), /phase must match/i);
});

test("uniqueSortedStrings filters, deduplicates, and sorts values", () => {
  assert.deepEqual(uniqueSortedStrings(["b", "a", "b", "", undefined]), ["a", "b"]);
});

test("createDefaultPhaseManifest returns the stable manifest shape", () => {
  assert.deepEqual(createDefaultPhaseManifest("phase-0"), {
    phase: "phase-0",
    status: "not-started",
    startedAt: "",
    completedAt: "",
    nextPhase: "",
    validation: {
      check: "not-run",
      test: "not-run",
      coverage: "not-run",
    },
    artifacts: [],
    subagents: [],
    decisions: [],
    notes: [],
  });
});

test("applyManifestPatch merges validation and sorted list fields deterministically", () => {
  const manifest = createDefaultPhaseManifest("phase-0");
  const next = applyManifestPatch(manifest, {
    status: "planning",
    artifacts: ["b.md", "a.md", "b.md"],
    validation: { check: "passed" },
    notes: ["note-b", "note-a"],
  });

  assert.deepEqual(next, {
    ...manifest,
    status: "planning",
    artifacts: ["a.md", "b.md"],
    subagents: [],
    decisions: [],
    notes: ["note-a", "note-b"],
    validation: {
      check: "passed",
      test: "not-run",
      coverage: "not-run",
    },
  });
});

test("upsertPhaseIndex inserts and sorts phase entries deterministically", () => {
  const index = upsertPhaseIndex(
    {
      phases: [
        {
          phase: "phase-10",
          status: "planning",
          manifestPath: "tmp/phases/phase-10/manifest.json",
          updatedAt: "2026-05-12T10:00:00Z",
        },
      ],
    },
    {
      phase: "phase-2",
      status: "planning",
      manifestPath: "tmp/phases/phase-2/manifest.json",
      updatedAt: "2026-05-12T11:00:00Z",
    },
  );

  assert.deepEqual(index, {
    phases: [
      {
        phase: "phase-2",
        status: "planning",
        manifestPath: "tmp/phases/phase-2/manifest.json",
        updatedAt: "2026-05-12T11:00:00Z",
      },
      {
        phase: "phase-10",
        status: "planning",
        manifestPath: "tmp/phases/phase-10/manifest.json",
        updatedAt: "2026-05-12T10:00:00Z",
      },
    ],
  });
});

test("createDefaultPhaseIndex returns the stable index shape", () => {
  assert.deepEqual(createDefaultPhaseIndex(), { phases: [] });
});

test("buildPhasePaths returns deterministic project-relative paths", () => {
  assert.deepEqual(buildPhasePaths("/repo", "phase-2"), {
    projectRoot: "/repo",
    phasesRoot: "/repo/tmp/phases",
    phase: "phase-2",
    phaseDir: "/repo/tmp/phases/phase-2",
    docsPhasesRoot: "/repo/docs/phases",
    phasePlanPath: "/repo/docs/phases/phase-2.md",
    manifestPath: "/repo/tmp/phases/phase-2/manifest.json",
    indexPath: "/repo/tmp/phases/index.json",
    bashExitOnePath: "/repo/tmp/phases/phase-2/bash-exit-1.jsonl",
  });
});

test("ensurePhaseFiles writes manifest and index files with merged patch data", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-phase-files-"));

  try {
    const first = await ensurePhaseFiles(tempDir, "phase-0", {
      status: "planning",
      artifacts: ["variant-a.md", "review.md"],
      notes: ["first note"],
    });

    const second = await ensurePhaseFiles(tempDir, "phase-0", {
      artifacts: ["summary.md"],
      decisions: ["keep scope narrow"],
    });

    assert.equal(first.manifest.status, "planning");
    assert.deepEqual(second.manifest.artifacts, ["review.md", "summary.md", "variant-a.md"]);
    assert.deepEqual(second.manifest.decisions, ["keep scope narrow"]);
    assert.equal(second.index.phases.length, 1);
    assert.equal(second.index.phases[0].phase, "phase-0");
    assert.equal(second.index.phases[0].status, "planning");
    assert.equal(second.index.phases[0].manifestPath, "tmp/phases/phase-0/manifest.json");
    assert.match(second.index.phases[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const manifestOnDisk = JSON.parse(await readFile(second.paths.manifestPath, "utf8"));
    const indexOnDisk = JSON.parse(await readFile(second.paths.indexPath, "utf8"));

    assert.deepEqual(manifestOnDisk, second.manifest);
    assert.deepEqual(indexOnDisk, second.index);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseCliArgs parses expected options", () => {
  assert.deepEqual(
    parseCliArgs(["--project-root", "/repo", "--phase", "phase-3", "--patch", '{"status":"planning"}']),
    {
      projectRoot: "/repo",
      phase: "phase-3",
      patch: { status: "planning" },
    },
  );
});

test("parseCliArgs rejects missing phase, missing option values, and unknown arguments", () => {
  assert.throws(() => parseCliArgs([]), /missing required --phase/i);
  assert.throws(() => parseCliArgs(["--project-root"]), /missing value for --project-root/i);
  assert.throws(() => parseCliArgs(["--phase"]), /missing value for --phase/i);
  assert.throws(() => parseCliArgs(["--patch"]), /missing value for --patch/i);
  assert.throws(() => parseCliArgs(["--phase", "--patch"]), /missing value for --phase/i);
  assert.throws(() => parseCliArgs(["--wat"]), /unknown argument/i);
});

test("ensure-phase-files CLI emits stable machine-readable success output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-phase-files-cli-"));
  const cliPath = path.resolve("packages/core/bin/ensure-phase-files.mjs");

  try {
    const result = await runNode(cliPath, [
      "--project-root",
      tempDir,
      "--phase",
      "phase-4",
      "--patch",
      '{"status":"planning","notes":["cli"]}',
    ]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      ok: true,
      projectRoot: tempDir,
      phasesRoot: path.join(tempDir, "tmp", "phases"),
      phase: "phase-4",
      phaseDir: path.join(tempDir, "tmp", "phases", "phase-4"),
      docsPhasesRoot: path.join(tempDir, "docs", "phases"),
      phasePlanPath: path.join(tempDir, "docs", "phases", "phase-4.md"),
      manifestPath: path.join(tempDir, "tmp", "phases", "phase-4", "manifest.json"),
      indexPath: path.join(tempDir, "tmp", "phases", "index.json"),
      bashExitOnePath: path.join(tempDir, "tmp", "phases", "phase-4", "bash-exit-1.jsonl"),
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
