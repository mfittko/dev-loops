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

test("the emitted plan carries angles + groups + floors (GATE-EXEC-PROPORTIONALITY, primer-owned deterministic plan)", async () => {
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
    headFiles: { "docs/note.md": "line one\nline two\nline three\n" },
  });
  try {
    const result = runDispatch(fixture);
    assert.equal(result.mode, "full_fanout");
    assert.equal(result.reason, "over_threshold");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
