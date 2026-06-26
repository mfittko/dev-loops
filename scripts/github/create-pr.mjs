#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
const USAGE = `Usage: create-pr.mjs [gh pr create args...]
Canonical PR-creation wrapper around \`gh pr create\`. Every PR opened through this
tool is ALWAYS a draft and is self-assigned by default. Never call raw \`gh pr create\`.
Behavior:
  - injects exactly one \`--draft\` when absent (draft is the only mode)
  - defaults \`--assignee @me\` when no assignee is given (self-assigned by default)
  - honors an explicit \`--assignee <login>\` / \`-a <login>\` when supplied (no default injected)
  - rejects \`--ready\` before invoking \`gh\`
  - detects missing \`Closes #N\` / \`Fixes #N\` in \`--body\` or \`--body-file\` content (non-fatal stderr warning)
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
async function warnMissingClosingKeyword(args) {
  const body = await resolveBody(args);
  if (body === null) return; // no --body or --body-file, skip
  if (!detectClosingKeyword(body)) {
    process.stderr.write(
      "[create-pr] Warning: PR body missing `Closes #N` or `Fixes #N`. " +
        "GitHub will not auto-close the linked issue on merge.\n",
    );
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
export function spawnCreatePr(ghArgs, { ghCommand = "gh", env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ghCommand, ghArgs, {
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(typeof code === "number" ? code : 1);
    });
  });
}
export async function main(argv = process.argv.slice(2), runtime = {}) {
  const { help, ghArgs } = buildCreatePrArgs(argv);
  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  await warnMissingClosingKeyword(argv);
  return spawnCreatePr(ghArgs, runtime);
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
