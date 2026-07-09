import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewInput,
  severityToEvent,
  decideHosting,
  buildArtifactHtml,
  ARTIFACT_MAX_FINDINGS,
} from "@dev-loops/core/loop/ui-review-report";
import { buildDraftReviewPayload } from "@dev-loops/core/loop/reviewer-loop-state";
import { parseUiReviewReportCliArgs } from "../../scripts/loop/ui-review-report.mjs";

const HEAD_SHA = "a".repeat(40);

// A ranked findings list shaped exactly like Stage 3 (ui-review-diagnose) emits:
// two anchorable (a server-log exception + a 500 error response) and one
// non-anchorable (source file not in the diff) that must land in the body.
const FINDINGS = [
  {
    severity: "must-fix",
    kind: "server-log-exception",
    message: "NoMethodError in UsersController#show",
    exception: { type: "NoMethodError", message: "undefined method `name' for nil" },
    source: { file: "app/models/user.rb", line: 11 },
    anchor: { path: "app/models/user.rb", line: 11, side: "RIGHT" },
    anchorable: true,
    nonAnchorableReason: null,
    evidence: { flow: "users", step: "show", screenshotPath: "/out/users-show.png", statePath: "/out/users-show.json" },
  },
  {
    severity: "must-fix",
    kind: "error-response",
    message: "error response 500 at /users/1",
    exception: { type: null, message: null },
    source: { file: "app/assets/widget.js", line: 3 },
    anchor: { path: "app/assets/widget.js", line: 3, side: "RIGHT" },
    anchorable: true,
    nonAnchorableReason: null,
    evidence: { flow: "users", step: "show", screenshotPath: "/out/users-show.png", statePath: "/out/users-show.json" },
  },
  {
    severity: "must-fix",
    kind: "error-response",
    message: "error response 500 at /api/orphan",
    exception: { type: null, message: null },
    source: null,
    anchor: null,
    anchorable: false,
    nonAnchorableReason: "source file is not among the PR's changed files",
    evidence: null,
  },
];

test("buildReviewInput -> buildDraftReviewPayload: pending, head-pinned, anchored inline comments, non-anchorable in body", () => {
  const reviewInput = buildReviewInput({
    findings: FINDINGS,
    headSha: HEAD_SHA,
    hosting: { hosting: "claude-artifact", publishable: true, htmlPath: "/out/report.html" },
  });
  const payload = buildDraftReviewPayload(reviewInput);

  // Head-pinned to the exact reviewed commit.
  assert.equal(payload.commit_id, HEAD_SHA);
  // Pending/draft: never carries an event.
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "event"), false);

  // Exactly the two anchorable findings become inline comments on their anchors.
  assert.equal(payload.comments.length, 2);
  for (const c of payload.comments) {
    assert.equal(c.side, "RIGHT");
    assert.ok(c.path && c.line && c.body.length > 0);
  }
  const byPath = Object.fromEntries(payload.comments.map((c) => [c.path, c]));
  assert.equal(byPath["app/models/user.rb"].line, 11);
  assert.equal(byPath["app/assets/widget.js"].line, 3);
  // Inline comment carries the reproduced exception + a fix direction.
  assert.match(byPath["app/models/user.rb"].body, /NoMethodError/);
  assert.match(byPath["app/models/user.rb"].body, /Fix direction/i);

  // The non-anchorable finding is retained in the body (never dropped).
  assert.match(payload.body, /source file is not among the PR's changed files/);
  assert.match(payload.body, /orphan/);
});

test("severityToEvent: confirmed 500 stays PENDING unless submit is authorized", () => {
  const unauthorized = severityToEvent({ findings: FINDINGS, submitAuthorized: false });
  assert.equal(unauthorized.event, null);
  assert.equal(unauthorized.blocking, true);
  assert.equal(unauthorized.severity, "must-fix");

  const authorized = severityToEvent({ findings: FINDINGS, submitAuthorized: true });
  assert.equal(authorized.event, "REQUEST_CHANGES");
  assert.equal(authorized.blocking, true);

  // No blocking server error -> no REQUEST_CHANGES even when authorized.
  const noteOnly = severityToEvent({
    findings: [{ severity: "note", kind: "server-log-pattern-invalid", anchorable: false }],
    submitAuthorized: true,
  });
  assert.equal(noteOnly.event, null);
  assert.equal(noteOnly.blocking, false);
});

test("decideHosting: Claude harness -> publishable directive; off-Claude -> fail closed with reason + follow-up", () => {
  const onClaude = decideHosting({ htmlPath: "/out/report.html", env: { CLAUDECODE: "1" } });
  assert.equal(onClaude.hosting, "claude-artifact");
  assert.equal(onClaude.publishable, true);
  assert.equal(onClaude.htmlPath, "/out/report.html");

  const offClaude = decideHosting({ htmlPath: "/out/report.html", env: {} });
  assert.equal(offClaude.hosting, "unavailable");
  assert.equal(offClaude.publishable, false);
  assert.ok(typeof offClaude.reason === "string" && offClaude.reason.length > 0);
  assert.equal(offClaude.followup, "#1285");
});

test("buildArtifactHtml: self-contained + CSP-safe, inlines screenshot, logs caps", () => {
  const screenshot = { path: "/out/users-show.png", dataUri: "data:image/png;base64,AAAA" };
  const { html, caps } = buildArtifactHtml({
    findings: FINDINGS,
    counts: { total: 3, anchorable: 2, nonAnchorable: 1 },
    pr: { number: 42, headSha: HEAD_SHA },
    screenshot,
    generatedAt: "2026-07-09T00:00:00.000Z",
  });

  assert.match(html, /Content-Security-Policy/);
  // Fully inlined: no remote resources.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.match(html, /NoMethodError/);
  assert.match(html, /source file is not among the PR/);
  assert.equal(caps.length, 0);

  // Findings past the cap are truncated and the truncation is logged.
  const many = Array.from({ length: ARTIFACT_MAX_FINDINGS + 5 }, (_unused, i) => ({
    severity: "note",
    kind: "page-error",
    message: `finding ${i}`,
    exception: { type: null, message: null },
    source: null,
    anchor: null,
    anchorable: false,
    nonAnchorableReason: "note",
    evidence: null,
  }));
  const capped = buildArtifactHtml({
    findings: many,
    counts: { total: many.length, anchorable: 0, nonAnchorable: many.length },
    pr: { number: 42, headSha: HEAD_SHA },
    screenshot: null,
    generatedAt: "2026-07-09T00:00:00.000Z",
  });
  assert.ok(capped.caps.some((c) => /truncated/i.test(c)));
});

test("CLI: parses required args, submit-authorized and dry-run default off", () => {
  const opts = parseUiReviewReportCliArgs(["--pr", "42", "--diagnose-result", "d.json", "--html-output", "o.html"]);
  assert.equal(opts.pr, 42);
  assert.equal(opts.diagnoseResult, "d.json");
  assert.equal(opts.htmlOutput, "o.html");
  assert.equal(opts.submitAuthorized, false);
  assert.equal(opts.dryRun, false);
  assert.throws(() => parseUiReviewReportCliArgs(["--diagnose-result", "d.json", "--html-output", "o.html"]), /Missing required --pr/);
});

test("buildArtifactHtml: oversized screenshot is omitted and logged, never silently dropped", () => {
  const big = "data:image/png;base64," + "A".repeat(10 * 1024 * 1024);
  const { html, caps } = buildArtifactHtml({
    findings: FINDINGS,
    counts: { total: 3, anchorable: 2, nonAnchorable: 1 },
    pr: { number: 42, headSha: HEAD_SHA },
    screenshot: { path: "/out/big.png", dataUri: big },
    generatedAt: "2026-07-09T00:00:00.000Z",
  });
  assert.doesNotMatch(html, /AAAA/);
  assert.ok(caps.some((c) => /screenshot/i.test(c) && /omitted/i.test(c)));
});
