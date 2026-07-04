import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

async function makeRepoWithWorktrees() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-xwt-")));
  const repoA = path.join(base, "a");
  git(base, ["init", "-q", repoA]);
  git(repoA, ["config", "user.email", "test@example.com"]);
  git(repoA, ["config", "user.name", "Test"]);
  git(repoA, ["commit", "--allow-empty", "-q", "-m", "init"]);
  const repoB = path.join(base, "b");
  git(repoA, ["worktree", "add", "-q", "-b", "feature", repoB]);
  return { base, repoA, repoB: await realpath(repoB) };
}

// Config with requireFanoutEvidence + both gates required, mirroring the enforced posture.
const CONFIG = {
  gates: {
    requireFanoutEvidence: true,
    draft: { required: true },
    preApproval: { required: true },
  },
};

const HEAD = "abc1234def5678";
const MARKER = { visible: true, headSha: HEAD, executionMode: "fanout_fanin" };

test("cross-worktree: ledger written in worktree A is found when checked from worktree B (#1050)", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    // Write the fan-out ledger in worktree A.
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "draft_gate", headSha: HEAD, verdict: "clean", findings: "[]" },
      { repoRoot: repoA },
    );

    // Check from worktree B — the ledger lives in A, not B.
    const result = await buildFanoutEnforcement({
      repo: "owner/repo",
      pr: "42",
      currentHeadSha: HEAD,
      draftGateMarker: MARKER,
      preApprovalGateMarker: MARKER,
      config: CONFIG,
      cwd: repoB,
    });

    assert.equal(result.required, true);
    const draft = result.gates.find((g) => g.name === "draft_gate");
    assert.ok(draft, "draft gate present");
    assert.equal(draft.ledgerExists, true, "ledger written in A must be visible from B");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("negative: ledger absent in all checkouts reports ledgerExists false", async () => {
  const { base, repoB } = await makeRepoWithWorktrees();
  try {
    const result = await buildFanoutEnforcement({
      repo: "owner/repo",
      pr: "42",
      currentHeadSha: HEAD,
      draftGateMarker: MARKER,
      preApprovalGateMarker: MARKER,
      config: CONFIG,
      cwd: repoB,
    });

    assert.equal(result.required, true);
    for (const gate of result.gates) {
      assert.equal(gate.ledgerExists, false, `${gate.name} ledger must be absent`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- Round-trip + shadow-bug coverage (requireFanoutProvenance) ---
// Config mirroring the enforced posture PLUS opt-in provenance enforcement.
const PROV_CONFIG = {
  gates: {
    requireFanoutEvidence: true,
    requireFanoutProvenance: true,
    draft: { required: true },
    preApproval: { required: true },
  },
};
// Only the pre_approval gate is fanned out here (draft marker not visible) so a
// single ledger drives the round trip.
const PA_MARKER = { visible: true, headSha: HEAD, executionMode: "fanout_fanin" };
const NO_DRAFT_MARKER = { visible: false };
function cleanEvidenceFor(headSha) {
  return {
    currentHeadSha: headSha,
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha },
  };
}

test("round-trip: write valid provenance -> buildFanoutEnforcement reads it -> pre-merge check PASSES", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 2, perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-b" }] }),
      },
      { repoRoot: repoA },
    );
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: PROV_CONFIG, cwd: repoB,
    });
    assert.equal(enforcement.requireProvenance, true);
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(pa && pa.provenance, "provenance must be read from the ledger");
    assert.equal(pa.provenance.distinctReviewers, 2);

    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("round-trip: a below-floor (distinctReviewers:1) ledger FAILS closed", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "scope", reviewer: "review-a" }] }),
      },
      { repoRoot: repoA },
    );
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: PROV_CONFIG, cwd: repoB,
    });
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, false);
    assert.ok(check.failures.some((f) => f.includes("got 1") && f.includes("route to conductor")), JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("shadow-bug: a provenance-less ledger in an earlier checkout does NOT shadow a valid one in another", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    // repoB (== cwd, enumerated FIRST) carries a provenance-LESS ledger for the head.
    await writeGateFindingsLog(
      { repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]" },
      { repoRoot: repoB },
    );
    // repoA (enumerated later) carries the valid provenance-bearing ledger.
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 2, perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-b" }] }),
      },
      { repoRoot: repoA },
    );
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: PROV_CONFIG, cwd: repoB,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(pa && pa.provenance, "must read the valid provenance, not the shadowing null");
    assert.equal(pa.provenance.distinctReviewers, 2);
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
