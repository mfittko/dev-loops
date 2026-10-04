import assert from "node:assert/strict";
import { test } from "bun:test";

import { computeSpecDigest, requireSpecFromBody } from "@dev-loops/core/loop/spec-authority";
import { parseWaiveAdrTripwireCliArgs, runCli, waiveAdrTripwire } from "../../scripts/github/waive-adr-tripwire.mjs";
import { captureStream } from "../_helpers.mjs";

const HEAD = "d".repeat(40);
const CONTRACT = "skills/docs/x-contract.md";
const ISSUE_BODY = [
  "## Acceptance criteria",
  "",
  "- [ ] The contract doc states the rule.",
  "",
  "## Definition of done",
  "",
  "- [ ] The doc edit is merged.",
  "",
  "## AC / DoD matrix",
  "",
  "| Acceptance criterion | Completion evidence |",
  "| --- | --- |",
  `| The contract doc states the rule. | \`${CONTRACT}\` carries the rule text. |`,
  "",
  "## Non-goals",
  "",
  "- Nothing else changes.",
  "",
].join("\n");
const DIGEST = computeSpecDigest(requireSpecFromBody(ISSUE_BODY));
const PR_BODY = "Summary.\n\nCloses #7\n";
const AUTH = { inForce: true, record: { grantedBy: "operator", grantedAt: "2026-10-01", expires: "2026-12-01", reason: "contract doc edits" } };
const OPTIONS = { repo: "o/n", pr: 9 };

function harness(over = {}) {
  const edits = [];
  const deps = {
    readStandingAuthorization: () => AUTH,
    fetchPr: async () => ({ body: PR_BODY, headRefOid: HEAD, baseRefName: "main", closingIssuesReferences: { nodes: [{ number: 7 }] } }),
    fetchIssueBody: async () => ISSUE_BODY,
    evaluateAdrTripwire: async () => ({ outcome: "block", triggers: [{ type: "contract-doc", path: CONTRACT }] }),
    fetchDraftGateEvidence: async () => ({ currentHeadClean: true }),
    readRecordedSpecDigest: async () => DIGEST,
    editPr: async (opts, rt) => { edits.push({ opts, rt }); return { ok: true }; },
    ...over,
  };
  return { edits, run: () => waiveAdrTripwire(OPTIONS, deps) };
}

async function assertRefusal(over, reason) {
  const { edits, run } = harness(over);
  const result = await run();
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(result.reason, reason, JSON.stringify(result));
  assert.equal(edits.length, 0, "the body stays unchanged on a refusal");
  return result;
}

test("writes the head-pinned line through the edit-pr write path when every check passes", async () => {
  const { edits, run } = harness();
  const result = await run();
  assert.equal(result.ok, true);
  assert.equal(result.action, "waiver_written");
  assert.equal(result.line, `adr-tripwire:allow standing-authorization head=${HEAD} issue=7 granted-by=operator expires=2026-12-01 paths=${CONTRACT}`);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].rt.waiverWriter, true);
  assert.equal(edits[0].rt.currentBody, PR_BODY);
  assert.equal(edits[0].opts.body, `Summary.\n\nCloses #7\n\n${result.line}\n`);
});

test("replaces an earlier standing-authorization line and keeps every other line", async () => {
  const old = `adr-tripwire:allow standing-authorization head=${"e".repeat(40)} issue=7 granted-by=operator expires=2026-12-01 paths=${CONTRACT}`;
  const body = `Summary.\n\nCloses #7\n\n${old}\nTrailing note.\n`;
  const { edits, run } = harness({
    fetchPr: async () => ({ body, headRefOid: HEAD, baseRefName: "main", closingIssuesReferences: { nodes: [{ number: 7 }] } }),
  });
  const result = await run();
  assert.equal(result.ok, true);
  assert.ok(!edits[0].opts.body.includes(old));
  assert.ok(edits[0].opts.body.includes("Trailing note."));
  assert.equal(edits[0].opts.body.match(/adr-tripwire:allow/g).length, 1);
});

for (const state of ["missing", "malformed", "over_long", "expired"]) {
  test(`refuses with no_standing_authorization when the record is ${state}`, async () => {
    const result = await assertRefusal({ readStandingAuthorization: () => ({ inForce: false, state, detail: state }) }, "no_standing_authorization");
    assert.equal(result.state, state);
  });
}

test("refuses a lightweight PR on the pr_body path (no closing issue)", async () => {
  await assertRefusal({ fetchPr: async () => ({ body: "Summary only.", headRefOid: HEAD, baseRefName: "main", closingIssuesReferences: { nodes: [] } }) }, "lightweight_pr_body_path");
});

test("refuses a PR that links more than one tracker issue, or whose GitHub link disagrees with the body", async () => {
  await assertRefusal({ fetchPr: async () => ({ body: "Closes #7\nFixes #8", headRefOid: HEAD, baseRefName: "main", closingIssuesReferences: { nodes: [{ number: 7 }, { number: 8 }] } }) }, "not_exactly_one_tracker_issue");
  await assertRefusal({ fetchPr: async () => ({ body: PR_BODY, headRefOid: HEAD, baseRefName: "main", closingIssuesReferences: { nodes: [{ number: 99 }] } }) }, "not_exactly_one_tracker_issue");
});

test("refuses when the tripwire does not block", async () => {
  await assertRefusal({ evaluateAdrTripwire: async () => ({ outcome: "pass", satisfiedBy: "adr", triggers: [] }) }, "tripwire_not_blocking");
});

const trigger = (t) => async () => ({ outcome: "block", triggers: [{ type: "contract-doc", path: CONTRACT }, t] });
for (const t of [
  { type: "gate-config", path: "packages/core/src/config/extension-defaults.yaml" },
  { type: "rule-modality-reversal", path: CONTRACT, ruleId: "R-X", from: "must", to: "should" },
  { type: "rule-modality-reversal", path: CONTRACT, ruleId: "R-GONE", from: "must", to: "none" },
  { type: "unresolvable-rule-scan", path: CONTRACT },
  { type: "standing-authorizations-change", path: ".devloops" },
  { type: "devloops-proportionality", path: ".devloops", fields: ["localImplementation.lightMode.maxFiles"] },
]) {
  test(`refuses an ineligible ${t.type} trigger${t.ruleId ? ` (${t.ruleId})` : ""}`, async () => {
    await assertRefusal({ evaluateAdrTripwire: trigger(t) }, "ineligible_trigger");
  });
}

test("refuses a contract doc not named in the issue matrix", async () => {
  const result = await assertRefusal({
    evaluateAdrTripwire: async () => ({ outcome: "block", triggers: [{ type: "contract-doc", path: "skills/docs/other-contract.md" }] }),
  }, "contract_doc_not_in_matrix");
  assert.deepEqual(result.missing, ["skills/docs/other-contract.md"]);
});

test("refuses when the linked issue has no valid AC / DoD matrix", async () => {
  await assertRefusal({ fetchIssueBody: async () => ISSUE_BODY.replace(/\| The contract doc[^\n]*\n/, "") }, "issue_matrix_invalid");
});

test("refuses without a clean draft_gate verdict on the current head", async () => {
  await assertRefusal({ fetchDraftGateEvidence: async () => ({ currentHeadClean: false }) }, "no_clean_draft_gate");
});

test("refuses when the recorded specDigest differs from the issue's current digest, or is missing", async () => {
  await assertRefusal({ readRecordedSpecDigest: async () => "sha256:stale" }, "spec_digest_mismatch");
  await assertRefusal({ readRecordedSpecDigest: async () => null }, "spec_digest_unrecorded");
  await assertRefusal({ fetchIssueBody: async () => "no spec here" }, "issue_matrix_invalid");
});

test("parse and CLI: --repo and --pr are required; a refusal exits 1 with a typed stderr reason", async () => {
  assert.throws(() => parseWaiveAdrTripwireCliArgs(["--repo", "o/n"]), /requires --repo and --pr/);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "9"], {
    stdout,
    stderr,
    readStandingAuthorization: () => ({ inForce: false, state: "missing", detail: "none" }),
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr.get()).reason, "no_standing_authorization");
  assert.equal(stdout.get(), "");
});

test("the real edit-pr write path accepts the writer's line (no waiver-line refusal) and issues one gh pr edit", async () => {
  const { editPr } = await import("../../scripts/github/edit-pr.mjs");
  const calls = [];
  const run = async (_cmd, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const result = await waiveAdrTripwire(OPTIONS, {
    readStandingAuthorization: () => AUTH,
    fetchPr: async () => ({ body: PR_BODY, headRefOid: HEAD, baseRefName: "main", closingIssuesReferences: { nodes: [{ number: 7 }] } }),
    fetchIssueBody: async () => ISSUE_BODY,
    evaluateAdrTripwire: async () => ({ outcome: "block", triggers: [{ type: "contract-doc", path: CONTRACT }] }),
    fetchDraftGateEvidence: async () => ({ currentHeadClean: true }),
    readRecordedSpecDigest: async () => DIGEST,
    runChild: run,
    editPr: (opts, rt) => editPr(opts, { ...rt, fetchPrContext: async () => ({ headRefName: "issue-7", closingIssuesReferences: [], body: PR_BODY }) }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const edit = calls.find((a) => a[0] === "pr" && a[1] === "edit");
  assert.ok(edit.join(" ").includes("adr-tripwire:allow standing-authorization"));
  assert.equal(calls.length, 1);
});
