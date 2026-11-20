#!/usr/bin/env node
/**
 * decision record — the sanctioned writer of an operator decision comment (OPERATOR-DECISION-RECORDER).
 * Slice 1 writes the record-only kinds `accept`, `exempt` and `defer`. The `permissions.ask` rule in
 * .claude/settings.json is the operator's approval prompt, so the recorder runs only under Claude
 * (`CLAUDECODE=1`); any other harness refuses with `harness_without_permission_prompt`.
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ghJson } from "@dev-loops/core/github/gh";
import { guardCommentBodyNoIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { commentIssue } from "@dev-loops/core/github/issue-ops";
import { isClaudeHarness } from "@dev-loops/core/loop/run-context";
import { assertSupportedKind, buildDecisionComment, HEADER_MARKER, isFullHead, parseAnswerFile } from "@dev-loops/core/github/operator-decision-record";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: dev-loops decision record --repo <owner/name> --target <pr|issue> <number> --kind <accept|exempt|defer> [--head <40-hex>] --operator-answer-file <path> --body-file <path>
Post one operator decision comment: a reason line, a \`dev-loops:operator-decision\` header, the quoted question and answer, then the body.
The operator answer file is JSON: {"question": "...", "option": "...", "answer": "..."} as the question tool returned them.
--head is required for a PR target (it must be the live head) and refused for an issue target.
The kinds approve-merge, adr-allow and copilot-disposition are not yet supported.
Runs only under Claude Code (CLAUDECODE=1) behind the \`permissions.ask\` prompt; elsewhere it refuses with
reason harness_without_permission_prompt and the operator posts the line by hand.
Success (stdout, JSON): { "ok": true, "action": "decision_recorded", "repo": "...", "target": "...", "number": 0, "kind": "...", "commentUrl": "..." }
Refusal (stderr, JSON, exit 1): { "ok": false, "refused": true, "reason": "<code>", "detail": "..." }
Reason codes: harness_without_permission_prompt, head_required, head_forbidden, head_malformed, file_unreadable,
answer_file_invalid, empty_body, header_marker_in_input, comment_guard_refused, target_closed, target_is_pull_request,
stale_head, recorder_error.
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);

export function parseRecordCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, target: { type: "string" }, kind: { type: "string" }, head: { type: "string" }, "operator-answer-file": { type: "string" }, "body-file": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const o = { help: false, jq: undefined, silent: false };
  for (const t of tokens) {
    if (t.kind === "positional") {
      if (o.number !== undefined) throw parseError(`Unknown argument: ${t.value}`);
      o.number = parseIssueNumber(t.value, parseError);
      continue;
    }
    if (t.kind !== "option") continue;
    if (t.name === "help") return { ...o, help: true };
    const take = () => requireTokenValue(t, parseError).trim();
    if (t.name === "repo") o.repo = take();
    else if (t.name === "target") o.target = take();
    else if (t.name === "kind") o.kind = take();
    else if (t.name === "head") o.head = take();
    else if (t.name === "operator-answer-file") o.answerFile = take();
    else if (t.name === "body-file") o.bodyFile = take();
    else if (!matchJqOutputToken(t, o, (x) => requireTokenValue(x, parseError))) throw parseError(`Unknown argument: ${t.rawName}`);
  }
  if (!o.repo || !o.target || o.number === undefined || !o.kind || !o.answerFile || !o.bodyFile) {
    throw parseError("decision record requires --repo, --target <pr|issue> <number>, --kind, --operator-answer-file and --body-file");
  }
  if (o.target !== "pr" && o.target !== "issue") throw parseError("--target must be pr or issue");
  try { parseRepoSlug(o.repo); assertSupportedKind(o.kind); } catch (e) { throw parseError(e.message); }
  return o;
}

const refuse = (reason, detail) => ({ ok: false, refused: true, reason, detail: `OPERATOR-DECISION-RECORDER: ${detail}` });
const readText = (path) => readFile(path).catch((e) => { throw Object.assign(e, { unreadable: path }); });

export async function recordDecision(o, { env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  if (!isClaudeHarness(env)) {
    return refuse("harness_without_permission_prompt", "this harness has no per-call permission prompt, so the recorder does not run; the operator posts the decision comment by hand");
  }
  const isPr = o.target === "pr";
  if (isPr && o.head === undefined) return refuse("head_required", "a PR target needs --head <40-hex>");
  if (!isPr && o.head !== undefined) return refuse("head_forbidden", "an issue target has no head; drop --head");
  if (isPr && !isFullHead(o.head)) return refuse("head_malformed", "--head must be a full 40-hex SHA");
  let answerBytes;
  let body;
  try {
    answerBytes = await readText(o.answerFile);
    body = (await readText(o.bodyFile)).toString("utf8");
  } catch (e) {
    if (e.unreadable) return refuse("file_unreadable", `cannot read ${e.unreadable} (${e.code ?? "unknown error"})`);
    throw e;
  }
  let answer;
  try { answer = parseAnswerFile(answerBytes.toString("utf8")); } catch (e) { return refuse("answer_file_invalid", e.message); }
  if (body.trim() === "") return refuse("empty_body", "the body file is empty");
  // The parsed fields, not the raw bytes: a JSON escape such as `:` hides the marker from a byte check.
  if ([answer.question, answer.option, answer.answer, body].some((text) => text.includes(HEADER_MARKER))) return refuse("header_marker_in_input", `the answer file and the body must not contain ${HEADER_MARKER}`);
  const live = await ghJson([isPr ? "pr" : "issue", "view", String(o.number), "--repo", o.repo, "--json", isPr ? "state,headRefOid" : "state,url"], { env, ghCommand, runChild: run });
  if (!isPr && /\/pull\/\d+$/u.test(String(live.url))) return refuse("target_is_pull_request", `#${o.number} is a pull request; use --target pr`);
  if (live.state !== "OPEN") return refuse("target_closed", `the ${o.target} is ${String(live.state).toLowerCase()}`);
  if (isPr && live.headRefOid !== o.head) return refuse("stale_head", `--head is not the live head ${live.headRefOid}`);
  const comment = buildDecisionComment({ kind: o.kind, targetType: o.target, number: o.number, head: isPr ? o.head : null, answerBytes, answer, body });
  try { guardCommentBodyNoIssuePrIds(comment, { ref: "operator decision comment" }); } catch (e) { return refuse("comment_guard_refused", e.message); }
  const { commentUrl } = await commentIssue({ repo: o.repo, issue: o.number, body: comment }, { env, ghCommand, run });
  return { ok: true, action: "decision_recorded", repo: o.repo, target: o.target, number: o.number, kind: o.kind, commentUrl };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  let options;
  try { options = parseRecordCliArgs(argv); } catch (e) { stderr.write(`${formatCliError(e)}\n`); return 1; }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
  let result;
  try { result = await recordDecision(options, { env, ghCommand, run }); } catch (e) { result = refuse("recorder_error", e instanceof Error ? e.message : String(e)); }
  if (result.refused) { stderr.write(`${JSON.stringify(result)}\n`); return 1; }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) runCli().then((code) => { process.exitCode = code; });
