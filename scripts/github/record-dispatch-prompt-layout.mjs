#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { GATE_NAMES } from "./_gate-names.mjs";
import { DISPATCH_PROMPT_LEADING_CAP_BYTES } from "@dev-loops/core/loop/review-dispatch-plan";

const USAGE = `Usage: record-dispatch-prompt-layout.mjs --scope <name> --head-sha <sha> --prefix-path <path> --prompt-file <path> [--help]
Capture the LEADING bytes of a dispatched reviewer's ACTUAL composed prompt
(GATE-EXEC-BRIEFING-PREFIX layout, issue #1841/completes #1468) as a fan-in
dispatch artifact. The orchestrator composes the reviewer prompt at fan-out
time with no code template — this is the minimal capture point that gives
verify-dispatch-prompt-layout.mjs / consolidate-fanin.mjs's fan-in something
mechanical to check: whether the prompt actually LEADS with the round's
byte-identical invariant prefix (inline mode) or its byte-identical pointer
line (pointer-seeding mode), never angle-first.

Call this ONCE per dispatched reviewer/group, right after composing its
prompt and BEFORE (or immediately after) spawning it, from the SAME
orchestrator step that already runs write-gate-context.mjs's Phase 1.

Required:
  --scope <name>       Reviewer/group scope, same vocabulary as
                        verify-fresh-review-context.mjs --scope (e.g.
                        "draft-gate-coverage" or "draft-gate-group-a").
  --head-sha <sha>      The FULL 40- or 64-char reviewed head SHA (git rev-parse HEAD).
  --prefix-path <path>  The invariant-prefix file path this reviewer's prompt
                        was composed from/points at (write-gate-context.mjs's
                        \`<gate>-<headSha>.briefing-prefix.txt\`). Its BASENAME
                        must be \`<gate>-<headSha>.briefing-prefix.txt\` for a
                        canonical gate name and this exact head SHA — anything
                        else fails closed (exit 1). Recorded verbatim, but
                        NEVER trusted for its own bytes at verify time: the
                        fan-in independently re-discovers the real
                        \`<tmp-root>/gate-context/**\` record for the
                        (gate, headSha) pair extracted from this basename, so a
                        record pointing at an arbitrary/tampered file can never
                        smuggle in different ground-truth bytes.
  --prompt-file <path>  Path to a file holding the ACTUAL composed reviewer
                        prompt text (UTF-8) — the literal bytes the reviewer
                        was dispatched with, not a paraphrase. Its leading
                        ${DISPATCH_PROMPT_LEADING_CAP_BYTES} bytes are captured;
                        a longer prompt is truncated (recorded as "truncated":
                        true — a truncated capture can still prove misalignment
                        but never prove alignment beyond the captured bytes).
Optional:
  --tmp-root <path>     The tmp/ directory to write the record under (default:
                        process.cwd()/tmp). Must match the --tmp-root/cwd the
                        fan-in (consolidate-fanin.mjs) later reads from.
Output (stdout, JSON):
  { "ok": true, "recorded": true, "scope": "...", "headSha": "...", "prefixPath": "...", "truncated": false }
  { "ok": true, "recorded": false, "reason": "..." }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Recorded
  1  Refused to record: --prefix-path's basename is not a canonical
     <gate>-<headSha>.briefing-prefix.txt record name for the given
     --head-sha, or --prompt-file is missing/unreadable
  2  Usage or internal error, or invalid --jq filter`.trim();

const HEAD_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const VALID_SCOPE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const parseError = buildParseError(USAGE);

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

/**
 * Validate that `prefixPath`'s BASENAME is a canonical
 * `<gate>-<headSha>.briefing-prefix.txt` record name for the given head SHA
 * (write-gate-context.mjs's `buildGateBriefingPrefixPath` naming). Pure and
 * path-resolution-free by design (issue #1841): the caller's directory portion
 * of `prefixPath` is NEVER trusted as ground truth — only the gate name it
 * encodes is extracted, and the ACTUAL bytes are always re-discovered from the
 * real on-disk `<tmp-root>/gate-context/**` record (see
 * verify-dispatch-prompt-layout.mjs's `findGateBriefingPrefixBytes`), so a
 * captured record naming a directory that doesn't exist (or has since moved)
 * can never smuggle in different ground-truth bytes. Shared by the CLI here
 * and by verify-dispatch-prompt-layout.mjs so the naming rule cannot drift.
 *
 * @param {string} prefixPath
 * @param {string} headSha — already lowercased/trimmed
 * @returns {{ ok: true, gate: string } | { ok: false, reason: string }}
 */
export function validateBriefingPrefixPath(prefixPath, headSha) {
  const basename = path.basename(String(prefixPath ?? ""));
  const suffix = `-${headSha}.briefing-prefix.txt`;
  if (!basename.endsWith(suffix)) {
    return { ok: false, reason: `--prefix-path ${JSON.stringify(prefixPath)} basename is not a canonical "<gate>-${headSha}.briefing-prefix.txt" record` };
  }
  const gate = basename.slice(0, -suffix.length);
  if (!GATE_NAMES.includes(gate)) {
    return { ok: false, reason: `--prefix-path ${JSON.stringify(prefixPath)} basename names an unknown gate ${JSON.stringify(gate)} (must be one of ${GATE_NAMES.join(", ")})` };
  }
  return { ok: true, gate };
}

export function dispatchPromptLayoutRecordPath(tmpRoot, scope, headSha) {
  return path.join(tmpRoot, `checkpoint-dispatch-prompt-${scope}-${headSha}.json`);
}

export async function main(argv = process.argv.slice(2), { tmpRootDefault = path.join(process.cwd(), "tmp") } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const scope = resolveFlagValue(argv, "--scope");
  if (scope === null || scope === "" || !VALID_SCOPE_RE.test(scope)) {
    process.stderr.write(`${formatCliError(parseError(`--scope is required and must be non-empty, alphanumeric/hyphen only${scope ? ` (got ${JSON.stringify(scope)})` : ""}.`))}\n`);
    return 2;
  }
  const headShaArg = resolveFlagValue(argv, "--head-sha");
  if (headShaArg === null || headShaArg === "" || !HEAD_SHA_RE.test(headShaArg)) {
    process.stderr.write(`${formatCliError(parseError(`--head-sha is required and must be the FULL 40- or 64-character hex head SHA${headShaArg ? ` (got ${JSON.stringify(headShaArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headSha = headShaArg.toLowerCase();
  const prefixPathArg = resolveFlagValue(argv, "--prefix-path");
  if (prefixPathArg === null || prefixPathArg === "") {
    process.stderr.write(`${formatCliError(parseError("--prefix-path is required and must be non-empty."))}\n`);
    return 2;
  }
  const promptFileArg = resolveFlagValue(argv, "--prompt-file");
  if (promptFileArg === null || promptFileArg === "") {
    process.stderr.write(`${formatCliError(parseError("--prompt-file is required and must be non-empty."))}\n`);
    return 2;
  }
  const tmpRootArg = resolveFlagValue(argv, "--tmp-root");
  if (tmpRootArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --tmp-root value: must be non-empty."))}\n`);
    return 2;
  }
  const tmpRoot = tmpRootArg ?? tmpRootDefault;
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  const finish = (payload, ok) => emitResult(payload, { jq, silent, ok });

  const pathCheck = validateBriefingPrefixPath(prefixPathArg, headSha);
  if (!pathCheck.ok) {
    return finish({ ok: true, recorded: false, scope, headSha, reason: pathCheck.reason }, false);
  }
  let promptText;
  try {
    promptText = await readFile(path.resolve(process.cwd(), promptFileArg), "utf8");
  } catch (err) {
    return finish({ ok: true, recorded: false, scope, headSha, reason: `--prompt-file "${promptFileArg}" is unreadable (${err.code ?? "error"})` }, false);
  }
  const truncated = promptText.length > DISPATCH_PROMPT_LEADING_CAP_BYTES;
  const leading = truncated ? promptText.slice(0, DISPATCH_PROMPT_LEADING_CAP_BYTES) : promptText;

  const recordPath = dispatchPromptLayoutRecordPath(tmpRoot, scope, headSha);
  try {
    await mkdir(path.dirname(recordPath), { recursive: true });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  const record = {
    scope,
    headSha,
    prefixPath: prefixPathArg,
    gate: pathCheck.gate,
    leading,
    truncated,
    capturedAt: new Date().toISOString(),
  };
  try {
    await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  return finish({ ok: true, recorded: true, scope, headSha, prefixPath: prefixPathArg, truncated }, true);
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
