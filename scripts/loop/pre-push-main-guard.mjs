#!/usr/bin/env node
import { createInterface } from "node:readline";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";

const DEVLOOPS_PREPUSH_BYPASS_VAR = "DEVLOOPS_PREPUSH_BYPASS";
const BLOCKED_REFS = ["refs/heads/main"];

const USAGE = `Usage:
  pre-push-main-guard.mjs

Reads pre-push hook input from stdin (Git pre-push hook protocol).
Blocks direct pushes to protected refs (by default: refs/heads/main).

Exit codes:
  0  Push allowed (non-main ref, or bypassed)
  1  Push blocked (target is a protected ref)

Bypass:
  DEVLOOPS_PREPUSH_BYPASS=1   Skip all checks (for emergencies only).
                         Preferred: push a feature branch and open a PR.`.trim();

const parseError = buildParseError(USAGE);

/**
 * Parse pre-push hook input lines.
 *
 * Git pre-push hook protocol: each line is four whitespace-delimited fields:
 *   <local ref> <local sha> <remote ref> <remote sha>
 * The fourth field (remote sha) is all-zeros for new branches.
 *
 * This parser accepts lines with at least three fields (treating the
 * optional fourth field as null when absent). Malformed non-empty
 * lines with fewer than three fields are ignored silently — the guard
 * prefers to fail-open on unparseable input rather than silently
 * blocking unknown refs.
 */
async function readPushRefs(input) {
  const refs = [];
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      refs.push({ localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] || null });
    }
  }
  return refs;
}

/**
 * Check whether any push target is a blocked ref.
 */
function findBlockedRef(refs) {
  for (const ref of refs) {
    if (BLOCKED_REFS.includes(ref.remoteRef)) {
      return ref.remoteRef;
    }
  }
  return null;
}

export function parsePrePushGuardCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") return { help: true };
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  return { help: false };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env } = {}) {
  const options = parsePrePushGuardCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }

  if ((env[DEVLOOPS_PREPUSH_BYPASS_VAR] ?? "").trim() === "1") {
    stdout.write(JSON.stringify({ ok: true, bypassed: true, reason: `${DEVLOOPS_PREPUSH_BYPASS_VAR}=1` }) + "\n");
    return { ok: true, bypassed: true };
  }

  const refs = await readPushRefs(stdin);
  const blockedRef = findBlockedRef(refs);

  if (blockedRef) {
    const payload = {
      ok: false,
      error: "direct_push_to_main_blocked",
      blockedRef,
      message: "Direct pushes to main branch are blocked. Push a feature branch and open a pull request instead.",
    };
    stderr.write(`${JSON.stringify(payload)}\n`);
    return payload;
  }

  const payload = { ok: true, blocked: false, refsChecked: refs.length };
  stdout.write(`${JSON.stringify(payload)}\n`);
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((result) => { if (result?.ok === false) { process.exitCode = 1; } }).catch((error) => { process.stderr.write(`${formatCliError(error)}\n`); process.exitCode = 1; });
}
