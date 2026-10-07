import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  FINDING_MARKER_RE,
  collectFingerprints,
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
  MAX_MERGED_MEMBERS,
  mergeSameDefectFindings,
  normalizeFindingSummary,
  splitSentences,
} from "../../scripts/github/_gate-finding-text.mjs";
import { escapeProse, renderBoundedFindingsCommentBody } from "../../scripts/github/post-gate-findings.mjs";
import { fetchAllReviewThreads } from "../../scripts/github/list-review-threads.mjs";
import { MERGED_THREAD_BODY_MAX, renderStructuredFindings } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { readFileSync } from "node:fs";
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

// The two angles describe one defect in different words, so both name the
// violated requirement as their defectKey.
const holisticKeyed = { ...holistic, defectKey: "AC-late-scale" };
const noOpKeyed = { ...noOp, defectKey: "AC-late-scale" };

const AFTER_LINES = [
  "**medium** · holistic, no-op · judge: act",
  "`src/Widget.js:69`",
  "**Problem:** `update()` never scales a widget that renders after the asset pack loads. `applyScale` only runs in `mount()` (`Widget.js:69`).",
  "**Failing case:** the widget mounts before the pack is ready, renders unscaled, and overflows choice buttons and sort items.",
  "**Fix:**",
  "1. Extract the find-node + `applyScale` block into `scaleWidget()`.",
  "2. Call it from `mount()` and from `refresh(() => scaleWidget())` in the ready callback.",
  "3. Assert in `Widget.test.js` that a late-rendered widget gets an inline `font-size`.",
  "**Problem (no-op):** `update()` has its `applyScale` call commented out, so a widget that renders after the pack-loaded event is never scaled.",
  "**Fix (no-op):** Run the scaling step after the late render with `refresh(() => scaleWidget())`.",
];

test("golden: the two-angle defectKey-merged fixture renders one merged comment with each distinct Problem and Fix, verbatim", () => {
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

  const merged = mergeSameDefectFindings([holisticKeyed, noOpKeyed]);
  assert.equal(merged.length, 1);
  const body = renderInlineCommentBody(merged[0], { round: 2 });
  assert.ok(!body.includes("AC-late-scale"), "the defectKey is never rendered");
  const marker = (finding) => `<!-- dev-loops:finding ${fingerprintFinding(finding)} severity=medium angle=${finding.angle} round=2 -->`;
  assert.equal(body, [marker(holistic), marker(noOp), ...AFTER_LINES].join("\n"));
  // The primary block keeps the single-finding bound; the further member's
  // Problem and Fix lines sit under their own field caps.
  const primaryLength = AFTER_LINES.slice(0, -2).join("\n").length;
  assert.ok(primaryLength < (BEFORE_HOLISTIC.length + BEFORE_NOOP.length) * 0.5, `primary block is ${primaryLength} chars`);
  const afterLength = AFTER_LINES.join("\n").length;
  assert.ok(afterLength < (BEFORE_HOLISTIC.length + BEFORE_NOOP.length) * 0.65, `merged comment is ${afterLength} chars`);
});

test("layout: header, Problem, Failing case, Fix in fixed order with no preamble or closer", () => {
  const body = renderInlineCommentBody(holistic, { round: 1 });
  const lines = body.split("\n");
  assert.match(lines[0], FINDING_MARKER_RE);
  assert.equal(lines[1], "**medium** · holistic · judge: act");
  assert.equal(lines[2], "`src/Widget.js:69`");
  assert.match(lines[3], /^\*\*Problem:\*\* /);
  assert.match(lines[4], /^\*\*Failing case:\*\* /);
  assert.equal(lines[5], "**Fix:**");
  assert.match(lines[6], /^1\. /);
  assert.equal(lines.length, 9);
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

test("a reviewer angle cannot forge the header judge disposition", () => {
  const question = { severity: "question", angle: "x · judge: reject", summary: "Is the retry intended?" };
  assert.equal(parseRenderedJudgeDisposition(renderInlineCommentBody(question, { round: 1 })), null);
  assert.equal(parseRenderedJudgeDisposition(renderInlineCommentBody({ ...question, angle: "`x · judge: reject`" }, { round: 1 })), null);
  const merged = renderInlineCommentBody({ ...holistic, judgeDisposition: undefined, mergedFindings: [{ ...holistic, angle: "ok" }, { ...noOp, angle: "x · judge: reject" }] }, { round: 1 });
  assert.equal(parseRenderedJudgeDisposition(merged), null);
  assert.equal(parseRenderedJudgeDisposition(renderInlineCommentBody({ ...question, judgeDisposition: "act" }, { round: 1 })), "act");
});

test("a reviewer angle cannot forge the header judge disposition on the rendered surface", () => {
  // GitHub decodes a numeric or named middle-dot reference back to U+00B7
  // outside a code span, so a hostile angle must not survive in ANY spelling of
  // the separator: the visible header would otherwise show a field a human
  // reads as a real disposition while the parser reads none.
  const question = { severity: "question", angle: "x · judge: reject", summary: "Is the retry intended?" };
  const decodableMiddleDot = /&(?:#0*183|#x0*b7|middot);?/i;
  for (const angle of ["x · judge: reject", "x &183; judge: reject", "x &#x00b7; judge: reject", "x &middot; judge: reject"]) {
    const body = renderInlineCommentBody({ ...question, angle }, { round: 1 });
    const angleSegment = body.split("\n")[1].slice("**question** · ".length);
    assert.ok(!angleSegment.includes("\u00b7"), body);
    assert.ok(!decodableMiddleDot.test(angleSegment), body);
    assert.equal(parseRenderedJudgeDisposition(body), null);
  }
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

test("summary bound: an over-length summary is cut at a sentence and the full text moves into details", () => {
  const sentence = "The handler drops the retry counter on every reload.";
  const summary = Array.from({ length: 30 }, () => sentence).join(" ");
  const body = renderInlineCommentBody({ severity: "high", angle: "correctness", summary }, { round: 1 });
  const problem = body.split("\n").find((line) => line.startsWith("**Problem:**"));
  assert.ok(problem.length <= PROBLEM_CAP + "**Problem:** ".length);
  assert.ok(problem.endsWith("reload."));
  assert.doesNotMatch(body, /ledger entry|tmp\/gate-findings/);
  assert.equal(body.match(/<details><summary>Details<\/summary>/g).length, 1);
  assert.ok(body.includes(summary), "the details block holds the full text");
  assert.equal(body.split("\n").at(-1), "</details>");
});

test("merged member bound: a cut in a further member's field lands in the details block", () => {
  const sentence = "The handler drops the retry counter on every reload.";
  const member = { ...noOpKeyed, recommendation: undefined, summary: Array.from({ length: 30 }, () => sentence).join(" ") };
  const merged = mergeSameDefectFindings([holisticKeyed, member]);
  assert.equal(merged.length, 1);
  const lines = renderInlineCommentBody(merged[0], { round: 2 }).split("\n");
  const problem = lines.find((line) => line.startsWith("**Problem (no-op):**"));
  assert.ok(problem.length <= PROBLEM_CAP + "**Problem (no-op):** ".length);
  assert.ok(problem.endsWith("reload."));
  assert.ok(!lines.some((line) => line.startsWith("**Fix (no-op):**")), "a member without a recommendation renders no Fix line");
  const details = lines.slice(lines.indexOf("<details><summary>Details</summary>")).join("\n");
  assert.ok(details.includes("**Problem (no-op):**"), "the full member text is labelled in details");
  assert.ok(details.includes(member.summary), "details holds the full member summary");
  assert.doesNotMatch(lines.join("\n"), /ledger entry/);
});

test("caps: failing case cuts at its own bound; a short comment has no details block", () => {
  const long = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  assert.ok(FAILING_CASE_CAP !== RECOMMENDATION_CAP && RECOMMENDATION_CAP !== PROBLEM_CAP);
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short.", failingCase: long(40), recommendation: long(2) }, { round: 1 });
  const failing = body.split("\n").find((line) => line.startsWith("**Failing case:**"));
  assert.ok(failing.length <= FAILING_CASE_CAP + "**Failing case:** ".length);
  assert.match(failing, /\.$/);
  assert.match(body, /<details><summary>Details<\/summary>/);
  assert.doesNotMatch(renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short." }, { round: 1 }), /details/);
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
  const merged = mergeSameDefectFindings([holisticKeyed, noOpKeyed]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].mergedFindings.map((f) => f.angle), ["holistic", "no-op"]);
  const different = { ...noOp, angle: "robustness", summary: "Missing null check: `config` may be undefined when `mount()` runs before init." };
  const kept = mergeSameDefectFindings([holistic, different]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], holistic);
  assert.equal(mergeSameDefectFindings([holisticKeyed, { ...noOpKeyed, line: 70 }]).length, 2);
  assert.equal(mergeSameDefectFindings([holisticKeyed, { ...noOpKeyed, files: ["src/Other.js"] }]).length, 2);
  assert.equal(mergeSameDefectFindings([holisticKeyed, { ...noOpKeyed, judgeDisposition: "reject" }]).length, 2);
});

test("merge: without a defectKey, only identical normalized summaries merge", () => {
  const a = { ...holistic, summary: "Cache lookup returns stale entries after invalidation." };
  const merged = mergeSameDefectFindings([a, { ...noOp, summary: "cache LOOKUP returns stale-entries, after invalidation" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].mergedFindings.length, 2);
  // Both members share one fingerprint; each still keeps its own marker.
  const markers = [...renderInlineCommentBody(merged[0], { round: 1 }).matchAll(new RegExp(FINDING_MARKER_RE.source, "gm"))];
  assert.equal(markers.length, 2);
  assert.deepEqual(markers.map((m) => parseFindingMarker(m[0]).angle), ["holistic", "no-op"]);
  assert.equal(mergeSameDefectFindings([a, { ...noOp, summary: "Cache lookup returns stale entries before invalidation." }]).length, 2);
});

test("merge: two summaryless same-file findings without a line stay separate", () => {
  const { summary: _a, line: _la, ...first } = holistic;
  const { summary: _b, line: _lb, ...second } = noOp;
  assert.equal(mergeSameDefectFindings([first, second]).length, 2);
});

test("merge: four pairs of different defects on one line stay separate", () => {
  const pairs = [
    ["Request handler returns incorrect response status when upstream timeout occurs", "Request handler logs sensitive response headers when upstream timeout occurs"],
    ["Cache lookup returns stale entries after invalidation", "Cache lookup leaks another user's entries after invalidation"],
    ["The retry loop swallows timeout errors during shutdown", "The retry budget ignored: timeout errors logged after shutdown"],
    ["Request handler returns incorrect response status during timeout", "Request handler logs sensitive response headers during timeout"],
  ];
  for (const [first, second] of pairs) {
    assert.equal(mergeSameDefectFindings([{ ...holistic, summary: first }, { ...noOp, summary: second }]).length, 2, `${first} / ${second}`);
  }
});

test("merge: different defectKeys, or a key on one finding only, block an identical-summary merge", () => {
  assert.equal(mergeSameDefectFindings([{ ...holistic, defectKey: "AC-1" }, { ...noOp, summary: holistic.summary, defectKey: "AC-2" }]).length, 2);
  assert.equal(mergeSameDefectFindings([{ ...holistic, defectKey: "AC-1" }, { ...noOp, summary: holistic.summary }]).length, 2);
  assert.equal(mergeSameDefectFindings([{ ...holistic, defectKey: "AC-1" }, { ...noOp, summary: holistic.summary, defectKey: "AC-1" }]).length, 1);
});

test("merge: a finding with no file never merges; two file-level findings with no line merge", () => {
  const { files: _files, line: _line, ...bare } = holistic;
  assert.equal(mergeSameDefectFindings([bare, { ...bare, angle: "no-op" }]).length, 2);
  const fileLevel = { ...bare, files: ["src/Widget.js"] };
  assert.equal(mergeSameDefectFindings([fileLevel, { ...fileLevel, angle: "no-op" }]).length, 1);
  assert.equal(mergeSameDefectFindings([fileLevel, { ...fileLevel, angle: "no-op", line: 3 }]).length, 2);
});

test("defectKey never changes the fingerprint or the finding marker", () => {
  assert.equal(fingerprintFinding(holisticKeyed), fingerprintFinding(holistic));
  assert.equal(renderInlineCommentBody(holisticKeyed, { round: 1 }), renderInlineCommentBody(holistic, { round: 1 }));
});

test("normalizeFindingSummary is the one normalization fingerprintFinding and isSameDefect share", () => {
  assert.equal(normalizeFindingSummary("  Cache `lookup()` -- STALE!  "), "cache lookup stale");
  const surfaceSrc = readFileSync(new URL("../../scripts/github/_gate-finding-surface.mjs", import.meta.url), "utf8");
  const textSrc = readFileSync(new URL("../../scripts/github/_gate-finding-text.mjs", import.meta.url), "utf8");
  const fingerprintSrc = surfaceSrc.slice(surfaceSrc.indexOf("export function fingerprintFinding"), surfaceSrc.indexOf("export function collectFingerprints"));
  const sameDefectSrc = textSrc.slice(textSrc.indexOf("export function isSameDefect"), textSrc.indexOf("export const MAX_MERGED_MEMBERS"));
  assert.match(fingerprintSrc, /normalizeFindingSummary\(finding\.summary\)/);
  assert.match(sameDefectSrc, /normalizeFindingSummary\(a\.summary\) === normalizeFindingSummary\(b\.summary\)/);
  assert.doesNotMatch(fingerprintSrc + sameDefectSrc, /toLowerCase/);
});

test("merge: an identical-summary merge renders exactly like its primary alone, plus the extra marker and angle", () => {
  const twin = { ...noOp, summary: holistic.summary };
  const body = renderInlineCommentBody(mergeSameDefectFindings([holistic, twin])[0], { round: 1 });
  assert.doesNotMatch(body, /\*\*(?:Problem|Fix) \(/);
  assert.equal(body.split("\n").filter((line) => line.startsWith("**Problem")).length, 1);
});

test("merge: the merged comment keeps every member fingerprint as a line-start marker", () => {
  const [merged] = mergeSameDefectFindings([{ ...noOpKeyed, severity: "low" }, holisticKeyed]);
  const body = renderInlineCommentBody(merged, { round: 1 });
  const markers = body.split("\n").filter((line) => line.startsWith("<!-- dev-loops:finding"));
  assert.equal(markers.length, 2);
  assert.equal(parseFindingMarker(body).angle, "holistic");
  assert.equal(parseFindingMarker(body).severity, "medium");
  assert.ok(body.includes(fingerprintFinding(holistic)) && body.includes(fingerprintFinding({ ...noOp })));
});

test("merge: a question and a defect on the same line do not merge", () => {
  assert.equal(mergeSameDefectFindings([holisticKeyed, { ...noOpKeyed, severity: "question" }]).length, 2);
});

test("merge: a findings-only `file` location merges, and the primary carries operatorVisible from any member", () => {
  const { files, ...withoutFiles } = noOpKeyed;
  const [merged] = mergeSameDefectFindings([{ ...holisticKeyed, files: undefined, file: files[0] }, { ...withoutFiles, file: files[0], operatorVisible: true }]);
  assert.equal(merged.mergedFindings.length, 2);
  assert.equal(merged.operatorVisible, true);
});

test("cutAtSentence never splits a code span when no whitespace precedes the cap", () => {
  const { text } = cutAtSentence(`x\`${"a".repeat(60)}\``, 20);
  assert.doesNotMatch(text, /`/);
});

test("splitSentences keeps list numbers and abbreviations inside one step, and the Fix lines number cleanly", () => {
  assert.deepEqual(splitSentences("1. Extract `scaleWidget()`. 2. Call it from `mount()`."), ["1. Extract `scaleWidget()`.", "2. Call it from `mount()`."]);
  assert.deepEqual(splitSentences("Raise the cap to 200. Add a test."), ["Raise the cap to 200.", "Add a test."]);
  assert.deepEqual(splitSentences("Guard the call, e.g. with a null check. Add a test."), ["Guard the call, e.g. with a null check.", "Add a test."]);
  const body = renderInlineCommentBody({ ...holistic, recommendation: "1. Extract `scaleWidget()`. 2. Call it, i.e. from `mount()`." }, { round: 1 });
  assert.ok(body.includes("1. Extract `scaleWidget()`.\n2. Call it, i.e. from `mount()`."));
});

test("splitSentences splits an unpunctuated newline list at each marker", () => {
  assert.deepEqual(splitSentences("1. Extract the block\n2. Call it from mount\n3. Add a test"), ["1. Extract the block", "2. Call it from mount", "3. Add a test"]);
});

test("cutAtSentence does not pair a stray backtick with the next real span", () => {
  assert.equal(cutAtSentence("a ` b. `c. d` e. more text here", 12).text, "a ` b.");
});

test("a recommendation with more than MAX_FIX_STEPS sentences renders five steps and a details block", () => {
  const recommendation = "Do one. Do two. Do three. Do four. Do five. Do six.";
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short.", recommendation }, { round: 1 });
  assert.equal(body.split("\n").filter((line) => /^\d+\. /.test(line)).length, 5);
  assert.match(body, /<details><summary>Details<\/summary>/);
  assert.match(body.slice(body.indexOf("<details>")), /Do six\./);
  assert.doesNotMatch(body, /ledger entry/);
});

test("an escape-heavy finding stays under the GitHub comment limit", () => {
  const heavy = "[<".repeat(20000);
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: heavy, failingCase: heavy, recommendation: heavy }, { round: 1 });
  assert.ok(body.length < 65536, String(body.length));
});

test("details bound never ends inside a code span, so a straddling span cannot expose raw HTML", () => {
  const summary = `${"a".repeat(7985)} \`<img src=https://x/p.png>tail\` end`;
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary }, { round: 1 });
  const details = body.slice(body.indexOf("<details>"));
  assert.match(details, /\[cut\]/);
  assert.doesNotMatch(details.replace(/`[^`]*`/g, ""), /<img/);
  assert.equal(details.match(/<\/details>/g).length, 1);
});

test("merge: shared stopwords and file identifiers do not merge two different defects", () => {
  const a = { ...holistic, summary: "`refresh()` in `Widget.js` skips `applyScale` when the widget mounts" };
  const b = { ...holistic, summary: "`refresh()` in `Widget.js` leaks the listener when the widget mounts" };
  assert.equal(mergeSameDefectFindings([a, b]).length, 2);
});

test("merge: two defects that share code-span identifiers do not merge", () => {
  const a = { ...holistic, summary: "`parseConfig()` in `loader.mjs` returns `undefined` for an empty `timeout` value" };
  const b = { ...holistic, summary: "`parseConfig()` in `loader.mjs` throws on a negative `timeout` value" };
  assert.equal(mergeSameDefectFindings([a, b]).length, 2);
});

test("a merged comment's non-primary fingerprints stay suppressed through fetchAllReviewThreads", async () => {
  const members = ["holistic", "no-op", "robustness"].map((angle) => ({ ...noOpKeyed, angle, summary: `${noOp.summary} Variant ${angle}.` }));
  assert.equal(new Set(members.map(fingerprintFinding)).size, 3);
  const body = renderInlineCommentBody(mergeSameDefectFindings(members)[0], { round: 1 });
  const node = { id: "T1", isResolved: false, isOutdated: false, path: "src/Widget.js", line: 69, comments: { nodes: [{ databaseId: 1, body, author: { login: "bot" } }] } };
  const payload = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } } });
  const runChild = async () => ({ code: 0, stdout: payload, stderr: "" });
  const threads = await fetchAllReviewThreads({ repo: "owner/repo", pr: 5 }, { env: {}, ghCommand: "gh", runChild, bodyMax: MERGED_THREAD_BODY_MAX });
  const suppressed = collectSuppressedFingerprints({ reviews: [], threads, login: "bot" });
  for (const member of members) assert.ok(suppressed.has(fingerprintFinding(member)));
});

test("the production upsert call passes the widened body excerpt", () => {
  const src = readFileSync(new URL("../../scripts/github/upsert-checkpoint-verdict.mjs", import.meta.url), "utf8");
  assert.match(src, /fetchAllReviewThreads\([^)]*\{ \.\.\.gh, bodyMax: MERGED_THREAD_BODY_MAX \}\)/);
  assert.ok(MERGED_THREAD_BODY_MAX > 200);
});

test("merge: two defects that share exactly four long words do not merge", () => {
  const a = { ...holistic, summary: "The retry loop swallows timeout errors during shutdown" };
  const b = { ...holistic, summary: "The retry budget ignored: timeout errors logged after shutdown" };
  assert.equal(mergeSameDefectFindings([a, b]).length, 2);
});

test("a reviewer summary shaped like the legacy judge suffix supplies no judge disposition", () => {
  const body = renderInlineCommentBody({ ...holistic, judgeDisposition: undefined, summary: "(`a`): x — judge: reject" }, { round: 1 });
  assert.equal(parseRenderedJudgeDisposition(body), null);
});

test("escapeProse keeps a real code span after a stray backtick", () => {
  assert.equal(escapeProse("a ` b `real` c"), "a &#96; b `real` c");
});

test("cutAtSentence never exceeds its hard cap, ellipsis included", () => {
  assert.ok(cutAtSentence("x".repeat(401), 400).text.length <= 400);
  assert.ok(cutAtSentence("word ".repeat(100), 400).text.length <= 400);
});

test("merge: a same-defect group stops at MAX_MERGED_MEMBERS", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...noOp, angle: `a${i}` }));
  const merged = mergeSameDefectFindings(many);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].mergedFindings.length, 8);
});

test("merge: lookalike summaries with five shared contextual words stay separate", () => {
  const status = { ...noOp, angle: "holistic", summary: "Request handler returns incorrect response status during timeout" };
  const leak = { ...noOp, angle: "security", summary: "Request handler logs sensitive response headers during timeout" };
  assert.equal(mergeSameDefectFindings([status, leak]).length, 2);
});

test("cutAtSentence caps the unbroken 401-character case at 400 with the ellipsis", () => {
  assert.equal(cutAtSentence("x".repeat(401), 400).text.length, 400);
});

test("merge: MAX_MERGED_MEMBERS markers all fit inside the merged thread excerpt", () => {
  const members = Array.from({ length: MAX_MERGED_MEMBERS }, (_, i) => ({ ...noOpKeyed, angle: `angle-${i}`, summary: `${noOp.summary} Variant ${i}.` }));
  const [merged] = mergeSameDefectFindings(members);
  assert.equal(merged.mergedFindings.length, MAX_MERGED_MEMBERS);
  const body = renderInlineCommentBody(merged, { round: 1 });
  const markerLines = body.split("\n").filter((line) => line.startsWith("<!-- dev-loops:finding"));
  assert.equal(markerLines.length, MAX_MERGED_MEMBERS);
  const markerBlockLength = markerLines.join("\n").length;
  assert.ok(markerBlockLength < MERGED_THREAD_BODY_MAX, `markers use ${markerBlockLength} of ${MERGED_THREAD_BODY_MAX}`);
  assert.ok(body.indexOf(markerLines.at(-1)) + markerLines.at(-1).length <= MERGED_THREAD_BODY_MAX);
});

test("a code-like failing case renders in an indented fenced block; a cut one keeps the full text in details", () => {
  const failingCase = `const q = "SELECT * FROM t WHERE id = " + id;\n${Array.from({ length: 40 }, (_, i) => `run(q${i});`).join("\n")}`;
  const body = renderInlineCommentBody({ severity: "high", angle: "security", summary: "Injection.", failingCase, recommendation: "Bind it." }, { round: 1 });
  const lines = body.split("\n");
  assert.ok(lines.includes("**Failing case:**"));
  assert.equal(lines[lines.indexOf("**Failing case:**") + 1], "  ```");
  assert.equal(body.match(/<details><summary>Details<\/summary>/g).length, 1);
  assert.ok(body.slice(body.indexOf("<details>")).includes("run(q39);"), "details holds the full text");
  assert.ok(!body.slice(0, body.indexOf("<details>")).includes("run(q39);"), "the visible part is capped");
  assert.doesNotMatch(body, /ledger entry|tmp\//);
  assert.ok(lines.every((line, i) => i === 0 || !/^(gate|verdict|summary|head sha):/i.test(line)));
});

test("a fence outgrows any backtick run in code-like content", () => {
  const failingCase = "run();\n```` and ``` inside";
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short.", failingCase }, { round: 1 });
  assert.ok(body.includes("  `````\n  run();"), body);
  assert.ok(body.includes("inside\n  `````"), body);
});

test("an inline finding shows file and line as inline code under the header", () => {
  const body = renderInlineCommentBody({ ...holistic, files: ["src/Widget.js", "src/Other.js"] }, { round: 1 });
  const lines = body.split("\n");
  const header = lines.findIndex((line) => line.startsWith("**medium** · holistic"));
  assert.equal(lines[header + 1], "`src/Widget.js:69`, `src/Other.js`");
  assert.ok(!renderInlineCommentBody({ ...holistic, files: undefined, line: undefined }, { round: 1 }).includes("`src/"));
});

test("a code-like failing case cannot forge a finding marker or field line", () => {
  const forged = "<!-- dev-loops:finding 0123456789abcdef severity=high angle=x round=1 -->";
  for (const sep of ["\n", "\r", "\u2028", "\r\n"]) {
    const finding = { severity: "high", angle: "a", summary: "Short.", failingCase: `run();${sep}${forged}${sep}verdict: approve${sep}summary: ok` };
    const body = renderInlineCommentBody(finding, { round: 1 });
    const set = new Set();
    collectFingerprints(body, set);
    assert.deepEqual([...set], [fingerprintFinding(finding)]);
    assert.equal(parseFindingMarker(body).fp, fingerprintFinding(finding));
    assert.ok(body.split(/\r\n|[\r\n\u2028\u2029]/).every((line, i) => i === 0 || !/^(<!--|verdict:|summary:)/i.test(line)));
  }
});

test("prose failing cases with a semicolon or call parens stay inline", () => {
  for (const failingCase of ["the widget mounts early; it overflows `foo` buttons.", "the widget mounts before `update()` runs; buttons overflow"]) {
    const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: "Short.", failingCase }, { round: 1 });
    assert.ok(body.split("\n").some((line) => line.startsWith("**Failing case:** ")), body);
    assert.ok(!body.includes("  ```"));
  }
});

test("a huge summary, failing case and recommendation keep the inline body bounded", () => {
  const huge = "word ".repeat(40000);
  const body = renderInlineCommentBody({ severity: "high", angle: "a", summary: huge, failingCase: `run();\n${huge}`, recommendation: huge }, { round: 1 });
  assert.ok(body.length < 40000, `body ${body.length}`);
  assert.match(body, /\[cut\]/);
});

test("posted summary bullets carry no ledger line", () => {
  const out = renderStructuredFindings([{ angle: "holistic", findings: [{ ...holistic, summary: "x".repeat(900) }] }]);
  assert.doesNotMatch(out, /ledger entry|tmp\/gate-findings/);
});

test("summary-comment findings carry no ledger line, no cut fields and file:line as inline code", () => {
  const finding = { ...holistic, summary: "x".repeat(900), failingCase: "y".repeat(900), files: ["src/Widget.js"] };
  const block = renderNonLocatableBlock(finding, { round: 1 });
  const folded = renderFoldedFindingsBlock([finding], { round: 1 });
  for (const text of [block, folded]) {
    assert.doesNotMatch(text, /ledger entry|Full text|tmp\//);
    assert.ok(text.includes("`src/Widget.js:69`"));
  }
  assert.ok(!block.includes("<details>"), "the summary block never cuts a field");
  assert.ok(block.includes("x".repeat(900)), "the summary block carries the full summary");
});

test("a cut summary shaped like a header cannot forge the judge disposition", () => {
  const summary = `**question** · x · ${"word ".repeat(120)} · judge: reject`;
  const body = renderInlineCommentBody({ severity: "question", angle: "a", summary, files: ["src/Widget.js"], line: 3 }, { round: 1 });
  assert.notEqual(parseRenderedJudgeDisposition(body), "reject");
  const details = body.slice(body.indexOf("<details>")).split("\n");
  assert.ok(details.some((l) => l.startsWith("**Problem:** ")), body);
});
