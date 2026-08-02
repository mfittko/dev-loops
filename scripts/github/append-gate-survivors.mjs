#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { loadDevLoopConfig, resolveGateConfig, resolveGateFollowUpIssue } from "@dev-loops/core/config";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { commentIssue } from "./comment-issue.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { findMarkedComment, listIssueComments, sanitizeCodeSpan, sanitizeInline } from "./post-gate-findings.mjs";
import { mapGateToConfigKey } from "./write-gate-context.mjs";

const USAGE = `Usage: append-gate-survivors.mjs --ledger <path> [--follow-up-issue <number>]
File the non-blocking ("survivor") findings from a closed gate round's disposition
ledger (write-gate-findings-log.mjs output) as one visible, marker-tagged comment on
the repo's consolidated follow-up issue. Idempotent per (repo, PR, gate, head SHA):
re-running against the same ledger never posts a second comment.

Blocking-severity findings (gates.<gate>.blockCleanOnFindingSeverities) are excluded —
they are already tracked by the gate's own findings/checkpoint flow, not the follow-up
issue. A ledger with zero survivors is a no-op (no network call, no comment).

Required:
  --ledger <path>              Path to a write-gate-findings-log.mjs JSON ledger:
                                { repo, pr, gate, headSha, verdict, loggedAt, findings[] }
                                repo/pr/gate/headSha are derived from the ledger itself.
Optional:
  --follow-up-issue <number>   Issue number to file survivors on. Defaults to
                                gates.followUpIssue from this worktree's dev-loop config.
                                Required (one way or the other) when survivors exist.

Output (stdout, JSON):
  { "ok": true, "skipped": "no_survivors", "count": 0, ... }
  { "ok": true, "skipped": "already_filed", "commentUrl": "...", ... }
  { "ok": true, "filed": <n>, "commentUrl": "...", ... }

${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including no-op skips)
  1  Argument error, unresolved follow-up issue with survivors present, or gh failure
  2  Invalid --jq filter`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
// Ranking for deterministic survivor-table ordering (worth-fixing-now before defer).
const SEVERITY_ORDER = ["must-fix", "worth-fixing-now", "defer"];

// Entity-encode a table cell: sanitizeInline neutralizes embedded HTML-comment
// delimiters and whitespace runs (shared with post-gate-findings.mjs); `|` is
// additionally entity-encoded (never backslash-escaped — a backslash-escape is
// itself a bypass vector for the next consumer that doesn't expect it) so a
// finding field can never break out of its Markdown table cell.
function sanitizeCell(value) {
  return sanitizeInline(value).replace(/\|/g, "&#124;");
}

export function buildSurvivorsMarker({ repo, pr, gate, headSha }) {
  return `<!-- dev-loops:gate-survivors ${repo} pr-${pr} ${gate} ${headSha} -->`;
}

// Findings whose severity is NOT in the gate's configured blocking set.
export function selectSurvivors(findings, blockCleanOnFindingSeverities) {
  const blocking = new Set(blockCleanOnFindingSeverities);
  return findings.filter((f) => !blocking.has(f.severity));
}

// Deterministic order: severity rank (worth-fixing-now before defer), then
// angle, then summary.
function sortSurvivors(survivors) {
  return [...survivors].sort((a, b) => {
    const rankA = SEVERITY_ORDER.indexOf(a.severity);
    const rankB = SEVERITY_ORDER.indexOf(b.severity);
    if (rankA !== rankB) return rankA - rankB;
    if (a.angle !== b.angle) return a.angle < b.angle ? -1 : 1;
    if (a.summary !== b.summary) return a.summary < b.summary ? -1 : 1;
    return 0;
  });
}

export function renderSurvivorsCommentBody({ repo, pr, gate, headSha, survivors }) {
  const marker = buildSurvivorsMarker({ repo, pr, gate, headSha });
  const shortSha = headSha.slice(0, 7);
  const lines = [
    marker,
    `### Gate survivors — \`${gate}\` @ \`${shortSha}\` (PR #${pr}) — ${survivors.length} finding(s)`,
    "",
    "| Severity | Angle | Summary | Location | Disposition |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const finding of sortSurvivors(survivors)) {
    const location = Array.isArray(finding.files) && finding.files.length > 0
      // Rendered INSIDE a backtick code span: sanitizeCodeSpan strips literal
      // backticks so a file ref cannot close the span and inject raw Markdown
      // into the rest of the row; the pipe encoding keeps the table intact.
      ? finding.files.map((f) => `\`${sanitizeCodeSpan(f).replace(/\|/g, "&#124;")}\``).join(", ")
      : "—";
    const disposition = finding.disposition ? sanitizeCell(finding.disposition) : "—";
    lines.push(`| ${sanitizeCell(finding.severity)} | ${sanitizeCell(finding.angle)} | ${sanitizeCell(finding.summary)} | ${location} | ${disposition} |`);
  }
  return lines.join("\n");
}

// Read + validate the findings-log ledger written by write-gate-findings-log.mjs.
// repo/pr/gate/headSha are derived from here (no redundant CLI identity flags
// that could disagree with the ledger's own values).
async function readLedger(ledgerPath) {
  let raw;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (err) {
    throw parseError(`Cannot read --ledger "${ledgerPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError(`--ledger "${ledgerPath}" must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw parseError(`--ledger "${ledgerPath}" must contain a JSON object`);
  }
  const { repo, pr, gate, headSha, findings } = parsed;
  // The repo slug is embedded verbatim in the idempotency marker's HTML
  // comment, so it must be a real owner/name — a malformed value could break
  // out of the marker (defeating idempotency) or inject comment content.
  let repoSlug;
  try {
    const { owner, name } = parseRepoSlug(typeof repo === "string" ? repo.trim() : repo);
    repoSlug = `${owner}/${name}`;
  } catch {
    throw parseError(`--ledger "${ledgerPath}" "repo" must be an owner/name slug`);
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    throw parseError(`--ledger "${ledgerPath}" is missing a valid "pr" number`);
  }
  if (gate !== "draft_gate" && gate !== "pre_approval_gate") {
    throw parseError(`--ledger "${ledgerPath}" "gate" must be draft_gate or pre_approval_gate`);
  }
  // Full-length only: the marker is keyed by this value, and accepting a
  // prefix would let the same close be represented two ways (short vs full),
  // producing distinct markers and a double-filed survivor comment.
  const fullHeadSha = normalizeFullHeadSha(headSha);
  if (fullHeadSha === null) {
    throw parseError(`--ledger "${ledgerPath}" "headSha" must be the full 40- or 64-char hex commit SHA`);
  }
  if (!Array.isArray(findings)) {
    throw parseError(`--ledger "${ledgerPath}" "findings" must be an array`);
  }
  findings.forEach((f, i) => {
    if (!f || typeof f !== "object" || !VALID_SEVERITIES.has(f.severity) || typeof f.angle !== "string" || typeof f.summary !== "string") {
      throw parseError(`--ledger "${ledgerPath}" findings[${i}] is malformed (expected {severity, angle, summary})`);
    }
  });
  return { repo: repoSlug, pr, gate, headSha: fullHeadSha, findings };
}

export function parseAppendGateSurvivorsCliArgs(argv) {
  const options = { help: false, ledgerPath: undefined, followUpIssue: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      ledger: { type: "string" },
      "follow-up-issue": { type: "string" },
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
    if (token.name === "ledger") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--ledger requires a non-empty path");
      }
      options.ledgerPath = p;
      continue;
    }
    if (token.name === "follow-up-issue") {
      options.followUpIssue = parsePositiveInteger(requireTokenValue(token, parseError), "--follow-up-issue", parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.ledgerPath === undefined) {
    throw parseError("Missing required argument: --ledger <path>");
  }
  return options;
}

export async function appendGateSurvivors(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  const { repo, pr, gate, headSha, findings } = await readLedger(options.ledgerPath);
  const { config, errors } = await loadDevLoopConfig({ repoRoot });
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`append-gate-survivors: dev-loop config could not be loaded/validated (--repo-root ${JSON.stringify(repoRoot)}): ${JSON.stringify(errors)}`);
  }
  const blockCleanOnFindingSeverities = resolveGateConfig(config, mapGateToConfigKey(gate)).blockCleanOnFindingSeverities;
  const survivors = selectSurvivors(findings, blockCleanOnFindingSeverities);
  const base = { repo, pr, gate, headSha };
  if (survivors.length === 0) {
    return { ok: true, skipped: "no_survivors", count: 0, ...base };
  }
  const followUpIssue = options.followUpIssue ?? resolveGateFollowUpIssue(config);
  if (!Number.isInteger(followUpIssue) || followUpIssue <= 0) {
    throw new Error(
      `gates.followUpIssue is not configured but this gate close has ${survivors.length} survivor finding(s); configure it or pass --follow-up-issue`,
    );
  }
  const marker = buildSurvivorsMarker(base);
  const comments = await listIssueComments({ repo, pr: followUpIssue }, { env, ghCommand });
  const existing = findMarkedComment(comments, marker);
  if (existing) {
    return {
      ok: true,
      skipped: "already_filed",
      commentUrl: typeof existing.html_url === "string" ? existing.html_url : null,
      followUpIssue,
      ...base,
    };
  }
  const body = renderSurvivorsCommentBody({ ...base, survivors });
  const result = await commentIssue({ repo, issue: followUpIssue, body }, { env, ghCommand });
  return { ok: true, filed: survivors.length, commentUrl: result.commentUrl, followUpIssue, ...base };
}

async function main() {
  let options;
  try {
    options = parseAppendGateSurvivorsCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await appendGateSurvivors(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
