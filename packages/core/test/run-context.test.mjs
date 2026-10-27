import assert from "node:assert/strict";
import { afterAll as after, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  RUN_ID_MARKERS,
  NEUTRAL_RUN_ID_VAR,
  NATIVE_PI_CHILD_MARKER,
  NATIVE_PI_PARENT_SESSION_MARKER,
  NATIVE_PI_RUNNER_MARKER,
  NATIVE_PI_SESSION_MARKER,
  NATIVE_PI_ASYNC_MARKERS,
  ASYNC_CONTEXT_ENV_MARKERS,
  resolveRunId,
  isNativePiAsyncContext,
  synthesizePiRunId,
  mintRunId,
  runContextEnv,
  runContextPath,
  writeRunContext,
  readRunContext,
  ensureRunId,
  isClaudeHarness,
  CLAUDE_HARNESS_MARKER,
  validateNativeCodexMetadata,
  describeCodexDiscoveryFailure,
  isNativeCodexThreadId,
  resolveCodexRolloutJournal,
  resolveNativeCodexContext,
  resolveNativeCodexHome,
} from "../src/loop/run-context.mjs";

const codexId = "01a15519-285b-74b3-8f36-01e51619bba3";
function codexMetadata(id = codexId) {
  return { type: "session_meta", payload: { id, parent_thread_id: "parent", source: {
    subagent: { thread_spawn: { parent_thread_id: "parent", depth: 2, agent_path: "/root/child", agent_role: null } },
  }, base_instructions: { text: "private instructions" } } };
}
function codexFixture() {
  const root = makeTempRoot();
  const dir = path.join(root, "sessions", "2026", "10", "19");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-19T18-57-54-${codexId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(codexMetadata())}\nSECRET TRANSCRIPT`);
  return { root, dir, file, env: { CODEX_HOME: root, CODEX_THREAD_ID: codexId } };
}

test("native Codex metadata validates child origin and returns only identity", () => {
  const result = validateNativeCodexMetadata(codexMetadata(), codexId);
  assert.equal(result.status, "valid");
  assert.equal(result.depth, 2);
  assert.equal(result.agentRole, null);
  assert.doesNotMatch(JSON.stringify(result), /private instructions|base_instructions/);
  assert.equal(validateNativeCodexMetadata(null, codexId).status, "rejected");
  assert.equal(validateNativeCodexMetadata(codexMetadata(), undefined).status, "rejected");
  for (const mutate of [
    (p) => { p.id = "other"; },
    (p) => { p.source = "cli"; },
    (p) => { p.source = { subagent: "review" }; },
    (p) => { p.parent_thread_id = "different"; },
    (p) => { p.parent_thread_id = codexId; p.source.subagent.thread_spawn.parent_thread_id = codexId; },
    (p) => { p.source.subagent.thread_spawn.depth = 0; },
    (p) => { p.source.subagent.thread_spawn.depth = 1.5; },
    (p) => { delete p.parent_thread_id; },
  ]) {
    const metadata = codexMetadata();
    mutate(metadata.payload);
    assert.equal(validateNativeCodexMetadata(metadata, codexId).status, "rejected");
  }
});

test("native Codex discovery is bounded, header-only and rejects uncertain IO", () => {
  const { env, file, dir } = codexFixture();
  assert.equal(resolveNativeCodexContext({ env }).status, "valid");
  let bytes = 0;
  const trackedFs = { ...fs, readSync(...args) { const count = fs.readSync(...args); bytes += count; return count; } };
  assert.equal(resolveNativeCodexContext({ env, fs: trackedFs }).status, "valid");
  assert.equal(bytes, fs.readFileSync(file).indexOf(10) + 1);
  const oversizedMetadata = codexMetadata();
  oversizedMetadata.payload.base_instructions.text = "x".repeat(128 * 1024);
  const oversizedHeader = `${JSON.stringify(oversizedMetadata)}\n`;
  assert.ok(Buffer.from(oversizedHeader).indexOf(10) > 128 * 1024);
  fs.writeFileSync(file, oversizedHeader);
  bytes = 0;
  const oversizedResult = resolveNativeCodexContext({ env, fs: trackedFs });
  assert.equal(oversizedResult.status, "rejected");
  assert.match(oversizedResult.reason, /exceeds byte bound/);
  assert.ok(bytes <= 128 * 1024);
  fs.copyFileSync(file, path.join(dir, `rollout-duplicate-${codexId}.jsonl`));
  assert.match(resolveNativeCodexContext({ env }).reason, /ambiguous/i);
  fs.unlinkSync(path.join(dir, `rollout-duplicate-${codexId}.jsonl`));
  for (const content of ["not json\n", "{}\n", "x".repeat(128 * 1024 + 1), JSON.stringify(codexMetadata())]) {
    fs.writeFileSync(file, content);
    assert.equal(resolveNativeCodexContext({ env }).status, "rejected");
  }
  assert.equal(resolveNativeCodexContext({ env, fs: { ...fs, openSync() { throw new Error("unreadable"); } } }).status, "rejected");
  assert.equal(resolveNativeCodexContext({ env, fs: { ...fs, opendirSync() { throw new Error("unreadable"); } } }).status, "rejected");
  fs.unlinkSync(file);
  assert.match(resolveNativeCodexContext({ env }).reason, /not found/i);
  assert.equal(resolveNativeCodexContext({ env: { CODEX_THREAD_ID: "unknown" } }).status, "rejected");
});

test("native Codex discovery helper binds the one journal the header reader then reads", () => {
  // Shared locator: the header-only identity reader and the terminal-evidence
  // adapter must resolve the SAME single file, never two independent locators.
  const { env, file } = codexFixture();
  assert.deepEqual(resolveCodexRolloutJournal({ threadId: codexId, env }), { ok: true, file });
  assert.deepEqual(resolveCodexRolloutJournal({ threadId: codexId.replace(/a3$/, "a4"), env }), { ok: false, code: "not_found" });
  // The extraction preserves the header-only, byte-bounded read of that file.
  let bytes = 0;
  const trackedFs = { ...fs, readSync(...args) { const count = fs.readSync(...args); bytes += count; return count; } };
  assert.equal(resolveNativeCodexContext({ env, fs: trackedFs }).status, "valid");
  assert.equal(bytes, fs.readFileSync(file).indexOf(10) + 1);
});

test("native Codex discovery rejects a lookup key that is not a UUIDv7 identity", () => {
  const { env, file } = codexFixture();
  assert.deepEqual(resolveCodexRolloutJournal({ threadId: codexId, env }), { ok: true, file });
  // A non-UUID key names no thread, so it is "not found" — never "unreadable" via a
  // thrown date parse that would mislabel the failure class.
  for (const rejected of ["unknown", codexId.slice(0, -1), codexId.toUpperCase(), "", 42, undefined, null]) {
    assert.deepEqual(resolveCodexRolloutJournal({ threadId: rejected, env }), { ok: false, code: "not_found" });
  }
  assert.equal(isNativeCodexThreadId(codexId), true);
  assert.equal(isNativeCodexThreadId("unknown"), false);
});

/** A stub fs whose one fixture date directory yields `entries` in the given order. */
function orderedDiscoveryFs(directory, entries) {
  return {
    ...fs,
    opendirSync(requested) {
      if (requested !== directory) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      let index = 0;
      return { readSync: () => (index < entries.length ? entries[index++] : null), closeSync() {} };
    },
  };
}

test("native Codex discovery decides once, so its typed reason never depends on enumeration order", () => {
  const root = makeTempRoot();
  const directory = path.join(root, "sessions", "2026", "10", "19");
  fs.mkdirSync(directory, { recursive: true });
  const env = { CODEX_HOME: root };
  const fileEntry = (prefix) => ({ name: `rollout-${prefix}-${codexId}.jsonl`, isFile: () => true });
  const directoryEntry = { name: `rollout-dir-${codexId}.jsonl`, isFile: () => false };

  // Two matching rollout files plus one matching-name directory: one typed reason for
  // the same directory state, in either enumeration order.
  for (const entries of [[fileEntry("a"), fileEntry("b"), directoryEntry], [directoryEntry, fileEntry("a"), fileEntry("b")]]) {
    assert.deepEqual(resolveCodexRolloutJournal({ threadId: codexId, env, fs: orderedDiscoveryFs(directory, entries) }),
      { ok: false, code: "ambiguous" });
  }
  // A single matching name that is not a regular file keeps its own typed reason.
  assert.deepEqual(resolveCodexRolloutJournal({ threadId: codexId, env, fs: orderedDiscoveryFs(directory, [directoryEntry]) }),
    { ok: false, code: "not_regular_file" });
  assert.deepEqual(resolveCodexRolloutJournal({ threadId: codexId, env, fs: orderedDiscoveryFs(directory, []) }),
    { ok: false, code: "not_found" });
});

test("discovery failure prose is total, so a rejected result never carries an undefined reason", () => {
  const unidentified = "Native Codex metadata is unreadable or malformed.";
  assert.equal(describeCodexDiscoveryFailure("symlink"), unidentified);
  assert.equal(describeCodexDiscoveryFailure(undefined), unidentified);
  const prose = new Set();
  for (const code of ["entry_bound", "not_regular_file", "ambiguous", "not_found", "unreadable"]) {
    const described = describeCodexDiscoveryFailure(code);
    assert.equal(typeof described, "string");
    assert.ok(described.length > 0);
    prose.add(described);
  }
  // Every known code keeps its own diagnostic; the fallback is only for unknown codes.
  assert.equal(prose.size, 5);
});

test("native Codex home resolution is one path both readers share", () => {
  assert.equal(resolveNativeCodexHome({ CODEX_HOME: "/custom/codex" }), "/custom/codex");
  assert.equal(resolveNativeCodexHome({ HOME: "/home/operator" }), path.join("/home/operator", ".codex"));
});

test("native Codex discovery admits adjacent local dates and stops at its entry bound", () => {
  const { env, file, root } = codexFixture();
  const adjacent = path.join(root, "sessions/2026/10/20");
  fs.mkdirSync(adjacent, { recursive: true });
  fs.renameSync(file, path.join(adjacent, path.basename(file)));
  assert.equal(resolveNativeCodexContext({ env }).status, "valid");
  let reads = 0;
  const boundedFs = { ...fs, opendirSync() { return {
    readSync() { reads++; return { name: "unrelated" }; }, closeSync() {},
  }; } };
  assert.match(resolveNativeCodexContext({ env, fs: boundedFs }).reason, /entry bound/);
  assert.equal(reads, 4097);
});

test("native Codex run identity is stable, sibling distinct, and never borrows or mints", () => {
  const { env, file, dir, root } = codexFixture();
  const inherited = { ...env, DEVLOOPS_RUN_ID: "stale", PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: "old" };
  assert.equal(resolveRunId(inherited), `codex-thread-${codexId}`);
  assert.equal(resolveRunId(inherited), `codex-thread-${codexId}`);
  const sibling = codexId.replace(/a3$/, "a4");
  fs.writeFileSync(path.join(dir, `rollout-sibling-${sibling}.jsonl`), `${JSON.stringify(codexMetadata(sibling))}\n`);
  assert.equal(resolveRunId({ ...env, CODEX_THREAD_ID: sibling }), `codex-thread-${sibling}`);
  assert.equal(resolveRunId({ ...inherited, DEVLOOPS_DETACHED: "1" }), null);
  fs.unlinkSync(file);
  assert.equal(resolveRunId(inherited), null);
  assert.throws(() => ensureRunId({ env: inherited, root }), /Codex/);
  assert.equal(fs.existsSync(runContextPath(root)), false);
});

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

test("RUN_ID_MARKERS lists the neutral primary then the legacy pi-subagents alias", () => {
  assert.deepEqual(RUN_ID_MARKERS, ["DEVLOOPS_RUN_ID", "PI_SUBAGENT_RUN_ID"]);
  assert.equal(NEUTRAL_RUN_ID_VAR, "DEVLOOPS_RUN_ID");
});

test("resolveRunId reads the neutral var", () => {
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "neutral" }), "neutral");
});

// Historical (#1008): pi-subagents <= 0.64 injected PI_SUBAGENT_RUN_ID (not DEVLOOPS_RUN_ID)
// into async-subagent child envs, so it is honored as the legacy run-id alias. pi-subagents
// >= 0.65 stopped injecting it — see the native-marker cases below. The neutral var wins
// when both are present.
test("resolveRunId reads the legacy pi-subagents alias when the neutral var is absent", () => {
  assert.equal(resolveRunId({ PI_SUBAGENT_RUN_ID: "pi-run" }), "pi-run");
});

test("resolveRunId prefers the neutral var over the legacy pi-subagents alias", () => {
  assert.equal(
    resolveRunId({ DEVLOOPS_RUN_ID: "neutral", PI_SUBAGENT_RUN_ID: "pi-run" }),
    "neutral",
  );
});

test("resolveRunId trims and treats blank/absent as null", () => {
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "  spaced  " }), "spaced");
  assert.equal(resolveRunId({ DEVLOOPS_RUN_ID: "   " }), null);
  assert.equal(resolveRunId({}), null);
  // We deliberately do NOT call resolveRunId() with no argument here: the
  // default resolves from process.env, which carries the Pi-runtime-injected
  // async-context markers under an async-subagent session (and none in CI). Pass an
  // explicitly marker-stripped env so this assertion is environment-independent
  // (mirrors the CI guarantee). Strip every async-context marker, not just the
  // run-id carriers — the native pi-subagents >= 0.65 markers synthesize an id too.
  const ambientClean = { ...process.env };
  for (const marker of ASYNC_CONTEXT_ENV_MARKERS) delete ambientClean[marker];
  assert.equal(resolveRunId(ambientClean), null);
});

// ---------------------------------------------------------------------------
// Native Pi async-runner markers (pi-subagents >= 0.65): they carry no run id,
// so a stable one is synthesized from the parent session instead of returning null.
// ---------------------------------------------------------------------------

test("NATIVE_PI_ASYNC_MARKERS names the three native markers and stays out of RUN_ID_MARKERS", () => {
  assert.deepEqual(NATIVE_PI_ASYNC_MARKERS, [
    NATIVE_PI_CHILD_MARKER,
    NATIVE_PI_PARENT_SESSION_MARKER,
    NATIVE_PI_RUNNER_MARKER,
  ]);
  assert.deepEqual(ASYNC_CONTEXT_ENV_MARKERS, [...RUN_ID_MARKERS, ...NATIVE_PI_ASYNC_MARKERS, "CODEX_THREAD_ID"]);
  // The native markers carry no run id — folding them into RUN_ID_MARKERS would make
  // resolveRunId return the child flag ("1") as if it were an id.
  for (const marker of NATIVE_PI_ASYNC_MARKERS) {
    assert.ok(!RUN_ID_MARKERS.includes(marker), `${marker} must not be a run-id carrier`);
  }
});

const nativePiEnv = (overrides = {}) => ({
  [NATIVE_PI_CHILD_MARKER]: "1",
  [NATIVE_PI_PARENT_SESSION_MARKER]: "session-abc",
  ...overrides,
});

test("isNativePiAsyncContext requires the child flag AND a non-empty parent session", () => {
  assert.equal(isNativePiAsyncContext(nativePiEnv()), true);
  // The runner marker corroborates but is never sufficient alone.
  assert.equal(isNativePiAsyncContext({ [NATIVE_PI_RUNNER_MARKER]: "1" }), false);
  // Neither half is sufficient on its own.
  assert.equal(isNativePiAsyncContext({ [NATIVE_PI_CHILD_MARKER]: "1" }), false);
  assert.equal(isNativePiAsyncContext({ [NATIVE_PI_PARENT_SESSION_MARKER]: "session-abc" }), false);
  // A flag value other than exactly "1" is not the runner's contract value.
  assert.equal(isNativePiAsyncContext(nativePiEnv({ [NATIVE_PI_CHILD_MARKER]: "true" })), false);
  // Blank parent session ids are not inspectable.
  assert.equal(isNativePiAsyncContext(nativePiEnv({ [NATIVE_PI_PARENT_SESSION_MARKER]: "   " })), false);
  assert.equal(isNativePiAsyncContext({}), false);
});

test("resolveRunId synthesizes a stable id from the native Pi parent session", () => {
  const expected = "pi-session-session-abc";
  assert.equal(resolveRunId(nativePiEnv()), expected);
  // Same parent session -> same id (repeated resolution is stable).
  assert.equal(resolveRunId(nativePiEnv()), expected);
  assert.equal(synthesizePiRunId("session-abc"), expected);
  // A different parent session yields a different id.
  assert.notEqual(resolveRunId(nativePiEnv({ [NATIVE_PI_PARENT_SESSION_MARKER]: "session-xyz" })), expected);
  // Trimmed, so whitespace padding does not mint a second identity.
  assert.equal(resolveRunId(nativePiEnv({ [NATIVE_PI_PARENT_SESSION_MARKER]: "  session-abc  " })), expected);
});

// Sibling regression: runner coordination treats an EQUAL run id as an authorized refresh
// rather than a conflict, so two concurrent children of one parent session sharing an id would
// silently bypass the one-runner-per-PR lease. The child's own session id keeps them distinct.
test("resolveRunId gives sibling native Pi children of one parent session distinct ids", () => {
  const parent = "session-abc";
  const siblingA = nativePiEnv({ [NATIVE_PI_PARENT_SESSION_MARKER]: parent, [NATIVE_PI_SESSION_MARKER]: "child-a" });
  const siblingB = nativePiEnv({ [NATIVE_PI_PARENT_SESSION_MARKER]: parent, [NATIVE_PI_SESSION_MARKER]: "child-b" });

  assert.equal(resolveRunId(siblingA), "pi-session-child-a");
  assert.equal(resolveRunId(siblingB), "pi-session-child-b");
  assert.notEqual(resolveRunId(siblingA), resolveRunId(siblingB));
  // Stable per child, and the parent session alone still yields the documented fallback id.
  assert.equal(resolveRunId(siblingA), "pi-session-child-a");
  assert.equal(resolveRunId(nativePiEnv({ [NATIVE_PI_PARENT_SESSION_MARKER]: parent })), `pi-session-${parent}`);
  // Trimmed, so whitespace padding does not mint a second identity for the same child.
  assert.equal(resolveRunId(nativePiEnv({ [NATIVE_PI_SESSION_MARKER]: "  child-a  " })), "pi-session-child-a");
});

test("the Pi per-child session id is not async-start evidence on its own", () => {
  // The Pi runtime injects it into every Pi shell, the main agent's included.
  assert.equal(isNativePiAsyncContext({ [NATIVE_PI_SESSION_MARKER]: "child-a" }), false);
  assert.equal(resolveRunId({ [NATIVE_PI_SESSION_MARKER]: "child-a" }), null);
  assert.equal(resolveRunId({ [NATIVE_PI_CHILD_MARKER]: "1", [NATIVE_PI_SESSION_MARKER]: "child-a" }), null);
  // It is an identity, not a signal, so it is not part of the async-context marker set.
  assert.ok(!NATIVE_PI_ASYNC_MARKERS.includes(NATIVE_PI_SESSION_MARKER));
  assert.ok(!ASYNC_CONTEXT_ENV_MARKERS.includes(NATIVE_PI_SESSION_MARKER));
});

test("resolveRunId still returns null when no async-context marker is present", () => {
  assert.equal(resolveRunId({}), null);
  assert.equal(resolveRunId({ [NATIVE_PI_RUNNER_MARKER]: "1" }), null);
  assert.equal(resolveRunId({ [NATIVE_PI_CHILD_MARKER]: "1" }), null);
  assert.equal(resolveRunId({ [NATIVE_PI_PARENT_SESSION_MARKER]: "session-abc" }), null);
});

test("resolveRunId prefers a run-id carrier over the synthesized native Pi id", () => {
  assert.equal(resolveRunId(nativePiEnv({ DEVLOOPS_RUN_ID: "neutral" })), "neutral");
  assert.equal(resolveRunId(nativePiEnv({ PI_SUBAGENT_RUN_ID: "legacy" })), "legacy");
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
