#!/usr/bin/env node
/**
 * run-gate-validation.mjs — GATE-EXEC-VALIDATION-ARTIFACT producer.
 *
 * The gate preamble runs this round's validation suites ONCE and records the
 * results here, so every per-angle reviewer of the same gate pass reads this
 * artifact instead of independently re-running the same suites (the token
 * cost that motivated #1550). write-gate-context.mjs's `--validation-results
 * <path>` flag threads this artifact's path into the shared briefing prefix
 * so reviewers know where to read it.
 *
 * Each `--suite <name>` MUST be a key of this repo's own package.json
 * `scripts` map — validated BEFORE anything executes. This is a trust
 * boundary: a free-form command string is never accepted, so this CLI can
 * only ever run what the repo's own package.json already declares runnable.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { GATE_NAMES, normalizeGate as normalizeGateShared, normalizeHeadSha as normalizeHeadShaShared } from "../github/_gate-names.mjs";
import { assertWorktreeAtHead, buildValidationResultsPath } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const DEFAULT_SUITES = ["verify"];
const OUTPUT_TAIL_CHARS = 4000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const USAGE = `Usage: run-gate-validation.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> [--suite <name>]... [--tmp-root <dir>]
Run this round's validation suites ONCE and record the results in the shared
validation-results artifact (GATE-EXEC-VALIDATION-ARTIFACT) so every per-angle
gate reviewer reads this record instead of re-running the same suites.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate|review>
  --head-sha <sha>
Optional:
  --suite <name>              npm script name to run (repeatable). MUST be a key
                               of this repo's package.json "scripts" map — an
                               unknown name fails closed (exit 1) BEFORE anything
                               runs. Default: verify
  --tmp-root <path>            Root tmp directory (default: tmp/)

Output (stdout, JSON — the artifact itself):
  { "ok": true, "repo": "...", "pr": 1, "gate": "draft_gate", "headSha": "...",
    "generatedAt": "...", "allPassed": true,
    "suites": [ { "name": "verify", "command": "npm run verify", "exitCode": 0,
                  "outputTail": "...", "outputPath": "tmp/gate-context/.../...log" } ] }
Exit codes:
  0   Success (even when a suite fails — allPassed:false is the signal)
  1   Usage/IO error (bad args, unknown --suite, unwritable artifact dir)
  2   Invalid --jq filter

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

const normalizeGate = normalizeGateShared;
const normalizeHeadSha = normalizeHeadShaShared;

export function parseRunGateValidationCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      suite: { type: "string", multiple: true },
      "tmp-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    suites: [],
    tmpRoot: "tmp",
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      return { help: true };
    }
    if (token.name === "repo") {
      const repo = requireTokenValue(token, parseError).trim();
      const parts = repo.split("/");
      if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
        throw parseError(`--repo must be in owner/name format, got: ${JSON.stringify(repo)}`);
      }
      options.repo = repo;
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "gate") {
      const gate = normalizeGate(requireTokenValue(token, parseError));
      if (!gate) throw parseError(`--gate must be one of: ${GATE_NAMES.join(", ")}`);
      options.gate = gate;
      continue;
    }
    if (token.name === "head-sha") {
      const sha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--head-sha must be a 7-64 character hex SHA");
      options.headSha = sha;
      continue;
    }
    if (token.name === "suite") {
      const name = requireTokenValue(token, parseError).trim();
      if (name.length === 0) throw parseError("--suite must not be empty/whitespace-only");
      options.suites.push(name);
      continue;
    }
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.suites.length === 0) {
    options.suites = [...DEFAULT_SUITES];
  }
  const missing = ["repo", "pr", "gate", "headSha"].filter((k) => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  return options;
}

/**
 * Trust-boundary guard: every `--suite` name must already be a key of the
 * repo's own `package.json` "scripts" map. Called BEFORE any suite runs, so
 * an unknown name fails closed without executing anything at all.
 * @param {string[]} suites
 * @param {Record<string, string>} scripts
 * @throws {Error} naming every unknown suite
 */
// A suite name lands verbatim in the per-suite log filename, so beyond being
// a known script it must also be a safe single path segment: no separators, no
// leading dot (covers ".."), nothing outside this conservative set. package.json
// script keys are repo-controlled input, not trusted input.
const SAFE_SUITE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function validateSuiteNames(suites, scripts) {
  const known = new Set(Object.keys(scripts ?? {}));
  const unknown = suites.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown validation suite(s) (not a key of this repo's package.json "scripts" map): ${unknown.join(", ")}. Refusing to execute anything.`,
    );
  }
  const unsafe = suites.filter((name) => !SAFE_SUITE_NAME_RE.test(name));
  if (unsafe.length > 0) {
    throw new Error(
      `Suite name(s) not usable as a log-file path segment (allowed: alphanumerics then [A-Za-z0-9._:-]): ${unsafe.join(", ")}. Refusing to execute anything.`,
    );
  }
}

/**
 * Read and parse `<repoRoot>/package.json`, returning its `scripts` map (or
 * `{}` when absent/malformed — an empty map rejects every `--suite` name via
 * {@link validateSuiteNames}, which is the correct fail-closed outcome).
 * @param {string} repoRoot
 * @returns {Promise<Record<string, string>>}
 */
export async function readPackageScripts(repoRoot) {
  let raw;
  try {
    raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
  } catch (err) {
    throw new Error(`could not read package.json in ${repoRoot}: ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`package.json in ${repoRoot} is not valid JSON: ${err?.message ?? err}`);
  }
  return parsed && typeof parsed.scripts === "object" && parsed.scripts !== null ? parsed.scripts : {};
}

// ponytail: a minimal CSI-sequence stripper (ESC '[' ... final-byte), covering
// every color/style code `npm run`/test reporters actually emit. Not a full
// ANSI-sequence grammar (OSC hyperlinks, DCS strings) — upgrade to a real
// ansi-regex dependency if a suite ever emits one of those into its tail.
export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Run one npm script suite via `npm run <name>` and capture stdout+stderr.
 * Never rejects: a non-zero exit or a spawn failure is reported as a suite
 * result, not thrown, so one suite's failure never aborts the round.
 * @param {string} name
 * @param {{ repoRoot: string }} opts
 * @returns {Promise<{ name: string, command: string, exitCode: number, output: string }>}
 */
function runSuite(name, { repoRoot }) {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["run", name],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER_BYTES, env: process.env },
      (error, stdout, stderr) => {
        let output = `${stdout ?? ""}${stderr ?? ""}`;
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (error && output.trim().length === 0) {
          // A spawn-level failure (e.g. npm itself missing) leaves stdout/stderr
          // empty — surface the error message instead of an unexplained blank log.
          output = error.message ?? String(error);
        }
        resolve({ name, command: `npm run ${name}`, exitCode, output });
      },
    );
  });
}

/**
 * Run every named suite once, write each suite's full (ANSI-stripped) output
 * to its own log file beside the validation-results artifact, and build the
 * artifact object. No I/O beyond the per-suite log writes; the caller writes
 * the artifact itself.
 * @param {object} input — { repo, pr, gate, headSha, suites, tmpRoot }
 * @param {{ repoRoot: string }} opts
 * @returns {Promise<object>} the artifact (no `ok`/ file-write side effect on the artifact itself)
 */
export async function buildValidationArtifact({ repo, pr, gate, headSha, suites, tmpRoot }, { repoRoot }) {
  const artifactPath = buildValidationResultsPath({ repo, pr, gate, headSha, tmpRoot });
  const artifactDir = path.dirname(artifactPath);
  await mkdir(path.resolve(repoRoot, artifactDir), { recursive: true });

  const suiteResults = [];
  for (const name of suites) {
    const { command, exitCode, output } = await runSuite(name, { repoRoot });
    const cleaned = stripAnsi(output);
    // ":" is a routine npm-script-key character (assets:check, schema:check)
    // but not a valid filename character on Windows, so it is mapped to "-"
    // in the log filename only; the artifact's `name` field keeps the real
    // suite name. Two keys differing only by ":" vs "-" would share a log
    // file; accepted, since both must already be safe path segments and the
    // artifact entries stay distinct.
    const logName = name.replace(/:/g, "-");
    const outputPath = path.join(artifactDir, `${gate}-${headSha}.validation-${logName}.log`);
    await writeFile(path.resolve(repoRoot, outputPath), cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`, "utf8");
    suiteResults.push({
      name,
      command,
      exitCode,
      outputTail: cleaned.slice(-OUTPUT_TAIL_CHARS),
      outputPath,
    });
  }

  return {
    ok: true,
    repo,
    pr,
    gate,
    headSha,
    generatedAt: new Date().toISOString(),
    allPassed: suiteResults.every((s) => s.exitCode === 0),
    // Stamp dependency state relative to package-lock.json (#1627): a worktree
    // whose installed deps (node_modules/.package-lock.json) do not match the
    // lockfile is validated against stale deps, so the artifact records the
    // delta instead of blessing it. Non-blocking (does not flip allPassed) — it
    // is a trust signal for consumers of the artifact, not a hard gate failure.
    depState: await resolveDepState(repoRoot),
    suites: suiteResults,
  };
}

/**
 * Whether a package-lock.json `packages[]` entry is installable on the
 * current host, given its optional `os`/`cpu` platform gates.
 * @param {{os?: string[], cpu?: string[]}} pkg
 * @returns {boolean}
 */
function isInstallableOnHost(pkg) {
  if (pkg.os && !pkg.os.includes(process.platform)) return false;
  if (pkg.cpu && !pkg.cpu.includes(process.arch)) return false;
  return true;
}

/**
 * Walk up from `startDir` to the nearest ancestor (inclusive) with a
 * `node_modules/.package-lock.json`, returning its raw contents and the
 * directory it was found in. Returns `{ raw: null, root: null }` when no
 * ancestor up to the filesystem root has one.
 * @param {string} startDir
 * @returns {Promise<{raw: string | null, root: string | null}>}
 */
async function findAncestorInstalledLock(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const raw = await readFile(path.join(dir, "node_modules", ".package-lock.json"), "utf8").catch(() => null);
    if (raw !== null) return { raw, root: dir };
    const parent = path.dirname(dir);
    if (parent === dir) return { raw: null, root: null };
    dir = parent;
  }
}

/**
 * Compare the repo's package-lock.json against the installed lock snapshot
 * (node_modules/.package-lock.json) (#1627). A mismatch means the validation
 * suites ran against stale deps — stamped, not blocking, so gate consumers can
 * distrust a stale run without a stale run itself failing the gate.
 *
 * npm's hidden lockfile (`node_modules/.package-lock.json`) is NEVER byte-
 * identical to the committed `package-lock.json` (it omits the root package
 * entry `packages[""]` and install-time metadata), so the comparison must be
 * structure-aware: the non-root dependency tree is compared by
 * `node_modules/<path>` key + `version`. A package present in the lock but
 * missing or version-differing in the installed snapshot means the installed
 * deps are stale relative to the lock. Cross-platform pure optional packages
 * (os/cpu-gated to a non-host platform) are not installed on this host, so they
 * are excluded from the comparison to avoid false "stale" stamps on a synced
 * tree.
 *
 * A loop worktree (tmp/worktrees/<repo>/<kind>-<n>) is a linked checkout:
 * ensure-worktree.mjs symlinks only `node_modules/@dev-loops/core` into it
 * and never runs `npm install` there, so the worktree has no local
 * `node_modules/.package-lock.json` of its own — the suites it runs still
 * resolve every other dependency by Node's normal ancestor-directory module
 * resolution, reaching the main checkout's `node_modules` above it. Reading
 * only `<repoRoot>/node_modules/.package-lock.json` therefore stamps every
 * worktree round "stale" unconditionally, regardless of whether the deps the
 * suites actually ran against are fresh. The installed-lock lookup below
 * walks up from `repoRoot` to the nearest ancestor directory that has one,
 * so it reads the dependency root the suites actually ran against.
 *
 * @param {string} repoRoot - Absolute path to the repo (main checkout or worktree).
 * @returns {Promise<{status: string, detail: string}>}
 */
async function resolveDepState(repoRoot) {
  const lockRaw = await readFile(path.join(repoRoot, "package-lock.json"), "utf8").catch(() => null);
  if (lockRaw === null) {
    return { status: "n-a", detail: "no package-lock.json at repo root" };
  }
  const { raw: installedRaw, root: depRoot } = await findAncestorInstalledLock(repoRoot);
  if (installedRaw === null) {
    return { status: "stale", detail: "node_modules/.package-lock.json absent in repoRoot or any ancestor — installed deps not materialized (npm ci/install not run)" };
  }
  const depRootNote = depRoot === repoRoot ? "" : ` (resolved from ancestor ${depRoot})`;
  let lock;
  let installed;
  try {
    lock = JSON.parse(lockRaw);
  } catch {
    return { status: "n-a", detail: "package-lock.json unparseable" };
  }
  try {
    installed = JSON.parse(installedRaw);
  } catch {
    return { status: "stale", detail: `node_modules/.package-lock.json unparseable${depRootNote} — cannot verify installed deps` };
  }
  const expected = lock.packages ?? {};
  const have = installed.packages ?? {};
  const missing = [];
  const mismatched = [];
  for (const [key, val] of Object.entries(expected)) {
    if (key === "") continue; // root package — absent from the installed hidden lock
    if (typeof val !== "object" || val === null) continue;
    if (!isInstallableOnHost(val)) continue; // non-host os/cpu-gated optional — never installed
    const installedEntry = have[key];
    if (!installedEntry) {
      missing.push(key);
      continue;
    }
    if (installedEntry.version !== val.version) mismatched.push(key);
  }
  if (missing.length === 0 && mismatched.length === 0) {
    const installedCount = Object.keys(have).filter((k) => k !== "").length;
    return { status: "synced", detail: `installed deps match package-lock.json (${installedCount} packages)${depRootNote}` };
  }
  const parts = [];
  if (missing.length) parts.push(`${missing.length} missing package(s)`);
  if (mismatched.length) parts.push(`${mismatched.length} version-mismatched package(s)`);
  return { status: "stale", detail: `installed deps diverge from package-lock.json${depRootNote}: ${parts.join(", ")}` };
}

/**
 * CLI entrypoint.
 * @param {string[]} [argv]
 * @param {{ repoRoot?: string }} [runtime]
 */
export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd() } = {}) {
  let options;
  try {
    options = parseRunGateValidationCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    // The artifact stamps --head-sha as the reviewers' only integrity handle, so
    // the suites must provably run in a tree checked out at that head; a stale
    // cwd would otherwise validate a different tree under this head's stamp.
    assertWorktreeAtHead(options.headSha, { repoRoot });
    const scripts = await readPackageScripts(repoRoot);
    validateSuiteNames(options.suites, scripts);

    const artifact = await buildValidationArtifact(
      { repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, suites: options.suites, tmpRoot: options.tmpRoot },
      { repoRoot },
    );

    const artifactPath = buildValidationResultsPath({
      repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, tmpRoot: options.tmpRoot,
    });
    await writeFile(path.resolve(repoRoot, artifactPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    process.exitCode = emitResult(artifact, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
