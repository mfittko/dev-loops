import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFanoutEnforcement, buildPreMergeGateCheck } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { buildLogPath, writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";

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
        // dry/kiss/pr-checklist-matrix are real preApproval pool angles (shipped
        // extension defaults); pr-checklist-matrix is also the gate's mandatory
        // angle, so angle-coverage enforcement passes at write time.
        provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }, { angle: "pr-checklist-matrix", reviewer: "review-c" }] }),
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
    assert.equal(pa.provenance.distinctReviewers, 3);

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
        // A single fresh angle (the mandatory pr-checklist-matrix) reviewed by
        // one reviewer satisfies the write-time one-reviewer-per-angle floor
        // (1 fresh angle, 1 reviewer) while distinctReviewers (1) still sits
        // below the >=2 read-time floor this test exercises.
        provenance: JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "pr-checklist-matrix", reviewer: "review-a" }] }),
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
        provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }, { angle: "pr-checklist-matrix", reviewer: "review-c" }] }),
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
    assert.equal(pa.provenance.distinctReviewers, 3);
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("residual shadow: a below-floor ledger in cwd checkout does NOT shadow a satisfying one elsewhere", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    // repoB (== cwd, enumerated FIRST) carries a write-time-valid (one fresh
    // angle, one reviewer) but READ-floor-BELOW ledger (distinctReviewers:1).
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 1, perAngle: [{ angle: "pr-checklist-matrix", reviewer: "review-a" }] }),
      },
      { repoRoot: repoB },
    );
    // repoA (enumerated later) carries the SATISFYING >=2 ledger.
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }, { angle: "pr-checklist-matrix", reviewer: "review-c" }] }),
      },
      { repoRoot: repoA },
    );
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: PROV_CONFIG, cwd: repoB,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(pa && pa.provenance, "must read the satisfying provenance, not the below-floor shadow");
    assert.equal(pa.provenance.distinctReviewers, 3, "satisfying ledger preferred over below-floor");
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Hand-craft a ledger file directly (bypassing writeGateFindingsLog): the read
// path must not trust that the write-time floor produced the worktree-local
// file, so forged ledgers are exactly what these fixtures simulate.
async function writeRawLedger(repoRoot, provenance) {
  const logPath = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
  const fullPath = path.join(repoRoot, logPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify({
    repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD,
    verdict: "clean", loggedAt: "2026-07-19T00:00:00.000Z", findings: [], provenance,
  }), "utf8");
}

test("selector scaled floor: a hand-crafted 3-fresh-angle/2-reviewer shadow does NOT satisfy (floor scales past the constant)", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    // repoB (cwd, enumerated first): distinctReviewers 2 meets the CONSTANT
    // floor but not the scaled max(2, 3 fresh angles) — a reverted selector
    // would wrongly accept this shadow. Each fresh angle keeps its OWN
    // reviewer so the pairing branch stays silent and ONLY the scaled term
    // rejects (mutation-isolated: reverting the scaled term must fail this).
    await writeRawLedger(repoB, {
      distinctReviewers: 2,
      perAngle: [
        { angle: "dry", reviewer: "review-a" },
        { angle: "kiss", reviewer: "review-b" },
        { angle: "pr-checklist-matrix", reviewer: "review-c" },
      ],
    });
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }, { angle: "pr-checklist-matrix", reviewer: "review-c" }] }),
      },
      { repoRoot: repoA },
    );
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: PROV_CONFIG, cwd: repoB,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(pa && pa.provenance, "must read the satisfying provenance, not the under-scaled shadow");
    assert.equal(pa.provenance.distinctReviewers, 3, "satisfying ledger preferred over the under-scaled-floor shadow");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("selector pairing: a hand-crafted PADDED shadow (cardinality met, one reviewer on two fresh angles) does NOT satisfy", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    await writeRawLedger(repoB, {
      distinctReviewers: 3,
      perAngle: [
        { angle: "dry", reviewer: "review-a" },
        { angle: "kiss", reviewer: "review-a" },
        { angle: "dry", reviewer: "review-b" },
        { angle: "pr-checklist-matrix", reviewer: "review-c" },
      ],
    });
    await writeGateFindingsLog(
      {
        repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: "[]",
        provenance: JSON.stringify({ distinctReviewers: 3, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }, { angle: "pr-checklist-matrix", reviewer: "review-c" }] }),
      },
      { repoRoot: repoA },
    );
    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: PROV_CONFIG, cwd: repoB,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(pa && pa.provenance, "must read the satisfying provenance, not the padded shadow");
    // The forged shadow has FOUR perAngle entries (padding); the valid ledger
    // has three. Entry count is the discriminator a reviewer-set-size check
    // cannot provide (both ledgers have 3 distinct reviewers) — removing the
    // selector's pairing call must fail this assertion.
    assert.equal(pa.provenance.perAngle.length, 3, "must accept the 3-entry valid ledger, not the 4-entry padded shadow");
    assert.ok(!pa.provenance.perAngle.some((e) => e.angle === "kiss" && e.reviewer === "review-a"), "the padded shadow's colliding entry must not be present");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- Angle-coverage enforcement blocks merge on bad provenance (#1196) ---
// Config declaring a mandatory preApproval angle, independent of requireFanoutProvenance.
const ANGLE_CONFIG = {
  gates: {
    requireFanoutEvidence: true,
    draft: { required: true },
    preApproval: { required: true, angles: ["dry", { name: "pr-checklist-matrix", mandatory: true }] },
  },
};

test("detect-checkpoint-evidence: a fanout_fanin ledger missing a mandatory angle blocks merge at evidence time (AC1)", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    // A hand-edited/shadow ledger (bypassing write-gate-findings-log's own
    // write-time enforcement) records fan-out provenance that never dispatched
    // the gate's mandatory angle.
    const ledgerPath = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    const fullLedgerPath = path.join(repoA, ledgerPath);
    await mkdir(path.dirname(fullLedgerPath), { recursive: true });
    await writeFile(fullLedgerPath, JSON.stringify({
      repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: [],
      provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "dry", reviewer: "review-b" }] },
    }) + "\n", "utf8");

    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: ANGLE_CONFIG, cwd: repoB,
    });
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, false);
    assert.ok(
      check.failures.some((f) => f.includes("missing mandatory angle(s): pr-checklist-matrix") && f.includes("route to conductor")),
      JSON.stringify(check.failures),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence: a fanout_fanin ledger naming a FOREIGN angle blocks merge at evidence time (AC2, through buildFanoutEnforcement)", async () => {
  // Full read-path integration: the pool resolved by buildFanoutEnforcement must
  // actually reach buildPreMergeGateCheck's foreign-angle check (guards against
  // a field-name mismatch making the merge-time pool check dead code).
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    const ledgerPath = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    const fullLedgerPath = path.join(repoA, ledgerPath);
    await mkdir(path.dirname(fullLedgerPath), { recursive: true });
    await writeFile(fullLedgerPath, JSON.stringify({
      repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: [],
      // Mandatory angle covered, but one recorded angle is outside the pool.
      provenance: { distinctReviewers: 2, perAngle: [{ angle: "pr-checklist-matrix", reviewer: "review-a" }, { angle: "made-up-angle", reviewer: "review-b" }] },
    }) + "\n", "utf8");

    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: ANGLE_CONFIG, cwd: repoB,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.deepEqual(pa.anglePool, ["pr-checklist-matrix", "dry"], "enforcement must carry the resolved pool as anglePool");
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, false);
    assert.ok(
      check.failures.some((f) => f.includes("outside the configured pool: made-up-angle")),
      JSON.stringify(check.failures),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence: a fanout_fanin ledger that simply OMITS provenance blocks merge when mandatory angles are configured", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    const ledgerPath = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    const fullLedgerPath = path.join(repoA, ledgerPath);
    await mkdir(path.dirname(fullLedgerPath), { recursive: true });
    await writeFile(fullLedgerPath, JSON.stringify({
      repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: [],
    }) + "\n", "utf8");

    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: ANGLE_CONFIG, cwd: repoB,
    });
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, false);
    assert.ok(
      check.failures.some((f) => f.includes("no valid fan-out provenance") && f.includes("route to conductor")),
      JSON.stringify(check.failures),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("angle-contract shadow: a stale checkout's provenance FAILING the angle contract does NOT shadow a passing one elsewhere", async () => {
  const { base, repoA, repoB } = await makeRepoWithWorktrees();
  try {
    const ledgerPath = buildLogPath({ repo: "owner/repo", pr: "42", gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" });
    // repoB (== cwd, enumerated FIRST) carries a stale ledger whose provenance
    // is internally consistent but MISSES the mandatory angle.
    const stalePath = path.join(repoB, ledgerPath);
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, JSON.stringify({
      repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: [],
      provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "dry", reviewer: "review-b" }] },
    }) + "\n", "utf8");
    // repoA (enumerated later) carries the ledger whose provenance PASSES.
    const goodPath = path.join(repoA, ledgerPath);
    await mkdir(path.dirname(goodPath), { recursive: true });
    await writeFile(goodPath, JSON.stringify({
      repo: "owner/repo", pr: 42, gate: "pre_approval_gate", headSha: HEAD, verdict: "clean", findings: [],
      provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "pr-checklist-matrix", reviewer: "review-b" }] },
    }) + "\n", "utf8");

    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo", pr: "42", currentHeadSha: HEAD,
      draftGateMarker: NO_DRAFT_MARKER, preApprovalGateMarker: PA_MARKER,
      config: ANGLE_CONFIG, cwd: repoB,
    });
    const pa = enforcement.gates.find((g) => g.name === "pre_approval_gate");
    assert.ok(
      pa.provenance.perAngle.some((e) => e.angle === "pr-checklist-matrix"),
      "must select the angle-contract-passing provenance, not the stale shadow",
    );
    const check = buildPreMergeGateCheck(cleanEvidenceFor(HEAD), 0, null, enforcement);
    assert.equal(check.ok, true, JSON.stringify(check.failures));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
