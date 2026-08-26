#!/usr/bin/env node
import { spawn } from "node:child_process";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, resolveBodyOrFile, runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveSettings, applyDevloopsBoard } from "../projects/_resolve-project.mjs";
import { main as addQueueItemMain } from "../projects/add-queue-item.mjs";
import { loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
import { detectLinkedIssuePr } from "./detect-linked-issue-pr.mjs";
const USAGE = `Usage: create-pr.mjs [gh pr create args...]
Canonical PR-creation wrapper around \`gh pr create\`. Every PR opened through this
tool is ALWAYS a draft and is self-assigned by default. Never call raw \`gh pr create\`.
Behavior:
  - injects exactly one \`--draft\` when absent (draft is the only mode)
  - defaults \`--assignee @me\` when no assignee is given (self-assigned by default)
  - honors an explicit \`--assignee <login>\` / \`-a <login>\` when supplied (no default injected)
  - rejects \`--ready\` before invoking \`gh\`
  - accepts \`--issue <n>\` (consumed here, never forwarded to \`gh\`): declares the
    tracker link this PR closes and makes a missing or mismatched \`Closes #N\`/
    \`Fixes #N\` closing reference in \`--body\`/\`--body-file\` FATAL (refused before
    \`gh\` is invoked). Without \`--issue\` the closing keyword is not enforced
    (issue-less \`--lightweight\` PRs intentionally carry none).
  - refuses opening a PR whose closing keyword/\`--issue\` names an issue that already
    has an open same-repo linked PR (FACADE-LINKED-PR-SINGLE-ARTIFACT), naming the prior
    PR; \`--allow-replacement-pr <prior>\` (consumed here, never forwarded to \`gh\`)
    records a deliberate replacement and lets the create through when <prior> matches the
    detected open linked-PR number. This adds the first network call (a same-repo linked-PR
    probe) to an otherwise-offline wrapper; when it cannot run (no \`--repo\`, or the GitHub
    API unavailable) the guard FAILS CLOSED on ambiguity rather than silently risking a
    duplicate.
  - \`--lightweight\` (consumed here in every form — bare or \`=true/1/false/0\`, last
    occurrence wins — never forwarded to \`gh\`): when an explicit \`--body\`/
    \`--body-file\` also carries no \`Closes #N\`/\`Fixes #N\`, the new PR is issue-less
    lightweight and is auto-enqueued as a board PR item in the configured In Progress column
    (reuses \`queue.board.number\` / \`queue.board.title\` from \`.devloops\`, same as the queue
    scripts). Requires an explicit \`--repo owner/name\` (space or = form). A trailing stdout
    line reports the outcome: \`{"board":{"enqueued":bool,...}}\`. No board configured, no
    \`--repo\`, no explicit body source, or an enqueue error is a non-fatal no-op (noted in
    that line; exit code unaffected). Omitting \`--lightweight\`, or a body that already
    carries a closing keyword (tracker-backed), never calls the board.
  - forwards every other argument to \`gh pr create\` unchanged
  - preserves the underlying \`gh pr create\` stdout, stderr, and exit code
Examples:
  node scripts/github/create-pr.mjs --repo owner/repo --base main --head feature --title "..." --body-file pr.md
  node <resolved-skill-scripts>/github/create-pr.mjs --repo owner/repo --base main --head feature --title "..." --body-file pr.md
Notes:
  - Use \`gh pr ready\` later to leave draft state; this wrapper never opens a ready PR.
  - Wrapper-owned validation: \`--ready\` (rejected), \`--issue\` closing-reference enforcement, and the linked-PR duplicate guard; all other argument validation is left to \`gh pr create\`.
  - \`--issue <n>\` makes the closing reference a MUST (refused if missing or mismatched); without \`--issue\` the closing keyword is not enforced.
  - The linked-PR duplicate guard runs for any closing keyword/\`--issue\` and fails closed on ambiguity when the probe cannot run.
Exit codes:
  0  \`gh pr create\` succeeded
  1  wrapper validation failed or \`gh\` could not be spawned
  N  same non-zero exit code returned by \`gh pr create\``.trim();
const parseError = buildParseError(USAGE);
const READY_FLAG_PATTERN = /^--ready(?:$|=)/u;
// Bare and inline-boolean forms, mirroring DRAFT_FLAG_PATTERN below: every
// matching token is consumed (never forwarded to gh, which rejects unknown
// flags), and the LAST occurrence decides — bare or =true/=1 enables,
// anything else (=false, =0, ...) disables.
const LIGHTWEIGHT_FLAG_PATTERN = /^--lightweight(?:=(.*))?$/iu;
// #1626: `--issue <n>` declares the tracker link this PR closes. Consumed by the
// wrapper (never forwarded to gh), same shape as --repo.
const ISSUE_FLAG_PATTERN = /^--issue(?:=(.*))?$/u;
// #1629: `--allow-replacement-pr <prior>` records a deliberate replacement of
// an existing open linked PR, overriding the duplicate-refusal guard. Consumed
// by the wrapper (never forwarded to gh).
const ALLOW_REPLACEMENT_FLAG_PATTERN = /^--allow-replacement-pr(?:=(.*))?$/u;
// Both `--repo owner/name` and `--repo=owner/name` — gh accepts either form.
const REPO_FLAG_PATTERN = /^--repo(?:$|=)/u;
const PR_URL_NUMBER_PATTERN = /\/pull\/(\d+)(?:\D|$)/u;
const DRAFT_FLAG_PATTERN = /^--draft(?:=(.*))?$/iu;
// Shared inline-boolean truthiness for --draft= and --lightweight= values.
const TRUE_FLAG_VALUE_PATTERN = /^(?:true|1)$/iu;
// Detect both the long `--assignee`/`--assignee=<login>` forms and the `-a`
// short flag that `gh pr create` documents, so an explicit assignee in either
// form suppresses the `--assignee @me` default (otherwise a caller passing
// `-a <login>` would get a conflicting `--assignee @me` injected). (#894)
const ASSIGNEE_FLAG_PATTERN = /^(?:--assignee(?:$|=)|-a$)/u;
const DEFAULT_ASSIGNEE = "@me";
const CLOSING_KEYWORD_PATTERN = /Closes\s+#(\d+)|Fixes\s+#(\d+)/i;
const MAX_BODY_SCAN_BYTES = 16 * 1024;
export function detectClosingKeyword(body) {
  if (!body || typeof body !== "string") return false;
  return CLOSING_KEYWORD_PATTERN.test(body.slice(0, MAX_BODY_SCAN_BYTES));
}
// #1626: extract the issue number from a `Closes #N` / `Fixes #N` closing
// reference so create-pr can REFUSE a missing or mismatched reference when
// `--issue <n>` declares the tracker link (a warning is invisible under --jq).
export function extractClosingIssueNumber(body) {
  if (!body || typeof body !== "string") return null;
  const match = CLOSING_KEYWORD_PATTERN.exec(body.slice(0, MAX_BODY_SCAN_BYTES));
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}
// Never reads stdin (`gh pr create` doesn't either — body always comes from an
// explicit --body/--body-file), so allowStdin stays false. An unreadable or
// empty --body-file FAILS CLOSED (throws) rather than silently substituting ""
// (which used to let a broken/blank --body-file open a body-less PR unnoticed).
async function resolveBody(args) {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx !== -1 && bodyIdx + 1 < args.length) {
    return args[bodyIdx + 1];
  }
  const bodyFileIdx = args.indexOf("--body-file");
  if (bodyFileIdx !== -1 && bodyFileIdx + 1 < args.length) {
    return resolveBodyOrFile({ bodyFile: args[bodyFileIdx + 1], allowStdin: false });
  }
  return null; // no --body/--body-file given
}
// A plain string value for a single-value flag, in both the space form
// (`--repo owner/name`) and the inline form (`--repo=owner/name`); unlike
// resolveBody, never reads a file. Returns null when the flag is absent.
function getFlagValue(args, flagPattern) {
  const idx = args.findIndex((token) => flagPattern.test(token));
  if (idx === -1) return null;
  const eq = args[idx].indexOf("=");
  if (eq !== -1) return args[idx].slice(eq + 1);
  return idx + 1 < args.length ? args[idx + 1] : null;
}
function parsePrNumberFromOutput(stdout) {
  const match = PR_URL_NUMBER_PATTERN.exec(stdout ?? "");
  return match ? Number(match[1]) : null;
}
// Auto-enqueue ANY board item (issue or PR) into the given Status column — a
// generic, idempotent, fail-open board add shared by create-pr (lightweight
// PRs -> In Progress) and create-issue (new issues -> Backlog). This is the
// "one guard where all callers route" fix for QUEUE-BOARD-LINKED: a guard that
// only lives at one entry point. Reuses the same .devloops queue.board.number /
// queue.board.title resolution and add-queue-item's idempotent add — never
// reimplements the board API calls. An ADD (not a status transition) — board
// status transitions stay orchestrator-owned per sanctioned-commands.mjs.
// Never throws: an unconfigured board, a missing --repo, an unparsed item
// number, or an enqueue failure are all non-fatal no-ops reported in the
// returned shape. `column` defaults to the configured In Progress column (the
// historical lightweight-PR behavior).
export async function enqueueBoardItem({ repo, itemNumber, column, cwd, env, runChild }) {
  if (!repo) return { enqueued: false, reason: "repo-not-specified" };
  if (!Number.isInteger(itemNumber) || itemNumber < 1) return { enqueued: false, reason: "item-number-not-parsed" };
  const settings = resolveSettings(cwd);
  if (!settings?.project && !settings?.title) {
    return { enqueued: false, reason: "no-board-configured" };
  }
  const { columnNames, error: columnError } = loadStateColumnMap(cwd);
  if (columnError) {
    return { enqueued: false, reason: `config-error: ${columnError}` };
  }
  const args = { repo, item: itemNumber };
  applyDevloopsBoard(args, cwd);
  args.column = column ?? columnNames[LOGICAL_COLUMN.IN_PROGRESS];
  try {
    const result = await addQueueItemMain(args, { env, runChild, cwd });
    const { itemId, issueNumber, prNumber, status, alreadyPresent } = result.item;
    return { enqueued: true, itemId, issueNumber, prNumber, status, alreadyPresent };
  } catch (err) {
    return { enqueued: false, reason: `enqueue-error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Back-compat alias: issue-less lightweight PRs enqueue into In Progress. Keeps
// the historical return contract (prNumber + no issueNumber) so existing
// consumers of the lightweight-PR board note stay unchanged.
export async function enqueueIssuelessLightweightPr({ repo, prNumber, cwd, env, runChild }) {
  if (!Number.isInteger(prNumber) || prNumber < 1) return { enqueued: false, reason: "pr-number-not-parsed" };
  const board = await enqueueBoardItem({ repo, itemNumber: prNumber, cwd, env, runChild });
  if (board.reason === "item-number-not-parsed") board.reason = "pr-number-not-parsed";
  if (board.enqueued) {
    const { itemId, prNumber: n, status, alreadyPresent } = board;
    return { enqueued: true, itemId, prNumber: n, status, alreadyPresent };
  }
  return board;
}
// #1629: FACADE-LINKED-PR-SINGLE-ARTIFACT — refuse opening a PR whose closing
// keyword/`--issue` names an issue that already has an open same-repo linked
// PR, so no issue can accrue a second open PR that would silently shadow the
// first. A deliberate replacement records its intent via `--allow-replacement-pr
// <prior>` (which matches the detected open linked-PR number). Issue-less
// lightweight PRs carry no closing keyword and are exempt. When the check
// cannot run because `--repo` is absent or the GitHub API is unavailable, the
// guard FAILS CLOSED on ambiguity rather than silently risking a duplicate.
//
// Return value: `{ refusal: string | null, replaced?: number }`. `refusal` is
// a non-null reason string to refuse with (null = allow), `replaced` records the
// prior PR number when an explicit replacement override was honored.
export async function resolveLinkedPrGuard({ repo, issue, allowReplacementPr, runtime = {} }) {
  // #1629: treat an absent OR empty/whitespace repo slug as missing — an
  // empty `--repo=`/`--repo ""` would otherwise reach the network probe with
  // an invalid value and be misreported as "API unavailable" instead of the
  // honest fail-closed ambiguity refusal (copilot review finding).
  if (repo === null || (typeof repo === "string" && repo.trim() === "")) {
    return { refusal: `FACADE-LINKED-PR-SINGLE-ARTIFACT: cannot verify whether issue #${issue} already has an open linked PR because --repo owner/name was not provided — refusing on ambiguity (fail closed). Pass --repo owner/name to enable the same-repo duplicate-linked-PR check.` };
  }
  let linked;
  try {
    linked = await detectLinkedIssuePr({ repo, issue }, { env: runtime.env, ghCommand: runtime.ghCommand, runChild: runtime.runChild });
  } catch (err) {
    return { refusal: `FACADE-LINKED-PR-SINGLE-ARTIFACT: could not verify whether issue #${issue} already has an open linked PR because the GitHub API was unavailable (${err instanceof Error ? err.message : String(err)}) — refusing on ambiguity (fail closed).` };
  }
  if (!linked.hasOpenLinkedPr) {
    return { refusal: null };
  }
  if (allowReplacementPr !== null && Number(allowReplacementPr) === Number(linked.prNumber)) {
    return { refusal: null, replaced: linked.prNumber };
  }
  return { refusal: `FACADE-LINKED-PR-SINGLE-ARTIFACT: issue #${issue} already has an open linked PR #${linked.prNumber} (${linked.prUrl}) — refusing to open a duplicate. Pass --allow-replacement-pr ${linked.prNumber} to record a deliberate replacement.` };
}

export function buildCreatePrArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    return {
      help: true,
      ghArgs: null,
    };
  }
  if (args.some((token) => READY_FLAG_PATTERN.test(token))) {
    throw parseError("create-pr rejects --ready; open the PR as draft first, then run `gh pr ready` after the draft gate is satisfied");
  }
  const draftTokens = args.filter((token) => DRAFT_FLAG_PATTERN.test(token));
  const lastDraftToken = draftTokens.length > 0 ? draftTokens.at(-1) : null;
  const lastDraftSuppliesDraft = lastDraftToken === "--draft" || (typeof lastDraftToken === "string" && TRUE_FLAG_VALUE_PATTERN.test(lastDraftToken.slice("--draft=".length)));
  const hasAssignee = args.some((token) => ASSIGNEE_FLAG_PATTERN.test(token));
  return {
    help: false,
    ghArgs: [
      "pr",
      "create",
      ...args,
      ...(hasAssignee ? [] : ["--assignee", DEFAULT_ASSIGNEE]),
      ...(lastDraftSuppliesDraft ? [] : ["--draft"]),
    ],
  };
}
// captureStdout tees gh's stdout to a buffer (still writing it straight through to
// process.stdout, unbuffered) so the PR URL can be parsed once gh exits, without
// changing what a caller/terminal sees. Only enabled for the issue-less lightweight
// path; every other caller keeps the plain "inherit" byte-identical behavior.
export function spawnCreatePr(ghArgs, { ghCommand = "gh", env = process.env } = {}, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    // `gh pr create` never reads stdin (body comes from --body/--body-file), so
    // the captured path ignores it rather than inheriting: inheriting a
    // never-closing stdin (e.g. an in-process test runner) would hang any child
    // that waits for stdin to end.
    const child = spawn(ghCommand, ghArgs, {
      env,
      stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (captureStdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: typeof code === "number" ? code : 1, stdout });
    });
  });
}
export async function main(argv = process.argv.slice(2), runtime = {}) {
  // --help/-h short-circuits BEFORE wrapper-owned validation (#1626 Copilot
  // finding): otherwise `--help --issue` (or a valueless `--issue`) would throw
  // an --issue validation error before help is honored.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // Last occurrence wins, same as the --draft handling in buildCreatePrArgs.
  const lastLightweightToken = argv.filter((token) => LIGHTWEIGHT_FLAG_PATTERN.test(token)).at(-1) ?? null;
  const lightweight = lastLightweightToken === "--lightweight" ||
    (typeof lastLightweightToken === "string" && TRUE_FLAG_VALUE_PATTERN.test(lastLightweightToken.slice("--lightweight=".length)));
  // #1626: --issue <n> declares the tracker link this PR closes. Consumed by
  // the wrapper (never forwarded to gh) and makes the closing reference
  // (`Closes #n` / `Fixes #n`) a MUST — missing or mismatched is refused.
  const issuePresent = argv.some((token) => ISSUE_FLAG_PATTERN.test(token));
  const issueRaw = getFlagValue(argv, ISSUE_FLAG_PATTERN);
  let issue = null;
  if (issuePresent) {
    // A present-but-valueless --issue (bare trailing token, or `--issue=`)
    // MUST refuse rather than silently skip enforcement — silently dropping
    // the MUST on a malformed invocation is the exact gap this PR closes.
    // #1645: route through the shared parseIssueNumber primitive so the
    // positive-integer rule lives in one place (@dev-loops/core/cli/primitives).
    issue = parseIssueNumber(issueRaw, parseError);
  }
  // #1629: --allow-replacement-pr <prior> records a deliberate replacement of
  // an existing open linked PR (must match the detected prior PR number).
  // A present-but-valueless flag (bare trailing token, or `--allow-replacement-pr=`)
  // MUST refuse rather than silently skip the override — mirroring the
  // --issue MUST (copilot review finding).
  const allowReplacementPresent = argv.some((token) => ALLOW_REPLACEMENT_FLAG_PATTERN.test(token));
  const allowReplacementRaw = getFlagValue(argv, ALLOW_REPLACEMENT_FLAG_PATTERN);
  if (allowReplacementPresent && (allowReplacementRaw === null || allowReplacementRaw.trim() === "")) {
    throw parseError("--allow-replacement-pr requires a positive integer PR number (the existing open linked PR being replaced)");
  }
  let allowReplacementPr = null;
  if (allowReplacementRaw !== null) {
    const trimmed = allowReplacementRaw.trim();
    if (!/^[1-9]\d*$/u.test(trimmed)) {
      throw parseError("--allow-replacement-pr must be a positive integer PR number (the existing open linked PR being replaced)");
    }
    allowReplacementPr = Number(trimmed);
  }
  // Strip --lightweight, --issue, and --allow-replacement-pr (each with its
  // value in the space form) so none is forwarded to `gh pr create` (which
  // rejects unknown flags).
  // for...of + skip-flag avoids a hand-rolled index loop (arg-parsing contract).
  const forwardedArgv = [];
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) { skipNext = false; continue; }
    if (LIGHTWEIGHT_FLAG_PATTERN.test(token)) continue;
    if (ISSUE_FLAG_PATTERN.test(token)) {
      // = form carries the value; space form consumes the next token too.
      if (!token.includes("=")) skipNext = true;
      continue;
    }
    if (ALLOW_REPLACEMENT_FLAG_PATTERN.test(token)) {
      // = form carries the value; space form consumes the next token too.
      if (!token.includes("=")) skipNext = true;
      continue;
    }
    forwardedArgv.push(token);
  }
  const { help, ghArgs } = buildCreatePrArgs(forwardedArgv);
  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const body = await resolveBody(forwardedArgv);
  // #1626: with --issue <n> the closing reference is a MUST. A warning is
  // invisible under --jq (which the repo's token-discipline contract
  // mandates), so a missing or mismatched reference is refused before gh is
  // invoked. Without --issue the caller has not declared a tracker link, so
  // there is nothing to enforce (issue-less lightweight PRs intentionally
  // carry no closing keyword).
  if (issue !== null) {
    const closingNumber = extractClosingIssueNumber(body);
    if (closingNumber === null) {
      throw parseError(`--issue ${issue} requires a closing reference (Closes #${issue} or Fixes #${issue}) in --body/--body-file, but none was found — GitHub will not auto-close the linked issue on merge`);
    }
    if (closingNumber !== issue) {
      throw parseError(`--issue ${issue} requires the closing reference to match, but the body closes #${closingNumber} — refusing a mismatched closing reference`);
    }
  }
  // Issue-less lightweight: caller signals lightweight AND an explicit body
  // source (--body/--body-file) carries no closing keyword. A tracker-backed
  // lightweight PR (closing keyword present) never reaches the board — its
  // issue already owns the board entry. A null body (no explicit source) is
  // NOT classified issue-less: the body may come from elsewhere (editor,
  // template) and could carry a closing keyword this wrapper never saw, so it
  // fails toward not enqueuing and reports body-not-provided instead.
  const issueLess = lightweight && body !== null && !detectClosingKeyword(body);
  // #1629: FACADE-LINKED-PR-SINGLE-ARTIFACT — refuse to open a second PR
  // against an issue that already has an open same-repo linked PR (the closing
  // keyword in the body names the tracker issue). Issue-less lightweight PRs
  // carry no closing keyword and are exempt. This is the first network call in
  // an otherwise-offline wrapper; the guard FAILS CLOSED on ambiguity (missing
  // --repo, or the GitHub API unavailable) rather than silently risking a
  // duplicate. A matching --allow-replacement-pr <prior> records the intent and
  // lets the replacement through.
  const closingIssue = issue ?? extractClosingIssueNumber(body);
  if (closingIssue !== null) {
    const guard = await resolveLinkedPrGuard({
      repo: getFlagValue(forwardedArgv, REPO_FLAG_PATTERN),
      issue: closingIssue,
      allowReplacementPr,
      runtime,
    });
    if (guard.refusal) {
      throw parseError(guard.refusal);
    }
    if (guard.replaced) {
      process.stderr.write(`[create-pr] FACADE-LINKED-PR-SINGLE-ARTIFACT: opening replacement PR, replacing linked PR #${guard.replaced} for issue #${closingIssue}.\n`);
    }
  }
  const { code, stdout } = await spawnCreatePr(ghArgs, runtime, { captureStdout: issueLess });
  if (lightweight && code === 0 && (issueLess || body === null)) {
    const board = issueLess
      ? await enqueueIssuelessLightweightPr({
          repo: getFlagValue(forwardedArgv, REPO_FLAG_PATTERN),
          prNumber: parsePrNumberFromOutput(stdout),
          cwd: runtime.cwd ?? process.cwd(),
          env: runtime.env ?? process.env,
          runChild: runtime.runChild ?? _runChild,
        })
      : { enqueued: false, reason: "body-not-provided" };
    if (!board.enqueued) {
      process.stderr.write(`[create-pr] Board note: PR not enqueued (${board.reason}).\n`);
    }
    process.stdout.write(`${JSON.stringify({ board })}\n`);
  }
  return code;
}
if (isDirectCliRun(import.meta.url)) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
