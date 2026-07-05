#!/usr/bin/env node
/**
 * Provision a freshly-created worktree with the gitignored files/dirs the app
 * and tests need, copied/symlinked from the main checkout per `.devloops`
 * `worktree.copyOnInit` / `worktree.linkOnInit` (issue #909).
 *
 * - Sources resolve against the main checkout (`--repo-root`), never cwd.
 * - Entries are repo-relative literal paths OR glob patterns (native fsp.glob).
 * - copy = `fs.cp(recursive)`; link = absolute symlink into the main checkout.
 * - Every resolved source MUST resolve inside the main checkout (traversal guard).
 * - Fail-soft: a missing source / empty glob logs one warning and continues.
 * - Idempotent: skips a dest that is already correct.
 * - Does NOT run npm install (deps belong to `npm ci`-in-worktree).
 *
 * Also (unconditionally, independent of .devloops): links the workspace
 * package node_modules/@dev-loops/core -> ../../packages/core (relative,
 * pointing at the WORKTREE's own packages/core). Without npm install/ci in a
 * fresh worktree there is no node_modules at all, so scripts/**'s
 * `@dev-loops/core` imports resolve UP-TREE to the nearest ancestor
 * node_modules (the main checkout's) — silently testing main's core instead
 * of the branch's (#1144). Stale/broken links are replaced; a real file/dir
 * already occupying the slot is left alone (dest-conflict, never clobbered).
 *
 * Prints a JSON summary of actions to stdout. Never throws on a per-entry
 * problem; exits 0 unless its own arguments are invalid.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { loadDevLoopConfig, resolveWorktreeConfig } from "@dev-loops/core/config";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  provision-worktree.mjs --worktree-path <p> --repo-root <p>
Provision a worktree with gitignored files/dirs from the main checkout,
driven by .devloops worktree.copyOnInit / worktree.linkOnInit.
Required:
  --worktree-path <p>   Absolute path to the target worktree.
  --repo-root <p>       Absolute path to the main checkout (source of files).
Optional:
  -h, --help            Show this help.
Output (stdout, JSON):
  { "ok": true, "actions": [ { "mode": "copy"|"link"|"skip"|"reject", ... } ],
    "summary": { "copied": n, "linked": n, "skipped": n, "rejected": n,
                 "warnings": n } }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseProvisionWorktreeCliArgs(argv) {
  const options = { help: false, worktreePath: undefined, repoRoot: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "worktree-path": { type: "string" },
      "repo-root": { type: "string" },
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
    if (token.name === "worktree-path") {
      options.worktreePath = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "repo-root") {
      options.repoRoot = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.worktreePath) throw parseError("Missing required --worktree-path");
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  return options;
}

/**
 * Resolve a repo-relative entry (literal or glob) to matched absolute sources
 * inside repoRoot. Returns `{ matches: string[], traversal: string[] }`.
 * `traversal` holds matches that escaped repoRoot (rejected by caller).
 */
async function expandEntry(entry, repoRoot) {
  const matches = [];
  const traversal = [];
  const isGlob = /[*?[\]{}]/.test(entry);
  const inside = (abs) => abs === repoRoot || abs.startsWith(repoRoot + path.sep);

  if (isGlob) {
    // native fsp.glob (Node >=22) — expand against the main checkout.
    for await (const rel of fsp.glob(entry, { cwd: repoRoot })) {
      const abs = path.resolve(repoRoot, rel);
      (inside(abs) ? matches : traversal).push(abs);
    }
  } else {
    const abs = path.resolve(repoRoot, entry);
    (inside(abs) ? matches : traversal).push(abs);
  }
  return { matches, traversal };
}

async function pathExists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lexical `inside()` guard in expandEntry can't see through symlinks: a
 * source that is itself a symlink (or sits under a symlinked dir) pointing
 * OUTSIDE repoRoot resolves clean lexically but escapes on realpath. Re-check
 * the realpath here BEFORE any copy/link. Returns true when the resolved
 * source is genuinely inside repoRoot. Non-existent source → treat as inside
 * (the copy/link helpers handle missing sources with their own warning).
 */
async function realpathInside(src, repoRoot) {
  let real;
  try {
    real = await fsp.realpath(src);
  } catch {
    return true; // missing/broken — let the copy/link helper report it
  }
  const realRoot = await fsp.realpath(repoRoot).catch(() => repoRoot);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/** Copy: idempotent skip when dest already exists (worktree reuse). */
async function provisionCopy(src, dest, logWarn) {
  if (!(await pathExists(src))) {
    logWarn(`copyOnInit source missing, skipping: ${src}`);
    return { mode: "skip", reason: "source-missing", src, dest };
  }
  if (await pathExists(dest)) return { mode: "skip", reason: "exists", src, dest };
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(src, dest, { recursive: true });
  return { mode: "copy", src, dest };
}

/** Symlink: absolute link into the main checkout. Idempotent when correct. */
async function provisionLink(src, dest, logWarn) {
  if (!(await pathExists(src))) {
    logWarn(`linkOnInit source missing, skipping: ${src}`);
    return { mode: "skip", reason: "source-missing", src, dest };
  }
  const existing = await fsp.readlink(dest).catch(() => null);
  if (existing !== null) {
    if (path.resolve(path.dirname(dest), existing) === src) {
      return { mode: "skip", reason: "exists", src, dest };
    }
    return { mode: "skip", reason: "dest-conflict", src, dest };
  }
  if (await pathExists(dest)) return { mode: "skip", reason: "dest-conflict", src, dest };
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.symlink(src, dest); // absolute target — survives worktree moves under tmp/
  return { mode: "link", src, dest };
}

/**
 * Ensure node_modules/@dev-loops/core -> ../../packages/core (relative) in the
 * worktree, pointing at the worktree's OWN packages/core — never the main
 * checkout's (#1144). Idempotent: a correct link is a no-op; a stale/broken
 * link is replaced; a real file/dir at the dest is a dest-conflict skip
 * (never clobbered). node_modules is gitignored repo-wide, so this link is
 * always untracked.
 */
async function ensureCoreWorkspaceLink(worktreePath, logWarn) {
  const corePkgDir = path.join(worktreePath, "packages", "core");
  const scopeDir = path.join(worktreePath, "node_modules", "@dev-loops");
  const linkPath = path.join(scopeDir, "core");

  if (!(await pathExists(corePkgDir))) {
    logWarn(`workspace self-link source missing, skipping: ${corePkgDir}`);
    return { mode: "skip", reason: "source-missing", src: corePkgDir, dest: linkPath };
  }

  const relTarget = path.relative(scopeDir, corePkgDir);
  const existing = await fsp.readlink(linkPath).catch(() => null);
  if (existing !== null) {
    // Only the exact RELATIVE target is idempotent. An absolute (or otherwise
    // differently-spelled) link that happens to resolve correctly is
    // normalized to the relative form — absolute links break when the
    // worktree moves under tmp/.
    if (existing === relTarget) {
      return { mode: "skip", reason: "exists", src: corePkgDir, dest: linkPath };
    }
    await fsp.rm(linkPath, { force: true }); // stale/absolute/broken — replace below
  } else if (await pathExists(linkPath)) {
    logWarn(`workspace self-link dest conflict (not a symlink), skipping: ${linkPath}`);
    return { mode: "skip", reason: "dest-conflict", src: corePkgDir, dest: linkPath };
  }

  await fsp.mkdir(scopeDir, { recursive: true });
  await fsp.symlink(relTarget, linkPath);
  return { mode: "link", src: corePkgDir, dest: linkPath };
}

export async function provisionWorktree({ worktreePath, repoRoot }, { loadConfig = loadDevLoopConfig } = {}) {
  const root = path.resolve(repoRoot);
  const dst = path.resolve(worktreePath);
  const actions = [];
  const warnings = [];
  const logWarn = (msg) => {
    warnings.push(msg);
    process.stderr.write(`[provision-worktree] WARN ${msg}\n`);
  };

  // Fail-closed (repo convention): a config that failed to load/validate is
  // treated as EMPTY — zero provisioning actions, one WARN. We never act on an
  // unvalidated config (a bad entry could copy/link the wrong source).
  const { config, errors } = await loadConfig({ repoRoot: root });
  const safeConfig = errors && errors.length > 0 ? null : config;
  if (safeConfig === null && errors && errors.length > 0) {
    logWarn(`dev-loop config invalid (${errors.length} error(s)) — provisioning EMPTY config (no copy/link)`);
  }
  const { copyOnInit, linkOnInit } = resolveWorktreeConfig(safeConfig);

  for (const [entries, kind] of [[copyOnInit, "copy"], [linkOnInit, "link"]]) {
    for (const entry of entries) {
      const { matches, traversal } = await expandEntry(entry, root);
      for (const abs of traversal) {
        logWarn(`rejected (outside main checkout): ${entry} → ${abs}`);
        actions.push({ mode: "reject", reason: "traversal", entry, src: abs });
      }
      if (matches.length === 0 && traversal.length === 0) {
        logWarn(`no match for ${kind}OnInit entry: ${entry}`);
        actions.push({ mode: "skip", reason: "no-match", entry });
        continue;
      }
      for (const src of matches) {
        // Symlink-aware traversal guard: a source whose realpath escapes the
        // main checkout is rejected before any copy/link (the lexical inside()
        // above cannot see through symlinks).
        if (!(await realpathInside(src, root))) {
          logWarn(`rejected (symlink escapes main checkout): ${entry} → ${src}`);
          actions.push({ mode: "reject", reason: "traversal", entry, src });
          continue;
        }
        const dest = path.join(dst, path.relative(root, src));
        // Fail-soft per the header promise: a per-entry copy/link failure (e.g.
        // EACCES, dest conflict the helper didn't catch) logs ONE WARN, records
        // a skip action, and continues — it never aborts the whole run.
        try {
          const res = kind === "copy"
            ? await provisionCopy(src, dest, logWarn)
            : await provisionLink(src, dest, logWarn);
          actions.push({ entry, ...res });
        } catch (err) {
          const msg = (err && err.message) ? err.message : String(err);
          logWarn(`${kind} failed, skipping: ${src} → ${dest}: ${msg}`);
          actions.push({ entry, mode: "skip", reason: `${kind}-failed: ${msg}`, src, dest });
        }
      }
    }
  }

  // Unconditional (not driven by .devloops, still applies under a fail-closed
  // empty config) — the worktree's own package resolution is a structural
  // need, not an opt-in copy/link entry.
  try {
    const selfLink = await ensureCoreWorkspaceLink(dst, logWarn);
    actions.push({ entry: "node_modules/@dev-loops/core", ...selfLink });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    logWarn(`workspace self-link failed, skipping: ${msg}`);
    actions.push({
      entry: "node_modules/@dev-loops/core",
      mode: "skip",
      reason: `link-failed: ${msg}`,
      src: path.join(dst, "packages", "core"),
      dest: path.join(dst, "node_modules", "@dev-loops", "core"),
    });
  }

  const summary = { copied: 0, linked: 0, skipped: 0, rejected: 0, warnings: warnings.length };
  for (const a of actions) {
    if (a.mode === "copy") summary.copied++;
    else if (a.mode === "link") summary.linked++;
    else if (a.mode === "skip") summary.skipped++;
    else if (a.mode === "reject") summary.rejected++;
  }
  return { ok: true, actions, summary };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseProvisionWorktreeCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await provisionWorktree(options);
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
