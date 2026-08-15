#!/usr/bin/env node
/**
 * Resolve where the gate verdict/ledger tooling should run from (issue #1661).
 *
 * A stale installed dev-loops CLI (e.g. rc.1) lacks the gate-evidence CI
 * exclusion that newer source (rc.4+) has, so posting a pre_approval_gate
 * verdict through the stale script blocks on WAITING_FOR_CI. Canonical fix
 * surface is the dev-loop skill's script-path resolution: prefer the
 * worktree/source-scripts layout for verdict/ledger tooling whenever the
 * installed CLI version is older than the current source.
 *
 * This helper makes that preference deterministic. It compares the installed
 * dev-loops CLI version (resolved via the same bounded candidates the dev-loop
 * entrypoint uses) against the current source/worktree version (this script's
 * own repo root by default) and reports which layout to prefer.
 *
 * VERDICT-LEDGER-SOURCE: verdict/ledger tooling (upsert-checkpoint-verdict.mjs,
 * write-gate-findings-log.mjs, detect-checkpoint-evidence.mjs) MUST resolve via
 * this helper and run from the worktree-source layout when stale === true
 * (installed version older than source); otherwise keep the canonical installed
 * layout. Non-goal (#1661): this does NOT change the gate-evidence CI exclusion
 * logic in upsert-checkpoint-verdict.mjs itself.
 *
 * Output (stdout, JSON):
 *   { "ok": true, "preferredSource": "worktree"|"installed", "stale": bool,
 *     "installedVersion": ..., "sourceVersion": ..., "reason": "<why>" }
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildParseError } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  resolve-verdict-ledger-source.mjs [--source-root <path>] [--installed-root <path>]

Compare the installed dev-loops CLI version against the current source/worktree
version and report which layout the gate verdict/ledger tooling should run from
(issue #1661). Prefer worktree-source scripts when the installed CLI is stale.

Optional:
  --source-root <path>    Path to the dev-loops source/worktree package.json.
                          Default: this script's own repo root (../..).
  --installed-root <path> Path to the installed dev-loops package (its root
                          package.json). Default: bounded candidate detection
                          (node-module resolution, ~/.pi/agent/npm, npm root -g).
  -h, --help              Show this help.

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

// --- Pure version logic (unit-tested) ---

// Split "1.2.3-rc.5" (or "v1.2.3", or "1.2.3") into { core:[1,2,3], pre:"rc.5"|null }.
// Returns null for anything not parseable as a version core.
export function splitVersion(value) {
  if (typeof value !== "string") return null;
  const base = value.trim().replace(/^v/i, "");
  if (!base) return null;
  const dash = base.indexOf("-");
  const coreRaw = dash === -1 ? base : base.slice(0, dash);
  const pre = dash === -1 ? null : base.slice(dash + 1) || null;
  const core = coreRaw.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : Number.NaN));
  if (core.some((x) => Number.isNaN(x))) return null;
  return { core, pre };
}

// Compare two version strings (semver-ish; handles the rc.N prerelease pattern).
// Returns -1/0/1, or NaN when either input is unparseable.
export function compareVersions(a, b) {
  const A = splitVersion(a);
  const B = splitVersion(b);
  if (!A || !B) return Number.NaN;
  const len = Math.max(A.core.length, B.core.length);
  for (let i = 0; i < len; i++) {
    const av = A.core[i] ?? 0;
    const bv = B.core[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1; // release > prerelease
  if (B.pre === null) return -1;
  const toks = (s) => s.split(".").map((t) => (/^\d+$/.test(t) ? { n: Number(t) } : { s: t }));
  const at = toks(A.pre);
  const bt = toks(B.pre);
  const ml = Math.max(at.length, bt.length);
  for (let i = 0; i < ml; i++) {
    const aTok = at[i];
    const bTok = bt[i];
    if (aTok === undefined) return -1;
    if (bTok === undefined) return 1;
    if ("n" in aTok && "n" in bTok) {
      if (aTok.n !== bTok.n) return aTok.n < bTok.n ? -1 : 1;
    } else if ("s" in aTok && "s" in bTok) {
      if (aTok.s !== bTok.s) return aTok.s < bTok.s ? -1 : 1;
    } else {
      return "n" in aTok ? -1 : 1; // numeric prerelease segment sorts before string
    }
  }
  return 0;
}

// Decide which layout to prefer for verdict/ledger tooling.
export function resolveVerdictLedgerSource({ installedVersion, sourceVersion }) {
  const ip = String(installedVersion ?? "");
  const sp = String(sourceVersion ?? "");
  const cmp = compareVersions(sp, ip);
  const stale = cmp > 0; // source newer than installed
  return {
    ok: true,
    preferredSource: stale ? "worktree" : "installed",
    stale,
    installedVersion: ip,
    sourceVersion: sp,
    reason: stale
      ? `Installed dev-loops CLI (${ip}) is older than the source/worktree (${sp}); verdict/ledger tooling runs from the worktree source (has the gate-evidence CI exclusion).`
      : `Installed dev-loops CLI (${ip}) is not older than the source/worktree (${sp}); keep the canonical installed layout.`,
  };
}

// --- Installed package-root detection (bounded candidates, mirrors dev-loop entrypoint) ---

function readVersion(pkgRoot) {
  if (!pkgRoot) return null;
  const p = path.join(pkgRoot, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function detectInstalledRoot() {
  // 1. Node module resolution (best-effort).
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const entry = req.resolve("dev-loops/cli/index.mjs");
    return path.resolve(path.dirname(entry), "..");
  } catch {
    /* fall through */
  }
  // 2. Pi user-agent npm root.
  const home = process.env.HOME || os.homedir();
  const piRoot = path.join(home, ".pi/agent/npm/node_modules/dev-loops");
  if (existsSync(path.join(piRoot, "package.json"))) return piRoot;
  // 3. Global npm root.
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const globalRoot = path.join(g, "dev-loops");
    if (existsSync(path.join(globalRoot, "package.json"))) return globalRoot;
  } catch {
    /* ignore */
  }
  return null;
}

function parseResolveVerdictLedgerSourceCliArgs(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "source-root": { type: "string" },
      "installed-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
  });
  return values;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const values = parseResolveVerdictLedgerSourceCliArgs(argv);
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const sourceRoot =
    values["source-root"] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const installedRoot = values["installed-root"] ?? (await detectInstalledRoot());
  const sourceVersion = readVersion(sourceRoot) ?? "unknown";
  const installedVersion = readVersion(installedRoot) ?? "unknown";
  let result;
  if (sourceVersion === "unknown" || installedVersion === "unknown") {
    result = {
      ok: true,
      preferredSource: "installed",
      stale: false,
      installedVersion,
      sourceVersion,
      reason: `Could not compare versions (source=${sourceVersion}, installed=${installedVersion}); keep the canonical installed layout.`,
    };
  } else {
    result = resolveVerdictLedgerSource({ installedVersion, sourceVersion });
  }
  return emitResult(result, {
    jq: values.jq,
    silent: values.silent,
    stdout: io.stdout,
    stderr: io.stderr,
  });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exitCode = code);
}
