#!/usr/bin/env node
/**
 * CLI wrapper for the ui_review provision+boot orchestrator.
 *
 * Provisions an isolated worktree for a PR head (create-or-reuse + provision),
 * installs only the dependency-lock delta, runs pending dev-DB migrations
 * (destructive ones fail closed pending ack), boots the branch's app via the
 * project's declared run recipe, and waits on an HTTP readiness probe.
 *
 * This is a thin adapter: it wires real IO seams (git worktree, config, npm
 * install, shell migration commands, spawn, HTTP probe) into the pure core
 * orchestrator (packages/core/src/loop/ui-review-provision.mjs).
 */
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveUiReviewRunRecipe } from "@dev-loops/core/config";
import { provisionAndBoot } from "@dev-loops/core/loop/ui-review-provision";
import { isMainCheckout, parseMainWorktreePath } from "@dev-loops/core/loop/worktree-guard";
import { ensureWorktree } from "./ensure-worktree.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  ui-review-provision.mjs --repo-root <p> --pr <n> [--branch <name>] [--ack-destructive-migration]
Provision an isolated worktree for a PR head and boot the branch's app to a
ready state (Stage 1 of the ui_review route).
Required:
  --repo-root <p>                 Absolute path to the primary checkout.
  --pr <n>                        PR number whose head is provisioned.
Optional:
  --branch <name>                 Branch to check out (default: pr-<n>).
  --ack-destructive-migration     Acknowledge + unblock a destructive migration.
  -h, --help                      Show this help.
Output (stdout, JSON):
  { "ok": bool, "stopped": bool, "stopReason": string|null,
    "worktreePath": <p>, "depInstall": {...}, "migrations": {...},
    "boot": { "ready": bool, "attempts": n, ... }, "findings": [...], "logs": [...] }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw parseError(`${flag} must be a positive integer`);
  return n;
}

export function parseUiReviewProvisionCliArgs(argv) {
  const options = { help: false, repoRoot: undefined, pr: undefined, branch: undefined, ackDestructiveMigration: false };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      pr: { type: "string" },
      branch: { type: "string" },
      "ack-destructive-migration": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo-root") {
      options.repoRoot = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInt(requireTokenValue(token, parseError, { flagPattern: /^-/u }), "--pr");
      continue;
    }
    if (token.name === "branch") {
      options.branch = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "ack-destructive-migration") {
      // Bare flag or `=true` acks; an explicit `=false`/`=0`/`=no` must NOT ack
      // (fail closed — a destructive migration stays blocked unless truly asked).
      options.ackDestructiveMigration = token.value === undefined || !/^(false|0|no)$/iu.test(token.value.trim());
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  if (options.pr === undefined) throw parseError("Missing required --pr");
  return options;
}

/** Run a shell command in `cwd`, capturing stdout. Throws on non-zero exit. */
function runShell(command, cwd) {
  return execFileSync("sh", ["-c", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Read a file's text, or null when absent/unreadable. */
function readOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * npm-scoped dependency-lock delta: compare the worktree's package-lock.json to
 * the primary checkout's. Differing (or one-sided) content means the branch
 * changed dependencies and needs an install; identical means deps are shared.
 */
function detectDepDelta({ repoRoot, worktreePath }) {
  const main = readOrNull(path.join(repoRoot, "package-lock.json"));
  const branch = readOrNull(path.join(worktreePath, "package-lock.json"));
  if (main === null && branch === null) {
    return Promise.resolve({ changed: false, detail: "no package-lock.json in either checkout" });
  }
  if (main === branch) {
    return Promise.resolve({ changed: false, detail: "package-lock.json identical" });
  }
  return Promise.resolve({ changed: true, detail: "package-lock.json differs" });
}

/**
 * Ensure the worktree owns its node_modules before installing. linkOnInit can
 * symlink node_modules into the primary checkout; running `npm install` through
 * that symlink would write into the primary's real node_modules — mutating
 * shared deps. Replace a symlinked node_modules with a real (empty) directory so
 * the install is isolated to the worktree, leaving the primary untouched.
 *
 * Note: materializing to an empty dir makes `npm install` reinstall the full
 * tree (not just the lock delta). If that install cost matters, copy the
 * primary's real node_modules into the worktree first for an incremental
 * reconcile.
 *
 * @returns {boolean} true when a symlinked node_modules was materialized.
 */
export function ensureOwnNodeModules(worktreePath) {
  const nm = path.join(worktreePath, "node_modules");
  let st;
  try {
    st = lstatSync(nm);
  } catch {
    return false; // absent — npm install creates a real dir
  }
  if (!st.isSymbolicLink()) return false;
  rmSync(nm); // unlinks only the symlink; the primary's real dir is untouched
  mkdirSync(nm);
  return true;
}

/** npm install in the worktree, after ensuring it owns its node_modules. */
function installDeps({ worktreePath }) {
  try {
    const materialized = ensureOwnNodeModules(worktreePath);
    execFileSync("npm", ["install"], { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return Promise.resolve({ ok: true, detail: materialized ? "npm install (materialized own node_modules)" : "npm install" });
  } catch (err) {
    return Promise.resolve({ ok: false, detail: (err.stderr ?? err.message ?? "npm install failed").toString().trim() });
  }
}

function resolveRunRecipe(worktreePath) {
  return loadDevLoopConfig({ repoRoot: worktreePath }).then(({ config }) => resolveUiReviewRunRecipe(config));
}

function migrateCwd(worktreePath, recipe) {
  return recipe.cwd ? path.join(worktreePath, recipe.cwd) : worktreePath;
}

/**
 * List pending migrations from the status command output (one per non-blank
 * line) and flag destructive ones by regex. A status command that itself fails
 * is treated as a migration-safety block (fail closed via a synthetic finding).
 */
export function inspectMigrations({ worktreePath, recipe }) {
  const cwd = migrateCwd(worktreePath, recipe);
  let out;
  try {
    out = runShell(recipe.migrate.statusCommand, cwd);
  } catch (err) {
    const msg = (err.stderr ?? err.message ?? "migration status failed").toString().trim();
    // Safety block: cannot verify migrations -> treat as a destructive/blocked case.
    return Promise.resolve({ pending: ["<status-unavailable>"], destructive: [`migration status failed: ${msg}`], detail: "status command failed" });
  }
  const pending = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const re = new RegExp(recipe.migrate.destructivePattern, "iu");
  const destructive = pending.filter((l) => re.test(l));
  return Promise.resolve({ pending, destructive, detail: `${pending.length} line(s) from status` });
}

function applyMigrations({ worktreePath, recipe }) {
  const cwd = migrateCwd(worktreePath, recipe);
  try {
    runShell(recipe.migrate.applyCommand, cwd);
    return Promise.resolve({ ok: true, applied: 1, detail: "apply command ran" });
  } catch (err) {
    const msg = (err.stderr ?? err.message ?? "migration apply failed").toString().trim();
    return Promise.resolve({ ok: false, applied: 0, detail: `apply failed: ${msg}` });
  }
}

/** Spawn the boot command detached so the app stays up after this CLI exits. */
function bootApp({ worktreePath, recipe }) {
  const cwd = recipe.cwd ? path.join(worktreePath, recipe.cwd) : worktreePath;
  const child = spawn(recipe.command, { cwd, shell: true, detached: true, stdio: "ignore" });
  child.unref();
  return Promise.resolve({ pid: child.pid ?? null, detail: `spawned: ${recipe.command}` });
}

/** HTTP(S) readiness probe: resolve true on a 2xx/3xx response, false otherwise. */
function probe(url) {
  return new Promise((resolve) => {
    let client;
    try {
      client = new URL(url).protocol === "https:" ? https : http;
    } catch {
      resolve(false);
      return;
    }
    const req = client.get(url, (res) => {
      const ok = typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 400;
      res.resume();
      resolve(ok);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Assert the resolved worktree is NOT the primary checkout (fail closed). */
function assertNotPrimary({ worktreePath, repoRoot }) {
  let listOutput = "";
  try {
    listOutput = execFileSync("git", ["worktree", "list"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { ok: false, message: `git worktree list failed: ${(err.stderr ?? err.message ?? "").toString().trim()}` };
  }
  const mainWorktreePath = parseMainWorktreePath(listOutput);
  if (isMainCheckout(worktreePath, mainWorktreePath)) {
    return { ok: false, message: `${worktreePath} resolves to the primary checkout`, mainWorktreePath };
  }
  return { ok: true, mainWorktreePath };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseUiReviewProvisionCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await provisionAndBoot(
    {
      repoRoot: options.repoRoot,
      pr: options.pr,
      branch: options.branch,
      ackDestructiveMigration: options.ackDestructiveMigration,
    },
    {
      ensureWorktree: (a) => ensureWorktree(a).then((r) => ({ path: r.path, created: r.created, reused: r.reused })),
      assertNotPrimary,
      detectDepDelta,
      installDeps,
      resolveRunRecipe,
      inspectMigrations,
      applyMigrations,
      bootApp,
      probe,
      log: (msg) => stderr.write(`[ui-review-provision] ${msg}\n`),
    },
  );
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
