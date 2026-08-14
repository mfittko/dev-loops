import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runIdFreeEnv, runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";
import { buildFindingMarker } from "../../scripts/github/_gate-finding-surface.mjs";

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: runIdFreeEnv({ ...(options.env ?? {}), DEVLOOPS_RUN_ID: "" }),
});

function cleanGateBody(gate, headSha) {
  return [
    "Gate review: " + gate,
    "Reviewed head SHA: " + headSha,
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: " + (gate === "draft_gate" ? "mark ready for review" : "await final human approval"),
  ].join("\n");
}

// #1585: the draftGateSatisfied field + pre-merge evidence check fold in the
// gate-authored thread invariant. detect-checkpoint-evidence reuses its existing
// review-thread payload (marker-only count, no extra gh round-trip) so a clean
// verdict with a dangling gate-authored thread fails the pre-merge evidence check.
test("#1585: an unresolved gate-authored thread carrying a finding marker fails the pre-merge evidence check (the count is exercised)", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-1585-fold-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
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
  ], { repeatLastOnOverflow: true });

  const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
  assert.equal(result.code, 1, `Expected exit 1. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.preMergeGateCheck.ok, false);
  assert.equal(parsed.evidenceState, "violation");
  assert.match(parsed.preMergeGateCheck.failures.join("; "), /unresolved review threads/i);
});

test("#1585: draftGateSatisfied stays true when the gate-authored thread is resolved (positive counterpart)", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-1585-fold-pos-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
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

test("#1585: an unreadable thread-fetch state (-1) folds draftGateSatisfied to false and fails the pre-merge evidence check (fail-closed)", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-1585-unreadable-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
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

test("runIdFreeEnv strips ambient markers, drops undefined overrides, and lets explicit overrides win", () => {
  const prevDev = process.env.DEVLOOPS_RUN_ID;
  const prevPi = process.env.PI_SUBAGENT_RUN_ID;
  try {
    process.env.DEVLOOPS_RUN_ID = "ambient-dev";
    process.env.PI_SUBAGENT_RUN_ID = "ambient-pi";
    const forced = runIdFreeEnv({ EXPLICIT: "kept", UNSET: undefined });
    assert.equal(forced.DEVLOOPS_RUN_ID, undefined, "ambient DEVLOOPS_RUN_ID must be stripped");
    assert.equal(forced.PI_SUBAGENT_RUN_ID, undefined, "ambient PI_SUBAGENT_RUN_ID must be stripped");
    assert.equal(forced.EXPLICIT, "kept");
    assert.ok(!Object.prototype.hasOwnProperty.call(forced, "UNSET"), "undefined overrides must be removed, not kept as undefined (child_process.spawn rejects non-string env values)");
  } finally {
    if (prevDev === undefined) delete process.env.DEVLOOPS_RUN_ID; else process.env.DEVLOOPS_RUN_ID = prevDev;
    if (prevPi === undefined) delete process.env.PI_SUBAGENT_RUN_ID; else process.env.PI_SUBAGENT_RUN_ID = prevPi;
  }
});
