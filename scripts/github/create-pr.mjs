#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveSettings, applyDevloopsBoard } from "../projects/_resolve-project.mjs";
import { main as addQueueItemMain } from "../projects/add-queue-item.mjs";
import { loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
const USAGE = `Usage: create-pr.mjs [gh pr create args...]
Canonical PR-creation wrapper around \`gh pr create\`. Every PR opened through this
tool is ALWAYS a draft and is self-assigned by default. Never call raw \`gh pr create\`.
Behavior:
  - injects exactly one \`--draft\` when absent (draft is the only mode)
  - defaults \`--assignee @me\` when no assignee is given (self-assigned by default)
  - honors an explicit \`--assignee <login>\` / \`-a <login>\` when supplied (no default injected)
  - rejects \`--ready\` before invoking \`gh\`
  - detects missing \`Closes #N\` / \`Fixes #N\` in \`--body\` or \`--body-file\` content (non-fatal stderr warning)
  - \`--lightweight\` (consumed here, never forwarded to \`gh\`): when an explicit \`--body\`/
    \`--body-file\` also carries no \`Closes #N\`/\`Fixes #N\`, the new PR is issue-less
    lightweight and is auto-enqueued as a board PR item in the configured In Progress column
    (reuses \`queue.projectNumber\` / \`queue.boardTitle\` from \`.devloops\`, same as the queue
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
  - Wrapper-owned validation is limited to \`--ready\`; all other argument validation is left to \`gh pr create\`.
  - Closing-keyword warning is advisory only and does not change exit code.
Exit codes:
  0  \`gh pr create\` succeeded
  1  wrapper validation failed or \`gh\` could not be spawned
  N  same non-zero exit code returned by \`gh pr create\``.trim();
const parseError = buildParseError(USAGE);
const READY_FLAG_PATTERN = /^--ready(?:$|=)/u;
const LIGHTWEIGHT_FLAG_PATTERN = /^--lightweight$/u;
// Both `--repo owner/name` and `--repo=owner/name` — gh accepts either form.
const REPO_FLAG_PATTERN = /^--repo(?:$|=)/u;
const PR_URL_NUMBER_PATTERN = /\/pull\/(\d+)(?:\D|$)/u;
const DRAFT_FLAG_PATTERN = /^--draft(?:=(.*))?$/iu;
const DRAFT_TRUE_VALUE_PATTERN = /^(?:true|1)$/iu;
// Detect both the long `--assignee`/`--assignee=<login>` forms and the `-a`
// short flag that `gh pr create` documents, so an explicit assignee in either
// form suppresses the `--assignee @me` default (otherwise a caller passing
// `-a <login>` would get a conflicting `--assignee @me` injected). (#894)
const ASSIGNEE_FLAG_PATTERN = /^(?:--assignee(?:$|=)|-a$)/u;
const DEFAULT_ASSIGNEE = "@me";
const CLOSING_KEYWORD_PATTERN = /Closes\s+#\d+|Fixes\s+#\d+/i;
const MAX_BODY_SCAN_BYTES = 16 * 1024;
export function detectClosingKeyword(body) {
  if (!body || typeof body !== "string") return false;
  return CLOSING_KEYWORD_PATTERN.test(body.slice(0, MAX_BODY_SCAN_BYTES));
}
async function resolveBody(args) {
  const bodyIdx = args.indexOf("--body");
  if (bodyIdx !== -1 && bodyIdx + 1 < args.length) {
    return args[bodyIdx + 1];
  }
  const bodyFileIdx = args.indexOf("--body-file");
  if (bodyFileIdx !== -1 && bodyFileIdx + 1 < args.length) {
    try {
      const content = await readFile(args[bodyFileIdx + 1], "utf8");
      return content;
    } catch {
      return "";
    }
  }
  return null; // unreadable → warn
}
function warnMissingClosingKeyword(body) {
  if (body === null) return; // no --body or --body-file, skip
  if (!detectClosingKeyword(body)) {
    process.stderr.write(
      "[create-pr] Warning: PR body missing `Closes #N` or `Fixes #N`. " +
        "GitHub will not auto-close the linked issue on merge.\n",
    );
  }
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
// Auto-enqueue an issue-less lightweight PR as a board PR item in the configured
// In Progress column. Reuses the same .devloops queue.projectNumber /
// queue.boardTitle resolution and add-queue-item's idempotent add — never
// reimplements the board API calls. Never throws: an unconfigured board, a
// missing --repo, an unparsed PR number, or an enqueue failure are all
// non-fatal no-ops reported in the returned shape.
export async function enqueueIssuelessLightweightPr({ repo, prNumber, cwd, env, runChild }) {
  if (!repo) return { enqueued: false, reason: "repo-not-specified" };
  if (!Number.isInteger(prNumber) || prNumber < 1) return { enqueued: false, reason: "pr-number-not-parsed" };
  const settings = resolveSettings(cwd);
  if (!settings?.project && !settings?.title) {
    return { enqueued: false, reason: "no-board-configured" };
  }
  const { columnNames, error: columnError } = loadStateColumnMap(cwd);
  if (columnError) {
    return { enqueued: false, reason: `config-error: ${columnError}` };
  }
  const args = { repo, item: prNumber };
  applyDevloopsBoard(args, cwd);
  args.column = columnNames[LOGICAL_COLUMN.IN_PROGRESS];
  try {
    const result = await addQueueItemMain(args, { env, runChild, cwd });
    const { itemId, prNumber: itemPrNumber, status, alreadyPresent } = result.item;
    return { enqueued: true, itemId, prNumber: itemPrNumber, status, alreadyPresent };
  } catch (err) {
    return { enqueued: false, reason: `enqueue-error: ${err instanceof Error ? err.message : String(err)}` };
  }
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
  const lastDraftSuppliesDraft = lastDraftToken === "--draft" || (typeof lastDraftToken === "string" && DRAFT_TRUE_VALUE_PATTERN.test(lastDraftToken.slice("--draft=".length)));
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
  const lightweight = argv.some((token) => LIGHTWEIGHT_FLAG_PATTERN.test(token));
  const forwardedArgv = argv.filter((token) => !LIGHTWEIGHT_FLAG_PATTERN.test(token));
  const { help, ghArgs } = buildCreatePrArgs(forwardedArgv);
  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const body = await resolveBody(forwardedArgv);
  warnMissingClosingKeyword(body);
  // Issue-less lightweight: caller signals lightweight AND an explicit body
  // source (--body/--body-file) carries no closing keyword. A tracker-backed
  // lightweight PR (closing keyword present) never reaches the board — its
  // issue already owns the board entry. A null body (no explicit source) is
  // NOT classified issue-less: the body may come from elsewhere (editor,
  // template) and could carry a closing keyword this wrapper never saw, so it
  // fails toward not enqueuing and reports body-not-provided instead.
  const issueLess = lightweight && body !== null && !detectClosingKeyword(body);
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
