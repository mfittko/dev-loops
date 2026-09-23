import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { runIdFreeEnv, runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";
import { buildFindingMarker, countUnresolvedGateAuthoredThreadsFromRawNodes } from "../../scripts/github/_gate-finding-surface.mjs";
import { detectCheckpointEvidence } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: runIdFreeEnv({ ...(options.env ?? {}), DEVLOOPS_RUN_ID: "" }),
});

function cleanGateBody(gate, headSha) {
  const lines = [
    "Gate review: " + gate,
    "Reviewed head SHA: " + headSha,
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: " + (gate === "draft_gate" ? "mark ready for review" : "await final human approval"),
  ];
  // pass/non-T1 on the pre_approval_gate so the size-budget merge gate imposes
  // no requirement here — these fixtures exercise gate-authored-thread
  // resolution, not the size gate.
  if (gate === "pre_approval_gate") {
    lines.push("Size-budget outcome: pass", "Size-budget T1 slice: not touched", "Size-budget waiver: none");
  }
  return lines.join("\n");
}

// #1585: the draftGateSatisfied field + pre-merge evidence check fold in the
// gate-authored thread invariant. detect-checkpoint-evidence reuses its existing
// review-thread payload (marker-only count, no extra gh round-trip) so a clean
// verdict with a dangling gate-authored thread fails the pre-merge evidence check.
test("#1585: an unresolved gate-authored thread carrying a finding marker fails the pre-merge evidence check (the count is exercised)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-1585-fold-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const marker = buildFindingMarker({ fp: "a".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  const { env } = await writeGhStubHelper(tempDir, [
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: JSON.stringify([
        { id: 42, body: cleanGateBody("draft_gate", "abc1234"), updated_at: "2026-05-29T21:00:00Z" },
        { id: 43, body: cleanGateBody("pre_approval_gate", "abc1234"), updated_at: "2026-05-29T22:00:00Z" },
      ]) + "\n",
    },
    { stdout: "[]" },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { id: "t1", isResolved: false, comments: { nodes: [{ databaseId: 9001, body: marker + "\n**nice-to-have** (`naming`): casing nit", author: { login: "gate-bot" } }] } },
        ] } } } },
      }) + "\n",
    },
    // ADR 0088: the marker-only pass above found one candidate thread, so the
    // count is narrowed by the authenticated gate login (same login the
    // thread's own comment carries here, so the narrowed count stays 1).
    { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "gate-bot" }) + "\n" },
  ], { repeatLastOnOverflow: true });

  const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
  assert.equal(result.code, 1, `Expected exit 1. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.preMergeGateCheck.ok, false);
  assert.equal(parsed.evidenceState, "violation");
  assert.match(parsed.preMergeGateCheck.failures.join("; "), /unresolved review threads/i);
});

test("#1585: draftGateSatisfied stays true when the gate-authored thread is resolved (positive counterpart)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-1585-fold-pos-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  // Disable fan-out evidence enforcement so the inline-style clean verdict
  // (no executionMode marker) is accepted — the fold under test is the
  // draftGateSatisfied thread invariant, not fan-out provenance.
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const marker = buildFindingMarker({ fp: "b".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  const { env } = await writeGhStubHelper(tempDir, [
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: JSON.stringify([
        { id: 42, body: cleanGateBody("draft_gate", "abc1234"), updated_at: "2026-05-29T21:00:00Z" },
        { id: 43, body: cleanGateBody("pre_approval_gate", "abc1234"), updated_at: "2026-05-29T22:00:00Z" },
      ]) + "\n",
    },
    { stdout: "[]" },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { id: "t1", isResolved: true, comments: { nodes: [{ databaseId: 9002, body: marker + "\n**nice-to-have** (`naming`): casing nit", author: { login: "gate-bot" } }] } },
        ] } } } },
      }) + "\n",
    },
  ], { repeatLastOnOverflow: true });

  const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
  assert.equal(result.code, 0, `Expected exit 0. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.draftGateSatisfied, true);
  assert.equal(parsed.preMergeGateCheck.ok, true);
});

test("#1585: an unreadable thread-fetch state (-1) folds draftGateSatisfied to false and fails the pre-merge evidence check (fail-closed)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-1585-unreadable-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const { env } = await writeGhStubHelper(tempDir, [
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: JSON.stringify([
        { id: 42, body: cleanGateBody("draft_gate", "abc1234"), updated_at: "2026-05-29T21:00:00Z" },
        { id: 43, body: cleanGateBody("pre_approval_gate", "abc1234"), updated_at: "2026-05-29T22:00:00Z" },
      ]) + "\n",
    },
    { stdout: "[]" },
    // Thread-fetch fails → fetchGithubReviewThreadsPayload throws → main()'s catch sets
    // unresolvedThreadCount=-1 AND unresolvedGateThreadCount=-1 → draftGateSatisfied folds to false.
    { assertArgs: ["api", "graphql"], assertArgContains: ["reviewThreads"], stdout: "", code: 1, stderr: "HTTP 500" },
  ], { repeatLastOnOverflow: true });

  const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
  // The thread-fetch failure (-1) fails the pre-merge evidence check fail-closed
  // (the draftGateSatisfied fold also sets it false, though the failure output
  // shape does not expose the field — the preMergeGateCheck failure is the
  // observable gate-close signal here).
  assert.equal(result.code, 1, `Expected exit 1. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.preMergeGateCheck.ok, false);
  assert.match(parsed.preMergeGateCheck.failures.join("; "), /could not fetch review thread state/i);
});

// ADR 0088: a thread that merely QUOTES a gate finding marker, but was
// authored by someone other than the authenticated gate login, must not
// count as a GATE-AUTHORED thread here — narrowed the same way
// detect-pr-gate-coordination-state.mjs narrows its own count (see the
// paired "#2381: ... cross-detector agreement" test there, which asserts
// mark_ready_for_review for this exact fixture shape). This PR still blocks
// on the SEPARATE, unrelated generic-unresolved-thread invariant
// (any unresolved thread, gate-authored or not — draft_gate's own evaluator
// branch never reads that signal, only the narrowed gate-authored count),
// so the login round-trip is exercised (assertArgs below requires it) and
// the resulting narrowed count is proven to agree with the coordination
// detector's own identical call, without claiming this fixture reaches
// draftGateSatisfied=true end to end (structurally unobservable here: the
// CLI's success JSON, where draftGateSatisfied is emitted, requires the
// generic invariant to ALSO pass, which requires the thread resolved — and a
// resolved thread never reaches the login-narrowing branch at all).
test("#2381: a foreign marker-quoting thread narrows the gate-authored count to 0 (login round-trip runs; agrees with detect-pr-gate-coordination-state.mjs's own narrowing)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-2381-foreign-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const marker = buildFindingMarker({ fp: "c".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  const rawThreadNodes = [
    // Marker-bearing, unresolved — but authored by a FOREIGN login, not this
    // gate's own authenticated login (resolved below as "gate-bot").
    { id: "t1", isResolved: false, comments: { nodes: [{ databaseId: 9003, body: marker + "\n**nice-to-have** (`naming`): casing nit", author: { login: "someone-else" } }] } },
  ];
  const { env } = await writeGhStubHelper(tempDir, [
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: JSON.stringify([
        { id: 42, body: cleanGateBody("draft_gate", "abc1234"), updated_at: "2026-05-29T21:00:00Z" },
        { id: 43, body: cleanGateBody("pre_approval_gate", "abc1234"), updated_at: "2026-05-29T22:00:00Z" },
      ]) + "\n",
    },
    { stdout: "[]" },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: rawThreadNodes } } } } }) + "\n",
    },
    // The marker-only pass finds one candidate, so the count is narrowed by
    // login — proves the round-trip actually runs for a foreign author too.
    { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "gate-bot" }) + "\n" },
  ], { repeatLastOnOverflow: true });

  const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
  // Still blocked, but ONLY by the generic invariant (any unresolved thread) —
  // never by the (now correctly narrowed-to-zero) gate-authored count.
  assert.equal(result.code, 1, `Expected exit 1. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stderr);
  assert.match(parsed.preMergeGateCheck.failures.join("; "), /unresolved review threads present \(1\)/i);

  // Same predicate detect-pr-gate-coordination-state.mjs's own narrowing
  // uses for this exact raw payload — both detectors agree the foreign
  // thread does not count as gate-authored.
  assert.equal(countUnresolvedGateAuthoredThreadsFromRawNodes(rawThreadNodes, "gate-bot"), 0);
});

// ADR 0088: the login round-trip only runs when the marker-only pass found a
// candidate thread; when that call itself fails, the gate-authored count
// fails closed (-1), the same as an unreadable thread payload — never falls
// back to the wider marker-only count (which would under-narrow and could
// disagree with the login-narrowed count detect-pr-gate-coordination-state.mjs
// reports for the same failure). The login lookup and the login-narrowed
// count live in their OWN try/catch, separate from the thread-payload fetch
// above it: a login failure here must fail closed ONLY the gate-authored
// count, never clobber the already-computed general unresolvedThreadCount
// (which the thread-payload fetch read successfully). The diagnostic below
// therefore names the real unresolved-thread count, not the misleading
// "could not fetch review thread state" message a shared catch would produce.
test("#2381: a login-resolution failure (after a marker-only candidate is found) fails closed the gate-authored count without clobbering the already-computed unresolvedThreadCount", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-2381-login-fail-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const marker = buildFindingMarker({ fp: "e".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  const { env } = await writeGhStubHelper(tempDir, [
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: JSON.stringify([
        { id: 42, body: cleanGateBody("draft_gate", "abc1234"), updated_at: "2026-05-29T21:00:00Z" },
        { id: 43, body: cleanGateBody("pre_approval_gate", "abc1234"), updated_at: "2026-05-29T22:00:00Z" },
      ]) + "\n",
    },
    { stdout: "[]" },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { id: "t1", isResolved: false, comments: { nodes: [{ databaseId: 9005, body: marker + "\n**nice-to-have** (`naming`): casing nit", author: { login: "gate-bot" } }] } },
        ] } } } },
      }) + "\n",
    },
    { assertArgs: ["api", "user"], stdout: "", code: 1, stderr: "HTTP 500" },
  ], { repeatLastOnOverflow: true });

  const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
  assert.equal(result.code, 1, `Expected exit 1. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.preMergeGateCheck.ok, false);
  assert.equal(parsed.evidenceState, "violation");
  const failureText = parsed.preMergeGateCheck.failures.join("; ");
  // The general thread read (t1, unresolved) succeeded BEFORE the login
  // lookup failed, so the real count (1) must survive into the diagnostic —
  // never the "could not fetch review thread state" message a shared catch
  // would produce by clobbering unresolvedThreadCount back to -1.
  assert.match(failureText, /unresolved review threads present \(1\)/i);
  assert.doesNotMatch(failureText, /could not fetch review thread state/i);
});

// #2381: the exported detectCheckpointEvidence() library path (used by
// detect-pr-gate-coordination-state.mjs) must be ABLE to fold the same
// unresolved-gate-authored-thread invariant into draftGateSatisfied that the
// CLI's own main() computes — previously this library entry point returned
// only gatherCheckpointEvidenceRaw's marker-only value regardless of what
// its caller knew, so the SAME unresolved gate-authored question could read
// draftGateSatisfied: true here while the CLI reported it blocked. The fold
// is caller-INJECTED (ctx.unresolvedGateThreadCount), never self-fetched —
// this library entry point must never spend an unconditional extra
// thread-payload fetch (and conditional `gh api user` round-trip) on every
// caller regardless of whether that caller even reads draftGateSatisfied
// (most don't). Only 3 gh calls are stubbed (no graphql thread fetch, no
// `api user` call) in every case below; an unwanted extra call overflows
// the stub and fails the test.
function stubMinimalCleanDraftGate(tempDir) {
  return writeGhStubHelper(tempDir, [
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: JSON.stringify([
        { id: 42, body: cleanGateBody("draft_gate", "abc1234"), updated_at: "2026-05-29T21:00:00Z" },
        { id: 43, body: cleanGateBody("pre_approval_gate", "abc1234"), updated_at: "2026-05-29T22:00:00Z" },
      ]) + "\n",
    },
    { stdout: "[]" },
  ]);
}

test("#2381: detectCheckpointEvidence() without an injected count returns the unchanged marker-only draftGateSatisfied (no thread fetch, no api user call)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-2381-lib-noop-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const { env } = await stubMinimalCleanDraftGate(tempDir);
  const result = await detectCheckpointEvidence({ repo: "owner/repo", pr: 17 }, { env, cwd: tempDir });
  assert.equal(result.draftGate.verdict, "clean");
  assert.equal(result.draftGateSatisfied, true, "absent an injected count, the library path keeps the unchanged marker-only value");
});

test("#2381: detectCheckpointEvidence() folds an injected unresolvedGateThreadCount into draftGateSatisfied (no extra thread-payload fetch or api user call)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-2381-lib-override-"));
  onTestFinished(() => rm(tempDir, { recursive: true, force: true }));
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

  const { env } = await stubMinimalCleanDraftGate(tempDir);
  const blocked = await detectCheckpointEvidence({ repo: "owner/repo", pr: 17 }, { env, cwd: tempDir, unresolvedGateThreadCount: 1 });
  assert.equal(blocked.draftGateSatisfied, false, "a nonzero injected count must fold draftGateSatisfied to false");

  const { env: env2 } = await stubMinimalCleanDraftGate(tempDir);
  const clean = await detectCheckpointEvidence({ repo: "owner/repo", pr: 17 }, { env: env2, cwd: tempDir, unresolvedGateThreadCount: 0 });
  assert.equal(clean.draftGateSatisfied, true, "an injected count of 0 must leave the marker-only clean value satisfied");
});

test("runIdFreeEnv strips ambient markers, drops undefined overrides, and lets explicit overrides win", () => {
  // Drive the markers from the shared RUN_ID_MARKERS adapter contract rather than
  // any harness-runtime literal, so this test stays harness-agnostic (the
  // harness-runtime var name is owned by the adapter boundary, not test code).
  const prev = new Map();
  try {
    for (const marker of RUN_ID_MARKERS) {
      prev.set(marker, process.env[marker]);
      process.env[marker] = "ambient-" + marker;
    }
    const forced = runIdFreeEnv({ EXPLICIT: "kept", UNSET: undefined });
    for (const marker of RUN_ID_MARKERS) {
      assert.equal(forced[marker], undefined, `${marker} must be stripped from the built env`);
    }
    assert.equal(forced.EXPLICIT, "kept");
    assert.ok(!Object.prototype.hasOwnProperty.call(forced, "UNSET"), "undefined overrides must be removed, not kept as undefined (child_process.spawn rejects non-string env values)");
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
