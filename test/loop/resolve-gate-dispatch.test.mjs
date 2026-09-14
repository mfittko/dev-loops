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
