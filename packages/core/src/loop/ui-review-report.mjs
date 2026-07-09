/**
 * Report for the ui_review route (Stage 4, terminal reporting stage).
 *
 * Pure decision layer. Maps the Stage-3 ranked findings into:
 *   - a pending draft-review input (consumed by buildDraftReviewPayload — the
 *     shared poster's contract: {path,line,body,side:RIGHT} inline comments, no
 *     `event`), with anchorable findings inlined on their exact diff anchors and
 *     non-anchorable findings retained in the review body,
 *   - a severity->event policy (a confirmed user-facing server error maps to
 *     REQUEST_CHANGES ONLY when the caller authorizes submit; otherwise the
 *     review stays pending with the severity recorded — never auto-submit),
 *   - a self-contained, CSP-safe HTML artifact string (ranked findings + inline
 *     screenshot evidence), and
 *   - a harness-aware hosting directive (Claude Code -> a publishable Artifacts
 *     directive for the orchestrator; any other harness -> fail closed with a
 *     stated reason and a follow-up marker — no hosted link this stage).
 *
 * All IO (reading the diagnose output + the screenshot bytes, writing the HTML,
 * invoking the poster) lives in the thin CLI. This module reads only its inputs.
 */

import { isClaudeHarness } from "./run-context.mjs";
import { sanitizeCopilotSummonTokens } from "../github/copilot-helpers.mjs";

/** Follow-up marker for the descoped GitHub-native hosting fallback. */
export const HOSTING_FOLLOWUP = "#1285";

/** Findings past this cap are dropped from the artifact and the drop is logged. */
export const ARTIFACT_MAX_FINDINGS = 100;

/** A screenshot whose data URI exceeds this is omitted from the artifact (logged). */
export const ARTIFACT_MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

/** The drive kinds that count as a confirmed user-facing server error. Both are
 * must-fix in the drive's classification: an error response the app returned and
 * a server-log exception the request raised. */
const SERVER_ERROR_KINDS = new Set(["error-response", "server-log-exception"]);

function normalizeSha(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A confirmed user-facing server error: a must-fix error-response / server-log
 * exception. This is the single-source predicate the severity policy keys off. */
function isBlockingFinding(finding) {
  return finding?.severity === "must-fix" && SERVER_ERROR_KINDS.has(finding?.kind);
}

/** Render a finding's reproduced exception as one line, falling back to its
 * message when the drive captured no parseable exception. */
function reproducedLine(finding) {
  const type = finding?.exception?.type;
  const message = finding?.exception?.message;
  if (typeof type === "string" && type.length > 0) {
    return message ? `${type}: ${message}` : type;
  }
  return typeof finding?.message === "string" && finding.message.length > 0
    ? finding.message
    : "Captured failure (no exception detail)";
}

/** A short, kind-specific fix direction. Deliberately generic — the goal is to
 * point the author at the changed line, not to prescribe the patch. */
function fixDirection(kind) {
  switch (kind) {
    case "error-response":
      return "Fix the request path so it no longer returns an error response.";
    case "server-log-exception":
    case "page-error":
      return "Guard the throwing code path; the exception above was raised here.";
    case "request-failed":
      return "The request from this change failed at the wire; verify the endpoint/URL.";
    default:
      return "Address the reproduced failure on this changed line.";
  }
}

/** Inline-comment body for an anchorable finding: reproduced exception + fix direction. */
export function formatInlineBody(finding) {
  return `Reproduced in the running app: ${reproducedLine(finding)}\nFix direction: ${fixDirection(finding?.kind)}`;
}

/**
 * Severity->event policy (pure). A confirmed user-facing server error maps to
 * REQUEST_CHANGES ONLY when submit is authorized; otherwise the review stays
 * pending (event null) with the severity recorded. Never auto-submits.
 *
 * @param {{findings?: object[], submitAuthorized?: boolean}} [input]
 * @returns {{event: "REQUEST_CHANGES"|null, blocking: boolean, submitAuthorized: boolean, severity: string}}
 */
export function severityToEvent({ findings = [], submitAuthorized = false } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const blocking = list.some(isBlockingFinding);
  const severity = blocking
    ? "must-fix"
    : (list.some((f) => f?.severity === "must-fix") ? "must-fix" : (list.length > 0 ? "note" : "none"));
  return {
    event: submitAuthorized && blocking ? "REQUEST_CHANGES" : null,
    blocking,
    submitAuthorized: Boolean(submitAuthorized),
    severity,
  };
}

/**
 * Harness-aware hosting directive (pure). Claude Code -> a publishable Artifacts
 * directive for the orchestrator to host (this module never calls an agent tool
 * itself). Any other harness / Artifacts unavailable -> fail closed with a
 * stated reason and the follow-up marker. The self-contained HTML is produced
 * regardless; only this link step is harness-aware.
 *
 * @param {{htmlPath: string, env?: Record<string,string|undefined>}} input
 */
export function decideHosting({ htmlPath, env = process.env } = {}) {
  if (isClaudeHarness(env)) {
    return { hosting: "claude-artifact", publishable: true, htmlPath: htmlPath ?? null };
  }
  return {
    hosting: "unavailable",
    publishable: false,
    htmlPath: htmlPath ?? null,
    reason: "no hosted-artifact publisher on this harness; GitHub-native fallback is deferred",
    followup: HOSTING_FOLLOWUP,
  };
}

/** One review-body line describing where the screenshot artifact lives. Links a
 * real hosted URL when one exists; otherwise states the harness-aware status so
 * the review never blocks on hosting. */
function artifactBodyLine({ hosting, hostedUrl }) {
  if (typeof hostedUrl === "string" && hostedUrl.length > 0) {
    return `Screenshot artifact: ${hostedUrl}`;
  }
  if (hosting?.hosting === "claude-artifact") {
    return "Screenshot artifact prepared for Claude Artifacts hosting (published by the harness; see run output).";
  }
  const reason = hosting?.reason ? ` (${hosting.reason})` : "";
  const followup = hosting?.followup ? ` [follow-up ${hosting.followup}]` : "";
  return `Screenshot artifact is unhosted this stage${reason}${followup}. Findings are included below.`;
}

/** Body line for a non-anchorable finding: it is kept, never dropped. */
function nonAnchorableBodyMessage(finding) {
  const reason = finding?.nonAnchorableReason ? ` — not inlined: ${finding.nonAnchorableReason}` : "";
  return `${reproducedLine(finding)}${reason}`;
}

/**
 * Map Stage-3 findings + hosting status into the merged-result input that the
 * shared buildDraftReviewPayload consumes. Anchorable findings become inline
 * comments on their exact {path,line,side:RIGHT} anchors; the artifact line and
 * every non-anchorable finding are retained as summary (body) findings.
 *
 * @param {{findings?: object[], headSha?: string|null, hosting?: object, hostedUrl?: string}} input
 */
export function buildReviewInput({ findings = [], headSha = null, hosting = null, hostedUrl = null } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const anchorable = list.filter((f) => f?.anchorable && f?.anchor);
  const nonAnchorable = list.filter((f) => !(f?.anchorable && f?.anchor));

  // Untrusted target-app text (exception type/message, log lines, nonAnchorableReason)
  // flows into these bodies. Sanitize copilot-summon tokens before they enter the
  // payload buildDraftReviewPayload posts verbatim — every sibling posting path does.
  const inlineComments = anchorable.map((f) => ({
    path: f.anchor.path,
    line: f.anchor.line,
    message: sanitizeCopilotSummonTokens(formatInlineBody(f)),
    severity: f.severity ?? "note",
  }));

  const summaryFindings = [
    { message: artifactBodyLine({ hosting, hostedUrl }), severity: "note" },
    ...nonAnchorable.map((f) => ({ message: sanitizeCopilotSummonTokens(nonAnchorableBodyMessage(f)), severity: f.severity ?? "note" })),
  ];

  const blocking = list.some(isBlockingFinding);
  const verdict = list.length === 0 ? "APPROVE" : (blocking ? "REQUEST_CHANGES" : "COMMENT");

  return {
    headSha: normalizeSha(headSha),
    verdict,
    inlineComments,
    summaryFindings,
    totalFindings: list.length,
    runsMerged: 0,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const ARTIFACT_STYLE = [
  "body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1a1a1a;background:#fafafa}",
  "h1{font-size:20px;margin:0 0 4px}",
  ".meta{color:#666;margin-bottom:20px}",
  ".finding{border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin:0 0 12px;background:#fff}",
  ".finding.blocking{border-left:4px solid #c0392b}",
  ".finding.note{border-left:4px solid #999}",
  ".sev{font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em}",
  ".anchor{color:#2c3e50;font-family:ui-monospace,monospace;font-size:12px}",
  ".exc{font-family:ui-monospace,monospace;white-space:pre-wrap;margin:6px 0}",
  ".reason{color:#c0392b;font-size:12px}",
  "img{max-width:100%;border:1px solid #ddd;border-radius:4px;margin-top:12px}",
].join("");

const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Build the self-contained, CSP-safe HTML artifact (ranked findings + inline
 * screenshot evidence). Fully inlined: no external scripts/styles/fonts/images.
 * Bounded caps (findings past ARTIFACT_MAX_FINDINGS, an oversized screenshot)
 * are applied here and returned in `caps` so the CLI can log them — never a
 * silent truncation.
 *
 * @param {{findings?: object[], counts?: object, pr?: object, screenshot?: {path:string,dataUri:string}|null, generatedAt?: string}} input
 * @returns {{html: string, caps: string[]}}
 */
export function buildArtifactHtml({ findings = [], counts = {}, pr = {}, screenshot = null, generatedAt } = {}) {
  const caps = [];
  const list = Array.isArray(findings) ? findings : [];

  let shown = list;
  if (list.length > ARTIFACT_MAX_FINDINGS) {
    shown = list.slice(0, ARTIFACT_MAX_FINDINGS);
    caps.push(`artifact: findings truncated to ${ARTIFACT_MAX_FINDINGS} of ${list.length} (${list.length - ARTIFACT_MAX_FINDINGS} not rendered)`);
  }

  let screenshotHtml = "";
  if (screenshot && typeof screenshot.dataUri === "string") {
    if (screenshot.dataUri.length > ARTIFACT_MAX_SCREENSHOT_BYTES) {
      caps.push(`artifact: screenshot omitted (${screenshot.dataUri.length} bytes > ${ARTIFACT_MAX_SCREENSHOT_BYTES} cap): ${screenshot.path ?? "unknown"}`);
    } else {
      screenshotHtml = `<h2>Reproduced evidence</h2><img alt="reproduced state" src="${escapeHtml(screenshot.dataUri)}" />`;
    }
  }

  const findingsHtml = shown.map((f) => {
    const blocking = isBlockingFinding(f);
    const cls = blocking ? "blocking" : "note";
    const anchor = f?.anchor
      ? `<div class="anchor">${escapeHtml(f.anchor.path)}:${escapeHtml(f.anchor.line)} (${escapeHtml(f.anchor.side)})</div>`
      : `<div class="reason">not inlined: ${escapeHtml(f?.nonAnchorableReason ?? "no anchor")}</div>`;
    return [
      `<div class="finding ${cls}">`,
      `<div class="sev">${escapeHtml(f?.severity ?? "note")} · ${escapeHtml(f?.kind ?? "finding")}</div>`,
      `<div class="exc">${escapeHtml(reproducedLine(f))}</div>`,
      anchor,
      "</div>",
    ].join("");
  }).join("");

  const total = Number.isFinite(counts?.total) ? counts.total : list.length;
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}" />`,
    "<title>UI review findings</title>",
    `<style>${ARTIFACT_STYLE}</style>`,
    "</head><body>",
    `<h1>UI review findings — PR #${escapeHtml(pr?.number ?? "?")}</h1>`,
    `<div class="meta">head ${escapeHtml(pr?.headSha ?? "?")} · ${escapeHtml(total)} finding(s) · ${escapeHtml(counts?.anchorable ?? 0)} anchorable · generated ${escapeHtml(generatedAt ?? "")}</div>`,
    findingsHtml,
    screenshotHtml,
    "</body></html>",
  ].join("");

  return { html, caps };
}
