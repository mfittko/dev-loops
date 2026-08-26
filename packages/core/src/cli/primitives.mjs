import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

/**
 * Shared CLI primitives for arg parsing, validation, and child process execution.
 * Extracted from scripts/_cli-primitives.mjs per issue #548 Phase 2.
 */

/**
 * Parse argv with node:util parseArgs while preserving the legacy hand-rolled
 * parser semantics that several callers depend on:
 *
 * - Unknown options/positionals throw `Unknown argument: <raw>`.
 * - A string option whose value is missing or looks like another flag throws
 *   `Missing value for <--flag>` (matching {@link requireOptionValue}).
 *
 * Returns a Map of canonical option name -> value (last-wins for repeats, which
 * matches the legacy while/shift loops that simply reassigned on each match).
 *
 * @param {string[]} argv
 * @param {Record<string, { type: "string" | "boolean", short?: string }>} options
 * @param {(message: string) => Error} [parseError]
 * @param {{ allowPositionals?: boolean, flagPattern?: RegExp }} [config]
 * @returns {{ values: Map<string, string | boolean>, positionals: string[] }}
 */
export function parseCliTokens(argv, options, parseError = null, { allowPositionals = false, flagPattern = /^--/u } = {}) {
  const { tokens } = parseArgs({
    args: [...argv],
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const values = new Map();
  const positionals = [];

  for (const token of tokens) {
    if (token.kind === "positional") {
      if (allowPositionals) {
        positionals.push(token.value);
        continue;
      }
      throw toCliError(`Unknown argument: ${token.value}`, parseError);
    }

    if (token.kind !== "option") {
      continue;
    }

    const spec = options[token.name];
    if (!spec) {
      throw toCliError(`Unknown argument: ${token.rawName}`, parseError);
    }

    if (spec.type === "boolean") {
      // A bare boolean flag carries no value (parseArgs → undefined) and means true;
      // an explicit inline value (e.g. --flag=false) is honored rather than forced true.
      values.set(token.name, token.value === undefined ? true : token.value !== "false");
      continue;
    }

    const value = token.value;
    if (typeof value !== "string" || value.length === 0 || flagPattern.test(value)) {
      throw toCliError(`Missing value for ${token.rawName}`, parseError);
    }
    values.set(token.name, value);
  }

  return { values, positionals };
}

function toCliError(message, parseError) {
  if (typeof parseError === "function") {
    return parseError(message);
  }
  return new Error(message);
}

export function requireOptionValue(args, flag, parseError = null, { flagPattern = /^--/u } = {}) {
  const value = args.shift();
  if (typeof value !== "string" || value.length === 0 || flagPattern.test(value)) {
    throw toCliError(`Missing value for ${flag}`, parseError);
  }
  return value;
}

/**
 * Token-based equivalent of {@link requireOptionValue} for callers that have
 * migrated to node:util parseArgs with `tokens: true`. Validates the value
 * attached to a parsed option token, rejecting missing or flag-like values with
 * the same `Missing value for <--flag>` message the legacy parsers emitted.
 *
 * @param {{ value?: string, rawName?: string }} token - a parseArgs option token
 * @param {(message: string) => Error} [parseError]
 * @param {{ flagPattern?: RegExp }} [config]
 * @returns {string}
 */
export function requireTokenValue(token, parseError = null, { flagPattern = /^--/u } = {}) {
  const value = token?.value;
  if (typeof value !== "string" || value.length === 0 || flagPattern.test(value)) {
    throw toCliError(`Missing value for ${token?.rawName}`, parseError);
  }
  return value;
}

export function parsePositiveInteger(value, flag, parseError = null) {
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    throw toCliError(`${flag} must be a positive integer`, parseError);
  }
  return Number(value);
}

export function parseNonNegativeInteger(value, flag, parseError = null) {
  if (!/^\d+$/.test(value)) {
    throw toCliError(`${flag} must be a non-negative integer`, parseError);
  }
  return Number(value);
}

export function parsePrNumber(value, parseError = null) {
  return parsePositiveInteger(value, "--pr", parseError);
}

export function parseIssueNumber(value, parseError = null) {
  return parsePositiveInteger(value, "--issue", parseError);
}

// Parse a comma-separated allowlist of numeric issue/PR ids (e.g. `1670,9000`
// from an `--allowed-refs` CLI option). Returns the ids as deduped numeric
// strings, empty array for an empty/whitespace-only input. Rejects any
// non-numeric (or zero) entry so a typo can never silently allowlist nothing.
export function parseAllowedRefsCsv(value, flag, parseError = null) {
  const parts = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const ids = [];
  for (const part of parts) {
    if (!/^\d+$/u.test(part) || Number(part) === 0) {
      throw toCliError(`${flag} must be a comma-separated list of positive integers (got ${JSON.stringify(part)})`, parseError);
    }
    if (!ids.includes(part)) {
      ids.push(part);
    }
  }
  return ids;
}

// `stdinText` is optional and additive: omit it and stdin stays closed exactly
// as before. Supply it (a `gh api ... --input -` payload) and it is piped in,
// so a caller that needs stdin no longer has to reach for a second, separately
// injected runner — every gh call in a script can route through the ONE
// runChild its tests already stub.
export function runChild(command, args, env = process.env, stdinText = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    }
    child.on("error", reject);
    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

/**
 * Resolve a `--body <text>` / `--body-file <path>` pair to the actual body
 * string, the one file-reading step every `--body-file` CLI flag in this repo
 * needs: read the file (or stdin, when `allowStdin` and `bodyFile === "-"`)
 * and FAIL CLOSED (throw) on an empty/whitespace-only result, so a blank or
 * unreadable `--body-file` can never silently clear a PR/comment body. When
 * `bodyFile` is absent, `body` is returned unchanged (no emptiness check —
 * callers that must reject an empty inline `--body` do that themselves,
 * since not every caller enforces it).
 *
 * @param {object} input
 * @param {string} [input.body] — inline body value, returned as-is when no bodyFile
 * @param {string} [input.bodyFile] — path to read the body from ("-" = stdin, when allowStdin)
 * @param {boolean} [input.allowStdin] — honor `bodyFile === "-"` as stdin (fd 0); default false
 * @returns {Promise<string | undefined>}
 */
export async function resolveBodyOrFile({ body, bodyFile, allowStdin = false } = {}) {
  if (bodyFile === undefined || bodyFile === null) return body;
  // fs/promises readFile does not accept an integer fd, so stdin (fd 0) is
  // read synchronously via the callback-style API, which does.
  const content = allowStdin && bodyFile === "-" ? readFileSync(0, "utf8") : await readFile(bodyFile, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`--body-file ${bodyFile} is empty`);
  }
  return content;
}

export function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return; }
      reject(new Error(stderr.trim().length > 0 ? stderr.trim() : `${command} exited with code ${code}`));
    });
  });
}
