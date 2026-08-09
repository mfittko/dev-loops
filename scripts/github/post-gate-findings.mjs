#!/usr/bin/env node
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText, sanitizeCopilotSummonTokens } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGatePostFindingsComments } from "@dev-loops/core/config";
// Severity vocabulary and its most-urgent-first ordering are owned by gate-fanin.
import { SEVERITY_ORDER, VALID_SEVERITIES, deriveDisposition, hasLocatableShape, isDefaultDeferrableSeverity, normalizeSeverity } from "@dev-loops/core/loop/gate-fanin";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveFindingsInput } from "./_findings-input.mjs";

const USAGE = `Usage: post-gate-findings.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> (--findings <json> | --findings-file <path>)
Post (or idempotently update) a visible, marker-tagged PR issue comment that lists the
consolidated gate fan-out findings, grouped by severity. The comment is idempotent
per gate: there is exactly one comment per gate, updated in place on each run
(the reviewed head is shown in the body) instead of duplicating it.

The disposition ledger (write-gate-findings-log.mjs) is the durable source of truth and is
written regardless of this comment; this comment is an opt-in SECOND surface, not guaranteed
to carry every finding of a large round on its own — a round large enough to exceed GitHub's
per-comment character limit degrades by dropping least-urgent findings first, naming what was
omitted and pointing back at the ledger for the complete record. It no-ops unless
gates.postFindingsComments is set to true in config.

Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>                 Current head SHA or hexadecimal prefix
  --findings <json>                JSON array of findings in the findings-log shape
                                   ([{severity, angle, summary, disposition?, files?}])
  --findings-file <path>           Read the --findings JSON array from a file instead of an
                                   inline argument (mutually exclusive with --findings; identical validation)
Output (stdout, JSON):
  { "ok": true, "action": "created"|"updated"|"noop"|"skipped",
    "omittedFindingsCount": <number> (present only when the render degraded to fit
    GitHub's comment length limit), ... }

${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, gh failure, or the round cannot be rendered within the comment
     length limit even with every finding dropped, nor with only its single
     most-urgent finding kept (fails closed rather than posting a truncated or
     partial record)
  2  Invalid --jq filter`.trim();

// Derived from SEVERITY_ORDER (never hand-copied) so a severity added there
// is automatically labeled — a hand-copied map would silently render
// "#### undefined (N)" for any severity it forgot.
const SEVERITY_LABELS = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, s.charAt(0).toUpperCase() + s.slice(1)]));

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

// The one gate vocabulary this module knows about. Shared by normalizeGate
// (CLI --gate parsing) and validateAndSanitizeRenderInputs's own membership
// check below, so the two can never name a different set of "real" gates.
const KNOWN_GATES = new Set(["draft_gate", "pre_approval_gate"]);

function normalizeGate(value) {
  const normalized = String(value).trim().toLowerCase();
  return KNOWN_GATES.has(normalized) ? normalized : null;
}

function normalizeHeadSha(value) {
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

// Validate via the centralized repo-slug validator shared by sibling GitHub
// scripts (parseRepoSlug). It enforces owner/name structure and rejects unsafe
// segments (".", "..", slashes, whitespace); we re-throw as a parseError so the
// CLI usage banner is preserved.
function validateRepo(repo) {
  try {
    parseRepoSlug(repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return repo;
}

// Validate + normalize a parsed --findings / --findings-file JSON array. Shared
// by both flags so they carry identical validation.
function validateFindingsArray(parsed, flagLabel) {
  if (!Array.isArray(parsed)) {
    throw parseError(`${flagLabel} must be a JSON array`);
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object") {
      throw parseError(`${flagLabel}[${i}] must be an object`);
    }
    f = { ...f, severity: normalizeSeverity(f.severity) };
    if (!f.severity || !VALID_SEVERITIES.has(f.severity)) {
      throw parseError(`${flagLabel}[${i}].severity must be one of: ${SEVERITY_ORDER.join(", ")}`);
    }
    if (!f.angle || typeof f.angle !== "string" || f.angle.trim().length === 0) {
      throw parseError(`${flagLabel}[${i}].angle is required`);
    }
    if (!f.summary || typeof f.summary !== "string" || f.summary.trim().length === 0) {
      throw parseError(`${flagLabel}[${i}].summary is required`);
    }
    const entry = {
      severity: f.severity,
      angle: f.angle.trim(),
      summary: f.summary.trim(),
    };
    if (Array.isArray(f.files)) {
      entry.files = f.files.filter(x => typeof x === "string" && x.trim().length > 0).map(x => x.trim());
    }
    if ("disposition" in f && typeof f.disposition === "string" && f.disposition.trim().length > 0) {
      entry.disposition = f.disposition.trim();
    } else if (isDefaultDeferrableSeverity(f.severity)) {
      // Routes through the SAME shared rule (deriveDisposition,
      // @dev-loops/core/loop/gate-fanin) every producer uses: a LOCATABLE
      // question (hasLocatableShape) defaults to "needs-answer", non-locatable
      // to "deferred" — see that function's own doc for the full rule. This
      // shape carries no `line` field at all (see USAGE above), so a question
      // here can never be proven locatable and always resolves to "deferred".
      // isDefaultDeferrableSeverity (gate-fanin) is the shared guard this
      // producer and write-gate-findings-log.mjs's own validator both route
      // through, so the two can never restate it out of sync.
      entry.disposition = deriveDisposition(f.severity, { locatable: hasLocatableShape(entry) });
    }
    return entry;
  });
}

export function parseFindings(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--findings must be valid JSON");
  }
  return validateFindingsArray(parsed, "--findings");
}

// Resolve the findings array from either --findings (inline JSON) or
// --findings-file (a path to a file containing the same JSON array) —
// mutually exclusive, identical validation either way. Shared plumbing lives
// in _findings-input.mjs; this file's own validateFindingsArray is the
// injected element validator.
function resolveFindings(options) {
  return resolveFindingsInput(options, { parseError, validate: validateFindingsArray });
}

export function parsePostGateFindingsCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    findings: undefined,
    findingsFile: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      findings: { type: "string" },
      "findings-file": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = validateRepo(requireTokenValue(token, parseError).trim());
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "gate") {
      const gate = normalizeGate(requireTokenValue(token, parseError));
      if (!gate) throw parseError("--gate must be draft_gate or pre_approval_gate");
      options.gate = gate;
      continue;
    }
    if (token.name === "head-sha") {
      const sha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--head-sha must be a 7-64 character hex SHA");
      options.headSha = sha;
      continue;
    }
    if (token.name === "findings") {
      options.findings = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "findings-file") {
      const findingsFile = requireTokenValue(token, parseError).trim();
      if (findingsFile.length === 0) {
        throw parseError("--findings-file requires a non-empty path");
      }
      options.findingsFile = findingsFile;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "headSha"]
    .filter(k => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  if (options.findings === undefined && options.findingsFile === undefined) {
    throw parseError("Missing required arguments: findings (pass --findings <json> or --findings-file <path>)");
  }
  if (options.findings !== undefined && options.findingsFile !== undefined) {
    throw parseError("--findings and --findings-file are mutually exclusive; pass only one");
  }
  return options;
}

// Hidden marker keyed by GATE ONLY. There is exactly one findings comment per
// gate, updated in place each run. The marker deliberately does NOT include the
// head SHA: --head-sha accepts any 7-64 hex prefix, so keying on its literal
// value would let a different prefix length (or the full SHA) for the same head
// miss the marker and post a duplicate. The reviewed head is still shown in the
// comment body for context. The HTML comment is not rendered by GitHub but is
// matched on the comment body.
export function buildFindingsMarker({ gate }) {
  return `<!-- dev-loops:gate-findings gate=${gate} -->`;
}

// Sanitize free text rendered INSIDE an inline backtick code span (`angle`,
// file refs). A code span's content is inert: CommonMark parses a code span
// BEFORE link/image/HTML syntax, so entity-encoding those constructs here
// would render the entity's own characters as visible text instead of the
// value's literal ones (`app/[id]/page.tsx` would render as
// `app/&#91;id]/page.tsx` rather than the legible original) — the code span
// already neutralizes the markup on its own, with no help needed. Only two
// transforms are still required: strip any literal backtick (it would
// prematurely close the code span, breaking out into raw Markdown for the
// remainder of the list item — backticks are never meaningful in an angle
// label or a file path) and collapse embedded whitespace/newlines
// (LLM-generated free text often carries them, which would otherwise split a
// single Markdown list item across lines). This repo's own machine-artifact
// marker delimiters (`<!--` / `-->`, see buildFindingsMarker) are still
// entity-encoded despite the code span's inertness to markdown:
// findMarkedComment matches the RAW comment body for a line starting with the
// marker BEFORE any markdown rendering happens, so a code-span value that
// lands as the first token on its own line must never be able to forge one.
export function sanitizeCodeSpan(value) {
  return String(value)
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .trim();
}

// Sanitize free text rendered as bare prose (`summary`, `disposition`): NOT
// wrapped in a code span, so — unlike sanitizeCodeSpan — it is not already
// inert to markdown/HTML. Composes the code-span-safe base (backtick strip, so
// a stray backtick here can never shift CommonMark's left-to-right backtick
// pairing and unwrap a LATER field's own code span on the same rendered line;
// whitespace collapse; marker-delimiter encoding) PLUS the neutralization bare
// prose still needs: any other raw `<` (a markdown-to-HTML renderer would
// otherwise pass a raw tag through live) and the markdown link/image bracket
// forms `[text](url)` / `![alt](url)` (a live clickable link, or an
// auto-loaded remote image and its read-receipt/IP-leak risk, that a finding
// field never asked for). Free text comes from scoped-review agents or
// arbitrary --findings/--findings-json producer input, so every one of these
// is untrusted. Every neutralization here is an HTML ENTITY, never a
// backslash-escape: an entity has no failure mode where a value's own literal
// character absorbs the escape and turns it into something live again.
// upsert-checkpoint-verdict.mjs's sanitizeStructuredInline now imports this
// exact function instead of keeping its own copy.
export function sanitizeInline(value) {
  return sanitizeCodeSpan(value)
    .replace(/</g, "&lt;")
    // Neutralize a plain link's opening bracket (any `[` NOT already part of an
    // image's `![`, handled next) before the image-form pass below, so an
    // image's `[` (still preceded by a literal `!` here) is told apart from a
    // plain link's `[`.
    .replace(/(?<!!)\[/g, "&#91;")
    .replace(/!\[/g, "!&#91;");
}

// GitHub rejects an issue comment body over this many characters. Exported so
// the bounding resolver below (and its tests) share the one authoritative
// number rather than a second hand-copied literal.
export const GITHUB_COMMENT_MAX_CHARS = 65536;

export function renderFindingsCommentBody({ gate, headSha, findings, omittedCounts = [], maxChars = GITHUB_COMMENT_MAX_CHARS }) {
  const marker = buildFindingsMarker({ gate });
  const lines = [
    marker,
    `### Gate fan-out findings: ${gate}`,
    "",
    // Plain text head SHA (no backticks) so GitHub autolinks the commit.
    `Reviewed head: ${headSha}`,
    "",
    "This comment shows only the latest posted round for this gate; earlier rounds' findings are no longer shown here and live on their own per-round gate reviews.",
    "",
  ];
  if (omittedCounts.length > 0) {
    const omittedTotal = omittedCounts.reduce((sum, { count }) => sum + count, 0);
    const breakdown = omittedCounts.map(({ severity, count }) => `${count} ${SEVERITY_LABELS[severity]}`).join(", ");
    // Names the bound actually applied (maxChars), not the GitHub default
    // constant — a caller that passes a non-default maxChars (e.g. a test, or
    // a future stricter bound) must never post an explanation that disagrees
    // with the limit it was actually rendered against.
    lines.push(
      `**Note:** ${omittedTotal} finding(s) omitted from this comment (${breakdown}) — the full round exceeded this comment's ${maxChars}-character limit. This gate round's disposition ledger (written by write-gate-findings-log.mjs) always carries the complete, unbounded record.`,
      "",
    );
  }
  if (findings.length === 0) {
    lines.push(
      omittedCounts.length > 0
        ? "Every finding for this round is omitted above; none survived the comment length bound."
        : "No findings. All review angles passed for this head.",
    );
    return sanitizeCopilotSummonTokens(lines.join("\n"));
  }
  const grouped = new Map();
  for (const sev of SEVERITY_ORDER) {
    grouped.set(sev, []);
  }
  for (const finding of findings) {
    // Normalize defensively: this function's real caller (resolveFindings /
    // validateFindingsArray, above) always normalizes first, but a legacy
    // severity spelling reaching this grouping loop unnormalized must still
    // render under its canonical group rather than throw.
    grouped.get(normalizeSeverity(finding.severity)).push(finding);
  }
  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev);
    // Skip an empty severity group entirely: without this, every severity
    // that has zero findings for this round would still render its own
    // "#### <Label> (0)" heading with nothing under it.
    if (group.length === 0) continue;
    lines.push(`#### ${SEVERITY_LABELS[sev]} (${group.length})`);
    for (const finding of group) {
      // Sanitize free-text fields so embedded newlines/whitespace don't break
      // the single-line Markdown list item.
      const summary = sanitizeInline(finding.summary);
      const dispositionSuffix = finding.disposition ? ` — _${sanitizeInline(finding.disposition)}_` : "";
      // angle is a code/label literal → backticks; summary is prose. angle is
      // free text from a scoped-review agent and is rendered inside an inline
      // code span, so it must be sanitized too: an embedded backtick or newline
      // would otherwise break the code span (markdown injection) or split the
      // list item. Use sanitizeCodeSpan (backtick-stripping) since it lives
      // inside backticks, consistent with the file refs below.
      const angle = sanitizeCodeSpan(finding.angle);
      lines.push(`- \`${angle}\`: ${summary}${dispositionSuffix}`);
      if (Array.isArray(finding.files) && finding.files.length > 0) {
        // File refs go inside backticks; sanitize each so embedded whitespace,
        // newlines, or backticks can't break the single Markdown list item /
        // code span, and drop any that sanitize to empty.
        const refs = finding.files
          .map(f => sanitizeCodeSpan(f))
          .filter(f => f.length > 0)
          .map(f => `\`${f}\``)
          .join(", ");
        if (refs.length > 0) {
          lines.push(`  - files: ${refs}`);
        }
      }
    }
    lines.push("");
  }
  // Drop trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  // Neutralize any bare @copilot/`/copilot`* tokens a finding summary quotes
  // (e.g. an excerpt of the anti-summon rule itself) so this comment can never
  // arm request-copilot-review.mjs's anti-summon guard.
  return sanitizeCopilotSummonTokens(lines.join("\n"));
}

// Least-urgent-first: the order individual findings are dropped when a
// round's rendered comment would exceed GitHub's comment limit — every
// finding in a less-urgent severity group is dropped before any finding in a
// more-urgent one. The reverse of SEVERITY_ORDER (most-urgent-first).
const DROP_LEAST_URGENT_FIRST = [...SEVERITY_ORDER].reverse();

// Groups an ordered list of dropped findings into the `omittedCounts` shape
// (`[{ severity, count }]`, least-urgent-first, zero-count severities
// omitted) the comment's omission note renders from.
function summarizeDroppedBySeverity(dropped) {
  const counts = new Map();
  for (const finding of dropped) {
    const severity = normalizeSeverity(finding.severity);
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  return DROP_LEAST_URGENT_FIRST
    .filter((severity) => counts.has(severity))
    .map((severity) => ({ severity, count: counts.get(severity) }));
}

// Reports an arbitrary invalid value in an error message. Never JSON.stringify:
// it throws a TypeError on a BigInt and silently renders a Symbol as the
// string "undefined" (JSON.stringify(Symbol()) === undefined), both worse
// than the value an error message exists to name. `null` is reported as
// "null", matching the per-element guards that already special-case it,
// rather than the "object" typeof would give.
function describeInvalidValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "bigint") return `${value}n`;
  if (type === "object" || type === "function") return type;
  return String(value); // number, boolean, undefined, symbol
}

// Validates and sanitizes every caller-supplied value that
// renderBoundedFindingsCommentBody renders, in ONE place, so a value newly
// added to what gets rendered can never bypass validation by omission — four
// consecutive review rounds each added one more one-off guard here before
// this consolidation. Returns the comment's identity-key fields ready to
// render: gate NORMALIZED (trim + lowercase, constrained to KNOWN_GATES —
// never sanitized, since it is a closed two-value vocabulary, not free
// text) and headSha SANITIZED (see sanitizeInline above; it is not a closed
// set); findings are validated only here, since their own free-text fields
// (summary/angle/files/disposition) are sanitized later, at render time, by
// renderFindingsCommentBody itself.
function validateAndSanitizeRenderInputs({ gate, headSha, findings, maxChars }) {
  // gate is the comment's IDENTITY key (buildFindingsMarker): an unvalidated
  // undefined/blank value would render `gate=undefined` and thereafter match
  // (and keep updating) that bogus marker on every later run. headSha is
  // rendered directly into the body ("Reviewed head: ...") with the same
  // failure mode. headSha is SANITIZED (not just checked for non-emptiness):
  // an unsanitized newline-bearing headSha can forge a line-start marker for
  // a DIFFERENT gate (findMarkedComment matches on line-start text, breaking
  // that gate's comment). gate is instead normalized (trim + lowercase, the
  // same transform normalizeGate applies to the CLI's own --gate) and
  // required to be one of KNOWN_GATES: with only two possible values there is
  // no collision surface between them left to sanitize away, so gate never
  // needs sanitizeInline at render time the way headSha does.
  if (typeof gate !== "string") {
    throw new Error(`renderBoundedFindingsCommentBody: gate must be a non-empty string, got ${describeInvalidValue(gate)}`);
  }
  const normalizedGate = gate.trim().toLowerCase();
  if (!KNOWN_GATES.has(normalizedGate)) {
    throw new Error(`renderBoundedFindingsCommentBody: gate must be one of: ${[...KNOWN_GATES].join(", ")}, got ${describeInvalidValue(gate)}`);
  }
  if (typeof headSha !== "string" || headSha.trim().length === 0) {
    throw new Error(`renderBoundedFindingsCommentBody: headSha must be a non-empty string, got ${describeInvalidValue(headSha)}`);
  }
  if (!Array.isArray(findings)) {
    throw new Error(`renderBoundedFindingsCommentBody: findings must be an array, got ${describeInvalidValue(findings)}`);
  }
  // for...of (never .forEach, which SKIPS array holes) so a sparse findings
  // array produces the same named, index-bearing error as any other bad
  // element — matching how renderFindingsCommentBody itself consumes the
  // array (`for (const finding of findings)`, which yields `undefined` for a
  // hole). forEach silently skipping the hole here would let it reach the
  // render unchecked and crash there with an unnamed TypeError instead.
  let i = 0;
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}] must be an object, got ${describeInvalidValue(finding)}`);
    }
    if (!SEVERITY_ORDER.includes(normalizeSeverity(finding.severity))) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].severity must be one of: ${SEVERITY_ORDER.join(", ")}, got ${describeInvalidValue(finding.severity)}`);
    }
    // angle/summary are rendered directly into the comment (as a code span /
    // bare prose respectively); an unvalidated caller passing neither would
    // otherwise post the literal string "undefined" into a PR comment. The
    // render uses the SANITIZED value (sanitizeCodeSpan/sanitizeInline below),
    // never the raw one, so a raw value that is non-empty but sanitizes to
    // nothing (e.g. a bare "```") must be rejected here too — checking only
    // the raw string would let it through and render an empty code span /
    // empty prose run.
    if (typeof finding.angle !== "string" || finding.angle.trim().length === 0) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].angle must be a non-empty string, got ${describeInvalidValue(finding.angle)}`);
    }
    if (sanitizeCodeSpan(finding.angle).length === 0) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].angle sanitizes to an empty code span, got ${describeInvalidValue(finding.angle)}`);
    }
    if (typeof finding.summary !== "string" || finding.summary.trim().length === 0) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].summary must be a non-empty string, got ${describeInvalidValue(finding.summary)}`);
    }
    if (sanitizeInline(finding.summary).length === 0) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].summary sanitizes to an empty string, got ${describeInvalidValue(finding.summary)}`);
    }
    // disposition is rendered directly into the comment (bare prose, for any
    // truthy value, when present — see renderFindingsCommentBody's own `?:`
    // truthiness check). Only undefined/null/"" are exempted by name below;
    // every OTHER non-string-or-blank value (0, false, NaN included — they
    // are just as falsy at render time as null/"", but are not exempted
    // here) falls through to the typeof-string check and is rejected, since
    // it would otherwise post junk ("[object Object]"/"42"/"true") into the
    // comment.
    if (
      finding.disposition !== undefined && finding.disposition !== null && finding.disposition !== ""
      && (typeof finding.disposition !== "string" || finding.disposition.trim().length === 0)
    ) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].disposition must be a non-empty string when present, got ${describeInvalidValue(finding.disposition)}`);
    }
    // The render uses the SANITIZED disposition (sanitizeInline), never the
    // raw one, so a non-blank string that sanitizes to nothing (e.g. a bare
    // "```") must be rejected too — otherwise it would render the empty
    // italic run " — __".
    if (
      typeof finding.disposition === "string" && finding.disposition.trim().length > 0
      && sanitizeInline(finding.disposition).length === 0
    ) {
      throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].disposition sanitizes to an empty string, got ${describeInvalidValue(finding.disposition)}`);
    }
    // files entries are rendered directly as code-span file refs (see
    // renderFindingsCommentBody); an unvalidated element would otherwise post
    // the literal string "undefined"/"null"/"[object Object]" into the comment.
    if (finding.files !== undefined) {
      if (!Array.isArray(finding.files)) {
        throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].files must be an array, got ${describeInvalidValue(finding.files)}`);
      }
      finding.files.forEach((file, j) => {
        if (typeof file !== "string" || file.trim().length === 0) {
          throw new Error(`renderBoundedFindingsCommentBody: findings[${i}].files[${j}] must be a non-empty string, got ${describeInvalidValue(file)}`);
        }
      });
    }
    i += 1;
  }
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`renderBoundedFindingsCommentBody: maxChars must be a positive integer, got ${describeInvalidValue(maxChars)}`);
  }
  return { gate: normalizedGate, headSha: sanitizeInline(headSha) };
}

// Renders the findings comment body, degrading ONE FINDING AT A TIME (never a
// whole group at once, and never a silently truncated field) when the full
// render would exceed GitHub's comment length limit — least-urgent finding
// first, across every less-urgent severity group before touching a
// more-urgent one. Dropping proportionately (rather than whole groups) means
// a round only slightly over the limit loses close to (though, per the
// search's own comment below, not always exactly) as few low-priority
// findings as it takes to fit, instead of every finding in whichever group is
// dropped first — the most urgent findings always survive as long as ANY
// finding would fit. Every omission is named in the posted comment itself,
// with a pointer to the disposition ledger — the one surface that is never
// length-bounded. Throws (fails closed) when BOTH the emptiest render (every
// finding dropped) and the render with only its single most-urgent finding
// kept still cannot fit, so a round that truly cannot be posted is
// never reported as a success.
export function renderBoundedFindingsCommentBody({ gate, headSha, findings, maxChars = GITHUB_COMMENT_MAX_CHARS }) {
  ({ gate, headSha } = validateAndSanitizeRenderInputs({ gate, headSha, findings, maxChars }));
  const body = renderFindingsCommentBody({ gate, headSha, findings, maxChars });
  if (body.length <= maxChars) {
    return { body, omittedCounts: [] };
  }
  // Least-urgent-first candidate order for individual removal, preserving
  // each finding's original relative order within its own severity group.
  // Indices, not the finding objects themselves: an identity-keyed Set would
  // collapse every slot holding the SAME object reference into a single
  // drop no matter how many of those slots `k` asks to remove, under-dropping
  // (and under-counting the omission note) whenever a findings array repeats
  // a reference.
  const dropOrder = DROP_LEAST_URGENT_FIRST.flatMap(
    (severity) => findings
      .map((_, i) => i)
      .filter((i) => normalizeSeverity(findings[i].severity) === severity),
  );
  // Renders the body with the first `k` (least-urgent-first) findings of
  // dropOrder removed, by index.
  function renderWithDropped(k) {
    const droppedIndexes = dropOrder.slice(0, k);
    const dropSet = new Set(droppedIndexes);
    const remaining = findings.filter((_, i) => !dropSet.has(i));
    const omittedCounts = summarizeDroppedBySeverity(droppedIndexes.map((i) => findings[i]));
    return { body: renderFindingsCommentBody({ gate, headSha, findings: remaining, omittedCounts, maxChars }), omittedCounts };
  }
  const n = dropOrder.length;
  const fullyDropped = renderWithDropped(n);
  // Dropping the very LAST remaining finding is the one step whose render can
  // grow instead of shrink: the zero-findings branch of
  // renderFindingsCommentBody adds its own "none survived" sentence, which
  // can outweigh the few characters that single finding's own line would
  // have cost. So `fits(n)` alone is not a reliable "nothing fits" probe —
  // the genuinely minimal fitting render can be `n - 1` (one finding
  // surviving) even when `n` (zero survive) does not fit.
  const almostFullyDropped = n > 0 ? renderWithDropped(n - 1) : fullyDropped;
  if (fullyDropped.body.length > maxChars && almostFullyDropped.body.length > maxChars) {
    throw new Error(
      `Gate findings comment for gate "${gate}" at head ${headSha} cannot be rendered within GitHub's ${maxChars}-character comment limit even with every finding dropped, nor with only its single most-urgent finding kept; refusing to post a truncated or partial record.`,
    );
  }
  // Binary-search a drop count that fits, rather than dropping one finding at
  // a time and re-rendering after each — O(log n) renders instead of O(n),
  // each still O(n) work, so O(n log n) instead of O(n^2) for a large round.
  // The rendered length is NOT strictly non-increasing as more findings are
  // dropped: dropping the first finding of a severity group also adds that
  // group to the omission note (", <count> <Label>"), which can add more
  // characters than the dropped finding's own line removed, so the curve can
  // bump upward mid-range, not just at the last step. The search stays SAFE
  // despite that: `hi` starts at `hiBound`, already confirmed to fit above,
  // and is only ever narrowed to a `mid` whose render was itself just
  // verified to fit — so the returned render is always confirmed to fit
  // `maxChars`, never assumed. A bump can only cost optimality (the search
  // may settle on dropping a few more findings than the true minimum when it
  // steps past a dip on the non-fitting side), never correctness.
  const hiBound = fullyDropped.body.length <= maxChars ? n : n - 1;
  let lo = 1;
  let hi = hiBound;
  let best = hiBound === n ? fullyDropped : almostFullyDropped;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = renderWithDropped(mid);
    if (candidate.body.length <= maxChars) {
      best = candidate;
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}

// Shared by every sibling GitHub script that reads a `--paginate --slurp`
// endpoint (an array of per-page arrays) rather than hand-rolling the same
// flatten check at each call site.
export function flattenPaginatedSlurp(payload) {
  if (Array.isArray(payload) && payload.every(p => Array.isArray(p))) {
    return payload.flat();
  }
  return Array.isArray(payload) ? payload : [];
}

// Shared `gh` invoke-and-parse helper: run a `gh` subcommand, fail loudly on a
// non-zero exit (naming the command so a failure is traceable back to the
// call site), and parse its stdout as JSON. Exported so sibling GitHub
// scripts that only ever need a stdin-less `gh` call (no `--input -` payload)
// can reuse this instead of re-implementing the same exit-code check.
export async function runGhJson(args, { env, ghCommand, runChild: run = runChild }) {
  const result = await run(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: `gh ${args.slice(0, 3).join(" ")}` });
}

export async function listIssueComments({ repo, pr }, { env, ghCommand, runChild: run }) {
  const payload = await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`],
    { env, ghCommand, runChild: run },
  );
  return flattenPaginatedSlurp(payload);
}

// Line-start anchored: every marker this module's own producers render is
// always the FIRST character of its own line — never rendered mid-line. Matching on
// `body.includes(marker)` alone would also honor a marker merely QUOTED
// inside a comment's free text (a reply that pastes a prior comment's marker
// as an example, or a hostile comment crafted to forge one), and this
// function's result is PATCHed in place by the caller — so a quoted marker
// must never be treated as the genuine, idempotency-keying one.
//
// `author` is the second, orthogonal trust boundary: the caller's own
// authenticated `gh` login. A comment is only considered a match if it was
// authored by that login — a foreign comment forging the exact marker shape
// must never be mistaken for this tool's own idempotent comment (and then
// PATCHed as if it were). Comments here are the raw GitHub REST shape
// (`user.login`), not the normalized `author` field this repo's other
// GraphQL-derived thread/review objects carry.
//
// `author` is REQUIRED, not optional: an omitted author used to fail OPEN
// (every comment matched regardless of who authored it), which is exactly the
// forgery this trust boundary exists to close. Every caller has an
// authenticated login available (resolveAuthenticatedLogin) by the time it
// needs to find its own marked comment, so there is no legitimate call site
// that cannot supply one.
export function findMarkedComment(comments, marker, { author } = {}) {
  if (typeof author !== "string" || author.trim().length === 0) {
    throw new Error("findMarkedComment requires a non-empty author (the authenticated gh viewer's own login); omitting it would fail open and let a foreign comment forging the marker be mistaken for this tool's own idempotent comment.");
  }
  for (const comment of comments) {
    if (comment?.user?.login !== author) continue;
    if (comment && typeof comment.body === "string"
      && comment.body.split(/\r?\n/).some((line) => line.startsWith(marker))) {
      return comment;
    }
  }
  return null;
}

// The authenticated `gh` viewer's own login: the trust boundary every
// gate-authored-provenance decision in this repo's gate tooling is anchored
// to (never rendered marker text alone, which a foreign comment could forge
// just as easily as this repo's own producers render it). Shared by every
// caller that needs to scope a marker read/write to its own comments —
// currently this module's own idempotent upsert, the gate verdict poster's
// finding-surface suppression, and close-gate-findings.mjs's disposition pass.
export async function resolveAuthenticatedLogin({ env, ghCommand, runChild: run }) {
  const payload = await runGhJson(["api", "user"], { env, ghCommand, runChild: run });
  const login = typeof payload?.login === "string" ? payload.login.trim() : "";
  if (login.length === 0) {
    throw new Error("gh api user returned no login; cannot verify gate-authored marker provenance — fail closed.");
  }
  return login;
}

function parseCommentMutationResponse(payload) {
  const commentId = Number.isInteger(payload?.id) ? payload.id : null;
  const commentUrl = typeof payload?.html_url === "string" && payload.html_url.trim().length > 0
    ? payload.html_url.trim()
    : null;
  if (commentId === null || commentUrl === null) {
    throw new Error("Gate findings comment mutation did not return a comment id and html_url");
  }
  return { commentId, commentUrl };
}

async function createComment({ repo, pr, body }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`],
    { env, ghCommand },
  );
  return parseCommentMutationResponse(payload);
}

async function updateComment({ repo, commentId, body }, { env, ghCommand }) {
  const payload = await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`],
    { env, ghCommand },
  );
  return parseCommentMutationResponse(payload);
}

export async function postGateFindings(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  const findings = await resolveFindings(options);
  // loadDevLoopConfig never throws: it returns { config, warnings, errors }.
  // A non-empty errors array means the config could not be loaded/validated, so
  // log it (stderr) and fall back to default behavior (config-unavailable →
  // null → resolveGatePostFindingsComments defaults on → proceed to post),
  // rather than trusting a malformed/partial config object. Mirrors how
  // detect-checkpoint-evidence treats config-unavailable.
  const { config: loadedConfig, errors: configErrors } = await loadDevLoopConfig({ repoRoot });
  let config = loadedConfig;
  if (Array.isArray(configErrors) && configErrors.length > 0) {
    process.stderr.write(
      `post-gate-findings: dev-loop config could not be loaded/validated; using default behavior. errors=${JSON.stringify(configErrors)}\n`,
    );
    config = null;
  }
  if (!resolveGatePostFindingsComments(config)) {
    return {
      ok: true,
      action: "skipped",
      reason: "gates.postFindingsComments is not true",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: options.headSha,
      findingsCount: findings.length,
    };
  }
  // Normalized the same way renderBoundedFindingsCommentBody normalizes gate
  // (trim + lowercase, then required to be a KNOWN_GATES member) before
  // embedding it in the body's own marker, so this comment-search marker and
  // the one actually rendered into desiredBody always agree — true only
  // because gate is constrained to that closed, two-value vocabulary; a
  // free-text field would need its own sanitizeInline call here instead.
  const marker = buildFindingsMarker({ gate: normalizeGate(options.gate) });
  // Fails closed (throws) when the round cannot be rendered within GitHub's
  // comment limit even with every finding dropped, nor with only its single
  // most-urgent finding kept, rather than reporting a false success below.
  const { body: desiredBody, omittedCounts } = renderBoundedFindingsCommentBody({
    gate: options.gate,
    headSha: options.headSha,
    findings,
  });
  const login = await resolveAuthenticatedLogin({ env, ghCommand });
  const comments = await listIssueComments({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const existing = findMarkedComment(comments, marker, { author: login });
  const base = {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    findingsCount: findings.length,
    // Only present when the render degraded, so an unbounded round's result
    // shape is unchanged.
    ...(omittedCounts.length > 0
      ? { omittedFindingsCount: omittedCounts.reduce((sum, { count }) => sum + count, 0) }
      : {}),
  };
  if (existing) {
    if (typeof existing.body === "string" && existing.body === desiredBody) {
      return {
        ...base,
        action: "noop",
        commentId: Number.isInteger(existing.id) ? existing.id : null,
        commentUrl: typeof existing.html_url === "string" ? existing.html_url : null,
      };
    }
    const updated = await updateComment({ repo: options.repo, commentId: existing.id, body: desiredBody }, { env, ghCommand });
    return { ...base, action: "updated", ...updated };
  }
  const created = await createComment({ repo: options.repo, pr: options.pr, body: desiredBody }, { env, ghCommand });
  return { ...base, action: "created", ...created };
}

async function main() {
  let options;
  try {
    options = parsePostGateFindingsCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await postGateFindings(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
