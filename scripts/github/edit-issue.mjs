#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parseIssueNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { editIssue as coreEditIssue } from "@dev-loops/core/github/issue-ops";
import { detectGrillEmbedHeading } from "@dev-loops/core/loop/issue-refinement-artifact";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: edit-issue.mjs --repo <owner/name> --issue <number> [--title <t>] [--body <b> | --body-file <path>] [--add-assignee <u>] [--remove-assignee <u>] [--milestone <m>] [--state <open|closed>] [--reason <completed|not_planned>]
Edit issue title/body/assignees/milestone/state. Thin wrapper over \`gh issue edit\`
(plus \`gh issue close\`/\`gh issue reopen\` for --state) — use this instead of an
agent-level raw \`gh issue edit\`/\`gh issue close\`/\`gh issue reopen\` so the loop's
internal-tooling record stays clean (siblings: edit-pr.mjs, comment-issue.mjs).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --issue <number>              Issue number
At least one edit:
  --title <t>                   New issue title
  --body <b>                    New issue body as a single argument
  --body-file <path>            Read the new body from a file (- reads stdin)
  --add-assignee <u>            Assignee to add (repeatable)
  --remove-assignee <u>         Assignee to remove (repeatable)
  --milestone <m>               Milestone to set (empty string clears it)
                                (--title/--body/--body-file reject empty or
                                whitespace-only values; use --milestone "" only
                                to clear the milestone)
  --state <open|closed>         Close or reopen the issue (a separate \`gh issue
                                close\`/\`gh issue reopen\` call, run after any
                                other edits above; valid alone or combined)
  --reason <completed|not_planned>
                                Close reason; only valid together with
                                --state closed
  --enforce-grill               Opt-in GRILL-SUBLOOP-NO-EMBED-SYNTHESIS (#1628):
                                refuse a body that embeds grill
                                transcript/synthesis/Q&A headings.
Output (stdout, JSON):
  { "ok": true, "repo": "owner/repo", "issue": 17, "edited": ["title", "body", ..., "state"] }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseEditIssueCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      "add-assignee": { type: "string", multiple: true },
      "remove-assignee": { type: "string", multiple: true },
      milestone: { type: "string" },
      state: { type: "string" },
      reason: { type: "string" },
      "enforce-grill": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    issue: undefined,
    title: undefined,
    body: undefined,
    bodyFile: undefined,
    addAssignees: [],
    removeAssignees: [],
    milestone: undefined,
    state: undefined,
    reason: undefined,
    enforceGrill: false,
    jq: undefined,
    silent: false,
  };
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
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "issue") {
      options.issue = parseIssueNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "title") {
      const title = requireTokenValue(token, parseError);
      if (title.trim().length === 0) {
        throw parseError("--title must not be empty or whitespace-only");
      }
      options.title = title;
      continue;
    }
    if (token.name === "body") {
      const body = requireTokenValue(token, parseError);
      if (body.trim().length === 0) {
        throw parseError("--body must not be empty or whitespace-only");
      }
      options.body = body;
      continue;
    }
    if (token.name === "body-file") {
      const rawPath = requireTokenValue(token, parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--body-file must be a non-empty path");
      }
      options.bodyFile = rawPath;
      continue;
    }
    if (token.name === "add-assignee") {
      const u = requireTokenValue(token, parseError).trim();
      if (u.length === 0) throw parseError("--add-assignee must be a non-empty login");
      options.addAssignees.push(u);
      continue;
    }
    if (token.name === "remove-assignee") {
      const u = requireTokenValue(token, parseError).trim();
      if (u.length === 0) throw parseError("--remove-assignee must be a non-empty login");
      options.removeAssignees.push(u);
      continue;
    }
    if (token.name === "milestone") {
      // Read the raw token value: an empty string is a valid milestone value
      // (`gh issue edit --milestone ""` clears it), so this deliberately does NOT
      // go through requireTokenValue (which rejects empty). Guard only a truly
      // missing value (`--milestone` with no following token). A whitespace-only
      // value is neither a clear nor a real milestone name — fail closed rather
      // than forwarding it to gh for a less actionable error.
      if (typeof token.value !== "string") {
        throw parseError("--milestone requires a value (use an empty string to clear)");
      }
      if (token.value.length > 0 && token.value.trim().length === 0) {
        throw parseError('--milestone must be a milestone name or "" to clear (whitespace-only is not allowed)');
      }
      options.milestone = token.value;
      continue;
    }
    if (token.name === "state") {
      const s = requireTokenValue(token, parseError).trim();
      if (s !== "open" && s !== "closed") {
        throw parseError(`--state must be "open" or "closed" (got: "${s}")`);
      }
      options.state = s;
      continue;
    }
    if (token.name === "reason") {
      const r = requireTokenValue(token, parseError).trim();
      if (r !== "completed" && r !== "not_planned") {
        throw parseError(`--reason must be "completed" or "not_planned" (got: "${r}")`);
      }
      options.reason = r;
      continue;
    }
    if (token.name === "enforce-grill") {
      options.enforceGrill = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("Editing an issue requires both --repo <owner/name> and --issue <number>");
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw parseError("--body and --body-file are mutually exclusive; pass only one");
  }
  if (options.reason !== undefined && options.state !== "closed") {
    throw parseError("--reason is only valid together with --state closed");
  }
  const hasEdit =
    options.title !== undefined ||
    options.body !== undefined ||
    options.bodyFile !== undefined ||
    options.addAssignees.length > 0 ||
    options.removeAssignees.length > 0 ||
    options.milestone !== undefined ||
    options.state !== undefined;
  if (!hasEdit) {
    throw parseError("Editing an issue requires at least one of --title/--body/--body-file/--add-assignee/--remove-assignee/--milestone/--state");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

export async function editIssue(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  // GRILL-SUBLOOP-NO-EMBED-SYNTHESIS (#1628): behind the --enforce-grill opt-in,
  // refuse to write a body that embeds grill transcript/synthesis/Q&A headings.
  if (options.enforceGrill && (options.body !== undefined || options.bodyFile !== undefined)) {
    // Resolve the body ONCE (inline, stdin, or file). The stdin/file read fails
    // closed on an empty / whitespace-only value so a blank --body-file cannot
    // silently clear the issue body — mirroring edit-pr's resolveBody (USAGE
    // promises --body / --body-file reject empties).
    let body = options.body;
    if (body === undefined) {
      if (options.bodyFile === "-") {
        body = readFileSync(0, "utf8");
      } else {
        body = await readFile(options.bodyFile, "utf8");
      }
      if (body.trim().length === 0) {
        throw new Error(`--body-file ${options.bodyFile} is empty`);
      }
    }
    const heading = detectGrillEmbedHeading(body);
    if (heading !== null) {
      throw new Error(
        `GRILL-SUBLOOP-NO-EMBED-SYNTHESIS: issue body embeds grill material under heading \`## ${heading}\`; ` +
        `the raw grill transcript/synthesis/Q&A must stay in an ephemeral tmp artifact, not the durable issue body.`,
      );
    }
    // Stdin (`--body-file -`) was consumed above to run the grill check; forward
    // the resolved text inline so the core edit reuses it instead of re-reading
    // the exhausted fd 0 (which would yield "" and throw).
    if (options.bodyFile === "-") {
      options.body = body;
      options.bodyFile = undefined;
    }
  }
  return coreEditIssue(options, { env, ghCommand, run });
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseEditIssueCliArgs(argv);
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
    result = await editIssue(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
