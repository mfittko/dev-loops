/**
 * Append-only JSONL log of every `gh` call (issue #3338). One line per call,
 * shared by all dev-loops instances through the main checkout's `tmp/`.
 * Records the subcommand and its `--json` field list, never bodies or
 * responses. A logging failure never fails or alters the `gh` call.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseMainWorktreePath } from "../loop/worktree-guard.mjs";

export const GH_CALL_LOG_ENV = "DEVLOOPS_GH_CALL_LOG";
const GIT_TIMEOUT_MS = 5000;
const RATE_LIMIT_PATTERN = /rate limit/i;
// `gh` implements these command groups on GraphQL; `pr diff` is a REST call.
const GRAPHQL_GROUPS = new Set(["pr", "issue", "project", "repo", "search", "release"]);

let cachedLogPath;

/** Log path: env override, else `<main checkout>/tmp/gh-calls.jsonl` (resolved once per process). */
export function resolveGhCallLogPath(cwd = process.cwd(), env = process.env) {
  if (env[GH_CALL_LOG_ENV]) return env[GH_CALL_LOG_ENV];
  if (cachedLogPath === undefined) {
    let main = cwd;
    try {
      const listing = execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS });
      main = parseMainWorktreePath(listing) ?? cwd;
    } catch { /* not a git checkout: log under cwd */ }
    cachedLogPath = path.join(main, "tmp", "gh-calls.jsonl");
  }
  return cachedLogPath;
}

/** Classify a `gh` argv as `graphql` or `rest`. */
export function classifyGhCall(args) {
  if (args[0] === "api") return args[1] === "graphql" ? "graphql" : "rest";
  if (args[0] === "pr" && args[1] === "diff") return "rest";
  return GRAPHQL_GROUPS.has(args[0]) ? "graphql" : "rest";
}

function describeGhCall(args) {
  const words = [];
  for (const arg of args.slice(0, 3)) {
    if (arg.startsWith("-") || /^\d+$/u.test(arg)) break;
    words.push(arg);
  }
  const jsonAt = args.indexOf("--json");
  const fields = jsonAt >= 0 && args[jsonAt + 1] ? ` --json ${args[jsonAt + 1]}` : "";
  const prAt = args.indexOf("--pr");
  const prArg = prAt >= 0 ? args[prAt + 1] : (args[0] === "pr" ? args[2] : undefined);
  const pr = /^\d+$/u.test(prArg ?? "") ? Number(prArg) : null;
  return { subcommand: `${words.join(" ")}${fields}`, pr };
}

/** Append one record. Swallows every error: logging must never affect the `gh` call. */
export function recordGhCall(args, { durationMs, status, stderr = "", script = process.argv[1], logPath, now = new Date() } = {}) {
  try {
    const { subcommand, pr } = describeGhCall(args);
    const record = {
      timestamp: now.toISOString(),
      script: script ? path.basename(script) : null,
      pr,
      kind: classifyGhCall(args),
      subcommand,
      durationMs,
      status,
      rateLimited: status !== 0 && RATE_LIMIT_PATTERN.test(String(stderr)),
    };
    const file = logPath ?? resolveGhCallLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    // One appendFileSync per line: O_APPEND keeps concurrent writers' lines whole.
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch { /* swallow */ }
}

/** `execFileSync("gh", args, options)` that records the call. Rethrows the original error. */
export function ghSync(args, options = {}) {
  const started = Date.now();
  try {
    const out = execFileSync("gh", args, options);
    recordGhCall(args, { durationMs: Date.now() - started, status: 0 });
    return out;
  } catch (err) {
    recordGhCall(args, { durationMs: Date.now() - started, status: typeof err?.status === "number" ? err.status : 1, stderr: err?.stderr ?? err?.message });
    throw err;
  }
}

const tally = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

/** Summarize JSONL log text. Malformed lines are skipped. */
export function summarizeGhCalls(text) {
  const summary = { total: 0, graphql: 0, graphqlShare: 0, rateLimited: 0, perScript: {}, perPr: {}, perMinute: {} };
  for (const line of text.split("\n")) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== "object") continue;
    summary.total += 1;
    if (rec.kind === "graphql") summary.graphql += 1;
    if (rec.rateLimited) summary.rateLimited += 1;
    tally(summary.perScript, rec.script ?? "unknown");
    if (rec.pr != null) tally(summary.perPr, String(rec.pr));
    tally(summary.perMinute, String(rec.timestamp ?? "").slice(0, 16));
  }
  summary.graphqlShare = summary.total === 0 ? 0 : Number((summary.graphql / summary.total).toFixed(3));
  return summary;
}

/** Read and summarize the log at `logPath`; a missing log is an empty summary. */
export function summarizeGhCallLog(logPath = resolveGhCallLogPath()) {
  let text = "";
  try { text = readFileSync(logPath, "utf8"); } catch { /* no log yet */ }
  return summarizeGhCalls(text);
}
