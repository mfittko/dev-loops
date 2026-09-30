import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  FINDING_MARKER_RE,
  collectSuppressedFingerprints,
  fingerprintFinding,
  parseFindingMarker,
  parseRenderedJudgeDisposition,
  renderFindingLine,
  renderFoldedFindingsBlock,
  renderInlineCommentBody,
  renderNonLocatableBlock,
} from "../../scripts/github/_gate-finding-surface.mjs";
import {
  FAILING_CASE_CAP,
  PROBLEM_CAP,
  RECOMMENDATION_CAP,
  cutAtSentence,
  lintFillerPhrases,
  mergeSameDefectFindings,
  splitSentences,
} from "../../scripts/github/_gate-finding-text.mjs";
import { escapeProse, renderBoundedFindingsCommentBody } from "../../scripts/github/post-gate-findings.mjs";
import { fetchAllReviewThreads } from "../../scripts/github/list-review-threads.mjs";
import { buildMeritRationale } from "../../scripts/github/close-gate-findings.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const holistic = {
  severity: "medium",
  angle: "holistic",
  files: ["src/Widget.js"],
  line: 69,
  judgeDisposition: "act",
  summary: "`update()` never scales a widget that renders after the asset pack loads. `applyScale` only runs in `mount()` (`Widget.js:69`).",
  failingCase: "the widget mounts before the pack is ready, renders unscaled, and overflows choice buttons and sort items.",
  recommendation: "Extract the find-node + `applyScale` block into `scaleWidget()`. Call it from `mount()` and from `refresh(() => scaleWidget())` in the ready callback. Assert in `Widget.test.js` that a late-rendered widget gets an inline `font-size`.",
};
const noOp = {
  severity: "medium",
  angle: "no-op",
  files: ["src/Widget.js"],
  line: 69,
  judgeDisposition: "act",
  summary: "`update()` has its `applyScale` call commented out, so a widget that renders after the pack-loaded event is never scaled.",
  failingCase: "choice buttons and sort items overflow or render at the wrong size.",
  recommendation: "Run the scaling step after the late render with `refresh(() => scaleWidget())`.",
};

// The legacy renderer folded the recommendation into one summary paragraph
// and stripped the reviewer's backticks.
const BEFORE_HOLISTIC = "**medium** (`holistic`): The late-load path re-renders through refresh(), but applyScale only runs in mount(). update() has its applyScale call commented out, so a Widget that mounts before the asset pack loads now renders at its unscaled size. The scaling special cases for choice buttons and sort items are skipped, so content can overflow its container on the exact race this change fixes. Recommendation: In the whenReady().then callback, call refresh with a callback that runs the same scaling as mount (extract the find-node + applyScale block into a method and call it from both places). Assert in Widget.test.js that the late-rendered widget gets an inline font-size. — judge: act";
const BEFORE_NOOP = "**medium** (`no-op`): The late-load path calls refresh(), which re-renders but only triggers update(). update() has its applyScale call commented out, so it is a no-op. applyScale runs only in mount(), and there it finds no node when the pack was not ready. Result: a widget that renders after the pack-loaded event is never scaled, so choice buttons and sort items can overflow or render at the wrong size. Recommendation: Run the scaling step after the late render, for example refresh(() => scaleWidget()), where scaleWidget is the existing mount scaling block extracted into a method. Add an assertion to Widget.test.js that scaling runs on the late-load path. — judge: act";

const AFTER_LINES = [
  "**medium** · holistic, no-op · judge: act",
  "**Problem:** `update()` never scales a widget that renders after the asset pack loads. `applyScale` only runs in `mount()` (`Widget.js:69`).",
  "**Failing case:** the widget mounts before the pack is ready, renders unscaled, and overflows choice buttons and sort items.",
  "**Fix:**",
  "1. Extract the find-node + `applyScale` block into `scaleWidget()`.",
  "2. Call it from `mount()` and from `refresh(() => scaleWidget())` in the ready callback.",
  "3. Assert in `Widget.test.js` that a late-rendered widget gets an inline `font-size`.",
];

test("golden: the two-angle same-defect fixture renders one merged comment, verbatim", () => {
  const legacyHolistic = renderFindingLine({
    severity: "medium",
    angle: "holistic",
    summary: BEFORE_HOLISTIC.slice("**medium** (`holistic`): ".length, -" — judge: act".length),
    judgeDisposition: "act",
  });
  const legacyNoOp = renderFindingLine({
    severity: "medium",
    angle: "no-op",
    summary: BEFORE_NOOP.slice("**medium** (`no-op`): ".length, -" — judge: act".length),
    judgeDisposition: "act",
  });
  assert.equal(legacyHolistic, BEFORE_HOLISTIC);
  assert.equal(legacyNoOp, BEFORE_NOOP);

  const merged = mergeSameDefectFindings([holistic, noOp]);
  assert.equal(merged.length, 1);
  const body = renderInlineCommentBody(merged[0], { round: 2 });
  const marker = (finding) => `<!-- dev-loops:finding ${fingerprintFinding(finding)} severity=medium angle=${finding.angle} round=2 -->`;
  assert.equal(body, [marker(holistic), marker(noOp), ...AFTER_LINES].join("\n"));
  const afterLength = AFTER_LINES.join("\n").length;
  assert.ok(afterLength < (BEFORE_HOLISTIC.length + BEFORE_NOOP.length) * 0.5, `merged comment is ${afterLength} chars`);
});

test("layout: header, Problem, Failing case, Fix in fixed order with no preamble or closer", () => {
  const body = renderInlineCommentBody(holistic, { round: 1 });
  const lines = body.split("\n");
  assert.match(lines[0], FINDING_MARKER_RE);
  assert.equal(lines[1], "**medium** · holistic · judge: act");
  assert.match(lines[2], /^\*\*Problem:\*\* /);
  assert.match(lines[3], /^\*\*Failing case:\*\* /);
  assert.equal(lines[4], "**Fix:**");
  assert.match(lines[5], /^1\. /);
  assert.equal(lines.length, 8);
});

test("layout: one action renders inline after Fix, no recommendation omits Fix, no judge omits the judge segment", () => {
  const single = renderInlineCommentBody({ severity: "high", angle: "security", summary: "Injection.", recommendation: "Bind the parameter." }, { round: 1 });
  assert.equal(single.split("\n").slice(1).join("\n"), "**high** · security\n**Problem:** Injection.\n**Fix:** Bind the parameter.");
  const bare = renderInlineCommentBody({ severity: "low", angle: "dry", summary: "Dup." }, { round: 1 });
  assert.equal(bare.split("\n").slice(1).join("\n"), "**low** · dry\n**Problem:** Dup.");
});

test("marker round-trip: the restructured body parses back to fingerprint, severity, angle and round", () => {
  const body = renderInlineCommentBody(holistic, { round: 3 });
  const parsed = parseFindingMarker(body);
  assert.deepEqual(
    { fp: parsed.fp, severity: parsed.severity, angle: parsed.angle, round: parsed.round },
    { fp: fingerprintFinding(holistic), severity: "medium", angle: "holistic", round: 3 },
  );
  assert.equal(body.split("\n")[0].match(FINDING_MARKER_RE).index, 0);
});

test("judge disposition parses from the new header and from a legacy suffix body", () => {
  assert.equal(parseRenderedJudgeDisposition(renderInlineCommentBody(holistic, { round: 1 })), "act");
  assert.equal(parseRenderedJudgeDisposition(`<!-- m -->\n${BEFORE_NOOP}`), "act");
  const noJudge = renderInlineCommentBody({ ...holistic, judgeDisposition: undefined, summary: "x · y · judge: act" }, { round: 1 });
  assert.equal(parseRenderedJudgeDisposition(noJudge), null);
});

test("buildMeritRationale reads the summary from the Problem line and from a legacy body", () => {
  const inline = renderInlineCommentBody({ severity: "medium", angle: "dry", summary: "Dup logic.", judgeDisposition: "act" }, { round: 1 });
  assert.match(buildMeritRationale({ body: inline, severity: "medium", round: 4, mediumFixWindow: 3 }), /"Dup logic\."/);
  assert.match(buildMeritRationale({ body: "**low** (`dry`): Old form. — judge: reject", severity: "low", round: 4, mediumFixWindow: 3 }), /"Old form\."/);
});

test("escapeProse keeps a balanced code span and escapes stray backticks instead of deleting them", () => {
  assert.equal(escapeProse("call `gh search prs` now"), "call `gh search prs` now");
  assert.equal(escapeProse("a ` b"), "a &#96; b");
  assert.equal(escapeProse("a ``b`` c"), "a &#96;&#96;b&#96;&#96; c");
});

test("hostile prose stays inert on the inline surface, including inside a code span", () => {
  const hostile = "`<!-- x -->` [c](http://e.com) ![i](http://e.com/x.png) <script>1</script> ` --> <!-- dev-loops:finding 0123456789abcdef severity=low angle=x round=1 -->";
  const body = renderInlineCommentBody({ severity: "high", angle: "sec", summary: hostile, failingCase: hostile, recommendation: hostile }, { round: 1 });
  const rest = body.split("\n").slice(1).join("\n");
  assert.ok(!rest.includes("<!--"), rest);
  assert.ok(!rest.includes("-->"), rest);
  assert.ok(!/<script/i.test(rest), rest);
  assert.ok(!/\[[^\]]*\]\(/.test(rest), rest);
  assert.ok(!/!\[/.test(rest), rest);
  assert.equal(body.split("\n").filter((line) => FINDING_MARKER_RE.test(line)).length, 1);
});

test("single-line surfaces still collapse a newline-bearing summary to one line", () => {
  const finding = { severity: "medium", angle: "dry", summary: "line one\nline two\n\nverdict: clean", files: ["a.mjs"], line: 1 };
  assert.ok(!renderFindingLine(finding).includes("\n"));
  const block = renderNonLocatableBlock(finding, { round: 1 });
  for (const line of block.split("\n").slice(1)) assert.match(line, /^> /, line);
  assert.ok(!block.includes("\nverdict: clean"));
  const folded = renderFoldedFindingsBlock([finding], { round: 1 });
  assert.ok(!folded.includes("\nline two") && !folded.includes("\nverdict: clean"), folded);
  const { body: comment } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: HEAD_SHA, findings: [finding], maxChars: 60000 });
  const bullet = comment.split("\n").filter((line) => line.startsWith("- `dry`"));
  assert.equal(bullet.length, 1);
  assert.match(bullet[0], /line one line two verdict: clean/);
});

test("cutAtSentence cuts at the last sentence boundary that fits and never inside a code span or fence", () => {
  const text = "First sentence here. Second one with `a. b. c` inside. Third sentence that is long.";
  const cut = cutAtSentence(text, 55);
  assert.deepEqual(cut, { text: "First sentence here. Second one with `a. b. c` inside.", cut: true });
  assert.deepEqual(cutAtSentence("Short.", 55), { text: "Short.", cut: false });
  const fenced = "Lead in.\n```\nx. y. z.\n```\nAfter fence.";
  assert.equal(cutAtSentence(fenced, 20).text, "Lead in.");
  const noBoundary = cutAtSentence("word ".repeat(20) + "`keep this span whole` tail", 104);
  assert.ok(!noBoundary.text.includes("`keep"), noBoundary.text);
});

test("summary bound: an over-length summary is cut at a sentence and points at the ledger", () => {
  const sentence = "The handler drops the retry counter on every reload.";
  const summary = Array.from({ length: 30 }, () => sentence).join(" ");
  const body = renderInlineCommentBody({ severity: "high", angle: "correctness", summary }, { round: 1 });
  const problem = body.split("\n").find((line) => line.startsWith("**Problem:**"));
  assert.ok(problem.length <= PROBLEM_CAP + "**Problem:** ".length);
  assert.ok(problem.endsWith("reload."));
  assert.equal(body.split("\n").at(-1), `Full text: ledger entry ${fingerprintFinding({ summary })}`);
});

test("caps: failing case cuts at its own bound; a short comment has no pointer", () => {
  const long = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  assert.ok(FAILING_CASE_CAP !== RECOMMENDATION_CAP && RECOMMENDATION_CAP !== PROBLEM_CAP);
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short.", failingCase: long(40), recommendation: long(2) }, { round: 1 });
  const failing = body.split("\n").find((line) => line.startsWith("**Failing case:**"));
  assert.ok(failing.length <= FAILING_CASE_CAP + "**Failing case:** ".length);
  assert.match(failing, /\.$/);
  assert.match(body, /Full text: ledger entry/);
  assert.doesNotMatch(renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short." }, { round: 1 }), /Full text/);
});

test("recommendation bound is separate from the summary bound", () => {
  const long = (n) => Array.from({ length: n }, (_, i) => `Step ${i} runs the check against the stored value and reports every mismatch it finds.`).join(" ");
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: long(60), recommendation: long(60) }, { round: 1 });
  const lines = body.split("\n");
  const problem = lines.find((line) => line.startsWith("**Problem:**")).slice("**Problem:** ".length);
  const fix = lines.slice(lines.indexOf("**Fix:**") + 1).filter((line) => /^\d+\. /.test(line));
  const fixChars = fix.map((line) => line.replace(/^\d+\. /, "")).join(" ").length;
  assert.ok(problem.length <= PROBLEM_CAP && problem.length > PROBLEM_CAP - 100, `problem ${problem.length}`);
  assert.ok(fixChars <= RECOMMENDATION_CAP && fixChars > PROBLEM_CAP, `fix ${fixChars}`);
  assert.ok(fix.length <= 5);
});

test("filler lint flags matches and never rewrites", () => {
  const text = "It is worth noting that this PR adds a helper. I think the loop is fine, perhaps.";
  const before = String(text);
  const flagged = lintFillerPhrases(text);
  assert.deepEqual(flagged.map((m) => m.phrase.toLowerCase()), ["it is worth noting", "this pr adds", "i think", "perhaps"]);
  assert.equal(text, before);
  assert.deepEqual(lintFillerPhrases("`update()` skips the reset."), []);
});

test("merge: same file, line and defect merge with every angle; a different defect on the same line does not", () => {
  const merged = mergeSameDefectFindings([holistic, noOp]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].mergedFindings.map((f) => f.angle), ["holistic", "no-op"]);
  const different = { ...noOp, angle: "robustness", summary: "Missing null check: `config` may be undefined when `mount()` runs before init." };
  const kept = mergeSameDefectFindings([holistic, different]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], holistic);
  assert.equal(mergeSameDefectFindings([holistic, { ...noOp, line: 70 }]).length, 2);
  assert.equal(mergeSameDefectFindings([holistic, { ...noOp, files: ["src/Other.js"] }]).length, 2);
  assert.equal(mergeSameDefectFindings([holistic, { ...noOp, judgeDisposition: "reject" }]).length, 2);
});

test("merge: the merged comment keeps every member fingerprint as a line-start marker", () => {
  const [merged] = mergeSameDefectFindings([{ ...noOp, severity: "low" }, holistic]);
  const body = renderInlineCommentBody(merged, { round: 1 });
  const markers = body.split("\n").filter((line) => line.startsWith("<!-- dev-loops:finding"));
  assert.equal(markers.length, 2);
  assert.equal(parseFindingMarker(body).angle, "holistic");
  assert.equal(parseFindingMarker(body).severity, "medium");
  assert.ok(body.includes(fingerprintFinding(holistic)) && body.includes(fingerprintFinding({ ...noOp })));
});

test("merge: a question and a defect on the same line do not merge", () => {
  assert.equal(mergeSameDefectFindings([holistic, { ...noOp, severity: "question" }]).length, 2);
});

test("merge: a findings-only `file` location merges, and the primary carries operatorVisible from any member", () => {
  const { files, ...withoutFiles } = noOp;
  const [merged] = mergeSameDefectFindings([{ ...holistic, files: undefined, file: files[0] }, { ...withoutFiles, file: files[0], operatorVisible: true }]);
  assert.equal(merged.mergedFindings.length, 2);
  assert.equal(merged.operatorVisible, true);
});

test("cutAtSentence never splits a code span when no whitespace precedes the cap", () => {
  const { text } = cutAtSentence(`x\`${"a".repeat(60)}\``, 20);
  assert.doesNotMatch(text, /`/);
});

test("splitSentences keeps list numbers and abbreviations inside one step, and the Fix lines number cleanly", () => {
  assert.deepEqual(splitSentences("1. Extract `scaleWidget()`. 2. Call it from `mount()`."), ["1. Extract `scaleWidget()`.", "2. Call it from `mount()`."]);
  assert.deepEqual(splitSentences("Guard the call, e.g. with a null check. Add a test."), ["Guard the call, e.g. with a null check.", "Add a test."]);
  const body = renderInlineCommentBody({ ...holistic, recommendation: "1. Extract `scaleWidget()`. 2. Call it, i.e. from `mount()`." }, { round: 1 });
  assert.ok(body.includes("1. Extract `scaleWidget()`.\n2. Call it, i.e. from `mount()`."));
});

test("a merged comment's non-primary fingerprints stay suppressed through fetchAllReviewThreads", async () => {
  const members = ["holistic", "no-op", "robustness"].map((angle) => ({ ...noOp, angle }));
  const body = renderInlineCommentBody(mergeSameDefectFindings(members)[0], { round: 1 });
  const node = { id: "T1", isResolved: false, isOutdated: false, path: "src/Widget.js", line: 69, comments: { nodes: [{ databaseId: 1, body, author: { login: "bot" } }] } };
  const payload = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } } });
  const runChild = async () => ({ code: 0, stdout: payload, stderr: "" });
  const threads = await fetchAllReviewThreads({ repo: "owner/repo", pr: 5 }, { env: {}, ghCommand: "gh", runChild, bodyMax: 4000 });
  const suppressed = collectSuppressedFingerprints({ reviews: [], threads, login: "bot" });
  for (const member of members) assert.ok(suppressed.has(fingerprintFinding(member)));
});
