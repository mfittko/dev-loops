#!/usr/bin/env node
/**
 * CLI wrapper for the ui_review teardown stage (Stage 5, terminal cleanup).
 *
 * Stops the app booted in Stage 1, drops the dev-DB rows the Stage-2 drive
 * created (only from an explicit manifest, only on confirmation), removes the
 * provisioned worktree via the shared cleanup path, and prunes the Stage-4
 * GitHub-native hosting gist (only on confirmation). It ALWAYS emits a
 * side-effect ledger enumerating what was torn down and what remains.
 *
 * Thin adapter: it wires the real IO seams — process kill (SIGTERM then a
 * logged SIGKILL fallback), row drop, worktree removal (the shared
 * cleanup-worktree path), and gist deletion (`gh gist delete`) — into the pure
 * core orchestrator
 * (packages/core/src/loop/ui-review-teardown.mjs), reading the prior-stage
 * result JSON from disk.
 */
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveUiReviewRunRecipe } from "@dev-loops/core/config";
import { teardown } from "@dev-loops/core/loop/ui-review-teardown";
import { cleanupWorktree } from "./cleanup-worktree.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const MAX_RESULT_BYTES = 16 * 1024 * 1024;

const USAGE = `Usage:
  ui-review-teardown.mjs --repo-root <p> --provision-result <p> [--drive-result <p>] [--report-result <p>] [--row-manifest <p>] [--confirm] [--no-stop-app]
Tear down the ui_review route's transient state and emit a side-effect ledger
(Stage 5 of the ui_review route). Destructive steps (row drops, worktree
removal, hosting-gist deletion) run ONLY with --confirm; the ledger is emitted
in every case.
Required:
  --repo-root <p>          Absolute path to the primary checkout (git cwd for worktree removal).
  --provision-result <p>   Path to the Stage-1 provision JSON (boot.pid, migrations, worktreePath).
Optional:
  --drive-result <p>       Path to the Stage-2 drive JSON (the rows-created signal).
  --report-result <p>      Path to the Stage-4 report JSON (its hosting.gist id, pruned with --confirm).
  --row-manifest <p>       Path to a JSON array of rows to drop (only used with --confirm).
  --confirm                Authorize the destructive steps (row drop + worktree removal + gist deletion).
  --no-stop-app            Do NOT stop the app process (clean shutdown otherwise runs regardless of --confirm).
  -h, --help               Show this help.
Output (stdout, JSON):
  { "ok": bool, "confirmed": bool, "errors": [...], "logs": [...],
    "ledger": { "migrations": {...}, "rows": {...}, "worktree": {...}, "gist": {...}, "process": {...} } }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseUiReviewTeardownCliArgs(argv) {
  const options = {
    help: false, repoRoot: undefined, provisionResult: undefined, driveResult: undefined,
    reportResult: undefined, rowManifest: undefined, confirm: false, stopApp: true,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      "provision-result": { type: "string" },
      "drive-result": { type: "string" },
      "report-result": { type: "string" },
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
    if (token.name === "report-result") { options.reportResult = requireTokenValue(token, parseError, { flagPattern: /^-/u }); continue; }
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
 * misreport, we refuse to ATTEMPT the kill and report the app as may-still-be-
 * running (`mayBeRunning:true` → mapped to a MAY_BE_RUNNING ledger status
 * upstream, non-fatal: a "couldn't stop", not a failed attempt). `platform` is
 * injectable so the win32 path is testable off a real Windows host.
 * ponytail: fail-closed stated-limitation, not a taskkill /T tree-kill — honest
 * and minimal for this stage; upgrade to a Windows process-tree kill if/when the
 * loop actually needs to run and reliably stop the app on win32. */
export async function killProcess({ pid, graceMs = 3000, pollMs = 100, platform = process.platform }) {
  if (platform === "win32") {
    return { stopped: false, forced: false, mayBeRunning: true, detail: "win32 process-group kill unsupported; app may still be running (a shell-PID kill would not reach the detached server child)" };
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

/** Extract the Stage-4 hosting gist ({id,url}) from a report result, or null.
 * Only the GitHub-native path publishes a gist; any other hosting has none. */
function gistFromReport(reportResult) {
  const hosting = reportResult?.hosting;
  if (hosting?.hosting !== "github-gist") return null;
  const g = hosting.gist;
  const id = typeof g?.id === "string" && g.id.trim().length > 0 ? g.id.trim() : null;
  return id ? { id, url: g.url ?? null } : null;
}

/** Delete a hosting gist via `gh gist delete`. Maps a non-zero exit / thrown
 * spawn to the teardown seam's fail-reported contract (never swallowed). */
async function deleteGist({ id }, { run = runChild } = {}) {
  const res = await run("gh", ["gist", "delete", id], process.env);
  if (res.code === 0) return { ok: true, detail: "deleted via gh gist delete" };
  return { ok: false, detail: `gh gist delete exit ${res.code}: ${res.stderr?.trim() || "no stderr"}` };
}

/** The single drive-session id every manifest row shares, or null. Fails closed
 * on an absent OR mixed session — the delete targets one session, so an ambiguous
 * or untagged manifest must never drop (better a "may remain" than a wrong scope). */
function sessionFromManifest(rows) {
  const list = rows ?? [];
  if (list.length === 0) return null;
  const ids = new Set();
  for (const r of list) {
    const s = typeof r?.session === "string" ? r.session.trim() : "";
    // Any untagged row means part of the manifest can't be scoped to a session:
    // refuse rather than delete only the tagged subset and misreport the rest as
    // dropped. Every row must carry the same non-empty session.
    if (s.length === 0) return null;
    ids.add(s);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/** Drop the dev-DB rows a drive tagged with its session, via the project's
 * `uiReview.run.rowTeardown.deleteCommand`. The shared session id is passed in
 * UI_REVIEW_DRIVE_SESSION and the command runs in the provisioned worktree (dev
 * DB). Fail closed: no delete recipe, or a manifest with no single session, drops
 * nothing and says why — the core maps that to a drop failure, never a silent
 * no-op or a wrong-scope delete. */
async function dropRows({ rows }, { deleteCommand, cwd, run = runChild }) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    // No verified dev-scope directory to run the delete in (a malformed provision
    // worktreePath resolves to null upstream). Refuse rather than run the
    // destructive command in an unverified/wrong scope.
    return { ok: false, dropped: 0, detail: "no verified worktree cwd for the row delete (malformed provision worktreePath); refusing to run in an unverified scope" };
  }
  if (!deleteCommand) {
    return { ok: false, dropped: 0, detail: "no uiReview.run.rowTeardown.deleteCommand configured; cannot drop tagged rows" };
  }
  const session = sessionFromManifest(rows);
  if (!session) {
    return { ok: false, dropped: 0, detail: "manifest rows carry no single drive-session tag; refusing to drop (ambiguous target)" };
  }
  const env = { ...process.env, UI_REVIEW_DRIVE_SESSION: session };
  // POSIX single-quote the cwd — it is interpolated into a shell `cd`, and a
  // git-branch-derived worktree path may carry `$()`/backtick command-
  // substitution chars that would otherwise execute during a confirmed teardown.
  const quotedCwd = `'${cwd.replace(/'/g, "'\\''")}'`;
  const res = await run("sh", ["-c", `cd ${quotedCwd} && ${deleteCommand}`], env);
  if (res.code === 0) {
    // `dropped` is the number of manifested mutating steps requested for deletion,
    // not a confirmed DB-row count — the by-session deleteCommand returns none.
    return { ok: true, dropped: rows.length, detail: `requested deletion of rows tagged ${session} (${rows.length} manifested step(s)) via rowTeardown.deleteCommand` };
  }
  return { ok: false, dropped: 0, detail: `rowTeardown.deleteCommand exit ${res.code}: ${res.stderr?.trim() || "no stderr"}` };
}

/** Resolve the project's row-delete command from the (worktree) config. Loaded
 * lazily — only when a confirmed manifest actually needs dropping — so a teardown
 * with no rows never reads config. */
async function resolveDeleteCommand(repoRoot) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  return resolveUiReviewRunRecipe(config)?.rowTeardown?.deleteCommand ?? null;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, run = runChild } = {}) {
  const options = parseUiReviewTeardownCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return; }

  const provisionResult = readResultJson(options.provisionResult);
  const driveResult = readResultJson(options.driveResult);
  const reportResult = readResultJson(options.reportResult);
  const rowManifest = readRowManifest(options.rowManifest);

  // The row-delete command lives in the branch's (worktree) config and runs in the
  // worktree (its dev DB). Fall back to the primary checkout only when NO worktree
  // path was captured (absent/empty). A present-but-malformed (non-string)
  // worktreePath signals a corrupted provision result — resolve to null so the
  // delete fails closed rather than silently running in the wrong scope.
  const rawWorktreePath = provisionResult?.worktreePath;
  const dropCwd = rawWorktreePath != null && typeof rawWorktreePath !== "string"
    ? null
    : (typeof rawWorktreePath === "string" && rawWorktreePath.trim().length > 0 ? rawWorktreePath : options.repoRoot);

  const result = await teardown(
    {
      provisionResult,
      driveResult,
      rowManifest,
      gist: gistFromReport(reportResult),
      confirm: options.confirm,
      stopApp: options.stopApp,
    },
    {
      killProcess,
      deleteGist: (a) => deleteGist(a, { run }),
      // The Stage-2 drive stamps each mutating step with its drive-session id and
      // emits a manifest; this seam deletes exactly the rows the app tagged with
      // that session via the project's rowTeardown.deleteCommand. The delete
      // command is resolved lazily (only a confirmed manifest reaches this seam).
      dropRows: async (a) => dropRows(a, { deleteCommand: await resolveDeleteCommand(dropCwd), cwd: dropCwd, run }),
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
