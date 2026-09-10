#!/usr/bin/env node
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, sanitizeCopilotSummonTokens } from "../_core-helpers.mjs";
import { ghJson as runGhJson } from "@dev-loops/core/github/gh";
import { loadDevLoopConfig, resolveGatePostFindingsComments } from "@dev-loops/core/config";
// Severity vocabulary and its most-urgent-first ordering are owned by gate-fanin.
import { SEVERITY_ORDER, VALID_SEVERITIES, deriveDisposition, hasLocatableShape, isDefaultDeferrableSeverity, normalizeSeverity } from "@dev-loops/core/loop/gate-fanin";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveFindingsInput } from "./_findings-input.mjs";
import { guardCommentBodyNoIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { GATE_NAMES, normalizeGate as normalizeGateShared, normalizeHeadSha as normalizeHeadShaShared } from "./_gate-names.mjs";

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
const KNOWN_GATES = new Set(GATE_NAMES);

const normalizeGate = normalizeGateShared;
const normalizeHeadSha = normalizeHeadShaShared;

// parseRepoSlug enforces owner/name structure and rejects unsafe segments
// (".", "..", slashes, whitespace); re-thrown as parseError to keep the CLI
// usage banner.
function validateRepo(repo) {
  try {
    parseRepoSlug(repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return repo;
}

// Shared by --findings and --findings-file so both get identical validation.
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
      // Routes through the shared deriveDisposition rule (gate-fanin) also used
      // by write-gate-findings-log.mjs. This shape has no `line` field, so it
      // can never be proven locatable and always resolves to "deferred".
      entry.disposition = deriveDisposition(f.severity, { locatable: hasLocatableShape(entry) });
    }
    // Preserve the judge's relevance-based dispositions: without this,
    // the judge suffix in renderFindingsCommentBody is unreachable dead code.
    if (typeof f.judgeDisposition === "string" && f.judgeDisposition.trim().length > 0) {
      entry.judgeDisposition = f.judgeDisposition.trim();
    }
    if (typeof f.judgeRationale === "string" && f.judgeRationale.trim().length > 0) {
      entry.judgeRationale = f.judgeRationale.trim();
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

// Shared plumbing lives in _findings-input.mjs; validateFindingsArray above is
// the injected element validator.
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

// Hidden marker keyed by GATE ONLY, not head SHA: --head-sha accepts any 7-64
// hex prefix, so keying on its literal value would let a different prefix
// length for the same head miss the marker and post a duplicate. There is
// exactly one findings comment per gate, updated in place each run; the
// reviewed head is still shown in the body for context. The HTML comment is
// not rendered by GitHub but is matched on the raw comment body.
export function buildFindingsMarker({ gate }) {
  return `<!-- dev-loops:gate-findings gate=${gate} -->`;
}

// Sanitize free text rendered INSIDE an inline backtick code span (`angle`,
// file refs). A code span's content is inert to markdown/HTML (CommonMark
// parses it before link/image/HTML syntax), so only two transforms are still
// needed: strip a literal backtick (would prematurely close the span) and
// collapse embedded whitespace/newlines (would split the Markdown list item).
// The marker delimiters (`<!--`/`-->`) are still entity-encoded despite that
// inertness: findMarkedComment matches the RAW comment body for a line
// starting with the marker BEFORE markdown rendering, so a code-span value
// landing as the first token on its own line must never be able to forge one.
export function sanitizeCodeSpan(value) {
  return String(value)
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .trim();
}

// Sanitize free text rendered as bare prose (`summary`, `disposition`): unlike
// sanitizeCodeSpan, it is not already inert to markdown/HTML. Composes the
// code-span-safe base plus the neutralization bare prose still needs: raw `<`
// (would pass a live tag through) and markdown link/image brackets
// `[text](url)` / `![alt](url)` (a live link, or an auto-loaded remote image
// and its read-receipt/IP-leak risk). Free text is untrusted producer input.
// Every neutralization is an HTML entity, never a backslash-escape, so a
// value's own literal character can never absorb the escape and turn live
// again. upsert-checkpoint-verdict.mjs imports this exact function.
export function sanitizeInline(value) {
  return sanitizeCodeSpan(value)
    .replace(/</g, "&lt;")
    // Handle plain `[` (not part of `![`) before the image-form pass below,
    // so an image's `[` is told apart from a plain link's `[`.
    .replace(/(?<!!)\[/g, "&#91;")
    .replace(/!\[/g, "!&#91;");
}

// GitHub rejects an issue comment body over this many characters. Exported so
// the bounding resolver below (and its tests) share the one authoritative
// number rather than a second hand-copied literal.
export const GITHUB_COMMENT_MAX_CHARS = 65536;

// This module's ONLY render entry point; renderBoundedFindingsCommentBody
// composes it rather than duplicating a render path. Both run the same
// validateAndSanitizeRenderInputs seam, so a new renderable value can never
// bypass validation via either entry point.
export function renderFindingsCommentBody({ gate, headSha, findings, omittedCounts = [], maxChars = GITHUB_COMMENT_MAX_CHARS }) {
  ({ gate, headSha } = validateAndSanitizeRenderInputs({
    gate, headSha, findings, omittedCounts, maxChars, entryPoint: "renderFindingsCommentBody",
  }));
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
    // Names the bound actually applied (maxChars), never the GitHub default
    // constant, so the posted explanation can never disagree with the limit
    // it was actually rendered against.
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
    // Normalize defensively: a legacy severity spelling reaching this loop
    // unnormalized must still render under its canonical group, not throw.
    grouped.get(normalizeSeverity(finding.severity)).push(finding);
  }
  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev);
    // Skip empty groups: otherwise a zero-finding severity would still
    // render its own "#### <Label> (0)" heading with nothing under it.
    if (group.length === 0) continue;
    lines.push(`#### ${SEVERITY_LABELS[sev]} (${group.length})`);
    for (const finding of group) {
      // Sanitize free-text fields so embedded newlines/whitespace don't break
      // the single-line Markdown list item.
      const summary = sanitizeInline(finding.summary);
      const dispositionSuffix = finding.disposition ? ` — _${sanitizeInline(finding.disposition)}_` : "";
      // Judge relevance-based disposition, alongside the
      // severity-derived one.
      const judgeSuffix = finding.judgeDisposition
        ? ` — judge: _${sanitizeInline(finding.judgeDisposition)}_`
        : "";
      // angle renders inside a code span (backticks); summary is prose. Sanitize
      // angle with sanitizeCodeSpan too: an embedded backtick/newline would
      // otherwise break the span (markdown injection) or split the list item.
      const angle = sanitizeCodeSpan(finding.angle);
      lines.push(`- \`${angle}\`: ${summary}${dispositionSuffix}${judgeSuffix}`);
      if (Array.isArray(finding.files) && finding.files.length > 0) {
        // File refs go inside backticks; sanitize each so whitespace/newlines/
        // backticks can't break the list item, and drop any that sanitize empty.
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
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  // Neutralize any bare @copilot/`/copilot`* tokens a finding summary quotes
  // (e.g. an excerpt of the anti-summon rule itself) so this comment can never
  // arm request-copilot-review.mjs's anti-summon guard.
  return sanitizeCopilotSummonTokens(lines.join("\n"));
}

// Least-urgent-first drop order when a round's comment exceeds GitHub's
// limit: every less-urgent group drops before any more-urgent one. Reverse
// of SEVERITY_ORDER (most-urgent-first).
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
// it throws on a BigInt and silently renders a Symbol as "undefined", both
// worse than the value the message exists to name. `null` reports as "null"
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

// Validates and sanitizes every caller-supplied value renderFindingsCommentBody
// renders, in ONE place called from both renderFindingsCommentBody and
// renderBoundedFindingsCommentBody, so a value newly added to the render can
// never bypass validation by omission on either entry point. `entryPoint`
// names the export that actually ran this call, so a rejection is always
// attributed to the function the caller invoked. Returns the identity-key
// fields ready to render: gate NORMALIZED (trim + lowercase, constrained to
// KNOWN_GATES) and headSha SANITIZED (sanitizeInline); findings' own free-text
// fields are sanitized later, at render time, by renderFindingsCommentBody.
function validateAndSanitizeRenderInputs({ gate, headSha, findings, omittedCounts, maxChars, entryPoint }) {
  // gate is the comment's IDENTITY key (buildFindingsMarker): an unvalidated
  // blank value would render `gate=undefined` and keep matching that bogus
  // marker on every later run. headSha is SANITIZED, not just non-empty
  // checked: an unsanitized newline-bearing headSha could forge a line-start
  // marker for a DIFFERENT gate. gate is instead normalized (trim + lowercase)
  // and constrained to KNOWN_GATES, a closed vocabulary with no collision
  // surface left to sanitize away.
  if (typeof gate !== "string") {
    throw new Error(`${entryPoint}: gate must be a non-empty string, got ${describeInvalidValue(gate)}`);
  }
  const normalizedGate = gate.trim().toLowerCase();
  if (!KNOWN_GATES.has(normalizedGate)) {
    throw new Error(`${entryPoint}: gate must be one of: ${[...KNOWN_GATES].join(", ")}, got ${describeInvalidValue(gate)}`);
  }
  if (typeof headSha !== "string" || headSha.trim().length === 0) {
    throw new Error(`${entryPoint}: headSha must be a non-empty string, got ${describeInvalidValue(headSha)}`);
  }
  // The render uses the SANITIZED headSha, so a non-blank string that
  // sanitizes to nothing (e.g. a bare "```") must be rejected too, or the
  // identity line renders as the silently-empty "Reviewed head: ".
  if (sanitizeInline(headSha).length === 0) {
    throw new Error(`${entryPoint}: headSha sanitizes to an empty string, got ${describeInvalidValue(headSha)}`);
  }
  if (!Array.isArray(findings)) {
    throw new Error(`${entryPoint}: findings must be an array, got ${describeInvalidValue(findings)}`);
  }
  // for...of, never .forEach (which SKIPS array holes): a sparse findings
  // array must produce the same named, index-bearing error as any other bad
  // element, not reach the render unchecked and crash with an unnamed
  // TypeError.
  let i = 0;
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`${entryPoint}: findings[${i}] must be an object, got ${describeInvalidValue(finding)}`);
    }
    if (!SEVERITY_ORDER.includes(normalizeSeverity(finding.severity))) {
      throw new Error(`${entryPoint}: findings[${i}].severity must be one of: ${SEVERITY_ORDER.join(", ")}, got ${describeInvalidValue(finding.severity)}`);
    }
    // angle/summary render directly into the comment; unvalidated, they'd post
    // the literal "undefined". The render uses the SANITIZED value, so a raw
    // value that is non-empty but sanitizes to nothing (e.g. a bare "```")
    // must be rejected too, or it renders an empty code span / prose run.
    if (typeof finding.angle !== "string" || finding.angle.trim().length === 0) {
      throw new Error(`${entryPoint}: findings[${i}].angle must be a non-empty string, got ${describeInvalidValue(finding.angle)}`);
    }
    if (sanitizeCodeSpan(finding.angle).length === 0) {
      throw new Error(`${entryPoint}: findings[${i}].angle sanitizes to an empty code span, got ${describeInvalidValue(finding.angle)}`);
    }
    if (typeof finding.summary !== "string" || finding.summary.trim().length === 0) {
      throw new Error(`${entryPoint}: findings[${i}].summary must be a non-empty string, got ${describeInvalidValue(finding.summary)}`);
    }
    if (sanitizeInline(finding.summary).length === 0) {
      throw new Error(`${entryPoint}: findings[${i}].summary sanitizes to an empty string, got ${describeInvalidValue(finding.summary)}`);
    }
    // disposition renders directly into the comment for any truthy value.
    // Only undefined/null/"" are exempted below; every other non-string value
    // (0, false, NaN included) falls through to the typeof-string check and
    // is rejected, or it would post junk ("[object Object]"/"42") instead.
    if (
      finding.disposition !== undefined && finding.disposition !== null && finding.disposition !== ""
      && (typeof finding.disposition !== "string" || finding.disposition.trim().length === 0)
    ) {
      throw new Error(`${entryPoint}: findings[${i}].disposition must be a non-empty string when present, got ${describeInvalidValue(finding.disposition)}`);
    }
    // The render uses the SANITIZED disposition, so a non-blank string that
    // sanitizes to nothing must be rejected too, or it renders the empty
    // italic run " — __".
    if (
      typeof finding.disposition === "string" && finding.disposition.trim().length > 0
      && sanitizeInline(finding.disposition).length === 0
    ) {
      throw new Error(`${entryPoint}: findings[${i}].disposition sanitizes to an empty string, got ${describeInvalidValue(finding.disposition)}`);
    }
    // judgeDisposition has the exact same failure mode as disposition above:
    // an unvalidated truthy non-string is coerced and posted as junk, and a
    // whitespace-only string collapses to an empty italic run.
    if (
      finding.judgeDisposition !== undefined && finding.judgeDisposition !== null && finding.judgeDisposition !== ""
      && (typeof finding.judgeDisposition !== "string" || finding.judgeDisposition.trim().length === 0)
    ) {
      throw new Error(`${entryPoint}: findings[${i}].judgeDisposition must be a non-empty string when present, got ${describeInvalidValue(finding.judgeDisposition)}`);
    }
    if (
      typeof finding.judgeDisposition === "string" && finding.judgeDisposition.trim().length > 0
      && sanitizeInline(finding.judgeDisposition).length === 0
    ) {
      throw new Error(`${entryPoint}: findings[${i}].judgeDisposition sanitizes to an empty string, got ${describeInvalidValue(finding.judgeDisposition)}`);
    }
    // files entries render as code-span file refs; unvalidated, an element
    // would post "undefined"/"null"/"[object Object]" into the comment.
    if (finding.files !== undefined) {
      if (!Array.isArray(finding.files)) {
        throw new Error(`${entryPoint}: findings[${i}].files must be an array, got ${describeInvalidValue(finding.files)}`);
      }
      // for...of (never .forEach, which skips holes) — same rationale as the
      // outer findings loop above.
      let j = 0;
      for (const file of finding.files) {
        if (typeof file !== "string" || file.trim().length === 0) {
          throw new Error(`${entryPoint}: findings[${i}].files[${j}] must be a non-empty string, got ${describeInvalidValue(file)}`);
        }
        // The render silently DROPS a file ref that sanitizes to empty
        // (files.filter), so a raw ref that is non-blank but sanitizes to
        // nothing (e.g. a bare "`") must be rejected here rather than
        // vanish from the rendered comment with no trace.
        if (sanitizeCodeSpan(file).length === 0) {
          throw new Error(`${entryPoint}: findings[${i}].files[${j}] sanitizes to an empty code span, got ${describeInvalidValue(file)}`);
        }
        j += 1;
      }
    }
    i += 1;
  }
  // omittedCounts renders straight into the omission note's breakdown with
  // no SEVERITY_LABELS fallback: an unknown severity would render "undefined",
  // and a non-array value would reach the note's own `.reduce` as an unnamed
  // TypeError. Both are rejected here, by name, before that render is reached.
  if (!Array.isArray(omittedCounts)) {
    throw new Error(`${entryPoint}: omittedCounts must be an array, got ${describeInvalidValue(omittedCounts)}`);
  }
  let m = 0;
  for (const entry of omittedCounts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${entryPoint}: omittedCounts[${m}] must be an object, got ${describeInvalidValue(entry)}`);
    }
    if (!SEVERITY_ORDER.includes(entry.severity)) {
      throw new Error(`${entryPoint}: omittedCounts[${m}].severity must be one of: ${SEVERITY_ORDER.join(", ")}, got ${describeInvalidValue(entry.severity)}`);
    }
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`${entryPoint}: omittedCounts[${m}].count must be a positive integer, got ${describeInvalidValue(entry.count)}`);
    }
    m += 1;
  }
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`${entryPoint}: maxChars must be a positive integer, got ${describeInvalidValue(maxChars)}`);
  }
  return { gate: normalizedGate, headSha: sanitizeInline(headSha) };
}

// Renders the findings comment body, degrading ONE FINDING AT A TIME (never a
// whole group, never a silently truncated field) when the full render exceeds
// GitHub's comment length limit — least-urgent finding first, across every
// less-urgent severity group before touching a more-urgent one, so the most
// urgent findings always survive as long as ANY finding would fit. Every
// omission is named in the comment, pointing back at the disposition ledger
// (never length-bounded). Throws (fails closed) when both the emptiest render
// and the render with only its single most-urgent finding kept still cannot
// fit, so a round that cannot be posted is never reported as a success.
export function renderBoundedFindingsCommentBody({ gate, headSha, findings, maxChars = GITHUB_COMMENT_MAX_CHARS }) {
  // This function's OWN gate/headSha bindings must also be normalized/
  // sanitized here, before anything else reads them: the fail-closed throw
  // below interpolates them directly, and dropOrder/renderWithDropped close
  // over them too. Idempotent against renderFindingsCommentBody's own
  // re-validation, since gate/headSha are already normalized by then.
  ({ gate, headSha } = validateAndSanitizeRenderInputs({
    gate, headSha, findings, omittedCounts: [], maxChars, entryPoint: "renderBoundedFindingsCommentBody",
  }));
  const body = renderFindingsCommentBody({ gate, headSha, findings, maxChars });
  if (body.length <= maxChars) {
    return { body, omittedCounts: [] };
  }
  // Least-urgent-first candidate order for individual removal, by INDEX not
  // object identity: an identity-keyed Set would collapse every slot holding
  // the SAME object reference into one drop, under-dropping (and
  // under-counting the omission note) when a findings array repeats a
  // reference.
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
  // Dropping the very LAST finding is the one step whose render can grow
  // instead of shrink: the zero-findings branch adds its own "none survived"
  // sentence, which can outweigh that finding's own line. So `fits(n)` alone
  // is not a reliable "nothing fits" probe — `n - 1` can fit even when `n`
  // does not.
  const almostFullyDropped = n > 0 ? renderWithDropped(n - 1) : fullyDropped;
  if (fullyDropped.body.length > maxChars && almostFullyDropped.body.length > maxChars) {
    throw new Error(
      `Gate findings comment for gate "${gate}" at head ${headSha} cannot be rendered within GitHub's ${maxChars}-character comment limit even with every finding dropped, nor with only its single most-urgent finding kept; refusing to post a truncated or partial record.`,
    );
  }
  // Binary-search a drop count that fits: O(n log n) instead of O(n^2) for a
  // large round. The rendered length is NOT strictly non-increasing (dropping
  // a group's first finding also adds that group to the omission note, which
  // can add more characters than the dropped line removed), but the search
  // stays SAFE: `hi` starts at `hiBound`, already confirmed to fit, and is
  // only narrowed to a `mid` whose render was itself just verified to fit — so
  // the returned render is always confirmed, never assumed, to fit `maxChars`.
  // A non-monotonic bump can only cost optimality, never correctness.
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

// Re-exported so sibling GitHub scripts (close-gate-findings.mjs,
// _gate-finding-surface.mjs) can keep importing `runGhJson` from here without
// changing their imports.
export { runGhJson };

export async function listIssueComments({ repo, pr }, { env, ghCommand, runChild: run }) {
  const payload = await runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`],
    { env, ghCommand, runChild: run },
  );
  return flattenPaginatedSlurp(payload);
}

// Line-start anchored: every marker this module renders is always the FIRST
// character of its own line. Matching `body.includes(marker)` alone would
// also honor a marker merely QUOTED inside a comment's free text, and this
// result is PATCHed in place by the caller, so a quoted marker must never be
// treated as the genuine, idempotency-keying one.
//
// `author` is the second, orthogonal trust boundary: the caller's own
// authenticated `gh` login. A comment only matches if authored by that login,
// so a foreign comment forging the exact marker shape can never be mistaken
// for this tool's own idempotent comment and PATCHed as if it were. Comments
// here use the raw GitHub REST shape (`user.login`).
//
// `author` is REQUIRED: an omitted author used to fail OPEN (every comment
// matched regardless of author), exactly the forgery this boundary closes.
// Every caller has an authenticated login (resolveAuthenticatedLogin) by the
// time it needs this.
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
// gate-authored-provenance decision is anchored to, never rendered marker
// text alone (which a foreign comment could forge just as easily). Shared by
// every caller scoping a marker read/write to its own comments.
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
  // ISSUE/PR-ID GUARD: refuse a generated comment body that emits a
  // raw issue/PR id (fail-closed) unless explicitly allowlisted.
  guardCommentBodyNoIssuePrIds(body, { ref: "gate findings comment body" });
  const payload = await runGhJson(
    ["api", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${body}`],
    { env, ghCommand },
  );
  return parseCommentMutationResponse(payload);
}

async function updateComment({ repo, commentId, body }, { env, ghCommand }) {
  // ISSUE/PR-ID GUARD — see createComment.
  guardCommentBodyNoIssuePrIds(body, { ref: "gate findings comment body" });
  const payload = await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`],
    { env, ghCommand },
  );
  return parseCommentMutationResponse(payload);
}

export async function postGateFindings(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  // resolveFindings returns `{ findings, overallVerdict }`; this script only
  // posts the visible comment and drops `overallVerdict` here — only
  // write-gate-findings-log.mjs persists it to the ledger.
  const { findings } = await resolveFindings(options);
  // loadDevLoopConfig never throws; a non-empty errors array means the config
  // could not be loaded/validated, so log it (stderr) and fall back to
  // default behavior rather than trust a malformed/partial config object.
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
  // Normalized the same way renderBoundedFindingsCommentBody normalizes gate,
  // so this comment-search marker always agrees with the one rendered into
  // desiredBody — true only because gate is a closed, two-value vocabulary.
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
