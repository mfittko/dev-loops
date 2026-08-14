import assert from "node:assert/strict";
import test, { after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  RUN_ID_MARKERS,
  NEUTRAL_RUN_ID_VAR,
  resolveRunId,
  mintRunId,
  runContextEnv,
  runContextPath,
  writeRunContext,
  readRunContext,
  ensureRunId,
  isClaudeHarness,
  CLAUDE_HARNESS_MARKER,
} from "../src/loop/run-context.mjs";

// Track temp dirs and clean them up after the suite so CI does not accumulate /tmp entries.
const tempRoots = [];
function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-"));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RUN_ID_MARKERS lists the neutral primary then the Pi-injected alias", () => {
  assert.deepEqual(RUN_ID_MARKERS, ["DEVLOOPS_RUN_ID", "PI_SUBAGENT_RUN_ID"]);
  assert.equal(NEUTRAL_RUN_ID_VAR, "DEVLOOPS_RUN_ID");
});

test("resolveRunId reads the neutral var", () => {
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "neutral" }), "neutral");
});

// The Pi runtime injects PI_SUBAGENT_RUN_ID (not DEVLOOPS_RUN_ID) into async-subagent
// child envs (#1008): it is honored as the run-id alias so the async-start gate recognizes
// the Pi context. The neutral var wins when both are present.
test("resolveRunId reads the Pi-injected alias when the neutral var is absent", () => {
  assert.equal(resolveRunId({ PI_SUBAGENT_RUN_ID: "pi-run" }), "pi-run");
});

test("resolveRunId prefers the neutral var over the Pi-injected alias", () => {
  assert.equal(
    resolveRunId({ DEVLOOPS_RUN_ID: "neutral", PI_SUBAGENT_RUN_ID: "pi-run" }),
    "neutral",
  );
});

test("resolveRunId trims and treats blank/absent as null", () => {
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "  spaced  " }), "spaced");
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "   " }), null);
  assert.equal(resolveRunId({}), null);
  // The undefined default resolves from process.env. In CI no run-id marker is
  // present, but under a Pi async-subagent session the runtime injects its
  // run-id alias into process.env, so strip every ambient marker to keep this
  // assertion environment-independent (mirrors the CI guarantee).
  const ambientClean = { ...process.env };
  for (const marker of RUN_ID_MARKERS) delete ambientClean[marker];
  assert.equal(resolveRunId(ambientClean), null);
});

test("mintRunId returns a neutral, unique id", () => {
  const a = mintRunId();
  const b = mintRunId();
  assert.match(a, /^devloops-[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("runContextEnv sets only the neutral var", () => {
  assert.deepEqual(runContextEnv("xyz"), { DEVLOOPS_RUN_ID: "xyz" });
});

test("writeRunContext/readRunContext roundtrip under .pi/", () => {
  const root = makeTempRoot();
  const written = writeRunContext({ runId: "devloops-1", root, mintedAt: "2026-01-01T00:00:00Z" });
  assert.equal(written, runContextPath(root));
  assert.equal(written, path.join(root, ".pi", "dev-loop-run-context.json"));

  const read = readRunContext({ root });
  assert.deepEqual(read, { runId: "devloops-1", mintedAt: "2026-01-01T00:00:00Z" });
});

test("writeRunContext defaults mintedAt to an ISO timestamp when not supplied", () => {
  const root = makeTempRoot();
  writeRunContext({ runId: "devloops-default-ts", root });
  const read = readRunContext({ root });
  assert.equal(read.runId, "devloops-default-ts");
  assert.match(read.mintedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("readRunContext returns null when absent or malformed", () => {
  const root = makeTempRoot();
  assert.equal(readRunContext({ root }), null);
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(runContextPath(root), "not json", "utf8");
  assert.equal(readRunContext({ root }), null);
});

test("writeRunContext rejects an empty run id", () => {
  const root = makeTempRoot();
  assert.throws(() => writeRunContext({ runId: "", root }), /non-empty string/);
});

test("ensureRunId reuses an existing env run id without minting or writing", () => {
  const root = makeTempRoot();
  const result = ensureRunId({ env: { DEVLOOPS_RUN_ID: "devloops-existing" }, root });
  assert.deepEqual(result, { runId: "devloops-existing", minted: false, statePath: null });
  // No state file should be written when reusing.
  assert.equal(fs.existsSync(runContextPath(root)), false);
});

test("ensureRunId mints and persists when no run id is present", () => {
  const root = makeTempRoot();
  const result = ensureRunId({ env: {}, root, mintedAt: "2026-02-02T00:00:00Z" });
  assert.equal(result.minted, true);
  assert.match(result.runId, /^devloops-/);
  assert.equal(result.statePath, runContextPath(root));
  assert.deepEqual(readRunContext({ root }), { runId: result.runId, mintedAt: "2026-02-02T00:00:00Z" });
});

test("ensureRunId mints in-memory when no root is given (no file write)", () => {
  const result = ensureRunId({ env: {} });
  assert.equal(result.minted, true);
  assert.equal(result.statePath, null);
  assert.match(result.runId, /^devloops-/);
});

test("isClaudeHarness is true only when CLAUDECODE is exactly \"1\"", () => {
  // Assert against explicit env objects only — the default arg reads process.env,
  // whose CLAUDECODE is ambient (set under the Claude Code harness, unset in CI).
  assert.equal(CLAUDE_HARNESS_MARKER, "CLAUDECODE");
  assert.equal(isClaudeHarness({ CLAUDECODE: "1" }), true);
  assert.equal(isClaudeHarness({ CLAUDECODE: "0" }), false);
  assert.equal(isClaudeHarness({ CLAUDECODE: "true" }), false);
  assert.equal(isClaudeHarness({ CLAUDECODE: "" }), false);
  assert.equal(isClaudeHarness({}), false);
});
