import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";
import { auditGateEvidence, parseAuditGateEvidenceCliArgs } from "../../scripts/github/audit-gate-evidence.mjs";

const scriptPath = path.resolve("scripts/github/audit-gate-evidence.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);
const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries);

// Build a runChild that routes each gh invocation by its first positional arg
// after the verb: `pr view` -> head oid; `api ... issues/.../comments` ->
// issue-comment payload; `api ... pulls/.../reviews` -> review payload.
function stubRunChild({ headRefOid = "3d4f0389", issueComments = [], reviews = [] }) {
  return async function runChild(command, args, env) {
    assert.equal(command, "gh");
    const joined = args.join(" ");
    if (joined.includes(`repos/owner/repo/issues/17/comments`)) {
      return { code: 0, stdout: `${JSON.stringify(issueComments)}\n`, stderr: "" };
    }
    if (joined.includes(`repos/owner/repo/pulls/17/reviews`)) {
      return { code: 0, stdout: `${JSON.stringify(reviews)}\n`, stderr: "" };
    }
    if (joined.includes("--json") && joined.includes("headRefOid")) {
      return { code: 0, stdout: `${JSON.stringify({ headRefOid })}\n`, stderr: "" };
    }
    throw new Error(`Unexpected gh invocation: ${joined}`);
  };
}

const DRAFT_CLEAN = {
  id: 4893963950,
  body: [
    "Gate review: draft_gate",
    "Reviewed head SHA: 3d4f0389",
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: mark ready for review",
  ].join("\n"),
  html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-4893963950",
  state: "COMMENTED",
  submitted_at: "2026-08-10T05:10:00Z",
};

const OLD_HEAD_SHA = "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4";

// A clean pre_approval_gate verdict stamped on an OLD head: all other fields
// valid, but the head SHA differs from the current head. Must NOT count as
// evidence for the current head (#1729 Copilot head-match finding).
const PRE_APPROVAL_OLD_HEAD = {
  id: 4894002824,
  body: [
    "Gate review: pre_approval_gate",
    `Reviewed head SHA: ${OLD_HEAD_SHA}`,
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: await final human approval",
  ].join("\n"),
  html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-4894002824",
  state: "COMMENTED",
  submitted_at: "2026-08-10T05:30:00Z",
};

const PRE_APPROVAL_CLEAN = {
  id: 4894002823,
  body: [
    "Gate review: pre_approval_gate",
    "Reviewed head SHA: 3d4f0389",
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: await final human approval",
  ].join("\n"),
  html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-4894002823",
  state: "COMMENTED",
  submitted_at: "2026-08-10T05:20:00Z",
};

test("audit-gate-evidence: verdicts posted ONLY as PR reviews are reported posted (no false missing) (#1729 AC2)", async () => {
  // The exact shape behind #1674: clean draft_gate + pre_approval_gate verdicts
  // exist as PR reviews; the issue-comment surface is empty. The audit must
  // NOT report them missing.
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17, headSha: "3d4f0389" },
    { runChild: stubRunChild({ issueComments: [], reviews: [DRAFT_CLEAN, PRE_APPROVAL_CLEAN] }) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.currentHeadSha, "3d4f0389");
  assert.deepEqual(result.surfaces, ["review", "issue_comment"]);

  assert.equal(result.draftGate.visible, true);
  assert.equal(result.draftGate.verdict, "clean");
  assert.equal(result.draftGate.surface, "review");
  assert.equal(result.draftGate.commentId, 4893963950);
  assert.equal(result.draftGate.headSha, "3d4f0389");

  assert.equal(result.preApprovalGate.visible, true);
  assert.equal(result.preApprovalGate.verdict, "clean");
  assert.equal(result.preApprovalGate.surface, "review");
  assert.equal(result.preApprovalGate.commentId, 4894002823);
  assert.equal(result.preApprovalGate.headSha, "3d4f0389");

  assert.equal(result.allVerdictsPosted, true);
  assert.deepEqual(result.missing, []);
});

test("audit-gate-evidence: missing verdicts are reported in the missing list", async () => {
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17, headSha: "3d4f0389" },
    { runChild: stubRunChild({ issueComments: [], reviews: [] }) },
  );

  assert.equal(result.allVerdictsPosted, false);
  assert.deepEqual(result.missing, ["draft_gate", "pre_approval_gate"]);
  assert.equal(result.draftGate.visible, false);
  assert.equal(result.preApprovalGate.visible, false);
});

test("audit-gate-evidence: clean pre_approval_gate on an OLD head is NOT current-head evidence (allVerdictsPosted=false) (#1729 Copilot finding)", async () => {
  // The exact high-signal Copilot defect: summarizeGateReviewComments picks the
  // newest gate comment regardless of head SHA, so a clean pre_approval_gate on
  // an older head must not drive allVerdictsPosted=true for the current head.
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17, headSha: "3d4f0389" },
    {
      runChild: stubRunChild({
        issueComments: [],
        reviews: [DRAFT_CLEAN, PRE_APPROVAL_OLD_HEAD],
      }),
    },
  );

  assert.equal(result.currentHeadSha, "3d4f0389");
  assert.equal(result.preApprovalGate.verdict, "clean");
  assert.equal(result.preApprovalGate.visible, true);
  assert.equal(result.preApprovalGate.headSha, OLD_HEAD_SHA);
  assert.equal(result.draftGate.verdict, "clean");
  assert.equal(result.allVerdictsPosted, false);
  assert.deepEqual(result.missing, ["pre_approval_gate"]);
});

test("audit-gate-evidence: clean draft_gate on an OLD head still counts (one-time transition gate)", async () => {
  // draft_gate is a one-time draft->ready transition gate, so a clean verdict on
  // an earlier head legitimately stands (mirrors detect-checkpoint-evidence).
  const DRAFT_OLD = {
    ...DRAFT_CLEAN,
    id: 4893963999,
    body: DRAFT_CLEAN.body.replace("Reviewed head SHA: 3d4f0389", `Reviewed head SHA: ${OLD_HEAD_SHA}`),
  };
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17, headSha: "3d4f0389" },
    {
      runChild: stubRunChild({
        issueComments: [],
        reviews: [DRAFT_OLD, PRE_APPROVAL_CLEAN],
      }),
    },
  );

  assert.equal(result.draftGate.headSha, OLD_HEAD_SHA);
  assert.equal(result.preApprovalGate.verdict, "clean");
  assert.equal(result.allVerdictsPosted, true);
  assert.deepEqual(result.missing, []);
});

test("audit-gate-evidence: verdict present on BOTH surfaces is reported posted", async () => {
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17, headSha: "3d4f0389" },
    {
      runChild: stubRunChild({
        issueComments: [PRE_APPROVAL_CLEAN],
        reviews: [DRAFT_CLEAN, PRE_APPROVAL_CLEAN],
      }),
    },
  );

  assert.equal(result.allVerdictsPosted, true);
  assert.deepEqual(result.missing, []);
});

test("audit-gate-evidence: auto-fetches head sha via pr view when --head-sha omitted", async () => {
  const fetchSha = "abc1234";
  // Verdicts must be stamped on the auto-fetched head to count as posted
  // (pre_approval_gate head-match requires the verdict headSha === current head).
  const draftOnFetch = { ...DRAFT_CLEAN, body: DRAFT_CLEAN.body.replace("3d4f0389", fetchSha) };
  const preOnFetch = { ...PRE_APPROVAL_CLEAN, body: PRE_APPROVAL_CLEAN.body.replace("3d4f0389", fetchSha) };
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17 },
    {
      runChild: stubRunChild({
        headRefOid: fetchSha,
        issueComments: [],
        reviews: [draftOnFetch, preOnFetch],
      }),
    },
  );

  assert.equal(result.currentHeadSha, fetchSha);
  assert.equal(result.allVerdictsPosted, true);
  assert.deepEqual(result.missing, []);
});

test("audit-gate-evidence: CLI parse rejects malformed inputs (coverage regression)", () => {
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--pr", "1735"]), /repo/);
  // Whitespace-padded-but-valid --repo is accepted (parseRepoSlug-trimmed), the
  // nit finding raised by Copilot on audit-gate-evidence.mjs.
  const padded = parseAuditGateEvidenceCliArgs(["--repo", "  owner/repo  ", "--pr", "17"]);
  assert.equal(padded.repo, "owner/repo");
  assert.equal(padded.pr, 17);
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--repo", "owner/../x", "--pr", "1"]), /repo/);
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--repo", "owner/name/extra", "--pr", "1"]), /repo/);
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--repo", "owner/repo"]), /pr/);
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--repo", "owner/repo", "--pr", "abc"]), /pr/);
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--repo", "owner/repo", "--pr", "1", "--head-sha", "zzz"]), /head-sha/);
});

test("audit-gate-evidence: CLI parse normalizes --repo through parseRepoSlug (no repo.repo deref) (#1729 gate finding)", () => {
  const parsed = parseAuditGateEvidenceCliArgs([
    "--repo",
    "mfittko/dev-loops",
    "--pr",
    "1735",
    "--head-sha",
    "f5c7161ce4cc76d04a1a7e84654c88a785908339",
  ]);
  assert.equal(parsed.repo, "mfittko/dev-loops");
  assert.equal(parsed.pr, 1735);
  assert.equal(parsed.headSha, "f5c7161ce4cc76d04a1a7e84654c88a785908339");
  assert.equal(parsed.help, undefined);
});

// The CLI entrypoint main() and its --silent verdict-presence predicate were
// previously only reachable through a spawned `node .../audit-gate-evidence.mjs`
// run, which no direct-call test exercised — the gap raised by the draft-gate
// coverage finding (#1729). These two tests spawn the real binary with a
// stubbed `gh` on PATH and pin the documented exit-code contract (0 = all
// verdicts posted under --silent; non-zero = at least one missing).

test("audit-gate-evidence spawned CLI: --silent exits 0 when both verdicts are posted via the PR-review surface", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-silent-ok-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `[[]]\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `${JSON.stringify([[DRAFT_CLEAN, PRE_APPROVAL_CLEAN]])}\n`,
      },
    ]);
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--head-sha", "3d4f0389", "--silent"],
      { env: gh.env },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("audit-gate-evidence spawned CLI: --silent exits non-zero when a verdict is missing (jq -e style predicate)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-silent-missing-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `[[]]\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `[[]]\n`,
      },
    ]);
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--head-sha", "3d4f0389", "--silent"],
      { env: gh.env },
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("audit-gate-evidence spawned CLI: --silent exits non-zero when pre_approval_gate is on an OLD head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-silent-oldhead-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `[[]]\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `${JSON.stringify([[DRAFT_CLEAN, PRE_APPROVAL_OLD_HEAD]])}\n`,
      },
    ]);
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--head-sha", "3d4f0389", "--silent"],
      { env: gh.env },
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("audit-gate-evidence spawned CLI: verbose mode prints the JSON report and exits 0 even when a verdict is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-audit-verbose-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `[[]]\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `[[]]\n`,
      },
    ]);
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--head-sha", "3d4f0389"],
      { env: gh.env },
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.allVerdictsPosted, false);
    assert.deepEqual(output.missing, ["draft_gate", "pre_approval_gate"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
