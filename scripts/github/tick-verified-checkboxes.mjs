#!/usr/bin/env node
// Sync verified AC/DoD checkboxes into the PR body and/or the linked issue body:
// after a clean pre_approval_gate verification, flip each verified item's `- [ ]`
// to `- [x]` in the PR body (a single `gh pr edit --body-file` update) and/or the
// linked issue body (`gh issue edit --body-file`, via edit-issue.mjs). Matches
// labels by EXACT (trimmed) text and fails closed — never blanket-checks, never
// unchecks. Pass --pr, --issue, or both; --pr alone preserves prior behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { editPr } from "./edit-pr.mjs";
import { viewPr } from "./view-pr.mjs";
import { editIssue } from "./edit-issue.mjs";
import { fetchIssueBody } from "../loop/detect-issue-refinement-artifact.mjs";

const USAGE = `Usage: tick-verified-checkboxes.mjs --repo <owner/name> (--pr <number> | --issue <number> | both) --verified <label> [--verified <label>...] [--dry-run]
Tick verified acceptance-criteria checkboxes in a PR body and/or the linked issue
body so both reflect reality after a clean pre_approval_gate verification. Flips
\`- [ ] <label>\` to \`- [x] <label>\` ONLY when <label> exactly equals a --verified
label (exact-match, fail-closed: never blanket-checks, never unchecks). Pass --pr
to tick the PR body, --issue to tick the issue body, or both to sync both in one
call (each via a single \`gh <pr|issue> edit --body-file\` update).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --pr <number>                 Pull request number (tick the PR body)
  --issue <number>              Issue number (tick the linked issue body)
                                At least one of --pr / --issue is required.
  --verified <label>            An exact (trimmed) checklist label that was verified
                                (repeatable; at least one is required)
Options:
  --dry-run                     Compute + report the flips but never edit anything
Output (stdout, JSON):
  { "ok": true,
    "pr": 17, "flipped": [...], "unmatched": [...], "edited": true|false,      // when --pr given
    "issue": 42, "issueFlipped": [...], "issueUnmatched": [...], "issueEdited": true|false }  // when --issue given
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

// GFM checklist line: optional indentation, a `-`/`*`/`+` bullet, a `[ ]`/`[x]`
// box, then the label. Capture indent + bullet so we preserve them on flip, and
// an optional trailing `\r` so CRLF bodies (as returned by `gh pr view`) round-
// trip byte-for-byte instead of silently failing to match.
const CHECKBOX_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*?)(\r?)$/;

// PURE: flip only unchecked checklist lines whose trimmed label EXACTLY equals a
// verified label. Never unchecks. Never touches non-checkbox text. Idempotent:
// an already-`[x]` verified label is neither flipped nor reported as unmatched.
// Returns { body, flipped, unmatched } where flipped = labels changed this call
// and unmatched = verified labels absent from the body's checklist.
export function tickVerifiedCheckboxes(body, verifiedLabels) {
  const verified = new Set(
    (verifiedLabels ?? []).map((l) => String(l).trim()).filter((l) => l.length > 0),
  );
  const flipped = [];
  const found = new Set();
  const lines = String(body).split("\n");
  const nextLines = lines.map((line) => {
    const m = line.match(CHECKBOX_RE);
    if (!m) return line;
    const [, indent, bullet, mark, rest, cr] = m;
    const label = rest.trim();
    if (!verified.has(label)) return line;
    found.add(label);
    if (mark !== " ") return line; // already checked — leave it, idempotent
    if (!flipped.includes(label)) flipped.push(label); // duplicate lines: report once
    return `${indent}${bullet} [x] ${rest}${cr}`;
  });
  const unmatched = [...verified].filter((label) => !found.has(label));
  return { body: nextLines.join("\n"), flipped, unmatched };
}

export function parseTickVerifiedCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      issue: { type: "string" },
      verified: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    issue: undefined,
    verified: [],
    dryRun: false,
    jq: undefined,
    silent: false,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "issue") {
      options.issue = parseIssueNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "verified") {
      const label = requireTokenValue(token, parseError).trim();
      if (label.length === 0) throw parseError("--verified must be a non-empty label");
      options.verified.push(label);
      continue;
    }
    if (token.name === "dry-run") {
      options.dryRun = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined) {
    throw parseError("Ticking checkboxes requires --repo <owner/name>");
  }
  if (options.pr === undefined && options.issue === undefined) {
    throw parseError("Ticking checkboxes requires at least one of --pr <number> / --issue <number>");
  }
  if (options.verified.length === 0) {
    throw parseError("at least one --verified is required");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// Tick `currentBody` for the verified labels and, when something flips (and not a
// dry run), persist it via `writeEdited(bodyFile)`. Shared by the PR and issue
// targets so the temp-file write/cleanup lives in one place.
async function applyTick(currentBody, verified, dryRun, writeEdited) {
  const { body: nextBody, flipped, unmatched } = tickVerifiedCheckboxes(currentBody, verified);
  if (flipped.length === 0 || dryRun) {
    return { flipped, unmatched, edited: false };
  }
  const dir = await mkdtemp(join(tmpdir(), "tick-verified-"));
  try {
    const bodyFile = join(dir, "body.md");
    await writeFile(bodyFile, nextBody, "utf8");
    await writeEdited(bodyFile);
    return { flipped, unmatched, edited: true };
  } finally {
    // Clean up the temp dir on success or failure; never let cleanup mask the result/error.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

export async function tickCheckboxes(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    run = runChild,
    editPr: edit = editPr,
    editIssue: editIss = editIssue,
    fetchIssueBody: fetchBody = fetchIssueBody,
  } = {},
) {
  const result = { ok: true };
  // PR body — reuse view-pr.mjs rather than re-implementing `gh pr view --json body`.
  if (options.pr !== undefined) {
    const { pr } = await viewPr(
      { repo: options.repo, pr: options.pr, fields: "body" },
      { env, ghCommand, run },
    );
    const currentBody = typeof pr.body === "string" ? pr.body : "";
    const r = await applyTick(currentBody, options.verified, options.dryRun, (bodyFile) =>
      edit(
        { repo: options.repo, pr: options.pr, bodyFile, addAssignees: [], removeAssignees: [] },
        { env, ghCommand, run },
      ),
    );
    result.pr = options.pr;
    result.flipped = r.flipped;
    result.unmatched = r.unmatched;
    result.edited = r.edited;
  }
  // Linked issue body — the sync that keeps the tracker's AC checkboxes honest.
  if (options.issue !== undefined) {
    const currentBody = await fetchBody(
      { repo: options.repo, issue: options.issue },
      { env, ghCommand, runChild: run },
    );
    const r = await applyTick(currentBody, options.verified, options.dryRun, (bodyFile) =>
      editIss(
        { repo: options.repo, issue: options.issue, bodyFile, addAssignees: [], removeAssignees: [] },
        { env, ghCommand, run },
      ),
    );
    result.issue = options.issue;
    result.issueFlipped = r.flipped;
    result.issueUnmatched = r.unmatched;
    result.issueEdited = r.edited;
  }
  return result;
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild, editPr: edit = editPr } = {},
) {
  let options;
  try {
    options = parseTickVerifiedCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  let result;
  try {
    result = await tickCheckboxes(options, { env, ghCommand, run, editPr: edit });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
