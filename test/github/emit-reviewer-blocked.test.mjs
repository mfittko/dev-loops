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

test("requires --head-sha/--angles/--model-turns/--tool-calls/--findings-dir (--run is optional)", async () => {
  assert.equal(await main([]), 2);
  assert.equal(await main(["--run", RUN, "--head-sha", HEAD_SHA]), 2);
});

test("--run is optional: an explicit empty value is still rejected", async () => {
  assert.equal(await main(["--run", "--head-sha", HEAD_SHA, "--angles", "a", "--model-turns", "0", "--tool-calls", "0", "--findings-dir", "unused"]), 2);
});

test("--run defaults to --head-sha when omitted, and the resulting blocked artifact still writes correctly", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--head-sha", HEAD_SHA,
      "--angles", "a,b", "--completed-angles", "a",
      "--model-turns", "10", "--tool-calls", "51",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].angle, "b");
    assert.equal(artifacts[0].headSha, HEAD_SHA);
    assert.equal(artifacts[0].reason, "reviewer_budget_exhausted");
  });
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
      const [entry] = await readdir(findingsDir);
      bodies[harness] = await readFile(path.join(findingsDir, entry), "utf8");
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

// Copilot review: sanitizeScopeSegment is lossy ("a/b" and "a-b" both
// sanitize to "a-b"), and every reviewer unit in a grouped round shares ONE
// --findings-dir. Before the content-hash filename suffix, two distinct
// angles that sanitize-collide raced to the SAME filename within a bump-loop
// that was only ever scoped to a single invocation — a later unit's blocked
// emission for a differently-spelled but same-sanitized angle silently
// clobbered an earlier unit's, losing a blocked angle from fan-in.
test("g) sanitize-colliding angles produce two distinct artifact files, neither clobbering the other", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "a/b,a-b",
      "--model-turns", "10", "--tool-calls", "51",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    const entries = await readdir(findingsDir);
    assert.equal(entries.length, 2, "two distinct files, not one clobbered by the other");
    assert.equal(new Set(entries).size, 2);
    const artifacts = await readArtifacts(findingsDir);
    assert.deepEqual(artifacts.map((a) => a.angle).sort(), ["a-b", "a/b"]);
  });
});
