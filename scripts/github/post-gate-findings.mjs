#!/usr/bin/env node
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText, sanitizeCopilotSummonTokens } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGatePostFindingsComments } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveFindingsInput } from "./_findings-input.mjs";

const USAGE = `Usage: post-gate-findings.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> (--findings <json> | --findings-file <path>)
Post (or idempotently update) a visible, marker-tagged PR issue comment that lists the
consolidated gate fan-out findings, grouped by severity. The comment is idempotent
per gate: there is exactly one comment per gate, updated in place on each run
(the reviewed head is shown in the body) instead of duplicating it.

The disposition ledger (write-gate-findings-log.mjs) is the durable source of truth and is
written regardless of this comment. This helper only posts the auditable PR summary, and
no-ops when gates.postFindingsComments is set to false in config.

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
  { "ok": true, "action": "created"|"updated"|"noop"|"skipped", ... }

${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();

const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
// Severity ordering for grouped rendering (most-blocking first).
const SEVERITY_ORDER = ["must-fix", "worth-fixing-now", "defer"];
const SEVERITY_LABELS = {
  "must-fix": "Must fix",
  "worth-fixing-now": "Worth fixing now",
  "defer": "Defer",
};

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function normalizeGate(value) {
  const gates = new Set(["draft_gate", "pre_approval_gate"]);
  const normalized = String(value).trim().toLowerCase();
  return gates.has(normalized) ? normalized : null;
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
    if (!f.severity || !VALID_SEVERITIES.has(f.severity)) {
      throw parseError(`${flagLabel}[${i}].severity must be one of: must-fix, worth-fixing-now, defer`);
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
    if ("disposition" in f && typeof f.disposition === "string" && f.disposition.trim().length > 0) {
      entry.disposition = f.disposition.trim();
    } else if (f.severity === "defer") {
      // Mirrors write-gate-findings-log.mjs / consolidate-fanin.mjs: a
      // non-blocking defer finding with no explicit disposition defaults to
      // "deferred" rather than rendering with no disposition suffix.
      entry.disposition = "deferred";
    }
    if (Array.isArray(f.files)) {
      entry.files = f.files.filter(x => typeof x === "string" && x.trim().length > 0).map(x => x.trim());
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

export function renderFindingsCommentBody({ gate, headSha, findings }) {
  const marker = buildFindingsMarker({ gate });
  const lines = [
    marker,
    `### Gate fan-out findings: ${gate}`,
    "",
    // Plain text head SHA (no backticks) so GitHub autolinks the commit.
    `Reviewed head: ${headSha}`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("No findings. All review angles passed for this head.");
    return sanitizeCopilotSummonTokens(lines.join("\n"));
  }
  const grouped = new Map();
  for (const sev of SEVERITY_ORDER) {
    grouped.set(sev, []);
  }
  for (const finding of findings) {
    grouped.get(finding.severity).push(finding);
  }
  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev);
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

export async function updateComment({ repo, commentId, body }, { env, ghCommand, runChild: run }) {
  const payload = await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`],
    { env, ghCommand, runChild: run },
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
      reason: "gates.postFindingsComments is false",
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: options.headSha,
      findingsCount: findings.length,
    };
  }
  const marker = buildFindingsMarker({ gate: options.gate });
  const desiredBody = renderFindingsCommentBody({ gate: options.gate, headSha: options.headSha, findings });
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
