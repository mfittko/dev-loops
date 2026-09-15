import { test } from "bun:test";
import assert from "node:assert/strict";

import { ensureFollowUpIssue } from "../../scripts/github/_gate-finding-surface.mjs";

// AC4 regression for issue #2216: the PR-2215 incident path
// applyFollowUpIssues -> ensureFollowUpIssue -> createIssue reached a live
// `gh issue create` under an unstubbed `bun run verify` and FILED A REAL ISSUE.
// applyFollowUpIssues (judge-pass.mjs) is a private delegator; ensureFollowUpIssue
// is the exported surface that performs the terminal createIssue write, so we
// model the path here.
//
// Only the read seam (listIssues) is stubbed, to avoid a live GitHub lookup; the
// write seam (createIssue/run) is left at its live default, exactly as the
// incident test did. The repo slug is fake, so a guard regression cannot mutate
// a real repo. The guard must block the write before any network call.

const entries = [{ fingerprint: "fp1", severity: "low", angle: "scope", summary: "deferred finding" }];
const noExistingFollowUp = async () => ({ issues: [] });

test("AC4 ensureFollowUpIssue -> createIssue fails closed when the write path is unstubbed", async () => {
  await assert.rejects(
    () =>
      ensureFollowUpIssue(
        { repo: "owner/repo", pr: 2215, entries },
        // listIssues stubbed (read); createIssue + run left at live defaults.
        { listIssues: noExistingFollowUp },
      ),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("AC4 the append (commentIssue) sub-path is also blocked when unstubbed", async () => {
  // With a known existing follow-up issue the path routes to commentIssue
  // instead of createIssue — still a live write that must fail closed.
  await assert.rejects(
    () =>
      ensureFollowUpIssue(
        { repo: "owner/repo", pr: 2215, entries, existingIssueNumber: 999 },
        {},
      ),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("AC2/AC4 a properly-stubbed follow-up create runs unaffected", async () => {
  const created = [];
  const result = await ensureFollowUpIssue(
    { repo: "owner/repo", pr: 2215, entries },
    {
      listIssues: noExistingFollowUp,
      createIssue: async (opts) => {
        created.push(opts);
        return { ok: true, issueNumber: 4242, url: "https://github.com/owner/repo/issues/4242" };
      },
    },
  );
  assert.equal(result.created, true);
  assert.equal(result.issueNumber, 4242);
  assert.equal(created.length, 1);
});
