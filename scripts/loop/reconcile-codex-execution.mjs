#!/usr/bin/env node
/**
 * reconcile-codex-execution
 *
 * Thin CLI over the read-only Codex terminal-evidence adapter. Reconciles ONE
 * owned execution before any process-inspection or cleanup escalation.
 *
 * It exposes no pid, kill or signal option on purpose: a tool-session id is an
 * opaque string, never an OS process identifier.
 */

import { isDirectCliRun } from "../_core-helpers.mjs";
import { emitResult } from "../lib/jq-output.mjs";
import {
  resolveCodexExecutionEvidence,
  unsupportedRuntimeResult,
} from "@dev-loops/core/loop/codex-execution-evidence";
import { NATIVE_CODEX_THREAD_ID_PATTERN } from "@dev-loops/core/loop/run-context";

export const USAGE = `Usage: reconcile-codex-execution.mjs --repo-root <p> --owner-thread-id <uuid> --execution-id <id> --cwd <path> [--journal <path>] [--json]

Read-only terminal-evidence reconciliation for one owned Codex execution.
Reports \`completed\`, \`unknown\` or \`unsupported\`; never probes or kills a process.

Required:
  --repo-root <p>        Expected repository root
  --owner-thread-id <id> Native Codex owner thread id (UUIDv7)
  --execution-id <id>    Opaque tool-session/execution id (e.g. 12938)
  --cwd <path>           Expected working directory

Optional:
  --journal <path>       Fixture-only explicit journal path; requires
                         DEVLOOPS_RECONCILE_FIXTURE=1. Owner binding still applies.
  --json                 Emit the JSON result (default; accepted for compatibility)
  --jq <filter>          Filter the JSON result through the shared jq subset
  --silent, -s           Print nothing; use the exit code only
  --help, -h             Show this help

Exit codes:
  0  typed result: completed, unknown or unsupported
  1  unreadable or ambiguous owner journal (owner resolution fails closed)
  2  malformed arguments (unknown flag, missing required flag, invalid owner id, blank execution id, journal outside fixture role)`;

const VALUE_FLAGS = new Set(["repo-root", "owner-thread-id", "execution-id", "cwd", "journal", "jq"]);
const BOOLEAN_FLAGS = new Set(["json", "silent", "help"]);

class ArgumentError extends Error {}

function parseReconcileArgs(argv, env = process.env) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") { raw.help = true; continue; }
    if (token === "-s") { raw.silent = true; continue; }
    if (!token.startsWith("--")) throw new ArgumentError(`unexpected positional argument: ${token}`);
    const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new ArgumentError(`unrecognized flag: ${token}`);
    const name = match[1];
    if (VALUE_FLAGS.has(name)) {
      if (Object.hasOwn(raw, name)) throw new ArgumentError(`duplicate flag: --${name}`);
      let value = match[2];
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new ArgumentError(`missing value for --${name}`);
        index += 1;
      }
      raw[name] = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (match[2] !== undefined) throw new ArgumentError(`flag --${name} takes no value`);
      raw[name] = true;
      continue;
    }
    throw new ArgumentError(`unrecognized flag: --${name}`);
  }
  if (raw.help) return { help: true };
  for (const required of ["repo-root", "owner-thread-id", "execution-id", "cwd"]) {
    if (raw[required] === undefined || raw[required].trim() === "") {
      throw new ArgumentError(`missing required flag: --${required}`);
    }
  }
  if (!NATIVE_CODEX_THREAD_ID_PATTERN.test(raw["owner-thread-id"])) {
    throw new ArgumentError("--owner-thread-id must be a UUIDv7");
  }
  if (raw["execution-id"].trim() === "") throw new ArgumentError("--execution-id must be a non-blank opaque id");
  if (raw["repo-root"].trim() === "" || raw.cwd.trim() === "") throw new ArgumentError("--repo-root and --cwd must be non-blank paths");
  if (raw.journal !== undefined && raw.journal.trim() === "") {
    throw new ArgumentError("--journal must be a non-blank path when supplied");
  }
  if (raw.journal !== undefined && env.DEVLOOPS_RECONCILE_FIXTURE !== "1") {
    throw new ArgumentError("--journal is only available in the test/fixture role (DEVLOOPS_RECONCILE_FIXTURE=1)");
  }
  return {
    repoRoot: raw["repo-root"],
    ownerThreadId: raw["owner-thread-id"],
    executionId: raw["execution-id"],
    cwd: raw.cwd,
    journal: raw.journal,
    json: raw.json === true,
    jq: raw.jq,
    silent: raw.silent === true,
  };
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

/**
 * Run the CLI. Returns the process exit code.
 *
 * @param {string[]} [argv]
 * @param {{ env?: Record<string,string|undefined>, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  let options;
  try {
    options = parseReconcileArgs(argv, env);
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error;
    writeJson(stderr, { ok: false, error: error.message });
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const resolve = io.resolve ?? resolveCodexExecutionEvidence;
  let result;
  try {
    result = resolve({
      ownerThreadId: options.ownerThreadId,
      executionId: options.executionId,
      repoRoot: options.repoRoot,
      cwd: options.cwd,
      journalPath: options.journal,
      env,
    });
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (!result.ok) {
    writeJson(stderr, { ok: false, error: result.reason });
    return 1;
  }
  return emitResult(
    {
      ok: true,
      status: result.status,
      reason: result.reason,
      owner: result.owner,
      execution: result.execution,
      cleanup: result.cleanup,
    },
    { jq: options.jq, silent: options.silent, stdout, stderr },
  );
}

export { parseReconcileArgs, unsupportedRuntimeResult };

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = main();
}
