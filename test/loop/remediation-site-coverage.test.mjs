import assert from "node:assert/strict";
import { test } from "bun:test";

import { normalizeFixerDispositionHandoff, siteCoverageGaps } from "@dev-loops/core/loop/fixer-disposition";
import { loadKnownRuleIds } from "../../scripts/lib/known-rule-ids.mjs";
import { buildDeltaInput, decideDeltaNextStep, startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { computeCommentDiscipline } from "../../scripts/loop/check-comment-discipline.mjs";

const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const FIX_SHA = "c".repeat(40);
const THREAD = "PRRT_kwDOabc123";

// A judge act-list entry as judge-pass writes it: the remediation text, class and site query ride the finding.
const SIBLINGS = ["src/a.mjs:guard", "src/b.mjs:guard", "src/c.mjs:guard"];
const actEntry = (over = {}) => ({
  fingerprint: "fp1",
  angle: "correctness",
  severity: "high",
  summary: "`guard` in src/a.mjs fails open",
  file: "src/a.mjs",
  judgeDisposition: "act",
  authorizedRemediation: "Deny on a failed lookup in every guard that shares the helper.",
  defectClass: "guard fails open on a failed lookup",
  siteQuery: "git grep -n 'catch' -- src/*.mjs",
  ...over,
});

const entry = (over = {}) => ({ threadId: THREAD, fixingCommitSha: FIX_SHA, disposition: "tackled", ...over });
const handoff = (over) => ({ headSha: CANDIDATE, dispositions: [entry(over)] });

const deltaResult = (sequence, over = {}) => ({
  reviewBaselineHead: BASE,
  candidateHead: CANDIDATE,
  actSetId: sequence.actSetId,
  actionableItems: [{ ref: "fp1", status: "resolved", evidence: ["every sibling site denies on a failed lookup"] }],
  newFindings: [],
  widenedReads: [],
  outcome: "locally_clear",
  ...over,
});

test("the delta input carries the site query and the authorized remediation text", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const input = buildDeltaInput({ sequence, candidateHead: CANDIDATE });
  assert.equal(input.actItems[0].authorizedRemediation, "Deny on a failed lookup in every guard that shares the helper.");
  assert.equal(input.actItems[0].siteQuery, "git grep -n 'catch' -- src/*.mjs");
  assert.equal(input.actItems[0].defectClass, "guard fails open on a failed lookup");
  assert.ok("residueOf" in input.resultShape.newFindings[0]);
});

test("an act item without remediation fields still builds a delta input (ledgers from before this change)", () => {
  const legacy = { fingerprint: "fp1", angle: "a", severity: "high", summary: "s", judgeDisposition: "act" };
  const input = buildDeltaInput({ sequence: startDeltaSequence({ reviewBaselineHead: BASE, actList: [legacy] }), candidateHead: CANDIDATE });
  assert.equal(input.actItems[0].siteQuery, undefined);
});

test("one act item with three sibling sites: the fixer covers all three and the delta returns locally_clear", () => {
  const normalized = normalizeFixerDispositionHandoff(handoff({
    returnedSites: SIBLINGS,
    sites: SIBLINGS.map((site) => ({ site, status: "fixed" })),
  }));
  assert.equal(normalized.dispositions[0].sites.filter((s) => s.status === "fixed").length, 3);
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const siteCoverage = normalizeFixerDispositionHandoff({
    headSha: CANDIDATE,
    siteCoverage: [{ fingerprint: "fp1", returnedSites: SIBLINGS, sites: SIBLINGS.map((site) => ({ site, status: "fixed" })) }],
  }).siteCoverage;
  const next = decideDeltaNextStep({ sequence, result: deltaResult(sequence), invocation: 1, currentHead: CANDIDATE, siteCoverage });
  assert.equal(next.outcome, "locally_clear");
});

test("a returned site that is neither fixed nor skipped with a reason fails the disposition", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff(handoff({
      returnedSites: SIBLINGS,
      sites: SIBLINGS.slice(0, 2).map((site) => ({ site, status: "fixed" })),
    })),
    /leaves returned site src\/c\.mjs:guard neither fixed nor skipped/,
  );
  assert.throws(
    () => normalizeFixerDispositionHandoff(handoff({
      returnedSites: SIBLINGS,
      sites: [...SIBLINGS.slice(0, 2).map((site) => ({ site, status: "fixed" })), { site: SIBLINGS[2], status: "skipped" }],
    })),
    /records no skip reason/,
  );
});

test("a skipped site with a reason is accepted", () => {
  const normalized = normalizeFixerDispositionHandoff(handoff({
    returnedSites: SIBLINGS,
    sites: [
      ...SIBLINGS.slice(0, 2).map((site) => ({ site, status: "fixed" })),
      { site: SIBLINGS[2], status: "skipped", reason: "generated file; the generator owns it" },
    ],
  }));
  assert.equal(normalized.dispositions[0].sites[2].reason, "generated file; the generator owns it");
});

test("a handoff without site fields keeps its earlier shape", () => {
  const [normalized] = normalizeFixerDispositionHandoff(handoff({})).dispositions;
  assert.deepEqual(Object.keys(normalized).sort(), ["disposition", "fingerprint", "fixingCommitSha", "threadId", "validation"]);
});

test("same-class residue without a recorded skip reason blocks the push", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const residue = { severity: "low", summary: "src/c.mjs has the same fail-open guard", evidence: ["src/c.mjs:12"], residueOf: "fp1" };
  const blocked = decideDeltaNextStep({ sequence, result: deltaResult(sequence, { newFindings: [residue] }), invocation: 1, currentHead: CANDIDATE });
  assert.equal(blocked.outcome, "needs_fix");
  assert.ok(blocked.errors.some((e) => /locally_clear requires/.test(e)));
  const reason = "generated file; the generator owns it";
  const siteCoverage = normalizeFixerDispositionHandoff({
    headSha: CANDIDATE,
    siteCoverage: [{ fingerprint: "fp1", returnedSites: ["src/c.mjs"], sites: [{ site: "src/c.mjs", status: "skipped", reason }] }],
  }).siteCoverage;
  const skipped = decideDeltaNextStep({
    sequence,
    result: deltaResult(sequence, { newFindings: [{ ...residue, site: "src/c.mjs", skipReason: reason }] }),
    invocation: 1,
    currentHead: CANDIDATE,
    siteCoverage,
  });
  assert.equal(skipped.outcome, "locally_clear");
  // An omitted siteCoverage is [] : an unrecorded skipReason does not unblock the residue.
  const unrecorded = decideDeltaNextStep({
    sequence,
    result: deltaResult(sequence, { newFindings: [{ ...residue, skipReason: "anything" }] }),
    invocation: 1,
    currentHead: CANDIDATE,
  });
  assert.notEqual(unrecorded.outcome, "locally_clear");
});

test("residue must name an act item of the sequence", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const result = deltaResult(sequence, { newFindings: [{ severity: "low", summary: "s", evidence: ["e"], residueOf: "nope" }] });
  assert.ok(decideDeltaNextStep({ sequence, result, invocation: 1, currentHead: CANDIDATE }).errors.some((e) => /residueOf/.test(e)));
});

test("a matcher fix names one test per listed input form", () => {
  const forms = ["--ref x", "--ref=x", "prose mention"];
  assert.throws(
    () => normalizeFixerDispositionHandoff(handoff({
      returnedSites: forms,
      sites: forms.map((site) => ({ site, status: "fixed", kind: "input_form" })),
    })),
    /names no test/,
  );
  const ok = normalizeFixerDispositionHandoff(handoff({
    returnedSites: forms,
    sites: forms.map((site, i) => ({ site, status: "fixed", kind: "input_form", test: `test/matcher.test.mjs case ${i + 1}` })),
  }));
  assert.equal(ok.dispositions[0].sites.length, 3);
});

// PR 2583 case: the remediation told the fixer to cite an issue number in a code comment.
test("a remediation that breaks LOCAL-COMMENT-DISCIPLINE: the fixer cites the rule and the comment check passes", () => {
  const literalRemedy = ["// The flag is read once at startup. Cite #2582 for the reason."];
  const compliantFix = ["// The flag is read once at startup, so a later change needs a restart."];
  const diff = (lines) => ["diff --git a/scripts/loop/x.mjs b/scripts/loop/x.mjs", "+++ b/scripts/loop/x.mjs", "@@ -0,0 +1 @@", ...lines.map((l) => `+${l}`)].join("\n");
  assert.equal(computeCommentDiscipline({ diffOutput: diff(literalRemedy) }).outcome, "block");
  assert.notEqual(computeCommentDiscipline({ diffOutput: diff(compliantFix) }).outcome, "block");
  const [normalized] = normalizeFixerDispositionHandoff(handoff({ ruleCitations: ["LOCAL-COMMENT-DISCIPLINE"] })).dispositions;
  assert.deepEqual(normalized.ruleCitations, ["LOCAL-COMMENT-DISCIPLINE"]);
  assert.throws(() => normalizeFixerDispositionHandoff(handoff({ ruleCitations: ["not a rule id"] })), /ruleCitations/);
});

// Site coverage keyed by act-item fingerprint: the commit_only handback and threadless act items.
const record = (items) => normalizeFixerDispositionHandoff({ headSha: CANDIDATE, siteCoverage: items }).siteCoverage;
const coverageItem = (over = {}) => ({
  fingerprint: "fp1",
  returnedSites: SIBLINGS,
  sites: SIBLINGS.map((site) => ({ site, status: "fixed" })),
  ...over,
});

test("a commit_only handback carries site coverage for a threadless act item", () => {
  const [normalized] = record([coverageItem()]);
  assert.equal(normalized.fingerprint, "fp1");
  assert.equal(normalized.sites.length, 3);
  assert.deepEqual(siteCoverageGaps([actEntry()], record([coverageItem()])), []);
  assert.throws(() => record([coverageItem({ sites: [] })]), /neither fixed nor skipped/);
  assert.throws(() => record([coverageItem(), coverageItem()]), /duplicate fingerprint/);
});

test("an act item with a site query and no record, or no returned sites, is a gap", () => {
  assert.deepEqual(siteCoverageGaps([actEntry()], undefined), ["act item fp1 has a site query and no site coverage record"]);
  assert.match(siteCoverageGaps([actEntry()], record([coverageItem({ returnedSites: [], sites: [] })]))[0], /no returned sites/);
  assert.deepEqual(siteCoverageGaps([{ ...actEntry(), siteQuery: undefined }], []), []);
});

test("a matcher act item needs one input_form site per accepted and rejected form", () => {
  const matcher = actEntry({ acceptedForms: ["--ref x", "--ref=x"], rejectedForms: ["prose mention"] });
  const sites = [
    { site: "--ref x", status: "fixed", kind: "input_form", test: "t1" },
    { site: "--ref=x", status: "fixed", kind: "input_form", test: "t2" },
  ];
  const partial = record([coverageItem({ returnedSites: ["--ref x", "--ref=x"], sites })]);
  assert.deepEqual(siteCoverageGaps([matcher], partial), ['act item fp1 records no input_form site for form "prose mention"']);
  const full = record([coverageItem({
    returnedSites: [...sites.map((s) => s.site), "prose mention"],
    sites: [...sites, { site: "prose mention", status: "skipped", kind: "input_form", reason: "prose is never a flag" }],
  })]);
  assert.deepEqual(siteCoverageGaps([matcher], full), []);
});

test("the delta check requires a skipReason to equal the recorded reason for that residueOf site", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const siteCoverage = record([coverageItem({
    sites: [...SIBLINGS.slice(0, 2).map((site) => ({ site, status: "fixed" })), { site: SIBLINGS[2], status: "skipped", reason: "generated file; the generator owns it" }],
  })]);
  const residue = (over = {}) => ({ severity: "low", summary: "same guard", evidence: ["src/c.mjs:12"], residueOf: "fp1", site: SIBLINGS[2], skipReason: "generated file; the generator owns it", ...over });
  const run = (finding) => decideDeltaNextStep({ sequence, result: deltaResult(sequence, { newFindings: [finding] }), invocation: 1, currentHead: CANDIDATE, siteCoverage });
  assert.equal(run(residue()).outcome, "locally_clear");
  assert.equal(run(residue({ skipReason: "I decided it is fine" })).outcome, "needs_fix");
  assert.ok(run(residue({ skipReason: "I decided it is fine" })).errors.some((e) => /must equal the reason recorded/.test(e)));
  assert.equal(run(residue({ site: SIBLINGS[0] })).outcome, "needs_fix", "a fixed site has no recorded skip reason");
  assert.equal(run(residue({ site: undefined })).outcome, "needs_fix");
});

test("the delta check reports a coverage gap for an act item with no record", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const next = decideDeltaNextStep({ sequence, result: deltaResult(sequence), invocation: 1, currentHead: CANDIDATE, siteCoverage: [] });
  assert.equal(next.outcome, "needs_fix");
  assert.ok(next.errors.some((e) => /no site coverage record/.test(e)));
});

test("ruleCitations must be registered rule IDs when the registry is supplied", () => {
  const ruleIds = new Set(["LOCAL-COMMENT-DISCIPLINE"]);
  const withCitation = (id) => ({ headSha: CANDIDATE, siteCoverage: [coverageItem({ ruleCitations: [id] })] });
  assert.doesNotThrow(() => normalizeFixerDispositionHandoff(withCitation("LOCAL-COMMENT-DISCIPLINE"), { ruleIds }));
  assert.throws(() => normalizeFixerDispositionHandoff(withCitation("NO-SUCH-RULE"), { ruleIds }), /does not register: NO-SUCH-RULE/);
  assert.ok(loadKnownRuleIds().has("LOCAL-COMMENT-DISCIPLINE"));
});

test("a duplicate site name in one coverage record is rejected", () => {
  const sites = [
    { site: "--ref x", status: "fixed", kind: "input_form", test: "t1" },
    { site: "--ref x", status: "skipped", reason: "r" },
  ];
  assert.throws(() => record([coverageItem({ returnedSites: ["--ref x"], sites })]), /records site --ref x more than once/);
});

test("matcher input forms survive startDeltaSequence into the delta coverage check", () => {
  const matcher = actEntry({ acceptedForms: ["--ref x", "--ref=x"], rejectedForms: ["prose mention"] });
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [matcher] });
  const sites = [
    { site: "--ref x", status: "fixed", kind: "input_form", test: "t1" },
    { site: "--ref=x", status: "fixed", kind: "input_form", test: "t2" },
  ];
  const siteCoverage = record([coverageItem({ returnedSites: sites.map((s) => s.site), sites })]);
  const next = decideDeltaNextStep({ sequence, result: deltaResult(sequence), invocation: 1, currentHead: CANDIDATE, siteCoverage });
  assert.equal(next.outcome, "needs_fix");
  assert.ok(next.errors.some((e) => /prose mention/.test(e)));
});

test("null residueOf and skipReason on an ordinary finding validate", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: [actEntry()] });
  const finding = { severity: "low", summary: "s", evidence: ["e"], residueOf: null, skipReason: null };
  const siteCoverage = record([coverageItem()]);
  const next = decideDeltaNextStep({ sequence, result: deltaResult(sequence, { newFindings: [finding] }), invocation: 1, currentHead: CANDIDATE, siteCoverage });
  assert.deepEqual(next.errors ?? [], []);
});
