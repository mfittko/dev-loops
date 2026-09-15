import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

// Copilot review (thread 2, issue 2155): the blocked artifact now writes to
// the CANONICAL per-angle path `<angle>.json` (sanitizeScopeSegment-d for
// filesystem safety only) — the SAME path the scoped reviewer's own normal
// artifact for that angle uses (see agents/review.agent.md's write-path
// invariant). Two distinct angles that sanitize-collide (e.g. "a/b" and
// "a-b" both sanitize to "a-b") landing in the SAME file is therefore a
// PRE-EXISTING property of the whole per-angle artifact scheme — every
// reviewer artifact uses `<angle>.json` — not something this producer
// introduces; consolidate-fanin.mjs keys on the artifact's own `angle`
// field and fails closed on a genuine same-angle duplicate regardless.
test("g) sanitize-colliding angles land in the SAME canonical file (last write wins), matching the reviewer's own per-angle scheme", async () => {
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
    assert.deepEqual(entries, ["a-b.json"]);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].angle, "a-b", "later angle in the list wins the shared canonical filename");
  });
});

// Copilot review (thread 2, issue 2155): on a sanctioned same-head retry, the
// reviewer writes its own normal `<angle>.json` artifact for the
// previously-blocked angle into the SAME --findings-dir. Because the blocked
// producer now uses that same canonical filename, the normal artifact
// OVERWRITES the stale blocked one — no coexisting second file, no ambiguous
// same-angle duplicate — so fan-in is not permanently stuck blocked.
test("h) a same-head retry's normal artifact supersedes the stale blocked artifact for the same angle", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const code = await main([
      "--run", RUN, "--head-sha", HEAD_SHA,
      "--angles", "coverage",
      "--model-turns", "10", "--tool-calls", "51",
      "--findings-dir", findingsDir,
    ]);
    assert.equal(code, 0);
    let artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].verdict, "blocked");

    // The retry: the scoped reviewer writes its own normal clean artifact for
    // the same angle at the canonical <angle>.json path.
    await writeFile(
      path.join(findingsDir, "coverage.json"),
      `${JSON.stringify({ angle: "coverage", verdict: "clean", headSha: HEAD_SHA, findings: [] }, null, 2)}\n`,
      "utf8",
    );

    artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1, "exactly one artifact remains for the angle");
    assert.equal(artifacts[0].verdict, "clean", "the normal artifact supersedes the stale blocked one");
    const result = consolidateFanin({ angleResults: artifacts });
    assert.notEqual(result.verdict, "blocked");
  });
});
