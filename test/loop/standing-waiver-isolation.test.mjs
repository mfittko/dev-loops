import assert from "node:assert/strict";
import { test } from "bun:test";

import { verifyFreshHumanApproval } from "@dev-loops/core/loop/merge-approval";
import { resolveSizeBudgetHumanApprovalRequired } from "@dev-loops/core/loop/size-budget-merge-gate";
import { parseCopilotBodyDispositionMarker } from "../../scripts/github/_copilot-body-disposition.mjs";
import { resolveApprovalState } from "../../scripts/release/verify-release-approval.mjs";
import { computeAdrTripwire } from "../../scripts/loop/check-adr-tripwire.mjs";
import { buildStandingWaiverLine } from "../../scripts/loop/adr-waiver-markers.mjs";

const HEAD = "c".repeat(40);
const LINE = buildStandingWaiverLine({ head: HEAD, issue: 7, grantedBy: "owner", expires: "2026-12-01", paths: ["skills/docs/x-contract.md"] });

test("the standing-authorization waiver line satisfies no other approval verifier", () => {
  const asComment = { user: { login: "owner", type: "User" }, body: LINE, author_association: "OWNER" };
  assert.equal(verifyFreshHumanApproval({ approvedBy: "owner", currentHeadSha: HEAD, comments: [asComment] }).satisfied, false);
  assert.equal(parseCopilotBodyDispositionMarker(LINE), null);
  assert.equal(
    resolveApprovalState({ version: "1.0.0", operator: "owner", releaseRef: "2026-10-01T00:00:00Z", comments: [{ author: "owner", body: LINE, createdAt: "2026-10-02T00:00:00Z" }] }).approved,
    false,
  );
  // Size-budget seam: the merge gate's approval input comes from verifyFreshHumanApproval over the PR
  // comments, so feed it the waiver line and assert the gate still requires human approval.
  const humanApprovalSatisfied = verifyFreshHumanApproval({ approvedBy: "owner", currentHeadSha: HEAD, comments: [asComment] }).satisfied;
  assert.equal(resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "escalate", touchesT1: false, humanApprovalSatisfied }), true);
});

test("none of the other approvals satisfies the tripwire: an approve merge comment or release approval in the body is no waiver", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: "M\tskills/docs/x-contract.md\n",
    baseContents: { "skills/docs/x-contract.md": "# x\n" },
    headContents: { "skills/docs/x-contract.md": "# x\n\nmore\n" },
    prBody: `approve merge ${HEAD}\napprove release v1.0.0\n<!-- dev-loops:copilot-body-disposition review=1 head=${HEAD} operator -->\n`,
    headSha: HEAD,
  });
  assert.equal(r.outcome, "block");
});
