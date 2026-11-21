/**
 * Append-only JSONL log of every `gh` call. One line per call,
 * shared by all dev-loops instances through the main checkout's `tmp/`.
 * Records the subcommand and its `--json` field list, never bodies or
 * responses. A logging failure never fails or alters the `gh` call.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseMainWorktreePath } from "../loop/worktree-guard.mjs";
import { withSecondaryLimitBackoff } from "./gh.mjs";
import { ghExecFileSync, takeGhSlot } from "./gh-throttle.mjs";

export const GH_CALL_LOG_ENV = "DEVLOOPS_GH_CALL_LOG";
const GIT_TIMEOUT_MS = 5000;
const RATE_LIMIT_PATTERN = /rate limit|was submitted too quickly/i;
// `gh` implements these command groups on GraphQL; `pr diff` is a REST call.
const GRAPHQL_GROUPS = new Set(["pr", "issue", "project", "repo", "release"]);

const mainCheckoutByCwd = new Map();

/**
 * Log path: absolute env override (trimmed; blank or relative is ignored),
 * else `<main checkout>/tmp/gh-calls.jsonl`. Returns null when no main checkout resolves and no absolute override is set.
 */
export function resolveGhCallLogPath(cwd = process.cwd(), env = process.env) {
  const override = String(env[GH_CALL_LOG_ENV] ?? "").trim();
  if (override && path.isAbsolute(override)) return override;
  let mainCheckout = mainCheckoutByCwd.get(cwd);
  if (mainCheckout === undefined) {
    try {
      const listing = execFileSync("git", ["worktree", "list"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS });
      mainCheckout = parseMainWorktreePath(listing) ?? null;
    } catch { mainCheckout = null; /* not a git checkout */ }
    mainCheckoutByCwd.set(cwd, mainCheckout);
  }
  if (mainCheckout === null) return null;
  return path.join(mainCheckout, "tmp", "gh-calls.jsonl");
}

/** Classify a `gh` argv as `graphql` or `rest`. */
export function classifyGhCall(args) {
  if (args[0] === "api") return args[1] === "graphql" ? "graphql" : "rest";
  if (args[0] === "pr" && args[1] === "diff") return "rest";
  return GRAPHQL_GROUPS.has(args[0]) ? "graphql" : "rest";
}

const PR_PATH = /\/(?:pulls|issues)\/(\d+)(?:\/|$)/u;
const FIELD_FLAGS = new Set(["-F", "-f", "--field", "--raw-field"]);
// `gh api` flags that take a separate value token; that value is never the endpoint.
const API_VALUE_FLAGS = new Set([...FIELD_FLAGS, "-H", "--header", "--jq", "-q", "-X", "--method", "--input", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);

/** PR number from the argv shape of each command kind; only the number is kept, never other values. */
function extractPr(args) {
  let found = null;
  if (args[0] === "api" && args[1] === "graphql") {
    args.forEach((arg, i) => {
      const m = FIELD_FLAGS.has(args[i - 1]) ? /^(?:pr|number)=(\d+)$/u.exec(arg) : null;
      if (m) found = m[1];
    });
  } else if (args[0] === "api") {
    // Match only the endpoint positional: flag values (bodies, jq filters) can contain `/issues/<n>/`.
    const endpoint = args.slice(1).find((a, i, rest) => !a.startsWith("-") && !API_VALUE_FLAGS.has(rest[i - 1]));
    found = endpoint === undefined ? null : PR_PATH.exec(endpoint)?.[1] ?? null;
  } else if (args[0] === "pr") {
    found = args.slice(2).find((a, i, rest) => /^\d+$/u.test(a) && !(rest[i - 1] ?? "").startsWith("-")) ?? null;
  }
  return found === null ? null : Number(found);
}

function describeGhCall(args) {
  const words = [];
  for (const arg of args.slice(0, 3)) {
    if (arg.startsWith("-") || /^\d+$/u.test(arg)) break;
    words.push(arg);
  }
  const jsonAt = args.indexOf("--json");
  const fields = jsonAt >= 0 && args[jsonAt + 1] ? ` --json ${args[jsonAt + 1]}` : "";
  return { subcommand: `${words.join(" ")}${fields}`, pr: extractPr(args) };
}

/** Append one record. Swallows every error: logging must never affect the `gh` call. */
export function recordGhCall(args, { durationMs, status, stderr = "", script = process.argv[1], logPath } = {}) {
  try {
    const { subcommand, pr } = describeGhCall(args);
    const record = {
      timestamp: new Date().toISOString(),
      script: script ? path.basename(script) : null,
      pr,
      kind: classifyGhCall(args),
      subcommand,
      durationMs,
      status,
      rateLimited: stderr === null ? (status === 0 ? false : null) : status !== 0 && RATE_LIMIT_PATTERN.test(String(stderr)),
    };
    const file = logPath ?? resolveGhCallLogPath();
    if (file === null) return;
    mkdirSync(path.dirname(file), { recursive: true });
    // One appendFileSync per line: O_APPEND keeps concurrent writers' lines whole.
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch { /* swallow */ }
}

// The spawn itself: one `execFileSync("gh")` per attempt, recorded with its own outcome.
function recordedExecFileSync(command, args, options) {
  const started = Date.now();
  try {
    const out = execFileSync(command, args, options);
    recordGhCall(args, { durationMs: Date.now() - started, status: 0 });
    return out;
  } catch (err) {
    recordGhCall(args, { durationMs: Date.now() - started, status: typeof err?.status === "number" ? err.status : 1, stderr: err?.stderr ?? null });
    throw err;
  }
}

/** Throttled (slot, one secondary-limit backoff) `execFileSync("gh", args, options)`; each spawn is recorded. Rethrows the original error. */
export function ghSync(args, options = {}) {
  return ghExecFileSync("gh", args, options, { execFile: recordedExecFileSync });
}

/** Command-aware `execFileSync` default for seams that take a command: records only `gh` calls. */
export function execFileSyncRecorded(command, args, options) {
  return command === "gh" ? ghSync(args, options) : execFileSync(command, args, options);
}

const execFileAsync = promisify(execFile);

/** Throttled (slot, one secondary-limit backoff) `execFile("gh", args, options)`; each spawn is recorded. Resolves `{ stdout, stderr }`, rethrows the original error. */
export function ghAsync(args, options = {}) {
  return withSecondaryLimitBackoff(async () => {
    await takeGhSlot({ env: options.env, cwd: options.cwd });
    const started = Date.now();
    try {
      const out = await execFileAsync("gh", args, options);
      recordGhCall(args, { durationMs: Date.now() - started, status: 0 });
      return out;
    } catch (err) {
      recordGhCall(args, { durationMs: Date.now() - started, status: typeof err?.code === "number" ? err.code : 1, stderr: err?.stderr ?? null });
      throw err;
    }
  });
}

const STDERR_TAIL_CHARS = 4096;

/**
 * `spawn(command, args, options)` that records the call when `command` is `gh`; returns the child.
 * A piped stderr is tailed for rate-limit detection; an inherited stderr records `rateLimited: null` (unknown).
 */
export function spawnRecorded(command, args, options) {
  const started = Date.now();
  const child = spawn(command, args, options);
  if (command !== "gh") return child;
  let tail = "";
  child.stderr?.on("data", (chunk) => { tail = `${tail}${chunk}`.slice(-STDERR_TAIL_CHARS); });
  child.on("close", (code) => recordGhCall(args, { durationMs: Date.now() - started, status: code ?? 1, stderr: child.stderr ? tail : null }));
  return child;
}

const tally = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

/** Summarize JSONL log text. Malformed lines are skipped. */
export function summarizeGhCalls(text) {
  const summary = { total: 0, graphql: 0, graphqlShare: 0, rateLimited: 0, perScript: {}, perPr: {}, perMinute: {} };
  for (const line of text.split("\n")) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
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
  if (logPath === null) return summarizeGhCalls(text);
  try { text = readFileSync(logPath, "utf8"); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  return summarizeGhCalls(text);
}
