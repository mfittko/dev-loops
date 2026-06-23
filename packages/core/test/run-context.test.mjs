import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  RUN_ID_MARKERS,
  NEUTRAL_RUN_ID_VAR,
  PI_RUN_ID_ALIAS_VAR,
  resolveRunId,
  mintRunId,
  runContextEnv,
  runContextPath,
  writeRunContext,
  readRunContext,
  ensureRunId,
} from "../src/loop/run-context.mjs";

test("RUN_ID_MARKERS lists the neutral var first, Pi alias second", () => {
  assert.deepEqual(RUN_ID_MARKERS, ["DEVLOOPS_RUN_ID", "PI_SUBAGENT_RUN_ID"]);
  assert.equal(NEUTRAL_RUN_ID_VAR, "DEVLOOPS_RUN_ID");
  assert.equal(PI_RUN_ID_ALIAS_VAR, "PI_SUBAGENT_RUN_ID");
});

test("resolveRunId prefers the neutral var over the Pi alias", () => {
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "neutral", PI_SUBAGENT_RUN_ID: "pi" }), "neutral");
});

test("resolveRunId honors the Pi alias when the neutral var is absent", () => {
  assert.equal(resolveRunId({ PI_SUBAGENT_RUN_ID: "pi-run" }), "pi-run");
});

test("resolveRunId trims and treats blank/absent as null", () => {
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "  spaced  " }), "spaced");
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "   " }), null);
  assert.equal(resolveRunId({}), null);
  assert.equal(resolveRunId(undefined), null);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-"));
  const written = writeRunContext({ runId: "devloops-1", root, mintedAt: "2026-01-01T00:00:00Z" });
  assert.equal(written, runContextPath(root));
  assert.equal(written, path.join(root, ".pi", "dev-loop-run-context.json"));

  const read = readRunContext({ root });
  assert.deepEqual(read, { runId: "devloops-1", mintedAt: "2026-01-01T00:00:00Z" });
});

test("readRunContext returns null when absent or malformed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-"));
  assert.equal(readRunContext({ root }), null);
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(runContextPath(root), "not json", "utf8");
  assert.equal(readRunContext({ root }), null);
});

test("writeRunContext rejects an empty run id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-"));
  assert.throws(() => writeRunContext({ runId: "", root }), /non-empty string/);
});

test("ensureRunId reuses an existing env run id without minting or writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-"));
  const result = ensureRunId({ env: { PI_SUBAGENT_RUN_ID: "pi-existing" }, root });
  assert.deepEqual(result, { runId: "pi-existing", minted: false, statePath: null });
  // No state file should be written when reusing.
  assert.equal(fs.existsSync(runContextPath(root)), false);
});

test("ensureRunId mints and persists when no run id is present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-"));
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
