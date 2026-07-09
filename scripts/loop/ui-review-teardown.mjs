#!/usr/bin/env node
/**
 * CLI wrapper for the ui_review teardown stage (Stage 5, terminal cleanup).
 *
 * Stops the app booted in Stage 1, drops the dev-DB rows the Stage-2 drive
 * created (only from an explicit manifest, only on confirmation), and removes
 * the provisioned worktree via the shared cleanup path. It ALWAYS emits a
 * side-effect ledger enumerating what was torn down and what remains.
 *
 * Thin adapter: it wires the real IO seams — process kill (SIGTERM then a
 * logged SIGKILL fallback), row drop, and worktree removal (the shared
 * cleanup-worktree path) — into the pure core orchestrator
 * (packages/core/src/loop/ui-review-teardown.mjs), reading the prior-stage
 * result JSON from disk.
 */
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { teardown } from "@dev-loops/core/loop/ui-review-teardown";
import { cleanupWorktree } from "./cleanup-worktree.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const MAX_RESULT_BYTES = 16 * 1024 * 1024;

const USAGE = `Usage:
  ui-review-teardown.mjs --repo-root <p> --provision-result <p> [--drive-result <p>] [--row-manifest <p>] [--confirm] [--no-stop-app]
Tear down the ui_review route's transient state and emit a side-effect ledger
(Stage 5 of the ui_review route). Destructive steps (row drops, worktree
removal) run ONLY with --confirm; the ledger is emitted in every case.
Required:
  --repo-root <p>          Absolute path to the primary checkout (git cwd for worktree removal).
  --provision-result <p>   Path to the Stage-1 provision JSON (boot.pid, migrations, worktreePath).
Optional:
  --drive-result <p>       Path to the Stage-2 drive JSON (the rows-created signal).
  --row-manifest <p>       Path to a JSON array of rows to drop (only used with --confirm).
  --confirm                Authorize the destructive steps (row drop + worktree removal).
  --no-stop-app            Do NOT stop the app process (clean shutdown otherwise runs regardless of --confirm).
  -h, --help               Show this help.
Output (stdout, JSON):
  { "ok": bool, "confirmed": bool, "errors": [...], "logs": [...],
    "ledger": { "migrations": {...}, "rows": {...}, "worktree": {...}, "process": {...} } }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseUiReviewTeardownCliArgs(argv) {
  const options = {
    help: false, repoRoot: undefined, provisionResult: undefined, driveResult: undefined,
    rowManifest: undefined, confirm: false, stopApp: true,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      "provision-result": { type: "string" },
      "drive-result": { type: "string" },
      "row-manifest": { type: "string" },
      confirm: { type: "boolean" },
      "no-stop-app": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo-root") { options.repoRoot = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "provision-result") { options.provisionResult = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "drive-result") { options.driveResult = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "row-manifest") { options.rowManifest = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
    if (token.name === "confirm") {
      // Bare flag or `=true` confirms; explicit `=false`/`=0`/`=no` must NOT
      // confirm (fail-safe — destructive steps stay gated unless truly asked).
      options.confirm = token.value === undefined || !/^(false|0|no)$/iu.test(token.value.trim());
      continue;
    }
    if (token.name === "no-stop-app") { options.stopApp = false; continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  if (!options.provisionResult) throw parseError("Missing required --provision-result");
  return options;
}

/** Read + parse a prior-stage result JSON, bounded. Returns null ONLY for a
 * genuinely OMITTED path (`file === undefined`); a SUPPLIED path that can't be
 * stat/read/parsed FAILS CLOSED (throws). A supplied-but-unreadable path silently
 * nulled would let teardown proceed on an incomplete ledger, misreporting rows as
 * none/may-remain off missing input even though a path was explicitly provided. */
function readResultJson(file) {
  if (file === undefined) return null;
  let size;
  try {
    size = statSync(file).size;
  } catch (err) {
    throw parseError(`cannot read ${file}: ${(err.message ?? err).toString()}`);
  }
  if (size > MAX_RESULT_BYTES) throw parseError(`${file} is too large (${size} bytes > ${MAX_RESULT_BYTES} cap)`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Read + validate an explicit `--row-manifest`. Absent (`undefined`) is the
 * honest "no manifest" path -> null. When a manifest path IS supplied, it must
 * parse to a JSON array or `{ rows: [...] }`; any other shape is a user/config
 * error and FAILS CLOSED (throws), never silently nulled — a silent null would
 * hide the error behind a misleading "may remain (untagged)" ledger even though
 * a manifest file was provided. */
function readRowManifest(file) {
  if (file === undefined) return null;
  const manifestJson = readResultJson(file); // present but unreadable/unparseable throws
  if (Array.isArray(manifestJson)) return manifestJson;
  if (Array.isArray(manifestJson?.rows)) return manifestJson.rows;
  throw parseError(`--row-manifest ${file} is malformed: expected a JSON array or { "rows": [...] }`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** True while `pid` is still alive. `process.kill(pid,0)` throws ESRCH when gone;
 * EPERM means it exists but we can't signal it (still "alive" for our purposes). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Signal a detached app: target the process GROUP (-pid) first — Stage 1 boots
 * the app detached (its own group leader) via a shell, so the real server is a
 * child in that group; signalling the group reaches it. Fall back to the bare
 * pid when the group signal is not deliverable. */
function signalProcess(pid, sig) {
  // Defense-in-depth: never signal unless `pid` is a positive integer. A pid of
  // 0 (`process.kill(0)` targets our OWN process group) or -1 (`process.kill(-1)`
  // targets EVERY process) would be catastrophic; the core already rejects these,
  // this guard makes it impossible for a group-kill to ever fire on a bad pid.
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`refusing to signal non-positive-integer pid: ${pid}`);
  }
  try {
    process.kill(-pid, sig);
    return;
  } catch {
    process.kill(pid, sig);
  }
}

/** Stop a process: SIGTERM, wait a bounded budget for a clean exit, then a
 * LOGGED SIGKILL fallback. A failed kill is reported (never swallowed).
 *
 * win32 FAIL-CLOSED: Node cannot signal a process GROUP on Windows (the `-pid`
 * form is unsupported and throws), and Stage 1 boots the app detached via a
 * shell — so the real server is a CHILD of the shell PID we hold. The group
 * signal would throw, `signalProcess` would fall back to the bare shell PID, and
 * a bare-pid `isAlive` poll would then report `stopped:true` while the detached
 * server keeps running — a FALSE success the ledger would enshrine. Rather than
 * misreport, we refuse to attempt the kill and report the app as NOT reliably
 * stopped (mapped to a not-stopped ledger status upstream). `platform` is
 * injectable so the win32 path is testable off a real Windows host.
 * ponytail: fail-closed stated-limitation, not a taskkill /T tree-kill — honest
 * and minimal for this stage; upgrade to a Windows process-tree kill if/when the
 * loop actually needs to run and reliably stop the app on win32. */
export async function killProcess({ pid, graceMs = 3000, pollMs = 100, platform = process.platform }) {
  if (platform === "win32") {
    return { stopped: false, forced: false, detail: "win32 process-group kill unsupported; app may still be running (a shell-PID kill would not reach the detached server child)" };
  }
  try {
    signalProcess(pid, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") return { stopped: true, forced: false, detail: "process already exited" };
    return { stopped: false, forced: false, detail: `SIGTERM failed: ${err.message ?? err}` };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { stopped: true, forced: false, detail: "stopped via SIGTERM" };
    await delay(pollMs);
  }
  if (!isAlive(pid)) return { stopped: true, forced: false, detail: "stopped via SIGTERM" };
  // Force-kill fallback (logged upstream via the returned `forced` flag).
  try {
    signalProcess(pid, "SIGKILL");
  } catch (err) {
    if (err.code === "ESRCH") return { stopped: true, forced: false, detail: "process exited before SIGKILL" };
    return { stopped: false, forced: true, detail: `SIGKILL failed after SIGTERM timeout: ${err.message ?? err}` };
  }
  await delay(pollMs);
  if (!isAlive(pid)) return { stopped: true, forced: true, detail: `force-killed (SIGKILL) after ${graceMs}ms SIGTERM grace` };
  return { stopped: false, forced: true, detail: "process still alive after SIGKILL" };
}

/** Remove the worktree via the shared, namespace-safe cleanup path. Maps its
 * fail-soft result to the teardown seam contract. */
function removeWorktree(repoRoot, { worktreePath }) {
  const res = cleanupWorktree({ repoRoot, path: worktreePath });
  return Promise.resolve({ removed: res.removed, ok: res.ok, detail: res.reason });
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseUiReviewTeardownCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return; }

  const provisionResult = readResultJson(options.provisionResult);
  const driveResult = readResultJson(options.driveResult);
  const rowManifest = readRowManifest(options.rowManifest);

  const result = await teardown(
    {
      provisionResult,
      driveResult,
      rowManifest,
      confirm: options.confirm,
      stopApp: options.stopApp,
    },
    {
      killProcess,
      // No real drop seam yet: Stage 2 does not tag rows, so an actual manifest
      // never arrives today and the ledger reports "may remain (untagged)". A
      // manifest handed in is dropped by whatever project mechanism supplies it;
      // until one exists, a confirmed manifest is a hard fail-closed error rather
      // than a silent no-op, so a caller can never think rows were dropped.
      dropRows: () => Promise.resolve({ ok: false, dropped: 0, detail: "no row-drop mechanism wired: dev-DB rows are untagged (Stage 2 does not tag rows); cannot drop a manifest safely" }),
      removeWorktree: (a) => removeWorktree(options.repoRoot, a),
      log: (msg) => stderr.write(`[ui-review-teardown] ${msg}\n`),
    },
  );
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: result.ok });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
