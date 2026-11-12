import assert from "node:assert/strict";
import { test } from "bun:test";

import { OPERATOR_OWNED_LINES, findOperatorOwnedLineRefusal, wrapOperatorOwnedPhrases } from "../src/github/operator-owned-lines.mjs";
import { detectGrillProvenance } from "../src/loop/refinement-grill-state.mjs";
import { guardCommentBodyNoIssuePrIds } from "../src/github/comment-id-guard.mjs";
import { parseCopilotBodyDispositionMarker } from "../src/github/copilot-body-disposition-marker.mjs";
import { verifyFreshHumanApproval } from "../src/loop/merge-approval.mjs";
import { resolveApprovalState, stripNonAssertionMarkdown as releaseStrip } from "../../../scripts/release/verify-release-approval.mjs";
import { stripNonAssertionMarkdown } from "../src/github/non-assertion-markdown.mjs";
import { APPROVAL_CODE_SPAN_FIXTURES } from "../../../scripts/lib/code-span-fixtures.mjs";
import { extractWaiverLines } from "../../../scripts/loop/adr-waiver-markers.mjs";

const SHA = "a".repeat(40);
const FIX = "b".repeat(40);
const operatorMarker = (review = "9") => `<!-- dev-loops:copilot-body-disposition review=${review} head=${SHA} operator -->`;
const GRILL_HEAD = "## 🔬 Grill / refinement results";
const grillLine = (handle) => `bypass: operator-authorized by ${handle}`;
const grillComment = (handle, line = grillLine(handle)) => `${GRILL_HEAD}\n\nSummary\n${line}\n`;
const fixMarker = `<!-- dev-loops:copilot-body-disposition review=9 head=${SHA} fix=${FIX} -->`;

test("registry: exact entry ids and standingAuthorization values", () => {
  assert.deepEqual(
    OPERATOR_OWNED_LINES.map((e) => [e.id, e.standingAuthorization]),
    [["approve-merge", false], ["approve-release", false], ["adr-tripwire-allow", false], ["copilot-body-disposition-operator", true], ["grill-provenance-bypass", false]],
  );
  assert.ok(Object.isFrozen(OPERATOR_OWNED_LINES));
});

test("findOperatorOwnedLineRefusal: null for a body with no entry or a non-string", () => {
  for (const body of ["", "plain text", "disapprove merge", fixMarker, undefined, null]) {
    assert.equal(findOperatorOwnedLineRefusal(body), null, String(body));
  }
});

// A deny that is removed must fail here: every entry refuses its own sample.
const SAMPLES = {
  "approve-merge": `approve merge ${SHA}`,
  "approve-release": "approve release v1.2.3",
  "adr-tripwire-allow": "adr-tripwire:allow hand written reason",
  "copilot-body-disposition-operator": operatorMarker(),
  "grill-provenance-bypass": grillComment("@op"),
};

test("every registry entry refuses its sample, names OPERATOR-OWNED-LINE and its label, and says the human posts", () => {
  for (const entry of OPERATOR_OWNED_LINES) {
    const msg = findOperatorOwnedLineRefusal(SAMPLES[entry.id]);
    assert.ok(msg, entry.id);
    assert.match(msg, /^OPERATOR-OWNED-LINE: /);
    assert.ok(msg.includes(entry.label), entry.id);
    assert.match(msg, /human posts the line/);
  }
});

test("the operator marker refusal names subagents and does not claim only the orchestrator posts it", () => {
  const msg = findOperatorOwnedLineRefusal(operatorMarker());
  assert.match(msg, /Subagents never post it/);
  assert.ok(!msg.includes("Only the orchestrator"));
  assert.match(msg, /human posts the line/);
});

test("--standing-authorization clears only the entries that accept it", () => {
  for (const entry of OPERATOR_OWNED_LINES) {
    const msg = findOperatorOwnedLineRefusal(SAMPLES[entry.id], { standingAuthorization: true });
    assert.equal(msg === null, entry.standingAuthorization, entry.id);
  }
  assert.equal(findOperatorOwnedLineRefusal(`${operatorMarker()}\napprove merge ${SHA}`, { standingAuthorization: true })?.includes("approve merge"), true);
});

test("standingAuthorization clears the operator marker only for boolean true", () => {
  assert.equal(findOperatorOwnedLineRefusal(operatorMarker(), { standingAuthorization: true }), null);
  for (const v of ["false", "true", 1, {}, false, undefined]) {
    assert.match(findOperatorOwnedLineRefusal(operatorMarker(), { standingAuthorization: v }), /OPERATOR-OWNED-LINE/);
    assert.throws(() => guardCommentBodyNoIssuePrIds(operatorMarker(), { standingAuthorization: v }), /OPERATOR-OWNED-LINE/);
  }
});

test("the shared guard refuses every entry and allowedRefs never clears it", () => {
  for (const entry of OPERATOR_OWNED_LINES) {
    assert.throws(() => guardCommentBodyNoIssuePrIds(SAMPLES[entry.id]), /OPERATOR-OWNED-LINE/, entry.id);
    assert.throws(() => guardCommentBodyNoIssuePrIds(`${SAMPLES[entry.id]}\nsee #1670`, { allowedRefs: ["1670"] }), /OPERATOR-OWNED-LINE/, entry.id);
  }
  assert.equal(guardCommentBodyNoIssuePrIds(operatorMarker(), { standingAuthorization: true }), operatorMarker());
  assert.throws(() => guardCommentBodyNoIssuePrIds("approve release v1.2.3", { standingAuthorization: true }), /OPERATOR-OWNED-LINE/);
});

const releaseState = (body) => resolveApprovalState({ version: "1.2.3", operator: "op", releaseRef: "2026-01-01T00:00:00Z", comments: [{ author: "op", body, createdAt: "2026-02-01T00:00:00Z" }] });

// Bodies where the reader and the guard once disagreed (whitespace and case-folding bypasses).
const ADVERSARIAL_RELEASE_BODIES = [
  " > approve release v1.2.3",
  "﻿> approve release v1.2.3",
  "　> approve release v1.2.3",
  " ```\napprove release v1.2.3\n```",
  "\f```\napprove release v1.2.3\n```",
  "ſapprove release v1.2.3",
  "Kapprove release v1.2.3",
  "ok ſapprove release v1.2.3",
];

test("approve-release: genuine and adversarial bodies are reader approvals and the guard refuses each", () => {
  const genuine = ["approve release v1.2.3", "Approve release v1.2.3.", "Looks good.\n\napprove release v1.2.3\n"];
  for (const body of [...genuine, ...ADVERSARIAL_RELEASE_BODIES]) {
    assert.equal(releaseState(body).approved, true, JSON.stringify(body));
    assert.ok(findOperatorOwnedLineRefusal(body), JSON.stringify(body));
  }
});

test("non-assertion-markdown: the core twin matches the release script's stripNonAssertionMarkdown", () => {
  const genuine = ["approve release v1.2.3", "Approve release v1.2.3.", "Looks good.\n\napprove release v1.2.3\n"];
  const bodies = [...APPROVAL_CODE_SPAN_FIXTURES.map((f) => f.body), ...genuine, ...ADVERSARIAL_RELEASE_BODIES];
  for (const body of bodies) assert.equal(stripNonAssertionMarkdown(body), releaseStrip(body), JSON.stringify(body));
});

test("approve-release: reader approves implies guard refuses over every code-span fixture", () => {
  for (const f of APPROVAL_CODE_SPAN_FIXTURES) {
    const body = f.body.replace("v1.0.0", "v1.2.3");
    if (releaseState(body).approved) assert.ok(findOperatorOwnedLineRefusal(body), f.name);
  }
});

test("approve-release: the guard over-refuses no code-span fixture", () => {
  const refused = APPROVAL_CODE_SPAN_FIXTURES.filter((f) => findOperatorOwnedLineRefusal(f.body)).map((f) => f.name);
  assert.deepEqual(refused, []);
});

test("approve-release: negated/instructional clauses are refused, a backticked mention passes", () => {
  assert.ok(findOperatorOwnedLineRefusal("do not approve release v1.2.3"));
  assert.equal(findOperatorOwnedLineRefusal("post `approve release v1.2.3` yourself"), null);
});

test("approve-merge refuses every text verifyFreshHumanApproval accepts, quote and fence lines included", () => {
  for (const body of [`approve merge ${SHA}`, `Approve Merge ${SHA}`, `- approve merge ${SHA}`, `  * approve   merge ${SHA}`, `> approve merge ${SHA}`, `\`\`\`\napprove merge ${SHA}\n\`\`\``]) {
    const result = verifyFreshHumanApproval({ approvedBy: "op", currentHeadSha: SHA, comments: [{ user: { login: "op" }, author_association: "OWNER", body }] });
    assert.equal(result.satisfied, true, body);
    assert.ok(findOperatorOwnedLineRefusal(body), body);
  }
  assert.ok(findOperatorOwnedLineRefusal(`> approve merge ${SHA}`));
  assert.equal(findOperatorOwnedLineRefusal("the operator must type approve merge <sha>"), null);
  assert.equal(findOperatorOwnedLineRefusal("approve mergeable"), null);
});

test("operator marker: refused after a fix marker, refused for every match, fix form and non-bare forms pass", () => {
  assert.equal(parseCopilotBodyDispositionMarker(`${fixMarker}\n${operatorMarker()}`).operator, false);
  assert.ok(findOperatorOwnedLineRefusal(`${fixMarker}\n${operatorMarker()}`));
  assert.ok(findOperatorOwnedLineRefusal(`${operatorMarker("1")} ${operatorMarker("2")}`));
  assert.equal(findOperatorOwnedLineRefusal(fixMarker), null);
  for (const body of [`\`\`\`\n${operatorMarker()}\n\`\`\``, `inline \`${operatorMarker()}\``, `> ${operatorMarker()}`]) {
    assert.equal(findOperatorOwnedLineRefusal(body), null, body);
  }
});

test("adr-tripwire-allow: the registry line match agrees with the waiver reader on a sample set", () => {
  const samples = ["adr-tripwire:allow reason", "  adr-tripwire:allow reason", " adr-tripwire:allow reason", "adr-tripwire:allow", "adr-tripwire:allowed", "see adr-tripwire:allow mid line", "x\nadr-tripwire:allow r", "`adr-tripwire:allow r`", "\tadr-tripwire:allow\tr"];
  for (const body of samples) {
    const entry = OPERATOR_OWNED_LINES.find((e) => e.id === "adr-tripwire-allow");
    assert.equal(entry.matches(body), extractWaiverLines(body).length > 0, JSON.stringify(body));
  }
});

test("the grill provenance entry refuses every body the reader accepts as a bypass", () => {
  const bodies = [
    grillComment("op"),
    grillComment("@op"),
    grillComment("op", grillLine("op").replace("bypass:", "BYPASS:")),
    grillComment("op", ` ${grillLine("op")}`),
    grillComment("op", `\`\`\`\n${grillLine("op")}\n\`\`\``),
  ];
  for (const body of bodies) {
    assert.equal(detectGrillProvenance([body]).bypass, true, body);
    assert.match(findOperatorOwnedLineRefusal(body, { standingAuthorization: true }), /grill provenance/, body);
  }
});

test("the grill provenance entry passes a backticked mention and a body that is not a results comment", () => {
  assert.equal(findOperatorOwnedLineRefusal(grillComment("op", `the line \`${grillLine("op")}\` is operator-owned`)), null);
  assert.equal(findOperatorOwnedLineRefusal(`Reviewer note\n${grillLine("op")}`), null);
});

test("wrapOperatorOwnedPhrases wraps the tail of a release approval split by a code span", () => {
  const split = "approve `x` release v1.2.3";
  assert.notEqual(findOperatorOwnedLineRefusal(split), null, "the guard reads the split form as an approval");
  assert.equal(findOperatorOwnedLineRefusal(wrapOperatorOwnedPhrases(split)), null);
});

test("wrapOperatorOwnedPhrases leaves an existing balanced code span unchanged", () => {
  assert.equal(wrapOperatorOwnedPhrases("`run approve merge now`"), "`run approve merge now`");
  assert.equal(wrapOperatorOwnedPhrases("`keep` approve merge `keep`"), "`keep` `approve merge` `keep`");
});
