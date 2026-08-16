import assert from "node:assert/strict";
import test from "node:test";

import { auditGateEvidence, parseAuditGateEvidenceCliArgs } from "../../scripts/github/audit-gate-evidence.mjs";

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
  const result = await auditGateEvidence(
    { repo: "owner/repo", pr: 17 },
    {
      runChild: stubRunChild({
        headRefOid: "abc1234",
        issueComments: [],
        reviews: [DRAFT_CLEAN, PRE_APPROVAL_CLEAN],
      }),
    },
  );

  assert.equal(result.currentHeadSha, "abc1234");
  assert.equal(result.allVerdictsPosted, true);
  assert.deepEqual(result.missing, []);
});

test("audit-gate-evidence: CLI parse rejects malformed inputs (coverage regression)", () => {
  assert.throws(() => parseAuditGateEvidenceCliArgs(["--pr", "1735"]), /repo/);
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
