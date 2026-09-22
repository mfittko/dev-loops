// End-to-end coverage for the reconcile-draft-gate.mjs-prescribed remedy:
// convert a ready PR to draft, post a fan-out draft_gate
// verdict, then restore ready — driven entirely through the three
// sanctioned wrapper functions, never a hand-rolled seam or a raw `gh`
// mutation. Claims-mode gh mock: each phase's calls are matched by
// assertion, independent of call order across the three composed functions.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { DEFAULT_TEST_PR_BODY, initSizeBudgetFixtureRepo, makeGhMock } from "../_helpers.mjs";

import { convertToDraft } from "../../scripts/github/convert-to-draft.mjs";
import { upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { restoreReady } from "../../scripts/github/restore-ready.mjs";

const REPO = "owner/repo";
const PR = 17;
const PR_NODE_ID = "PR_kwDOScHU78000017";

function cleanDraftGateReviewBody(headSha) {
  return [
    "### Gate review: `draft_gate`",
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    "**Verdict:** clean",
    "",
    "**Findings summary:** no issues found",
    "",
    "**Next action:** mark ready for review",
  ].join("\n");
}

test("convert-to-draft -> fan-out draft_gate post -> restore-ready composes with no raw gh mutation and no hand-rolled seam", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-draft-lifecycle-e2e-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "correctness", verdict: "clean", findings: [] },
        { angle: "pr-description", verdict: "clean", findings: [] },
        { angle: "holistic", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    // The durable findings-log ledger + provenance mechanics that
    // requireFanoutEvidence cross-checks are their own exhaustively-tested
    // surface (upsert-checkpoint-verdict.test.mjs); this test's only concern
    // is that the three sanctioned wrappers compose, so disable it here and
    // let the executionMode itself (fanout_fanin, never inline_single_agent)
    // stand for the real remedy shape.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");

    const { runChild, calls } = makeGhMock([
      // --- Phase 1: convert-to-draft.mjs (_draft-transition.mjs's own GraphQL
      // shape, distinguishable from ready-for-review.mjs's query by the space
      // after `number:` in "pullRequest(number: $number)"). ---
      {
        assertArgContains: ["pullRequest(number: $number)"],
        stdout: JSON.stringify({ data: { repository: { pullRequest: { id: PR_NODE_ID, isDraft: false } } } }),
      },
      {
        assertArgContains: ["convertPullRequestToDraft"],
        stdout: JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { id: PR_NODE_ID, isDraft: true } } } }),
      },

      // --- Phase 2: upsert-checkpoint-verdict.mjs (--execution-mode
      // fanout_fanin) coordination-state fetch + the review POST. ---
      {
        assertArgs: ["pr", "view", String(PR), "--repo", REPO, "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({
          number: PR,
          state: "OPEN",
          isDraft: true,
          headRefOid: headSha,
          body: DEFAULT_TEST_PR_BODY,
          closingIssuesReferences: [],
          reviews: [],
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      },
      { assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: '{"users":[],"teams":[]}\n' },
      {
        assertArgs: ["api", "graphql", `pr=${PR}`],
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      { assertArgs: ["pr", "view", String(PR), "--repo", REPO, "--json", "headRefOid"], stdout: JSON.stringify({ headRefOid: headSha }) },
      // Issue-comments read, claimed twice: once by upsert-checkpoint-verdict's
      // own coordination-state fetch (no evidence posted yet), once again by
      // restore-ready's fetchDraftGateEvidence in phase 3 (the clean verdict
      // lives on the PR-review surface, not here, so this stays empty both times).
      { assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`], stdout: "[]" },
      { assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`], stdout: "[]" },
      // upsert-checkpoint-verdict's own existing-review check (issue comments
      // then this) must see NO prior round for this head — the claims-mode
      // match for this call takes THIS (empty) entry first because it sorts
      // before phase 3's populated one below.
      { assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/reviews?per_page=100`], stdout: "[]" },
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/reviews`, "--input", "-"],
        assertStdinIncludes: ["**Verdict:** clean"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },

      // --- Phase 3: restore-ready.mjs (readyForReview with the CI precondition
      // skipped through the internal runtime seam — no `gh pr checks` entry
      // exists here, so a regression that re-enables the CI check would
      // consume the wrong entry and fail loudly). ---
      {
        assertArgContains: ["pullRequest(number:$number)"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { id: PR_NODE_ID, isDraft: true, headRefOid: headSha, baseRefName: baseBranch, state: "OPEN", mergeStateStatus: "CLEAN" } } },
        }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/reviews?per_page=100`],
        stdout: JSON.stringify([{ id: 101, state: "COMMENTED", submitted_at: "2026-06-05T00:00:00Z", user: { login: "gate-bot" }, body: cleanDraftGateReviewBody(headSha) }]),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "gate-bot" }) },
      {
        assertArgs: ["api", "graphql"],
        assertArgContains: ["reviewThreads"],
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }),
      },
      { assertArgs: ["pr", "ready", String(PR), "--repo", REPO], stdout: "" },
    ], { matchMode: "claims" });

    const env = {};
    const runtime = { env, ghCommand: "gh", repoRoot: tempDir, runChild };

    // Phase 1: convert the ready PR to draft — the sanctioned wrapper the raw
    // `gh pr edit --to-draft` seam violation would otherwise stand in for.
    const converted = await convertToDraft({ repo: REPO, pr: PR }, runtime);
    assert.equal(converted.ok, true);
    assert.equal(converted.action, "converted");
    assert.equal(converted.isDraft, true);

    // Phase 2: post the fan-out draft_gate verdict the reconcile-draft-gate.mjs
    // refusal text now prescribes by name.
    const posted = await upsertCheckpointVerdict({
      repo: REPO,
      pr: PR,
      gate: "draft_gate",
      headSha,
      verdict: "clean",
      findingsJson: findingsPath,
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
      nextAction: "mark ready for review",
      executionMode: "fanout_fanin",
    }, runtime);
    assert.equal(posted.ok, true);

    // Phase 3: restore ready — the transient-draft restore direction, reusing
    // ready-for-review.mjs's guards with only the CI precondition skipped.
    const restored = await restoreReady({ repo: REPO, pr: PR }, { ...runtime, syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }) });
    assert.equal(restored.ok, true);
    assert.equal(restored.action, "marked_ready");

    // No hand-rolled seam anywhere in the chain: every gh call is one of the
    // sanctioned wrapper functions' own calls, never a raw `gh pr edit` or
    // `gh pr ready --undo`.
    const ghCalls = calls.filter((c) => c.command === "gh");
    assert.ok(!ghCalls.some((c) => c.args[0] === "pr" && c.args[1] === "edit"), "no raw `gh pr edit` in the chain");
    assert.ok(!ghCalls.some((c) => c.args.includes("--undo")), "no raw `gh pr ready --undo` in the chain");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
