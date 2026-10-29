import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { parseSeverities } from "../../scripts/loop/resolve-gate-dispatch.mjs";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/loop/resolve-gate-dispatch.mjs", import.meta.url)
);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Minimal isolated git fixture with a light-mode-enabled `.devloops`, one
 * base commit, and a caller-supplied head commit — mirrors the fixture
 * pattern already used by test/loop/check-adr-tripwire.test.mjs. */
async function makeFixture({ devloops, headFiles }) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "resolve-gate-dispatch-"));
  const fixture = path.join(tmp, "repo");
  await mkdir(fixture, { recursive: true });
  execSync(
    "git init -q -b main && git config user.email t@t && git config user.name t",
    { cwd: fixture, stdio: "ignore" },
  );
  await writeFile(path.join(fixture, ".devloops"), devloops);
  await writeFile(path.join(fixture, "base.md"), "base\n");
  execSync("git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
  for (const [relPath, content] of Object.entries(headFiles)) {
    const abs = path.join(fixture, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
  return { tmp, fixture };
}

function runDispatch(fixture, gate = "draft") {
  const out = execFileSync(
    (Bun.which("node") ?? "node"),
    [SCRIPT, "--gate", gate, "--base", "base", "--head", "HEAD"],
    { cwd: fixture, encoding: "utf8" },
  );
  return JSON.parse(out.trim());
}

const LIGHT_DEVLOOPS = "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 5\n    maxLines: 100\n";

test("parseSeverities trims and drops empty entries", () => {
  assert.deepEqual(parseSeverities("a, ,b"), ["a", "b"]);
});

test("parseSeverities returns [] for an empty string", () => {
  assert.deepEqual(parseSeverities(""), []);
});

test("parseSeverities returns undefined for null/undefined", () => {
  assert.equal(parseSeverities(undefined), undefined);
  assert.equal(parseSeverities(null), undefined);
});

// Regression: fail-CLOSED. When scope detection fails (scope.ok===false), the
// gate must route to full_fanout/scope_detection_failed, never collapse to
// inline. A bad --base ref makes the git diff inside detectScope fail offline.
test("scope.ok===false routes to full_fanout, never inline", () => {
  const out = execFileSync(
    (Bun.which("node") ?? "node"),
    [SCRIPT, "--gate", "draft", "--base", "nonexistent-ref-xyz-please"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const result = JSON.parse(out.trim());
  assert.equal(result.ok, true);
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "scope_detection_failed");
  assert.equal(result.threshold, null);
  assert.equal(result.scope.ok, false);
});

// ---------------------------------------------------------------------------
// End-to-end (#1984): the new GATE-EXEC-PROPORTIONALITY floors, wired through
// the real CLI against a real git fixture — not just the pure-function unit
// tests in packages/core/test/config.test.mjs.
// ---------------------------------------------------------------------------

test("a genuinely trivial, non-risk, passing-size diff under the cap resolves inline", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: LIGHT_DEVLOOPS,
    headFiles: { "docs/note.md": "A trivial docs change.\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.equal(result.mode, "inline");
    assert.equal(result.reason, "under_threshold");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a diff touching a risk path forces full_fanout even though it is tiny and under the size cap", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: LIGHT_DEVLOOPS,
    headFiles: { "scripts/loop/some-gate-helper.mjs": "export const x = 1;\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.equal(result.mode, "full_fanout");
    assert.equal(result.reason, "risk_path_touch");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the emitted plan carries angles + groups + floors (GATE-EXEC-PROPORTIONALITY, gate-coordinator-owned deterministic plan)", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: LIGHT_DEVLOOPS,
    headFiles: { "docs/note.md": "A trivial docs change.\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.equal(result.mode, "inline");
    assert.ok(Array.isArray(result.angles));
    assert.ok(Array.isArray(result.groups));
    assert.equal(typeof result.floors, "object");
    assert.equal(result.floors.riskPath, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a risk-path touch forces full_fanout while preserving the configured tier's angle set", async () => {
  const devloops = `${LIGHT_DEVLOOPS}gates:\n  draft:\n    tiers:\n      - name: docs\n        match:\n          kinds: [docs]\n        angles: [link-check]\n`;
  // Non-risky control: a docs diff OUTSIDE any risk path matches the "docs"
  // tier and gets its REDUCED angle set (mandatory pr-description + docs).
  const control = await makeFixture({ devloops, headFiles: { "docs/note.md": "A tiny doc.\n" } });
  // Risky case: the SAME docs-classified diff, but under scripts/**/*gate* —
  // matches the same tier by kind, yet also trips the risk-path floor.
  const risky = await makeFixture({ devloops, headFiles: { "scripts/loop/gate-note.md": "A tiny doc.\n" } });
  try {
    // Non-risky, under-cap, tier-matched diff: no floor fires, so mode may be
    // "inline" (nothing fires) — only the ANGLE SET (the tier's reduced set)
    // matters for this comparison, not the mode.
    const controlResult = runDispatch(control.fixture);
    const riskyResult = runDispatch(risky.fixture);
    assert.equal(riskyResult.mode, "full_fanout");
    assert.equal(riskyResult.reason, "risk_path_touch");
    // The floor changes dispatch mode, not selection: both diffs keep the
    // mandatory-complete tier set.
    assert.deepEqual(new Set(riskyResult.angles), new Set(controlResult.angles));
  } finally {
    await rm(control.tmp, { recursive: true, force: true });
    await rm(risky.tmp, { recursive: true, force: true });
  }
});

// KNOWN, bounded range asymmetry (resolve-gate-dispatch.mjs's own doc
// comment): risk-path/scope facts read the two-dot `base..head` diff while
// the size-budget outcome reads the shared three-dot `base...head` merge-base
// diff. When `base` has moved forward independently of `head`, the two
// ranges genuinely describe different diffs. This must never crash or emit a
// self-contradictory result — the tool still returns ONE coherent decision
// even when its own two internal reads disagree on the underlying diff.
test("a diverged base (base advanced independently of head) still resolves one coherent, non-crashing plan", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: LIGHT_DEVLOOPS,
    headFiles: { "docs/note.md": "A trivial docs change.\n" },
  });
  try {
    // Advance `base` past its original position with an UNRELATED commit —
    // the two-dot base..head diff now also reflects base's own drift
    // reversed, while the three-dot base...head (size-budget) diff does not.
    execSync("git checkout -q base", { cwd: fixture, stdio: "ignore" });
    await mkdir(path.join(fixture, "unrelated"), { recursive: true });
    await writeFile(path.join(fixture, "unrelated", "extra.md"), "unrelated base-only content\n");
    execSync("git add . && git commit -qm 'base drifts forward'", { cwd: fixture, stdio: "ignore" });
    execSync("git checkout -q -", { cwd: fixture, stdio: "ignore" }); // back to head's commit

    const result = runDispatch(fixture);
    assert.equal(result.ok, true);
    assert.ok(["inline", "full_fanout"].includes(result.mode));
    assert.equal(typeof result.reason, "string");
    assert.ok(Array.isArray(result.angles) || result.angles === null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("over-cap still short-circuits to over_threshold before the new floors are consulted", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 1\n    maxLines: 1\n",
    headFiles: { "src/note.mjs": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.equal(result.mode, "full_fanout");
    assert.equal(result.reason, "over_threshold");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Changeset fragments are skipped from the light-mode scope count, never from
// the risk-path floor.
const MICRO_DEVLOOPS = "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 2\n    maxLines: 40\n";

test("a source + test + changeset fragment diff resolves inline under maxFiles 2", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: MICRO_DEVLOOPS,
    headFiles: { "src/util.mjs": "export const x = 1;\n", "test/util.test.mjs": "import './x';\n", "changes/1-util.md": "---\nbump: patch\n---\nFix.\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.deepEqual([result.scope.filesChanged, result.mode, result.reason], [2, "inline", "under_threshold"]);
    assert.equal(result.floors.sizeOutcome, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a risk-path file plus a changeset fragment still forces full_fanout", async () => {
  const { tmp, fixture } = await makeFixture({
    devloops: MICRO_DEVLOOPS,
    headFiles: { "docs/decisions/x.md": "# x\n", "changes/1-x.md": "Fix.\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.deepEqual([result.scope.filesChanged, result.mode, result.reason], [1, "full_fanout", "risk_path_touch"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("diff-class tier matching reads the raw diff, not the light-mode counted scope", async () => {
  const devloops = `${LIGHT_DEVLOOPS}gates:\n  draft:\n    tiers:\n      - name: docs\n        match:\n          kinds: [docs]\n          maxLines: 5\n        angles: [link-check]\n`;
  const control = await makeFixture({ devloops, headFiles: { "docs/note.md": "A tiny doc.\n" } });
  // Counted scope is 1 line (under the tier cap); the raw diff is 11 lines.
  const mixed = await makeFixture({ devloops, headFiles: { "docs/note.md": "A tiny doc.\n", "changes/1-x.md": "x\n".repeat(10) } });
  try {
    const controlResult = runDispatch(control.fixture);
    const mixedResult = runDispatch(mixed.fixture);
    assert.deepEqual([mixedResult.scope.linesChanged, mixedResult.scope.rawLinesChanged], [1, 11]);
    assert.notDeepEqual(new Set(mixedResult.angles), new Set(controlResult.angles));
  } finally {
    await rm(control.tmp, { recursive: true, force: true });
    await rm(mixed.tmp, { recursive: true, force: true });
  }
});

// Judge track: the record file + label + head sha flags lower only the track.
function runJudge(fixture, { record, labels, headSha, gate = "draft", baseOnly = false, noRange = false }) {
  const args = [SCRIPT, "--gate", gate, ...(noRange ? [] : ["--base", "base", ...(baseOnly ? [] : ["--head", "HEAD"])])];
  if (record !== undefined) args.push("--judge-record", record);
  if (labels !== undefined) args.push("--labels", labels);
  if (headSha !== undefined) args.push("--head-sha", headSha);
  return JSON.parse(execFileSync((Bun.which("node") ?? "node"), args, { cwd: fixture, encoding: "utf8" }).trim());
}

test("judge record + matching label + current head lowers the track; every mismatch routes to full", async () => {
  const { tmp, fixture } = await makeFixture({ devloops: LIGHT_DEVLOOPS, headFiles: { "docs/note.md": "A trivial docs change.\n" } });
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: fixture, encoding: "utf8" }).trim();
    const good = path.join(tmp, "good.json");
    const stale = path.join(tmp, "stale.json");
    const broken = path.join(tmp, "broken.json");
    const rec = (headSha) => JSON.stringify({ schemaVersion: 1, headSha, track: "light", signals: [{ signal: "additive", reason: "docs only" }] });
    await writeFile(good, rec(sha));
    await writeFile(stale, rec("b".repeat(40)));
    await writeFile(broken, "{not json");

    for (const gate of ["draft", "preApproval"]) {
      const lowered = runJudge(fixture, { gate, record: good, labels: "gate:light", headSha: sha });
      assert.deepEqual([lowered.mode, lowered.track, lowered.trackReason], ["inline", "light", "judge_light"]);
    }
    const baseline = runJudge(fixture, {});
    assert.deepEqual([baseline.track, baseline.trackReason], ["full", "judge_record_absent"]);
    const full = (opts) => runJudge(fixture, opts).track;
    assert.equal(full({ labels: "gate:light", headSha: sha }), "full");
    assert.equal(full({ record: good, headSha: sha }), "full");
    assert.equal(full({ record: stale, labels: "gate:light", headSha: sha }), "full");
    assert.equal(full({ record: broken, labels: "gate:light", headSha: sha }), "full");
    assert.equal(full({ record: path.join(tmp, "missing.json"), labels: "gate:light", headSha: sha }), "full");
    const withFull = runJudge(fixture, { record: good, labels: "gate:light,gate:full", headSha: sha });
    assert.deepEqual([withFull.mode, withFull.track], ["full_fanout", "full"]);
    // The judge never changes the dispatch plan.
    for (const k of ["mode", "reason", "angles", "groups", "floors"]) assert.deepEqual(runJudge(fixture, { record: good, labels: "gate:light", headSha: sha })[k], baseline[k], k);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

const BIG_DOC = `${"export const a = 1;\n".repeat(150)}`;
const judgeRec = (headSha, track = "light") => JSON.stringify({ schemaVersion: 1, headSha, track, signals: [{ signal: "additive", reason: "docs only" }] });

test("over the cap, a lowering judge track re-checks the size outcome and risk facts", async () => {
  const clean = await makeFixture({ devloops: LIGHT_DEVLOOPS, headFiles: { "src/big.mjs": BIG_DOC } });
  // A t1 pattern that matches the code file makes the size outcome unusable (block).
  const t1 = await makeFixture({
    devloops: `${LIGHT_DEVLOOPS}gates:\n  size:\n    tiers:\n      t1:\n        patterns: ["src/**"]\n        sliceHardLoc: 10\n`,
    headFiles: { "src/big.mjs": BIG_DOC },
  });
  try {
    for (const [f, tmp, expected] of [[clean.fixture, clean.tmp, "reduced"], [t1.fixture, t1.tmp, "full"]]) {
      const sha = execSync("git rev-parse HEAD", { cwd: f, encoding: "utf8" }).trim();
      const rec = path.join(tmp, "rec.json");
      await writeFile(rec, judgeRec(sha));
      const r = runJudge(f, { record: rec, labels: "gate:light", headSha: sha });
      assert.equal(r.reason, "over_threshold");
      assert.equal(r.track, expected, JSON.stringify(r));
      if (expected === "full") assert.equal(r.trackReason, "risk_floor");
    }
  } finally {
    await rm(clean.tmp, { recursive: true, force: true });
    await rm(t1.tmp, { recursive: true, force: true });
  }
});

test("a --head-sha that is not the resolved head, and case-variant labels", async () => {
  const { tmp, fixture } = await makeFixture({ devloops: LIGHT_DEVLOOPS, headFiles: { "docs/note.md": "A trivial docs change.\n" } });
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: fixture, encoding: "utf8" }).trim();
    const other = "c".repeat(40);
    const rec = path.join(tmp, "rec.json");
    const recOther = path.join(tmp, "rec-other.json");
    const recNull = path.join(tmp, "rec-null.json");
    await writeFile(rec, judgeRec(sha));
    await writeFile(recOther, judgeRec(other));
    await writeFile(recNull, "null");
    // Record and supplied sha agree with each other but not with the real head.
    const spoof = runJudge(fixture, { record: recOther, labels: "gate:light", headSha: other });
    assert.deepEqual([spoof.track, spoof.trackReason], ["full", "judge_head_mismatch"]);
    const upper = runJudge(fixture, { record: rec, labels: " GATE:Light ", headSha: sha });
    assert.deepEqual([upper.track, upper.trackReason], ["light", "judge_light"]);
    const fullUpper = runJudge(fixture, { record: rec, labels: "gate:light,GATE:FULL", headSha: sha });
    assert.deepEqual([fullUpper.mode, fullUpper.track], ["full_fanout", "full"]);
    const nul = runJudge(fixture, { record: recNull, labels: "gate:light", headSha: sha });
    assert.equal(nul.trackReason, "judge_record_invalid");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("--base without --head diffs the working tree, so a matching --head-sha never lowers", async () => {
  const { tmp, fixture } = await makeFixture({ devloops: LIGHT_DEVLOOPS, headFiles: { "docs/note.md": "A trivial docs change.\n" } });
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: fixture, encoding: "utf8" }).trim();
    const rec = path.join(tmp, "rec.json");
    await writeFile(rec, judgeRec(sha));
    const both = runJudge(fixture, { record: rec, labels: "gate:light", headSha: sha });
    assert.equal(both.track, "light");
    const noBase = runJudge(fixture, { record: rec, labels: "gate:light", headSha: sha, noRange: true });
    assert.equal(noBase.track, "light");
    const baseOnly = runJudge(fixture, { record: rec, labels: "gate:light", headSha: sha, baseOnly: true });
    assert.deepEqual([baseOnly.track, baseOnly.trackReason], ["full", "judge_head_mismatch"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("an inline-severity escalation forces track full", async () => {
  const { tmp, fixture } = await makeFixture({ devloops: LIGHT_DEVLOOPS, headFiles: { "docs/note.md": "A trivial docs change.\n" } });
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: fixture, encoding: "utf8" }).trim();
    const rec = path.join(tmp, "rec.json");
    await writeFile(rec, judgeRec(sha));
    const out = JSON.parse(execFileSync((Bun.which("node") ?? "node"),
      [SCRIPT, "--gate", "draft", "--base", "base", "--head", "HEAD", "--judge-record", rec, "--labels", "gate:light", "--head-sha", sha, "--inline-severities", "high"],
      { cwd: fixture, encoding: "utf8" }).trim());
    assert.deepEqual([out.reason, out.track, out.trackReason], ["escalated", "full", "escalated"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
