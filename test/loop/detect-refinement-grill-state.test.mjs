import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../../scripts/loop/detect-refinement-grill-state.mjs";

// Minimal writable that accumulates written strings, matching how the detector
// writes JSON to `stdout` / errors to `stderr` via emitResult.
function makeCapture() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

async function runDetect(args) {
  const stdout = makeCapture();
  const stderr = makeCapture();
  await runCli(args, { stdout, stderr });
  return { stdout: stdout.text(), stderr: stderr.text() };
}

const REFINED_BODY = [
  "## Acceptance criteria",
  "",
  "- [ ] the thing works",
  "",
].join("\n");

const PROSE_BODY = [
  "# Title",
  "",
  "Just some prose, no acceptance criteria at all.",
  "",
].join("\n");

test("--input snapshot mode returns the interpreted state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-input-"));
  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeFile(snapshotPath, JSON.stringify({ loaded: true, synthesized: true, reGrillRan: false }), "utf8");
    const { stdout } = await runDetect(["--input", snapshotPath]);
    assert.equal(JSON.parse(stdout).state, "re_grill");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--body-file with an already-refined body seeds grill_clean", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-refined-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    await writeFile(bodyPath, REFINED_BODY, "utf8");
    const { stdout } = await runDetect(["--body-file", bodyPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.snapshot.openGapCount, 0);
    assert.equal(parsed.state, "grill_clean");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--body-file with a prose-only body seeds await_answers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-prose-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    await writeFile(bodyPath, PROSE_BODY, "utf8");
    const { stdout } = await runDetect(["--body-file", bodyPath, "--surface", "pr"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.snapshot.openGapCount, 1);
    assert.equal(parsed.snapshot.surface, "pr");
    assert.equal(parsed.state, "await_answers");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("both input modes together fail closed", async () => {
  await assert.rejects(
    runDetect(["--input", "/tmp/x.json", "--body-file", "/tmp/y.md"]),
    /exactly one input source/,
  );
});

test("neither input mode fails closed", async () => {
  await assert.rejects(runDetect([]), /exactly one input source/);
});
