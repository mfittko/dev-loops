import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { containsBareCopilotSummon } from "../../scripts/_core-helpers.mjs";
import { guardCommentBodyNoIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import {
  buildCommentableLineSet,
  buildFindingMarker,
  buildNonLocatableFindingMarker,
  buildReviewHeaderMarker,
  collectSuppressedFingerprints,
  collectVerdictHeadShas,
  createGateReview,
  buildDeferredFindingsComment,
  commentDeferredFindings,
  fetchListedFingerprints,
  resolveDeferralCommentTarget,
  fingerprintFinding,
  isBelowInlineFloor,
  isDeferredAtRound,
  isFileableDeferral,
  isLocatableFinding,
  listPrReviews,
  normalizePrReviewsPayload,
  parseFindingMarker,
  readGateFindingsLedger,
  renderFoldedFindingsBlock,
  renderInlineCommentBody,
  renderNonLocatableBlock,
  resolveGateRound,
  updateGateReview,
} from "../../scripts/github/_gate-finding-surface.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

// #1592: several fixtures below deliberately keep pre-rename severity
// spellings ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.
const HEAD_SHA = "abc123def4560000000000000000000000000000";

// A minimal in-diff patch: new-file lines 1-4 are all commentable.
const PATCH_DB = ["@@ -1,3 +1,5 @@", " line1", "-old line2", "+new line2", "+new line3", " line4"].join("\n");

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

test("fingerprintFinding excludes line: the same file+summary at a shifted line dedupes", () => {
  const a = { files: ["src/a.mjs"], summary: "Missing null check" };
  const b = { files: ["src/a.mjs"], summary: "Missing null check", line: 999 };
  assert.equal(fingerprintFinding(a), fingerprintFinding(b));
});

test("fingerprintFinding falls back to an empty path when files is absent", () => {
  assert.equal(fingerprintFinding({ summary: "Naming nit" }), fingerprintFinding({ files: [], summary: "Naming nit" }));
});

test("fingerprintFinding normalizes summary casing/punctuation", () => {
  const a = { files: ["src/a.mjs"], summary: "Missing NULL check!" };
  const b = { files: ["src/a.mjs"], summary: "missing null check" };
  assert.equal(fingerprintFinding(a), fingerprintFinding(b));
});

test("fingerprintFinding trims files[0]: an untrimmed path fingerprints identically to its trimmed form", () => {
  const a = { files: [" src/a.mjs "], summary: "Missing null check" };
  const b = { files: ["src/a.mjs"], summary: "Missing null check" };
  assert.equal(fingerprintFinding(a), fingerprintFinding(b));
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

test("buildFindingMarker / parseFindingMarker round-trip", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "high", angle: "security", round: 2 });
  assert.deepEqual(parseFindingMarker(marker), { fp: "0123456789abcdef", severity: "high", angle: "security", round: 2, operatorVisible: false, disposition: null, issue: null });
});

test("buildFindingMarker / parseFindingMarker round-trip: a legacy-spelled severity still parses and normalizes on read", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "must-fix", angle: "security", round: 2 });
  assert.ok(marker.includes("severity=must-fix"), "the marker itself carries the spelling it was built with");
  assert.deepEqual(parseFindingMarker(marker), { fp: "0123456789abcdef", severity: "high", angle: "security", round: 2, operatorVisible: false, disposition: null, issue: null });
});

// #1846: the explicit operator-visibility signal round-trips through the
// marker's `ov=1` field — absent/false renders no field at all (the
// conservative default `isFileableDeferral` treats as NOT operator visible).
test("buildFindingMarker / parseFindingMarker round-trip: operatorVisible", () => {
  const visible = buildFindingMarker({ fp: "0123456789abcdef", severity: "low", angle: "naming", round: 1, operatorVisible: true });
  assert.match(visible, / ov=1( |-->)/);
  assert.equal(parseFindingMarker(visible).operatorVisible, true);

  const notVisible = buildFindingMarker({ fp: "0123456789abcdef", severity: "low", angle: "naming", round: 1, operatorVisible: false });
  assert.doesNotMatch(notVisible, /ov=1/);
  assert.equal(parseFindingMarker(notVisible).operatorVisible, false);

  // Omitted renders byte-identically to explicit false.
  const omitted = buildFindingMarker({ fp: "0123456789abcdef", severity: "low", angle: "naming", round: 1 });
  assert.equal(omitted, notVisible);
});

test("buildFindingMarker rejects a non-boolean operatorVisible", () => {
  assert.throws(
    () => buildFindingMarker({ fp: "0123456789abcdef", severity: "low", angle: "naming", round: 1, operatorVisible: "true" }),
    /operatorVisible must be a boolean/,
  );
});

// The ov=1 field, when present, renders BEFORE disposition/issue (matching
// the order stampDeferredDisposition's trailing-`-->` PATCH later appends
// them in), so a filed operator-visible low's fully-stamped marker still
// round-trips every field.
test("buildFindingMarker: operatorVisible + disposition + issue all round-trip together", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "low", angle: "naming", round: 1, operatorVisible: true, disposition: "deferred", issue: 42 });
  assert.match(marker, /round=1 ov=1 disposition=deferred issue=42 -->$/);
  const parsed = parseFindingMarker(marker);
  assert.equal(parsed.operatorVisible, true);
  assert.equal(parsed.disposition, "deferred");
  assert.equal(parsed.issue, 42);
});

test("buildFindingMarker with a disposition round-trips through parseFindingMarker", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "nice-to-have", angle: "naming", round: 1, disposition: "deferred" });
  assert.equal(parseFindingMarker(marker).disposition, "deferred");
});

// #1807: the follow-up issue number a `disposition=deferred` finding is
// tracked on (GATE-EXEC-DEFERRAL-RECORD) round-trips through the marker too.
test("buildFindingMarker with an issue number round-trips through parseFindingMarker", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "nice-to-have", angle: "naming", round: 1, disposition: "deferred", issue: 42 });
  assert.match(marker, /disposition=deferred issue=42 -->$/);
  const parsed = parseFindingMarker(marker);
  assert.equal(parsed.disposition, "deferred");
  assert.equal(parsed.issue, 42);
});

test("buildFindingMarker rejects a non-positive-integer issue", () => {
  assert.throws(
    () => buildFindingMarker({ fp: "0123456789abcdef", severity: "nice-to-have", angle: "naming", round: 1, disposition: "deferred", issue: 0 }),
    /issue must be a positive integer/,
  );
  assert.throws(
    () => buildFindingMarker({ fp: "0123456789abcdef", severity: "nice-to-have", angle: "naming", round: 1, disposition: "deferred", issue: 1.5 }),
    /issue must be a positive integer/,
  );
});

test("buildFindingMarker throws on a disposition value other than \"deferred\"", () => {
  assert.throws(
    () => buildFindingMarker({ fp: "0123456789abcdef", severity: "nice-to-have", angle: "naming", round: 1, disposition: "accepted-for-fix" }),
    /disposition must be "deferred"/,
  );
});

test("buildFindingMarker caps the angle field at 40 chars so a long label can never push the marker past a listing excerpt", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "nice-to-have", angle: "a".repeat(120), round: 1 });
  assert.equal(parseFindingMarker(marker).angle, "a".repeat(40));
});

test("parseFindingMarker returns null for text with no marker", () => {
  assert.equal(parseFindingMarker("just prose"), null);
});

test("parseFindingMarker (marker provenance): a marker quoted mid-line (not at line start) is never honored", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "must-fix", angle: "security", round: 1 });
  assert.equal(parseFindingMarker(`see prior: ${marker}`), null);
  assert.equal(parseFindingMarker(`> ${marker}`), null);
  assert.notEqual(parseFindingMarker(`prose\n${marker}`), null);
});

test("buildReviewHeaderMarker renders the gate-scoped round marker at column 0", () => {
  assert.equal(
    buildReviewHeaderMarker({ gate: "draft_gate", headSha: HEAD_SHA, round: 3 }),
    `<!-- dev-loops:gate-findings-review draft_gate ${HEAD_SHA} round=3 -->`,
  );
});

// ---------------------------------------------------------------------------
// Disposition window
// ---------------------------------------------------------------------------

test("isDeferredAtRound: high never defers, medium defers from round 4, low defers immediately", () => {
  assert.equal(isDeferredAtRound("high", 99), false);
  assert.equal(isDeferredAtRound("medium", 3), false);
  assert.equal(isDeferredAtRound("medium", 4), true);
  assert.equal(isDeferredAtRound("low", 1), true);
});

// #1592: question is a non-defect category that is answered, never deferred —
// an unanswered question blocks gate-close exactly like an open defect (via
// the unresolved-thread count, since it is never selected for auto-deferral).
// nit is a non-defect category that defers immediately, with no fixer cycle.
test("isDeferredAtRound: question never defers (any round), nit always defers immediately", () => {
  assert.equal(isDeferredAtRound("question", 1), false);
  assert.equal(isDeferredAtRound("question", 99), false);
  assert.equal(isDeferredAtRound("nit", 1), true);
  assert.equal(isDeferredAtRound("nit", 99), true);
});

// Backward compatibility (#1592): every pre-rename severity spelling still
// normalizes to its canonical replacement and behaves identically.
test("isDeferredAtRound: legacy severity spellings behave identically to their canonical replacement", () => {
  assert.equal(isDeferredAtRound("must-fix", 99), false);
  assert.equal(isDeferredAtRound("worth-fixing-now", 3), false);
  assert.equal(isDeferredAtRound("worth-fixing-now", 4), true);
  assert.equal(isDeferredAtRound("nice-to-have", 1), true);
  assert.equal(isDeferredAtRound("defer", 1), true);
});

// Fail-closed: an unrecognized severity (a malformed/forged marker) must
// never be silently auto-deferred and resolved through the same path as a
// genuine low/nit finding — it must stay open and surface as a dangling
// gate-authored thread that blocks gate-close.
test("isDeferredAtRound: an unrecognized severity fails CLOSED (never deferred)", () => {
  assert.equal(isDeferredAtRound("bogus", 1), false);
  assert.equal(isDeferredAtRound("bogus", 99), false);
  assert.equal(isDeferredAtRound("", 1), false);
  assert.equal(isDeferredAtRound(undefined, 1), false);
});

// #1581: the per-gate medium fix window overrides the built-in
// constant. A consumer raising the window to 5 keeps a round-4 medium finding open;
// lowering it to 1 defers a round-2 medium finding. high is always exempt.
test("isDeferredAtRound: a per-gate window parameter overrides the built-in constant (#1581)", () => {
  // Default (no third arg) still uses the built-in MEDIUM_FIX_WINDOW (3).
  assert.equal(isDeferredAtRound("medium", 3), false);
  assert.equal(isDeferredAtRound("medium", 4), true);
  // A raised per-gate window (5): round 4 now stays open; round 6 defers.
  assert.equal(isDeferredAtRound("medium", 4, 5), false);
  assert.equal(isDeferredAtRound("medium", 5, 5), false);
  assert.equal(isDeferredAtRound("medium", 6, 5), true);
  // A lowered per-gate window (1): round 2 defers; round 1 stays open.
  assert.equal(isDeferredAtRound("medium", 1, 1), false);
  assert.equal(isDeferredAtRound("medium", 2, 1), true);
  // high never defers, regardless of the per-gate window or round.
  assert.equal(isDeferredAtRound("high", 99, 1), false);
  assert.equal(isDeferredAtRound("high", 99, 5), false);
  // low always defers immediately, regardless of the window.
  assert.equal(isDeferredAtRound("low", 1, 5), true);
  // question never defers, regardless of the window.
  assert.equal(isDeferredAtRound("question", 99, 1), false);
  // nit always defers immediately, regardless of the window.
  assert.equal(isDeferredAtRound("nit", 1, 5), true);
});

// ---------------------------------------------------------------------------
// #1846: net-reduction filing bar — resolving a thread vs. FILING it to a
// tracked follow-up issue are separate decisions; isFileableDeferral governs
// the latter only.
// ---------------------------------------------------------------------------

test("isFileableDeferral: a nit is NEVER fileable, any round, regardless of operatorVisible", () => {
  assert.equal(isFileableDeferral("nit", false, 1), false);
  assert.equal(isFileableDeferral("nit", true, 99), false, "operatorVisible never applies to nit");
});

test("isFileableDeferral: a low is fileable only when operatorVisible is exactly true (conservative default)", () => {
  assert.equal(isFileableDeferral("low", undefined, 1), false);
  assert.equal(isFileableDeferral("low", false, 1), false);
  assert.equal(isFileableDeferral("low", "true", 1), false, "a truthy non-boolean never counts as the explicit signal");
  assert.equal(isFileableDeferral("low", true, 1), true);
});

test("isFileableDeferral: medium is unchanged (fileable only past the fix window), regardless of operatorVisible", () => {
  assert.equal(isFileableDeferral("medium", false, 3), false);
  assert.equal(isFileableDeferral("medium", false, 4), true);
  assert.equal(isFileableDeferral("medium", false, 4, 5), false);
  assert.equal(isFileableDeferral("medium", false, 6, 5), true);
});

test("isFileableDeferral: high/question are never fileable (they are never resolved by the disposition pass to begin with)", () => {
  assert.equal(isFileableDeferral("high", true, 99), false);
  assert.equal(isFileableDeferral("question", true, 99), false);
});

test("isFileableDeferral: legacy severity spellings behave identically to their canonical replacement", () => {
  assert.equal(isFileableDeferral("nice-to-have", true, 1), true);
  assert.equal(isFileableDeferral("nice-to-have", false, 1), false);
  assert.equal(isFileableDeferral("worth-fixing-now", false, 4), true);
});

// ---------------------------------------------------------------------------
// #2263: isBelowInlineFloor — the FOLDED-vs-INLINE/BODYFILED routing
// predicate. "Below the floor" is purely a SEVERITY_ORDER rank comparison;
// locatability is irrelevant here (a caller applies isLocatableFinding
// separately, only to candidates that pass this floor check).
// ---------------------------------------------------------------------------

test("isBelowInlineFloor: at the default \"medium\" floor, high/question/medium stay inline and low/nit fold", () => {
  assert.equal(isBelowInlineFloor("high", "medium"), false);
  assert.equal(isBelowInlineFloor("question", "medium"), false);
  assert.equal(isBelowInlineFloor("medium", "medium"), false);
  assert.equal(isBelowInlineFloor("low", "medium"), true);
  assert.equal(isBelowInlineFloor("nit", "medium"), true);
});

test("isBelowInlineFloor: lowering the floor to \"low\" restores low inline, only nit still folds (the escape hatch)", () => {
  assert.equal(isBelowInlineFloor("medium", "low"), false);
  assert.equal(isBelowInlineFloor("low", "low"), false);
  assert.equal(isBelowInlineFloor("nit", "low"), true);
});

test("isBelowInlineFloor: floor \"nit\" folds nothing (everything posts inline)", () => {
  for (const severity of ["high", "question", "medium", "low", "nit"]) {
    assert.equal(isBelowInlineFloor(severity, "nit"), false);
  }
});

test("isBelowInlineFloor: an unknown severity or floor fails CLOSED (posts inline, never silently folded)", () => {
  assert.equal(isBelowInlineFloor("bogus", "medium"), false);
  assert.equal(isBelowInlineFloor("low", "bogus"), false);
  assert.equal(isBelowInlineFloor(undefined, "medium"), false);
});

test("isBelowInlineFloor: legacy severity spellings normalize before ranking", () => {
  assert.equal(isBelowInlineFloor("nice-to-have", "medium"), true); // low
  assert.equal(isBelowInlineFloor("worth-fixing-now", "medium"), false); // medium
  assert.equal(isBelowInlineFloor("must-fix", "medium"), false); // high
});

// #2295 Copilot review fix 1: a "question" never folds, at ANY floor —
// including a floor value like "high" that the config schema no longer permits
// (the enum is constrained to ["medium","low","nit"]). isBelowInlineFloor is a
// pure function, not schema-bound, so this proves the defense-in-depth guard
// holds even for a floor the config can never produce. Contrast with
// "low"/"medium", which DO fold once the floor is raised past them.
test("isBelowInlineFloor: a \"question\" never folds, even at a floor value (\"high\") the config no longer permits", () => {
  assert.equal(isBelowInlineFloor("question", "high"), false);
  assert.equal(isBelowInlineFloor("question", "medium"), false);
  assert.equal(isBelowInlineFloor("low", "high"), true);
  assert.equal(isBelowInlineFloor("medium", "high"), true);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("renderInlineCommentBody: the marker is the body's first line", () => {
  const finding = { severity: "must-fix", angle: "security", summary: "SQL injection", recommendation: "Use a parameterized query" };
  const body = renderInlineCommentBody(finding, { round: 1 });
  // The marker carries the NORMALIZED severity ("high"), not the legacy
  // spelling passed in: renderInlineCommentBody normalizes once and reuses
  // it for both the marker and the rendered line.
  const marker = buildFindingMarker({ fp: fingerprintFinding(finding), severity: "high", angle: "security", round: 1 });
  assert.equal(body.split("\n")[0], marker);
  assert.match(body, /Recommendation: Use a parameterized query/);
});

test("renderInlineCommentBody neutralizes Copilot summon tokens", () => {
  const body = renderInlineCommentBody({ severity: "nice-to-have", angle: "dry", summary: "ask @copilot to re-review this" }, { round: 1 });
  assert.equal(containsBareCopilotSummon(body), false);
});

// #1846: a finding's own operatorVisible: true carries onto the posted
// marker's ov=1 field — this is the ONE place a producer marks a low
// operator-visible; absent renders no field (the conservative default).
test("renderInlineCommentBody: a finding's operatorVisible: true renders the marker's ov=1 field", () => {
  const visible = { severity: "low", angle: "correctness", summary: "stale cache", operatorVisible: true };
  const notVisible = { severity: "low", angle: "correctness", summary: "stale cache" };
  assert.match(renderInlineCommentBody(visible, { round: 1 }).split("\n")[0], /ov=1/);
  assert.doesNotMatch(renderInlineCommentBody(notVisible, { round: 1 }).split("\n")[0], /ov=1/);
});

test("renderNonLocatableBlock: every content line after the marker is blockquoted", () => {
  const block = renderNonLocatableBlock(
    { severity: "worth-fixing-now", angle: "dry", summary: "duplicated logic", recommendation: "extract a helper", files: ["src/a.mjs"] },
    { round: 1 },
  );
  const [markerLine, ...rest] = block.split("\n");
  assert.ok(markerLine.startsWith("<!-- dev-loops:finding "));
  for (const line of rest) {
    assert.ok(line.startsWith("> "), `expected blockquoted content line, got: ${JSON.stringify(line)}`);
  }
});

test("renderNonLocatableBlock: a non-high finding is stamped disposition=deferred at render time, high is not", () => {
  const low = renderNonLocatableBlock({ severity: "low", angle: "naming", summary: "casing nit" }, { round: 1 });
  const medium = renderNonLocatableBlock({ severity: "medium", angle: "perf", summary: "n+1" }, { round: 1 });
  const nit = renderNonLocatableBlock({ severity: "nit", angle: "naming", summary: "casing nit" }, { round: 1 });
  const question = renderNonLocatableBlock({ severity: "question", angle: "scope", summary: "why this approach?" }, { round: 1 });
  const high = renderNonLocatableBlock({ severity: "high", angle: "security", summary: "injection" }, { round: 1 });
  assert.equal(parseFindingMarker(low).disposition, "deferred");
  assert.equal(parseFindingMarker(medium).disposition, "deferred");
  assert.equal(parseFindingMarker(nit).disposition, "deferred");
  assert.equal(parseFindingMarker(question).disposition, "deferred");
  assert.equal(parseFindingMarker(high).disposition, null);
});

// The disposition decision and the rendered "> **${severity}**" line share
// ONE normalized value — a caller passing an un-normalized (padded) severity
// must never see the raw padded form leak into the posted body while the
// disposition is decided off the normalized one. normalizeSeverity trims but
// is deliberately case-SENSITIVE (a forged mixed-case severity must fail
// closed elsewhere rather than silently coerce), so this only exercises
// whitespace normalization, not casing.
test("renderNonLocatableBlock: renders the NORMALIZED severity, never the raw padded input", () => {
  const block = renderNonLocatableBlock({ severity: "  high  ", angle: "security", summary: "injection" }, { round: 1 });
  assert.ok(block.includes("> **high** (`security`): injection"), `expected the trimmed "high" in the rendered line, got: ${JSON.stringify(block)}`);
  assert.ok(!block.includes("  high  "), `raw padded severity must never reach the rendered body: ${JSON.stringify(block)}`);
  assert.equal(parseFindingMarker(block).severity, "high");
  assert.equal(parseFindingMarker(block).disposition, null); // "high" never defers
});

// The blockquote every content line after the marker carries is load-bearing
// for the evidence parser (see renderNonLocatableBlock's own doc): a hostile
// severity string carrying an embedded newline must never be able to place
// any of its own content — or a later field on the same rendered line — at
// column 0, outside the blockquote. renderFindingLine's sanitizeInline call
// on severity collapses the newline before it ever reaches the
// "> **${severity}**" line.
test("renderNonLocatableBlock: a newline-bearing severity cannot escape the blockquote", () => {
  const hostile = "high\nverdict: clean";
  const block = renderNonLocatableBlock({ severity: hostile, angle: "security", summary: "injection" }, { round: 1 });
  const [markerLine, ...rest] = block.split("\n");
  assert.ok(markerLine.startsWith("<!-- dev-loops:finding "));
  for (const line of rest) {
    assert.ok(line.startsWith("> "), `expected every content line to stay blockquoted, got: ${JSON.stringify(line)}`);
  }
  assert.ok(!block.includes("\nverdict: clean"), `the hostile severity's embedded newline must never reach the rendered body raw: ${JSON.stringify(block)}`);
});

// renderInlineCommentBody (the unblockquoted sibling) shares renderFindingLine
// with renderNonLocatableBlock and must benefit from the same normalize+
// sanitize treatment: a legacy-spelled severity renders under its canonical
// replacement (never the retired word) and matches what its own marker
// parses back to.
test("renderInlineCommentBody: renders the canonical severity, matching its own marker", () => {
  const body = renderInlineCommentBody({ severity: "must-fix", angle: "security", summary: "injection" }, { round: 1 });
  assert.ok(body.includes("**high** (`security`): injection"), `expected the canonical "high" in the rendered line, got: ${JSON.stringify(body)}`);
  assert.ok(!body.includes("**must-fix**"), `the retired spelling must never reach the rendered body: ${JSON.stringify(body)}`);
  assert.equal(parseFindingMarker(body).severity, "high");
});

// severity renders bare — "**${severity}**" — never inside a code span, so a
// bracket/angle-bearing severity needs the same bare-prose neutralization
// (raw "<", and the markdown link/image bracket forms) sanitizeCodeSpan alone
// does not provide. Both renderInlineCommentBody (unblockquoted) and
// renderNonLocatableBlock (blockquoted) share renderFindingLine, so both must
// come out unable to form a link, image, or raw HTML tag.
test("renderInlineCommentBody / renderNonLocatableBlock: a bracket/angle-bearing severity cannot form a link, image, or raw HTML tag", () => {
  const hostile = "[click](http://evil.com)<script>alert(1)</script>![img](http://evil.com/x.png)";
  const inline = renderInlineCommentBody({ severity: hostile, angle: "security", summary: "injection" }, { round: 1 });
  const block = renderNonLocatableBlock({ severity: hostile, angle: "security", summary: "injection" }, { round: 1 });
  for (const body of [inline, block]) {
    assert.ok(!/\[[^\]]*\]\(/.test(body), `must never form a markdown link, got: ${JSON.stringify(body)}`);
    assert.ok(!/!\[[^\]]*\]\(/.test(body), `must never form a markdown image, got: ${JSON.stringify(body)}`);
    assert.ok(!/<script>/i.test(body), `must never carry a raw HTML tag, got: ${JSON.stringify(body)}`);
  }
});

test("renderNonLocatableBlock: a legacy-spelled severity is still stamped/unstamped identically to its canonical replacement", () => {
  const legacyDefer = renderNonLocatableBlock({ severity: "nice-to-have", angle: "naming", summary: "casing nit" }, { round: 1 });
  const legacyMust = renderNonLocatableBlock({ severity: "must-fix", angle: "security", summary: "injection" }, { round: 1 });
  assert.equal(parseFindingMarker(legacyDefer).disposition, "deferred");
  assert.equal(parseFindingMarker(legacyMust).disposition, null);
});

// The line ref belongs to files[0] (the anchor isLocatableFinding keys on), not
// to whichever file happens to render last.
test("renderNonLocatableBlock: the line ref renders inside files[0]'s own code span", () => {
  const block = renderNonLocatableBlock(
    { severity: "nice-to-have", angle: "perf", summary: "N+1", files: ["src/a.mjs", "src/b.mjs"], line: 12 },
    { round: 1 },
  );
  assert.match(block, /^> Location: `src\/a\.mjs:12`, `src\/b\.mjs`$/m);
});

// ---------------------------------------------------------------------------
// #2263: renderFoldedFindingsBlock — the collapsed <details> surface for
// findings folded below the inline severity floor.
// ---------------------------------------------------------------------------

test("renderFoldedFindingsBlock: empty input renders nothing", () => {
  assert.equal(renderFoldedFindingsBlock([], { round: 1 }), "");
});

test("renderFoldedFindingsBlock: renders a collapsed <details> with a per-finding marker and a file:line + summary bullet", () => {
  const findings = [
    { severity: "low", angle: "naming", summary: "casing nit", files: ["src/a.mjs"], line: 12 },
    { severity: "nit", angle: "style", summary: "trailing whitespace" },
  ];
  const block = renderFoldedFindingsBlock(findings, { round: 2 });
  assert.match(block, /^<details>$/m);
  assert.match(block, /^<summary>Suppressed low\/nit findings \(2\) — below the inline severity floor<\/summary>$/m);
  assert.match(block, /^<\/details>$/m);
  assert.match(block, /^- `src\/a\.mjs:12` \*\*low\*\* \(`naming`\): casing nit$/m);
  assert.match(block, /^- \*\*nit\*\* \(`style`\): trailing whitespace$/m);
  // Every marker is a parseable line-start `dev-loops:finding` marker, one per
  // finding, carrying disposition=deferred.
  const markerLines = block.split("\n").filter((line) => line.startsWith("<!-- dev-loops:finding "));
  assert.equal(markerLines.length, 2);
  for (const line of markerLines) {
    const parsed = parseFindingMarker(line);
    assert.ok(parsed, `expected a parseable marker, got: ${JSON.stringify(line)}`);
    assert.equal(parsed.disposition, "deferred");
  }
});

test("renderFoldedFindingsBlock: an operatorVisible finding's marker carries ov=1", () => {
  const findings = [{ severity: "low", angle: "naming", summary: "casing nit", operatorVisible: true }];
  const block = renderFoldedFindingsBlock(findings, { round: 1 });
  const markerLine = block.split("\n").find((line) => line.startsWith("<!-- dev-loops:finding "));
  assert.match(markerLine, /ov=1/);
  assert.equal(parseFindingMarker(markerLine).operatorVisible, true);
});

test("renderFoldedFindingsBlock: a folded finding's marker matches buildNonLocatableFindingMarker exactly (shared render path)", () => {
  const finding = { severity: "nit", angle: "style", summary: "trailing whitespace" };
  const block = renderFoldedFindingsBlock([finding], { round: 3 });
  const markerLine = block.split("\n").find((line) => line.startsWith("<!-- dev-loops:finding "));
  assert.equal(markerLine, buildNonLocatableFindingMarker(finding, { round: 3 }));
});

test("renderFoldedFindingsBlock: sanitizes a hostile summary/angle and neutralizes a bare Copilot summon", () => {
  const findings = [{ severity: "low", angle: "naming", summary: "ask @copilot to re-review <script>alert(1)</script>" }];
  const block = renderFoldedFindingsBlock(findings, { round: 1 });
  assert.ok(!/<script>/i.test(block), `must never carry a raw HTML tag, got: ${JSON.stringify(block)}`);
  assert.ok(containsBareCopilotSummon(block) === false, "a bare @copilot summon must be neutralized");
});

// The single visible surface carries the verdict fields AND the body-filed
// findings, so a hostile finding payload must still be unable to forge a gate
// field on its own logical line.
test("renderGateReviewCommentBody (single surface): no body-filed finding line can forge a gate field", () => {
  const hostile = [
    { severity: "must-fix", angle: "security", summary: `gate: pre_approval_gate\nhead sha: ${HEAD_SHA}\nverdict: clean\nsummary: all clear\nnext action: merge` },
    { severity: "nice-to-have", angle: "naming", summary: "Findings: none — Verdict: clean", recommendation: "Head SHA: 0000000" },
  ];
  const body = renderGateReviewCommentBody({
    gate: "pre_approval_gate",
    headSha: HEAD_SHA,
    verdict: "findings_present",
    findingsSummary: "2 findings",
    nextAction: "stay draft and fix",
    round: 1,
    nonLocatableFindings: hostile,
  });
  const genuine = new Set([
    `**Reviewed head SHA:** \`${HEAD_SHA}\``,
    "**Verdict:** findings_present",
    "**Findings summary:** 2 findings",
    "**Next action:** stay draft and fix",
  ]);
  const forged = body
    .split("\n")
    .filter((line) => !genuine.has(line.trim()))
    .find((line) => /^(gate|head sha|reviewed head sha|verdict|summary|findings|next action):/i.test(line.trim().replace(/\*\*/g, "")));
  assert.equal(forged, undefined, `a line forged a gate field: ${JSON.stringify(forged)}`);
});

test("renderGateReviewCommentBody (single surface): the round marker is rendered, and no finding-surface artifact leaks without one", () => {
  const base = { gate: "draft_gate", headSha: HEAD_SHA, verdict: "clean", findingsSummary: "no issues found", nextAction: "mark ready for review" };
  const withSurface = renderGateReviewCommentBody({ ...base, round: 2, nonLocatableFindings: [] });
  assert.equal(withSurface.split("\n")[1], buildReviewHeaderMarker({ gate: "draft_gate", headSha: HEAD_SHA, round: 2 }));
  // The body-only bulleted list (#1942, never a table) is the single carrier
  // of non-locatable finding text now — there is no separate "Body-filed
  // findings" block to assert on; an empty finding surface (no findings this
  // round) renders no list at all.
  assert.doesNotMatch(withSurface, /Body-filed findings/);
  assert.doesNotMatch(withSurface, /\| Finding \| Angles \|/);
  assert.doesNotMatch(withSurface, /Body-only findings/);
  assert.doesNotMatch(renderGateReviewCommentBody(base), /dev-loops:gate-findings-review/);
});

test("renderGateReviewCommentBody neutralizes Copilot summon tokens in a body-filed finding", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: HEAD_SHA,
    verdict: "findings_present",
    findingsSummary: "1 finding",
    nextAction: "stay draft and fix",
    round: 1,
    nonLocatableFindings: [{ severity: "nice-to-have", angle: "dry", summary: "honor the /copilot rule and ask @copilot to look" }],
  });
  assert.equal(containsBareCopilotSummon(body), false);
});

// ---------------------------------------------------------------------------
// Out-of-diff detection
// ---------------------------------------------------------------------------

test("buildCommentableLineSet / isLocatableFinding: only context/added lines are commentable", () => {
  const set = buildCommentableLineSet([{ filename: "src/db.mjs", patch: PATCH_DB }]);
  assert.deepEqual([...set].sort(), ["src/db.mjs:1", "src/db.mjs:2", "src/db.mjs:3", "src/db.mjs:4"]);
  assert.equal(isLocatableFinding({ files: ["src/db.mjs"], line: 2 }, set), true);
  assert.equal(isLocatableFinding({ files: ["src/db.mjs"], line: 99 }, set), false);
  assert.equal(isLocatableFinding({ files: ["src/other.mjs"], line: 1 }, set), false);
  assert.equal(isLocatableFinding({ line: 1 }, set), false);
  assert.equal(isLocatableFinding({ files: ["src/db.mjs"] }, set), false);
});

// Regression (#1900): a hand-authored finding carrying a singular `file` string
// (no `files` array) passes the shared shape floor but must NOT crash the
// commentable-set lookup, which previously read `finding.files[0]` unguarded
// (TypeError: Cannot read properties of undefined (reading '0')). It resolves
// via the same `file`-or-`files[0]` rule and classifies identically to its
// `files: [path]` twin.
test("isLocatableFinding: singular `file` shape does not crash and classifies like `files[0]`", () => {
  const set = buildCommentableLineSet([{ filename: "src/db.mjs", patch: PATCH_DB }]);
  assert.equal(isLocatableFinding({ file: "src/db.mjs", line: 2 }, set), true);
  assert.equal(isLocatableFinding({ file: "src/db.mjs", line: 99 }, set), false);
  assert.equal(isLocatableFinding({ file: "src/other.mjs", line: 1 }, set), false);
});

// ---------------------------------------------------------------------------
// Suppression + verdict-head collection
// ---------------------------------------------------------------------------

test("collectSuppressedFingerprints folds OWN-authored markers only, and only at column 0", () => {
  const own = buildFindingMarker({ fp: "1111111111111111", severity: "nice-to-have", angle: "naming", round: 1 });
  const quoted = buildFindingMarker({ fp: "2222222222222222", severity: "nice-to-have", angle: "naming", round: 1 });
  const foreign = buildFindingMarker({ fp: "3333333333333333", severity: "nice-to-have", angle: "naming", round: 1 });
  const suppressed = collectSuppressedFingerprints({
    reviews: [
      { body: `${own}\n> a finding\nsee prior: ${quoted}`, author: "gate-bot" },
      { body: foreign, author: "someone-else" },
    ],
    threads: [],
    login: "gate-bot",
  });
  assert.deepEqual([...suppressed], ["1111111111111111"]);
});

test("collectVerdictHeadShas: only a genuine verdict header with a parseable reviewed head counts", () => {
  const genuine = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: HEAD_SHA,
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "mark ready for review",
  });
  const heads = new Set();
  collectVerdictHeadShas(
    [
      { body: genuine },
      { body: `> ${genuine.split("\n")[0]}\nAgreed.` }, // quoted header
      { body: "### Gate review: `draft_gate`\n\nno reviewed-head line at all" },
      { body: genuine.replace("draft_gate", "pre_approval_gate") }, // other gate
    ],
    "draft_gate",
    heads,
  );
  assert.deepEqual([...heads], [HEAD_SHA]);
});

// ---------------------------------------------------------------------------
// Ledger read + validate
// ---------------------------------------------------------------------------

// This is the single shared validator both producers (close-gate-findings.mjs,
// upsert-checkpoint-verdict.mjs) read their round through, so every rejection
// branch is pinned here rather than through one CLI's happy path.
const VALID_LEDGER = {
  repo: "owner/repo",
  pr: 17,
  gate: "draft_gate",
  headSha: HEAD_SHA,
  verdict: "findings_present",
  findings: [{ severity: "nice-to-have", angle: "coverage", summary: "no test for the retry path" }],
};

async function withLedgerFile(raw, assertRejection) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ledger-validate-"));
  try {
    const ledgerPath = path.join(dir, "ledger.json");
    await writeFile(ledgerPath, typeof raw === "string" ? raw : JSON.stringify(raw), "utf8");
    await assertRejection(ledgerPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rejects = (raw, message) => withLedgerFile(raw, (ledgerPath) => assert.rejects(() => readGateFindingsLedger(ledgerPath), message));

test("readGateFindingsLedger rejects a malformed envelope with a branch-specific message", async () => {
  await rejects("{not json", /must contain valid JSON/);
  await rejects("[]", /must contain a JSON object/);
  await rejects("null", /must contain a JSON object/);
  await rejects({ ...VALID_LEDGER, repo: "not-a-slug" }, /"repo" must be an owner\/name slug/);
  await rejects({ ...VALID_LEDGER, pr: undefined }, /is missing a valid "pr" number/);
  await rejects({ ...VALID_LEDGER, pr: "17" }, /is missing a valid "pr" number/);
  await rejects({ ...VALID_LEDGER, pr: 0 }, /is missing a valid "pr" number/);
  await rejects({ ...VALID_LEDGER, gate: "some_other_gate" }, /"gate" must be draft_gate or pre_approval_gate/);
  await rejects({ ...VALID_LEDGER, headSha: "abc123" }, /"headSha" must be the full/);
  await rejects({ ...VALID_LEDGER, verdict: "maybe" }, /"verdict" must be clean, findings_present, or blocked/);
  await rejects({ ...VALID_LEDGER, findings: {} }, /"findings" must be an array/);
});

test("readGateFindingsLedger rejects a malformed finding entry, naming its index", async () => {
  const withFinding = (finding) => ({ ...VALID_LEDGER, findings: [VALID_LEDGER.findings[0], finding] });
  await rejects(withFinding(null), /findings\[1\] is malformed/);
  await rejects(withFinding({ angle: "coverage", summary: "no severity" }), /findings\[1\] is malformed/);
  await rejects(withFinding({ severity: "urgent", angle: "coverage", summary: "unknown severity" }), /findings\[1\] is malformed/);
  await rejects(withFinding({ severity: "nice-to-have", summary: "no angle" }), /findings\[1\] is malformed/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage" }), /findings\[1\] is malformed/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage", summary: "x", line: 2.5 }), /findings\[1\]\.line must be a positive integer/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage", summary: "x", line: 0 }), /findings\[1\]\.line must be a positive integer/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage", summary: "x", line: -3 }), /findings\[1\]\.line must be a positive integer/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage", summary: "x", line: "2" }), /findings\[1\]\.line must be a positive integer/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage", summary: "x", files: "src/a.mjs" }), /findings\[1\]\.files must be an array/);
  await rejects(withFinding({ severity: "nice-to-have", angle: "coverage", summary: "x", files: { path: "src/a.mjs" } }), /findings\[1\]\.files must be an array/);
  await rejects(withFinding({ severity: "low", angle: "coverage", summary: "x", operatorVisible: "true" }), /findings\[1\]\.operatorVisible must be a boolean/);
  await rejects(withFinding({ severity: "low", angle: "coverage", summary: "x", judgeDisposition: "fix" }), /findings\[1\]\.judgeDisposition must be one of: act, defer, reject/);
});

// #1846: a "low" finding's own operatorVisible signal survives the ledger
// read unchanged — this is the field close-gate-findings.mjs's disposition
// pass reads (via the rendered marker's ov=1 field) to decide the filing bar.
test("readGateFindingsLedger passes a finding's operatorVisible through unchanged", async () => {
  await withLedgerFile(
    { ...VALID_LEDGER, findings: [{ ...VALID_LEDGER.findings[0], severity: "low", operatorVisible: true }] },
    async (ledgerPath) => {
      const ledger = await readGateFindingsLedger(ledgerPath);
      assert.equal(ledger.findings[0].operatorVisible, true);
    },
  );
});

test("readGateFindingsLedger returns the normalized ledger for a valid file", async () => {
  await withLedgerFile(
    { ...VALID_LEDGER, findings: [{ ...VALID_LEDGER.findings[0], files: ["  src/a.mjs  "], line: 4 }] },
    async (ledgerPath) => {
      const ledger = await readGateFindingsLedger(ledgerPath);
      assert.equal(ledger.repo, "owner/repo");
      assert.equal(ledger.gate, "draft_gate");
      assert.deepEqual(ledger.findings[0].files, ["src/a.mjs"]);
    },
  );
});

test("normalizePrReviewsPayload keeps only submitted reviews with a real timestamp and body", () => {
  const keep = { id: 1, state: "COMMENTED", submitted_at: "2026-08-04T00:00:00Z", body: "Gate review: draft_gate", html_url: "https://x/pr#pullrequestreview-1" };
  const out = normalizePrReviewsPayload([
    keep,
    { id: 2, state: "PENDING", submitted_at: "2026-08-04T00:00:00Z", body: "unsubmitted verdict body" },
    { id: 3, state: "COMMENTED", submitted_at: "", body: "empty timestamp" },
    { id: 4, state: "COMMENTED", submitted_at: "2026-08-04T00:00:00Z", body: "   " },
    { id: 5, state: "COMMENTED", body: "missing timestamp" },
    null,
    "junk",
  ]);
  assert.deepEqual(out, [{
    id: 1,
    body: "Gate review: draft_gate",
    surface: "review",
    html_url: "https://x/pr#pullrequestreview-1",
    created_at: "2026-08-04T00:00:00Z",
    updated_at: "2026-08-04T00:00:00Z",
  }]);
  assert.deepEqual(normalizePrReviewsPayload([[keep], []]), normalizePrReviewsPayload([keep]));
  assert.deepEqual(normalizePrReviewsPayload("not-an-array"), []);
  assert.equal(normalizePrReviewsPayload([{ ...keep, html_url: 42 }])[0].html_url, null);
});

test("listPrReviews excludes PENDING and timestamp-less reviews from round/suppression input", async () => {
  const payload = JSON.stringify([[
    { id: 1, state: "COMMENTED", submitted_at: "2026-08-04T00:00:00Z", body: "real review", user: { login: "octocat" } },
    { id: 2, state: "PENDING", submitted_at: "2026-08-04T00:00:00Z", body: "unsubmitted verdict-looking body" },
    { id: 3, state: "COMMENTED", submitted_at: "", body: "blank timestamp" },
    { id: 4, state: "COMMENTED", body: "missing timestamp" },
  ]]);
  const runChildStub = async () => ({ code: 0, stdout: payload, stderr: "" });
  const reviews = await listPrReviews({ repo: "owner/repo", pr: 17 }, { env: {}, ghCommand: "gh", runChild: runChildStub });
  assert.deepEqual(reviews, [{ id: 1, body: "real review", author: "octocat" }]);
});

test("listPrReviews shares the full submitted-review predicate (body/junk branches too)", async () => {
  const payload = JSON.stringify([[
    { id: 1, state: "COMMENTED", submitted_at: "2026-08-04T00:00:00Z", body: "real review", user: { login: "octocat" } },
    { id: 2, state: "COMMENTED", submitted_at: "2026-08-04T00:00:00Z", body: "   " },
    { id: 3, state: "COMMENTED", submitted_at: "2026-08-04T00:00:00Z" },
    null,
    "junk",
  ]]);
  const runChildStub = async () => ({ code: 0, stdout: payload, stderr: "" });
  const reviews = await listPrReviews({ repo: "owner/repo", pr: 17 }, { env: {}, ghCommand: "gh", runChild: runChildStub });
  assert.deepEqual(reviews, [{ id: 1, body: "real review", author: "octocat" }]);
});

test("readGateFindingsLedger normalizes the legacy severity spelling on read", async () => {
  const raw = JSON.stringify({
    repo: "o/n",
    pr: 7,
    gate: "draft_gate",
    headSha: "a1".repeat(20),
    verdict: "clean",
    findings: [{ severity: "defer", angle: "docs", summary: "legacy ledger entry" }],
  });
  await withLedgerFile(raw, async (ledgerPath) => {
    const ledger = await readGateFindingsLedger(ledgerPath);
    assert.equal(ledger.findings[0].severity, "low"); // "defer" normalizes to canonical "low"
  });
});

// ---------------------------------------------------------------------------
// #1585: countUnresolvedGateAuthoredThreads — the gate-close predicate
// ---------------------------------------------------------------------------

import {
  countUnresolvedGateAuthoredThreads,
  countUnresolvedGateAuthoredThreadsBySeverity,
  countUnresolvedGateAuthoredThreadsFromRawNodes,
  findJudgeDispositionForFingerprint,
  parseRenderedJudgeDisposition,
} from "../../scripts/github/_gate-finding-surface.mjs";

const GATE_LOGIN = "gate-bot";

function thread({ author = GATE_LOGIN, body, isResolved = false } = {}) {
  return { author, body, isResolved };
}

test("#1585 (a) fixer sees nice-to-have targets: an unresolved nice-to-have thread counts as gate-authored", () => {
  const niceToHave = thread({ body: `${buildFindingMarker({ fp: "a".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): casing nit` });
  // A nice-to-have thread IS counted (the fixer must see it as a triage target,
  // not have it silently auto-deferred before triage).
  assert.equal(countUnresolvedGateAuthoredThreads([niceToHave], GATE_LOGIN), 1);
});

test("#1585: must-fix, worth-fixing-now, AND nice-to-have unresolved threads all count toward the gate-close assertion", () => {
  const mustFix = thread({ body: `${buildFindingMarker({ fp: "1".repeat(16), severity: "must-fix", angle: "sec", round: 1 })}\n**must-fix** (\`sec\`): x` });
  const wfn = thread({ body: `${buildFindingMarker({ fp: "2".repeat(16), severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): y` });
  const nth = thread({ body: `${buildFindingMarker({ fp: "3".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): z` });
  assert.equal(countUnresolvedGateAuthoredThreads([mustFix, wfn, nth], GATE_LOGIN), 3);
});

test("#1585 (b) gate-close requires 0 unresolved gate-authored threads: resolved threads do not count", () => {
  const resolved = thread({ body: `${buildFindingMarker({ fp: "a".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): z`, isResolved: true });
  assert.equal(countUnresolvedGateAuthoredThreads([resolved], GATE_LOGIN), 0);
});

test("#1585: a FOREIGN-authored thread carrying a finding marker is excluded by author identity (login required)", () => {
  const foreign = thread({ author: "someone-else", body: `${buildFindingMarker({ fp: "a".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): z` });
  assert.equal(countUnresolvedGateAuthoredThreads([foreign], GATE_LOGIN), 0);
});

test("#1585: login=null is the marker-only fail-closed proxy (a foreign quote over-counts, never under-counts)", () => {
  const foreignQuote = thread({ author: "someone-else", body: `${buildFindingMarker({ fp: "a".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): z` });
  // marker-only: a foreign-authored thread carrying a marker still counts
  // (fail-closed toward blocking — safe, never under-counts a real gate thread).
  assert.equal(countUnresolvedGateAuthoredThreads([foreignQuote], null), 1);
});

test("#1585: a thread without a parseable finding marker never counts", () => {
  const noMarker = thread({ body: "looks good to me" });
  assert.equal(countUnresolvedGateAuthoredThreads([noMarker], GATE_LOGIN), 0);
});

test("#1585 (c) defer-from-round-1 is permitted for nice-to-haves: a round-1 nice-to-have thread is counted (defer allowed from round 1, no fix window)", () => {
  // The counter is severity-agnostic and round-agnostic: a nice-to-have at
  // round 1 is a gate-authored thread that must be resolved (fix-close or
  // defer-close) before gate close — defer is permitted from round 1 on.
  const nthRound1 = thread({ body: `${buildFindingMarker({ fp: "b".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): z` });
  assert.equal(countUnresolvedGateAuthoredThreads([nthRound1], GATE_LOGIN), 1);
});

test("#1585: countUnresolvedGateAuthoredThreadsFromRawNodes maps raw GraphQL thread nodes (marker-only, no login round-trip)", () => {
  const marker = buildFindingMarker({ fp: "c".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  const rawNodes = [
    { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 100, body: `${marker}\n**nice-to-have** (\`naming\`): z`, author: { login: GATE_LOGIN } }] } },
    { id: "T2", isResolved: true, comments: { nodes: [{ databaseId: 101, body: `${marker}\n**nice-to-have** (\`naming\`): w`, author: { login: GATE_LOGIN } }] } },
    { id: "T3", isResolved: false, comments: { nodes: [{ databaseId: 102, body: "no marker here", author: { login: GATE_LOGIN } }] } },
  ];
  // T1 unresolved + marker => counted; T2 resolved => not counted; T3 no marker => not counted.
  assert.equal(countUnresolvedGateAuthoredThreadsFromRawNodes(rawNodes), 1);
});

test("#1585: countUnresolvedGateAuthoredThreads throws (fail-closed) on a non-array threads input", () => {
  assert.throws(() => countUnresolvedGateAuthoredThreads(null, GATE_LOGIN), /threads must be an array/);
  assert.throws(() => countUnresolvedGateAuthoredThreads(undefined, GATE_LOGIN), /threads must be an array/);
});

test("#1585: an empty-string login falls back to the marker-only fail-closed proxy (never fail-open)", () => {
  const marker = buildFindingMarker({ fp: "d".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  const thread = { author: "someone-else", body: `${marker}\n**nice-to-have** (\`naming\`): z`, isResolved: false };
  // "" must behave like null (marker-only: over-counts a foreign quote, blocks safely).
  assert.equal(countUnresolvedGateAuthoredThreads([thread], ""), 1);
  assert.equal(countUnresolvedGateAuthoredThreads([thread], null), 1);
});

// #2381: countUnresolvedGateAuthoredThreadsBySeverity — same predicate,
// split into "question", "nit", and "other" (high/medium/low) buckets for
// ready-for-review.mjs's per-reason refusal text.
test("#2381: countUnresolvedGateAuthoredThreadsBySeverity splits question from every other severity, and the total always matches countUnresolvedGateAuthoredThreads", () => {
  const question = thread({ body: `${buildFindingMarker({ fp: "e".repeat(16), severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why?` });
  const high = thread({ body: `${buildFindingMarker({ fp: "f".repeat(16), severity: "must-fix", angle: "sec", round: 1 })}\n**must-fix** (\`sec\`): x` });
  const resolvedQuestion = thread({ body: `${buildFindingMarker({ fp: "1".repeat(16), severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): resolved already`, isResolved: true });
  const threads = [question, high, resolvedQuestion];
  const breakdown = countUnresolvedGateAuthoredThreadsBySeverity(threads, GATE_LOGIN);
  assert.deepEqual(breakdown, { total: 2, question: 1, nit: 0, other: 1 });
  assert.equal(breakdown.total, countUnresolvedGateAuthoredThreads(threads, GATE_LOGIN));
});

// Copilot review (PR 2402): a nit must split out of "other" into its OWN
// bucket — a nit is never a fixer target (NON_DEFECT_SEVERITIES,
// gate-fanin.mjs), unlike high/medium/low, so lumping it into "other" told
// operators to use a remedy (fixer fix-close) that cannot clear it.
test("#2381: countUnresolvedGateAuthoredThreadsBySeverity splits nit into its own bucket, separate from question and other defect severities", () => {
  const nit = thread({ body: `${buildFindingMarker({ fp: "9".repeat(16), severity: "nit", angle: "style", round: 1 })}\n**nit** (\`style\`): x` });
  const low = thread({ body: `${buildFindingMarker({ fp: "8".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): y` });
  const threads = [nit, low];
  const breakdown = countUnresolvedGateAuthoredThreadsBySeverity(threads, GATE_LOGIN);
  assert.deepEqual(breakdown, { total: 2, question: 0, nit: 1, other: 1 });
  assert.equal(breakdown.total, countUnresolvedGateAuthoredThreads(threads, GATE_LOGIN));
});

test("#2381: countUnresolvedGateAuthoredThreadsBySeverity throws (fail-closed) on a non-array threads input", () => {
  assert.throws(() => countUnresolvedGateAuthoredThreadsBySeverity(null, GATE_LOGIN), /threads must be an array/);
});

// ---------------------------------------------------------------------------
// ADR 0088: findJudgeDispositionForFingerprint — tier 2 (prior local ledger)
// disagreement resolution
// ---------------------------------------------------------------------------

const JDF_REPO = "owner/repo";
const JDF_PR = 42;
const JDF_GATE = "draft_gate";
const JDF_SUMMARY = "why this approach?";
const JDF_FP = fingerprintFinding({ summary: JDF_SUMMARY });

async function withLocalLedgerFiles(ledgers, fn) {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gate-finding-surface-ledgers-"));
  try {
    const dir = path.join(tmpRoot, "gate-findings", JDF_REPO.replace("/", "-"), `pr-${JDF_PR}`);
    await mkdir(dir, { recursive: true });
    for (const [filename, content] of Object.entries(ledgers)) {
      await writeFile(path.join(dir, filename), JSON.stringify(content), "utf8");
    }
    return await fn(tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function jdfLedger({ repo = JDF_REPO, pr = JDF_PR, gate = JDF_GATE, verdict = "findings_present", loggedAt, disposition, rationale }) {
  return {
    repo,
    pr,
    gate,
    verdict,
    loggedAt,
    findings: [{ severity: "question", angle: "scope", summary: JDF_SUMMARY, judgeDisposition: disposition, judgeRationale: rationale }],
  };
}

test("#2381: findJudgeDispositionForFingerprint picks the disposition from the ledger with the GREATEST loggedAt when two prior ledgers disagree", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headA.json`]: jdfLedger({ loggedAt: "2026-09-01T00:00:00.000Z", disposition: "reject", rationale: "old reasoning" }),
      [`${JDF_GATE}-headB.json`]: jdfLedger({ loggedAt: "2026-09-10T00:00:00.000Z", disposition: "act", rationale: "new reasoning" }),
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      assert.deepEqual(result, { disposition: "act", rationale: "new reasoning" });
    },
  );
});

// Mirrors the test above with the NEWER ledger in headA.json (lexically
// first) and the OLDER one in headB.json (lexically last) — the opposite
// directory-order pairing. The original test's lexical order coincides with
// "last readdir match wins"; this one's coincides with "first readdir match
// wins". Together the two pin down newest-loggedAt selection regardless of
// directory order, since only the real (loggedAt-based) implementation
// passes both.
test("#2381: findJudgeDispositionForFingerprint picks the GREATEST loggedAt regardless of directory order (mirrored fixture)", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headA.json`]: jdfLedger({ loggedAt: "2026-09-10T00:00:00.000Z", disposition: "act", rationale: "new reasoning" }),
      [`${JDF_GATE}-headB.json`]: jdfLedger({ loggedAt: "2026-09-01T00:00:00.000Z", disposition: "reject", rationale: "old reasoning" }),
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headA", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      assert.deepEqual(result, { disposition: "act", rationale: "new reasoning" });
    },
  );
});

test("#2381: findJudgeDispositionForFingerprint ignores a ledger whose own recorded repo/pr/gate does not match the inputs", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headA.json`]: jdfLedger({ pr: 999, loggedAt: "2026-09-10T00:00:00.000Z", disposition: "act", rationale: "foreign PR" }),
      [`${JDF_GATE}-headB.json`]: jdfLedger({ loggedAt: "2026-09-01T00:00:00.000Z", disposition: "reject", rationale: "this PR's own reasoning" }),
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      assert.deepEqual(result, { disposition: "reject", rationale: "this PR's own reasoning" });
    },
  );
});

// Copilot review (PR 2402): the SAME carry-forward eligibility gate
// write-gate-context.mjs applies to a prior ledger (buildCarryForwardPlan,
// resolve-angle-carry-forward.mjs — only `clean`/`findings_present` is a
// genuinely CLOSED round) must apply here too, or a `blocked`/partial local
// ledger can surface a stale `judgeDisposition: reject` for a round that
// never produced a settled verdict.
test("#2381: findJudgeDispositionForFingerprint ignores a ledger whose own verdict is not clean/findings_present (blocked, or missing)", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headA.json`]: jdfLedger({ verdict: "blocked", loggedAt: "2026-09-10T00:00:00.000Z", disposition: "reject", rationale: "stale, unsettled round" }),
      // Explicit undefined would just re-trigger jdfLedger's own default
      // parameter (verdict = "findings_present") — override the RETURNED
      // object's field instead so JSON.stringify genuinely drops it,
      // exercising the "missing verdict key entirely" case.
      [`${JDF_GATE}-headB.json`]: { ...jdfLedger({ loggedAt: "2026-09-11T00:00:00.000Z", disposition: "reject", rationale: "missing verdict field" }), verdict: undefined },
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      assert.equal(result, null, "neither a blocked nor a verdict-less ledger is carry-eligible; both must be skipped, not surfaced");
    },
  );
});

// #2381: an undecidable tier-2 disagreement returns a DISTINCT `{ ambiguous:
// true }` shape, never a plain `null` — resolveJudgeRejection (close-gate-findings.mjs)
// must be able to tell "no prior ledger matched at all" (a genuine cache
// miss, safe to fall through to tier 3) apart from "prior ledgers disagree
// with no decidable winner" (must STOP, never fall through to a possibly
// stale tier-3 rendered suffix).
test("#2381: findJudgeDispositionForFingerprint returns { ambiguous: true } (not null) when TIED loggedAt candidates disagree", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headA.json`]: jdfLedger({ loggedAt: "2026-09-10T00:00:00.000Z", disposition: "reject", rationale: "tied A" }),
      [`${JDF_GATE}-headB.json`]: jdfLedger({ loggedAt: "2026-09-10T00:00:00.000Z", disposition: "act", rationale: "tied B" }),
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      assert.deepEqual(result, { ambiguous: true });
    },
  );
});

test("#2381: findJudgeDispositionForFingerprint returns { ambiguous: true } (not null) when a MISSING loggedAt makes disagreeing candidates undecidable", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headA.json`]: jdfLedger({ loggedAt: undefined, disposition: "reject", rationale: "no timestamp" }),
      [`${JDF_GATE}-headB.json`]: jdfLedger({ loggedAt: "2026-09-10T00:00:00.000Z", disposition: "act", rationale: "timestamped" }),
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      assert.deepEqual(result, { ambiguous: true });
    },
  );
});

// listLocalFindingsLogFiles sorts its filename list (rather than trusting
// readdir order) so the ALL-AGREE citation path (matches[0].rationale, used
// when at least one candidate lacks a usable loggedAt) always cites the same
// ledger's rationale regardless of filesystem directory order. Filenames are
// written here in non-lexical order to show the result tracks sorted order,
// not write/insertion order.
test("#2381: findJudgeDispositionForFingerprint cites a deterministic (sorted-filename) rationale when every agreeing candidate lacks a usable loggedAt", async () => {
  await withLocalLedgerFiles(
    {
      [`${JDF_GATE}-headC.json`]: jdfLedger({ loggedAt: undefined, disposition: "reject", rationale: "from headC" }),
      [`${JDF_GATE}-headA.json`]: jdfLedger({ loggedAt: undefined, disposition: "reject", rationale: "from headA" }),
      [`${JDF_GATE}-headB.json`]: jdfLedger({ loggedAt: undefined, disposition: "reject", rationale: "from headB" }),
    },
    async (tmpRoot) => {
      const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
      // Alphabetically-first filename (headA) wins the citation, not
      // whatever order readdir happened to return the three files in.
      assert.deepEqual(result, { disposition: "reject", rationale: "from headA" });
    },
  );
});

// Copilot review (PR 2402): a non-ENOENT readdir failure on the ledger
// DIRECTORY (permissions, I/O error, the path being a file, ...) must fail
// closed for the judge-disposition lookup — treating it as an empty history
// would let a reject-close fall through to tier 3's possibly-stale rendered
// suffix without knowing whether an unreadable prior ledger disagreed. Only
// an ABSENT directory (ENOENT, the fresh-worktree/no-prior-round case) is a
// genuine cache miss.
async function withUnreadableLedgerDir(fn) {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gate-finding-surface-unreadable-"));
  try {
    const parentDir = path.join(tmpRoot, "gate-findings", JDF_REPO.replace("/", "-"));
    await mkdir(parentDir, { recursive: true });
    // A FILE where the ledger directory should be: readdir() on it throws
    // ENOTDIR, a non-ENOENT failure distinct from "directory absent" and
    // reproducible cross-platform (no chmod/permission dependence).
    await writeFile(path.join(parentDir, `pr-${JDF_PR}`), "not a directory", "utf8");
    return await fn(tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

test("#2381: findJudgeDispositionForFingerprint fails closed ({ ambiguous: true }) on a non-ENOENT ledger-directory read failure (ENOTDIR)", async () => {
  await withUnreadableLedgerDir(async (tmpRoot) => {
    const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
    assert.deepEqual(result, { ambiguous: true });
  });
});

test("#2381: findJudgeDispositionForFingerprint still treats an ABSENT ledger directory (ENOENT) as a cache miss (null)", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "gate-finding-surface-absent-"));
  try {
    const result = await findJudgeDispositionForFingerprint({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", tmpRoot, repoRoot: tmpRoot, fp: JDF_FP });
    assert.equal(result, null);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

// The round-number fallback count (resolveGateRound → countLocalFindingsLogFiles)
// shares listLocalFindingsLogFiles with the judge-disposition lookup above,
// but has no fail-closed obligation: it must keep working (not throw) on the
// exact same non-ENOENT failure that the judge lookup fails closed on.
test("#2381: resolveGateRound does not throw on a non-ENOENT ledger-directory read failure (ENOTDIR)", async () => {
  await withUnreadableLedgerDir(async (tmpRoot) => {
    const round = await resolveGateRound({ repo: JDF_REPO, pr: JDF_PR, gate: JDF_GATE, headSha: "headB", reviews: [], issueComments: [], tmpRoot, repoRoot: tmpRoot });
    assert.equal(round, 1);
  });
});

// ---------------------------------------------------------------------------
// ADR 0088: parseRenderedJudgeDisposition tier 3 — only the exact
// renderFindingLine suffix shape counts
// ---------------------------------------------------------------------------

test("#2381: parseRenderedJudgeDisposition parses the exact renderFindingLine suffix shape", () => {
  const body = "**question** (`scope`): why this approach? — judge: reject";
  assert.equal(parseRenderedJudgeDisposition(body), "reject");
});

test("#2381: parseRenderedJudgeDisposition does NOT parse a quoted 'judge: reject' phrase with looser spacing than the exact render suffix", () => {
  // An LLM-authored summary that discusses "judge: reject" in its own prose,
  // with double spaces around the separators (never what renderFindingLine
  // itself emits — always exactly one space on each side) — must not be
  // misread as a genuine rendered disposition suffix.
  const body = "**question** (`scope`): the review notes say the panel's rule is  —  judge:  reject";
  assert.equal(parseRenderedJudgeDisposition(body), null);
});

test("#1585: countUnresolvedGateAuthoredThreadsFromRawNodes throws (fail-closed) on a non-array rawNodes", () => {
  assert.throws(() => countUnresolvedGateAuthoredThreadsFromRawNodes(null), /rawNodes must be an array/);
  assert.throws(() => countUnresolvedGateAuthoredThreadsFromRawNodes("not-an-array"), /rawNodes must be an array/);
});

// #1731 guard-refusal: the gate-review write surfaces must refuse a raw
// issue/PR id in the verdict body or any inline finding comment BEFORE any gh
// I/O. These pin the guard wiring (createGateReview 661/663, updateGateReview
// 684) so a future drop/mis-wire ships red.
test("#1731: createGateReview refuses a verdict body containing a raw issue/PR id (guard fires before gh)", async () => {
  const runChild = async () => { throw new Error("guard must refuse before any gh I/O"); };
  await assert.rejects(
    () => createGateReview(
      { repo: "o/r", pr: 9, headSha: HEAD_SHA, body: "clean verdict for #1734", comments: [] },
      { ghCommand: "gh", runChild },
    ),
    /comment-id-guard refused to emit gate verdict comment body.*#1734/,
  );
});

test("#1731: createGateReview refuses inline finding comments containing a raw issue/PR id", async () => {
  const runChild = async () => { throw new Error("guard must refuse before any gh I/O"); };
  await assert.rejects(
    () => createGateReview(
      { repo: "o/r", pr: 9, headSha: HEAD_SHA, body: "clean body", comments: [{ path: "a.mjs", line: 1, body: "references #1731" }] },
      { ghCommand: "gh", runChild },
    ),
    /comment-id-guard refused to emit gate review inline finding comment.*#1731/,
  );
});

test("#1731: updateGateReview refuses a verdict body containing a raw issue/PR id (guard fires before gh)", async () => {
  const runChild = async () => { throw new Error("guard must refuse before any gh I/O"); };
  await assert.rejects(
    () => updateGateReview(
      { repo: "o/r", pr: 9, reviewId: 5, body: "see #1731 for the diff" },
      { ghCommand: "gh", runChild },
    ),
    /comment-id-guard refused to emit gate verdict comment body.*#1731/,
  );
});

// ---------------------------------------------------------------------------
// Deferral comment target: deferred findings go as ONE batched comment on the
// linked spec issue or the PR, per the configured tracker. No issue is created.
// ---------------------------------------------------------------------------

function deferralEntries() {
  return [
    { fingerprint: "1111111111111111", severity: "low", angle: "naming", summary: "casing nit" },
    { fingerprint: "2222222222222222", severity: "medium", angle: "perf", summary: "stale cache" },
  ];
}

// A fake `gh`: answers the closing-reference lookup and the target's comment
// list; records every call; throws on anything else (an issue create
// included). `closing` is a list of closing refs ({ number, repository? }).
function fakeGh({ closing = [], listedComments = [] } = {}) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ closingIssuesReferences: closing }), stderr: "" };
    }
    if (args[0] === "api" && args.some((arg) => /\/issues\/\d+\/comments/.test(arg))) {
      return { code: 0, stdout: JSON.stringify([listedComments.map((body) => ({ body }))]), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return { code: 0, stdout: `https://github.com/o/r/issues/${args[2]}#issuecomment-1\n`, stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

test("buildDeferredFindingsComment: every entry listed, the PR linked, no issue-create wording", () => {
  const body = buildDeferredFindingsComment({ repo: "o/r", pr: 42, entries: deferralEntries() });
  assert.equal(body.split("\n")[0], "<!-- dev-loops:deferred-summary -->");
  assert.match(body, /https:\/\/github\.com\/o\/r\/pull\/42/);
  assert.match(body, /^- `1111111111111111` \*\*low\*\* \(`naming`\): casing nit$/m);
  assert.match(body, /^- `2222222222222222` \*\*medium\*\* \(`perf`\): stale cache$/m);
  assert.doesNotThrow(() => guardCommentBodyNoIssuePrIds(body, { ref: "test deferral comment" }));
});

test("resolveDeferralCommentTarget: github tracker + exactly one same-repo closing reference -> that issue", async () => {
  const { run, calls } = fakeGh({ closing: [{ number: 77, repository: { name: "r", owner: { login: "o" } } }] });
  assert.equal(await resolveDeferralCommentTarget({ repo: "o/r", pr: 42, trackerProvider: "github" }, { run }), 77);
  assert.deepEqual(calls[0], ["pr", "view", "42", "--repo", "o/r", "--json", "closingIssuesReferences"]);
});

test("resolveDeferralCommentTarget: no closing reference, more than one, a cross-repo one, or one without repository data -> the PR", async () => {
  for (const closing of [[], [{ number: 77 }], [{ number: 77 }, { number: 78 }], [{ number: 77, repository: { name: "other", owner: { login: "o" } } }]]) {
    const { run } = fakeGh({ closing });
    assert.equal(await resolveDeferralCommentTarget({ repo: "o/r", pr: 42, trackerProvider: "github" }, { run }), 42, JSON.stringify(closing));
  }
});

test("resolveDeferralCommentTarget: a tracker other than github -> the PR, with no gh call at all", async () => {
  const { run, calls } = fakeGh({ closing: [{ number: 77, repository: { name: "r", owner: { login: "o" } } }] });
  assert.equal(await resolveDeferralCommentTarget({ repo: "o/r", pr: 42, trackerProvider: "jira" }, { run }), 42);
  assert.equal(calls.length, 0);
});

test("fetchListedFingerprints: reads only leading-bullet fingerprints from the target's comments", async () => {
  const { run } = fakeGh({
    listedComments: [
      "<!-- dev-loops:deferred-summary -->\nGate findings deferred:\n\n- `2222222222222222` **low** (`perf`): stale cache",
      "See commit `0123456789abcdef` for context — not a listed fingerprint.",
    ],
  });
  const result = await fetchListedFingerprints({ repo: "o/r", target: 101 }, { run });
  assert.deepEqual([...result], ["2222222222222222"]);
});

test("fetchListedFingerprints: a bullet in a comment without the deferral marker is not counted", async () => {
  const { run } = fakeGh({
    listedComments: ["Quoting the last deferral list:\n\n- `3333333333333333` **low** (`perf`): stale cache"],
  });
  const result = await fetchListedFingerprints({ repo: "o/r", target: 101 }, { run });
  assert.equal(result.size, 0);
});

test("commentDeferredFindings: one closing reference -> ONE batched comment on that issue, never an issue create", async () => {
  const { run, calls } = fakeGh({ closing: [{ number: 77, repository: { name: "r", owner: { login: "o" } } }] });
  const commentCalls = [];
  const commentIssue = async (opts) => {
    commentCalls.push(opts);
    return { ok: true, repo: opts.repo, issue: opts.issue, commentUrl: "https://github.com/o/r/issues/77#issuecomment-1" };
  };
  const result = await commentDeferredFindings({ repo: "o/r", pr: 42, entries: deferralEntries() }, { run, commentIssue });
  assert.equal(result.issueNumber, 77);
  assert.deepEqual([...result.appendedFingerprints], ["1111111111111111", "2222222222222222"]);
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issue, 77);
  assert.equal(calls.some((args) => args.includes("create")), false);
});

test("commentDeferredFindings: no closing reference -> the comment goes to the PR", async () => {
  const { run, calls } = fakeGh();
  const result = await commentDeferredFindings({ repo: "o/r", pr: 42, entries: deferralEntries() }, { run });
  assert.equal(result.issueNumber, 42);
  assert.deepEqual(calls.at(-1).slice(0, 4), ["issue", "comment", "42", "--repo"]);
});

test("commentDeferredFindings: a fingerprint the target already lists is not appended again; nothing new posts nothing", async () => {
  const { run, calls } = fakeGh({ closing: [{ number: 77, repository: { name: "r", owner: { login: "o" } } }], listedComments: ["<!-- dev-loops:deferred-summary -->\n- `1111111111111111` **low** (`naming`): casing nit"] });
  const first = await commentDeferredFindings({ repo: "o/r", pr: 42, entries: deferralEntries() }, { run });
  assert.deepEqual([...first.appendedFingerprints], ["2222222222222222"]);
  const bodyArg = calls.at(-1)[calls.at(-1).indexOf("--body") + 1];
  assert.doesNotMatch(bodyArg, /1111111111111111/);
  assert.match(bodyArg, /2222222222222222/);

  const retry = fakeGh({ closing: [{ number: 77, repository: { name: "r", owner: { login: "o" } } }], listedComments: ["<!-- dev-loops:deferred-summary -->\n- `1111111111111111` x\n- `2222222222222222` y"] });
  const second = await commentDeferredFindings({ repo: "o/r", pr: 42, entries: deferralEntries() }, { run: retry.run });
  assert.equal(second.issueNumber, 77);
  assert.equal(second.appendedFingerprints.size, 0);
  assert.equal(retry.calls.some((args) => args[0] === "issue"), false, "a pure retry posts no comment");
});

test("commentDeferredFindings rejects an empty entries array", async () => {
  await assert.rejects(
    () => commentDeferredFindings({ repo: "o/r", pr: 42, entries: [] }, {}),
    /entries must be a non-empty array/,
  );
});

// A finding's untrusted summary/angle carrying a bare `#<digits>` (single or
// repeated signs) must pass the REAL guard inside the real commentIssue: the
// rendered body strips the sign instead of entity-encoding it (an entity
// decodes right back to a bare id under the guard's own scan).
test("commentDeferredFindings: a bare #<digits> in summary or angle is neutralized through the REAL commentIssue guard", async () => {
  const entries = [
    { fingerprint: "5555555555555555", severity: "medium", angle: "regression-of-#321", summary: "duplicates #123456 behavior" },
    { fingerprint: "8888888888888888", severity: "medium", angle: "run-of-###55", summary: "duplicate of ##987 and also ###12" },
  ];
  const { run, calls } = fakeGh();
  await commentDeferredFindings({ repo: "o/r", pr: 7, entries }, { run });
  const bodyArg = calls.at(-1)[calls.at(-1).indexOf("--body") + 1];
  assert.doesNotMatch(bodyArg, /#\d/);
  assert.doesNotMatch(bodyArg, /&#35;/);
  assert.match(bodyArg, /duplicates 123456 behavior/);
  assert.match(bodyArg, /regression-of-321/);
  assert.match(bodyArg, /duplicate of 987 and also 12/);
  assert.match(bodyArg, /run-of-55/);
});
