import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
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
  "## AC / DoD matrix",
  "",
  "| Criterion outcome | Required completion evidence |",
  "|---|---|",
  "| the feature works end to end | a focused test proves the feature works |",
  "",
  "## Non-goals",
  "",
  "- none",
].join("\n");

const PROSE_BODY = [
  "# Title",
  "",
  "Just some prose, no acceptance criteria at all.",
  "",
].join("\n");

const RESULTS_TITLE = "🔬 Grill / refinement results";

const NO_GAPS_COMMENT = [
  `## ${RESULTS_TITLE}`,
  "",
  "source: auto (codebase, docs)",
  "",
  "No gaps were found on this pass. Verdict: grill-clean.",
].join("\n");

const GAP_FILLING_COMMENT = [
  `## ${RESULTS_TITLE}`,
  "",
  "source: auto (codebase, docs)",
  "",
  "### Gaps found and filled",
  "",
  "1. Missing scope boundary — filled from the codebase.",
  "",
  "Verdict: grill-clean.",
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

test("--body-file with an already-refined body but no recorded provenance stays at detect_gaps (the semantic pass is still owed)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-refined-noprov-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    await writeFile(bodyPath, REFINED_BODY, "utf8");
    const { stdout } = await runDetect(["--body-file", bodyPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.snapshot.openGapCount, 0);
    assert.equal(parsed.snapshot.provenanceRecorded, false);
    assert.equal(parsed.state, "detect_gaps");
    assert.equal(parsed.reason, "provenance_missing");
    assert.match(parsed.nextAction, /🔬 Grill \/ refinement results/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--body-file with an already-refined body AND a recorded no-gap results comment seeds grill_clean", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-refined-prov-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    const commentsPath = path.join(tempDir, "comments.json");
    await writeFile(bodyPath, REFINED_BODY, "utf8");
    await writeFile(commentsPath, JSON.stringify([{ body: NO_GAPS_COMMENT }]), "utf8");
    const { stdout } = await runDetect(["--body-file", bodyPath, "--comments-file", commentsPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.snapshot.openGapCount, 0);
    assert.equal(parsed.snapshot.provenanceRecorded, true);
    assert.equal(parsed.state, "grill_clean");
    assert.equal(parsed.reason, "provenance_recorded");
    assert.equal(parsed.bypass, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--comments-file accepts a { comments: [...] } wrapper object", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-comments-wrapper-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    const commentsPath = path.join(tempDir, "comments.json");
    await writeFile(bodyPath, REFINED_BODY, "utf8");
    await writeFile(commentsPath, JSON.stringify({ comments: [{ body: NO_GAPS_COMMENT }] }), "utf8");
    const { stdout } = await runDetect(["--body-file", bodyPath, "--comments-file", commentsPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.state, "grill_clean");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--body-file with a bypass-recorded results comment seeds grill_clean flagged as bypass", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-bypass-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    const commentsPath = path.join(tempDir, "comments.json");
    await writeFile(bodyPath, REFINED_BODY, "utf8");
    await writeFile(
      commentsPath,
      JSON.stringify([{ body: `## ${RESULTS_TITLE}\n\nbypass: operator-authorized by mfittko\n\nRan anyway; no gaps found.` }]),
      "utf8",
    );
    const { stdout } = await runDetect(["--body-file", bodyPath, "--comments-file", commentsPath]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.state, "grill_clean");
    assert.equal(parsed.reason, "provenance_bypass_recorded");
    assert.equal(parsed.bypass, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--body-file with a refined body on a plan surface seeds grill_clean with no comments-file (shape-only)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-plan-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    await writeFile(bodyPath, REFINED_BODY, "utf8");
    const { stdout } = await runDetect(["--body-file", bodyPath, "--surface", "plan"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.state, "grill_clean");
    assert.equal(parsed.reason, "plan_shape_only");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--comments-file is rejected in --input mode, same as --surface", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-comments-input-mode-"));
  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const commentsPath = path.join(tempDir, "comments.json");
    await writeFile(snapshotPath, JSON.stringify({ loaded: true }), "utf8");
    await writeFile(commentsPath, JSON.stringify([]), "utf8");
    await assert.rejects(
      runDetect(["--input", snapshotPath, "--comments-file", commentsPath]),
      /--comments-file applies only to --body-file mode/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("end-to-end: a hand-authored matrix with no comments gets a real semantic pass (detect_gaps), then a zero-gap results comment reaches grill_clean, and a gap-filling results comment also reaches grill_clean", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grill-detect-e2e-"));
  try {
    const bodyPath = path.join(tempDir, "body.md");
    await writeFile(bodyPath, REFINED_BODY, "utf8");

    // Pass 1: no comments recorded yet -- the detector refuses the zero-iteration
    // exit and routes back to the semantic gap pass instead of a silent no-op.
    const first = JSON.parse((await runDetect(["--body-file", bodyPath])).stdout);
    assert.equal(first.state, "detect_gaps");
    assert.equal(first.reason, "provenance_missing");

    // Pass 2: the semantic pass ran, found no gaps, and recorded its own
    // provenance by posting a results comment stating so.
    const noGapsCommentsPath = path.join(tempDir, "comments-no-gaps.json");
    await writeFile(noGapsCommentsPath, JSON.stringify([{ body: NO_GAPS_COMMENT }]), "utf8");
    const second = JSON.parse((await runDetect(["--body-file", bodyPath, "--comments-file", noGapsCommentsPath])).stdout);
    assert.equal(second.state, "grill_clean");
    assert.equal(second.reason, "provenance_recorded");

    // Alternative pass: the semantic pass found and filled a gap, and recorded
    // that outcome instead -- also a recorded pass, also grill_clean on a re-check.
    const gapFillingCommentsPath = path.join(tempDir, "comments-gap-filling.json");
    await writeFile(gapFillingCommentsPath, JSON.stringify([{ body: GAP_FILLING_COMMENT }]), "utf8");
    const third = JSON.parse((await runDetect(["--body-file", bodyPath, "--comments-file", gapFillingCommentsPath])).stdout);
    assert.equal(third.state, "grill_clean");
    assert.equal(third.reason, "provenance_recorded");
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
