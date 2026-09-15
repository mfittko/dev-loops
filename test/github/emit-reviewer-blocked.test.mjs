import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { main } from "../../scripts/github/emit-reviewer-blocked.mjs";
import { consolidateFanin } from "@dev-loops/core/loop/gate-fanin";

const HEAD_SHA = "c".repeat(40);
const RUN = "run-1";

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-emit-reviewer-blocked-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readArtifacts(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const artifacts = [];
  for (const name of entries.filter((n) => n.endsWith(".json")).sort()) {
    artifacts.push(JSON.parse(await readFile(path.join(dir, name), "utf8")));
  }
  return artifacts;
}

test("--help exits 0", async () => {
  const code = await main(["--help"]);
  assert.equal(code, 0);
});

test("requires --run/--head-sha/--angles/--model-turns/--tool-calls/--findings-dir", async () => {
  assert.equal(await main([]), 2);
  assert.equal(await main(["--run", RUN, "--head-sha", HEAD_SHA]), 2);
});

test("a) budget exhausted with partial coverage writes blocked artifacts for EXACTLY the unreviewed angles", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "a,b,c", "--completed-angles", "a",
      "--model-turns", "10", "--tool-calls", "51",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 2);
    assert.deepEqual(artifacts.map((a) => a.angle).sort(), ["b", "c"]);
    for (const artifact of artifacts) {
      assert.equal(artifact.verdict, "blocked");
      assert.equal(artifact.headSha, HEAD_SHA);
      assert.deepEqual(artifact.unreviewedAngles, ["b", "c"]);
      assert.equal(artifact.reason, "reviewer_budget_exhausted");
    }
  });
});

test("b) budget exhausted with all angles completed still writes a blocked artifact for EVERY assigned angle (never clean)", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "a,b", "--completed-angles", "a,b",
      "--model-turns", "10", "--tool-calls", "51",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 2);
    assert.deepEqual(artifacts.map((a) => a.angle).sort(), ["a", "b"]);
    for (const artifact of artifacts) {
      assert.equal(artifact.verdict, "blocked");
      assert.equal(artifact.reason, "reviewer_budget_exhausted");
      assert.deepEqual(artifact.unreviewedAngles, []);
    }
  });
});

test("c) within budget and fully covered exits 1 and writes nothing", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "a", "--completed-angles", "a",
      "--model-turns", "10", "--tool-calls", "10",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 1);
    assert.deepEqual(await readArtifacts(findingsDir), []);
  });
});

test("d) incomplete coverage within budget writes blocked artifacts for exactly the missing angles", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "a,b,c", "--completed-angles", "a",
      "--model-turns", "10", "--tool-calls", "10",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.deepEqual(artifacts.map((a) => a.angle).sort(), ["b", "c"]);
    for (const artifact of artifacts) {
      assert.equal(artifact.reason, "reviewer_coverage_incomplete");
    }
  });
});

test("e) cross-harness parity: pi/claude/codex produce byte-identical artifact bodies", async () => {
  await withTmpDir(async (tmpDir) => {
    const bodies = {};
    for (const harness of ["pi", "claude", "codex"]) {
      const findingsDir = path.join(tmpDir, harness);
      const code = await main([
        "--run", RUN, "--head-sha", HEAD_SHA,
        "--angles", "a,b", "--completed-angles", "a",
        "--model-turns", "10", "--tool-calls", "10",
        "--findings-dir", findingsDir,
        "--harness", harness,
      ]);
      assert.equal(code, 0);
      bodies[harness] = await readFile(path.join(findingsDir, "b.json"), "utf8");
    }
    assert.equal(bodies.pi, bodies.claude);
    assert.equal(bodies.claude, bodies.codex);
  });
});

test("f) a produced blocked artifact directory cannot consolidate clean via consolidateFanin", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "a,b,c", "--completed-angles", "a",
      "--model-turns", "10", "--tool-calls", "51",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    const angleResults = await readArtifacts(findingsDir);
    const result = consolidateFanin({ angleResults });
    assert.equal(result.verdict, "blocked");
  });
});
