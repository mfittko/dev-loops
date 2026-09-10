#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { normalizeGate, canonicalizeScope } from "./_gate-names.mjs";
import { composeReviewerPromptText } from "@dev-loops/core/loop/review-dispatch-plan";
import { buildGateBriefingPrefixPath, buildGateBriefingVolatilePath } from "./write-gate-context.mjs";
import { HEAD_SHA_RE, VALID_SCOPE_RE, recordDispatchPromptLayout } from "./record-dispatch-prompt-layout.mjs";

const USAGE = `Usage: compose-reviewer-prompt.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> --scope <name> --angle-suffix-file <path> [--tmp-root <path>] [--out <path>] [--help]
The SANCTIONED reviewer-prompt composer (issue #1852, closes the #1468/#1841
records-floor residual): the ONE way a compliant fan-out round produces a
dispatched reviewer prompt. It builds the exact full prompt — this round's
byte-identical invariant prefix (\`write-gate-context.mjs\`'s
\`<gate>-<headSha>.briefing-prefix.txt\`) INLINED as the leading bytes,
followed by the round's volatile tail (\`.briefing-volatile.txt\`, best-effort
— an absent one composes as empty, never blocking), followed by the
per-group/angle-specific suffix text supplied via --angle-suffix-file — and
records the dispatch-prompt layout ATOMICALLY (via
record-dispatch-prompt-layout.mjs's recordDispatchPromptLayout), so a
canonical-path dispatch is NEVER left unrecorded by agent discretion:
composing and recording are one call, not two the orchestrator could forget
to pair. GATE-EXEC-BRIEFING-PREFIX (skills/docs/gate-review-sub-loop-contract.md)
owns the full contract; this is the tool that makes it true by construction
rather than by prose review.

Run this ONCE per dispatch unit (one per angle under \`mode: per-angle\`, one
per group under grouped mode — the default), right after Phase 1's
write-gate-context.mjs call and before spawning the reviewer. Delivery is
harness-specific: a code-driven fan-out (e.g. pi's runs.all) reads this
command's --out file directly and spawns the reviewer from those exact
bytes; an agent-driven fan-out (Claude Code's Agent tool) has the
orchestrating agent read the --out file and pass its exact bytes, verbatim
and with no added preamble, as the Agent tool's prompt parameter — see
GATE-EXEC-BRIEFING-PREFIX's "Per-harness delivery" paragraph for the
Claude-Code caveat this implies (the orchestrating agent's fidelity in
relaying those bytes is not itself mechanically enforced by this CLI).

Required:
  --repo <owner/name>        Same vocabulary as write-gate-context.mjs.
  --pr <number>               Same vocabulary as write-gate-context.mjs.
  --gate <draft_gate|pre_approval_gate|review>
                               Same vocabulary as write-gate-context.mjs.
  --head-sha <sha>            The FULL 40- or 64-char reviewed head SHA
                               (git rev-parse HEAD) — matches
                               record-dispatch-prompt-layout.mjs's own
                               requirement, since this composer always
                               records.
  --scope <name>               Reviewer/group scope, same vocabulary as
                               verify-fresh-review-context.mjs --scope (e.g.
                               "draft-gate-coverage" or "draft-gate-group-a").
  --angle-suffix-file <path>  Path to a file holding the ACTUAL per-group
                               angle-specific prompt text (UTF-8) — the
                               persona/instructions text the orchestrator
                               authored for this dispatch unit, appended
                               STRICTLY AFTER the invariant prefix + volatile
                               tail. Never templated by this tool (angle
                               content is out of scope — see the contract's
                               non-goals): this CLI only enforces WHERE it
                               goes, never WHAT it says.
Optional:
  --tmp-root <path>            The tmp/ directory the round's gate-context
                               artifacts live under (default: process.cwd()/tmp;
                               must match the write-gate-context.mjs call that
                               produced this round's prefix/volatile files).
  --out <path>                 Where to write the composed prompt (default:
                               a deterministic sibling of the invariant-prefix
                               file, \`<gate>-<headSha>.dispatch-prompt-<scope>.txt\`).
Output (stdout, JSON):
  { "ok": true, "composed": true, "recorded": true, "scope": "...", "headSha": "...", "gate": "...", "promptPath": "...", "prefixPath": "...", "promptLength": <n>, "truncated": false }
  { "ok": true, "composed": false, "reason": "..." }
  On error (stderr, JSON):
  { "ok": false, "error": "...", "hint"?: "run with --help for usage" }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Composed and recorded
  1  Refused: the invariant-prefix record is missing for (gate, headSha)
     (run write-gate-context.mjs first), --angle-suffix-file is
     missing/unreadable/empty, or the (should-never-happen) recording step
     itself refused
  2  Usage or internal error (bad --repo/--pr/--gate/--head-sha/--scope shape,
     or a filesystem error composing/writing), or invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

/**
 * Compose one reviewer prompt (invariant prefix + volatile tail + angle suffix,
 * in that fixed order) and record its dispatch-prompt layout ATOMICALLY — the
 * reusable core the CLI and the one-shot fan-out emitter
 * (emit-fanout-dispatch.mjs) both call, so a canonical-path dispatch prompt is
 * NEVER produced by two independent code paths that could drift. All inputs are
 * pre-validated by the caller (the CLI validates via its arg parser; the emitter
 * derives them from the gate-context artifact + resolveFanoutGroups units).
 *
 * @returns {Promise<{ composed: boolean, reason?: string, recorded?: boolean,
 *   promptPath?: string, prefixPath?: string, promptLength?: number, truncated?: boolean }>}
 *   `composed: false` (with `reason`) is a caller-recoverable refusal (missing
 *   prefix record, unreadable/empty suffix, or the composer's own shape refusal);
 *   filesystem/record errors reject.
 */
export async function composeAndRecordReviewerPrompt({ repo, pr, gate, headSha, scope, angleSuffixFile, tmpRoot, out = null }) {
  const prefixPath = buildGateBriefingPrefixPath({ repo, pr, gate, headSha, tmpRoot });
  const volatilePath = buildGateBriefingVolatilePath({ repo, pr, gate, headSha, tmpRoot });

  let prefixBytes;
  try {
    prefixBytes = await readFile(prefixPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { composed: false, reason: `no invariant-prefix record at ${JSON.stringify(prefixPath)} — run write-gate-context.mjs for this (gate, headSha) first` };
    }
    throw err;
  }

  // Volatile tail is best-effort (a round that never wrote one still composes).
  let volatileBytes = "";
  try {
    volatileBytes = await readFile(volatilePath, "utf8");
  } catch {
    volatileBytes = "";
  }

  let angleSuffix;
  try {
    angleSuffix = await readFile(path.resolve(process.cwd(), angleSuffixFile), "utf8");
  } catch (err) {
    return { composed: false, reason: `--angle-suffix-file ${JSON.stringify(angleSuffixFile)} is unreadable (${err.code ?? "error"})` };
  }

  let composed;
  try {
    composed = composeReviewerPromptText({ prefixBytes, volatileBytes, angleSuffix });
  } catch (err) {
    return { composed: false, reason: err.message };
  }

  const outPath = out ?? path.join(path.dirname(prefixPath), `${gate}-${headSha}.dispatch-prompt-${scope}.txt`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, composed, "utf8");

  const recordResult = await recordDispatchPromptLayout({ scope, headSha, prefixPath, promptText: composed, tmpRoot });
  if (!recordResult.recorded) {
    return { composed: true, recorded: false, promptPath: outPath, prefixPath, reason: recordResult.reason };
  }
  return { composed: true, recorded: true, promptPath: outPath, prefixPath, promptLength: composed.length, truncated: recordResult.truncated };
}

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

export async function main(argv = process.argv.slice(2), { tmpRootDefault = path.join(process.cwd(), "tmp") } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const repo = resolveFlagValue(argv, "--repo");
  if (repo === null || repo === "") {
    process.stderr.write(`${formatCliError(parseError("--repo is required and must be non-empty (owner/name)."))}\n`);
    return 2;
  }
  const pr = resolveFlagValue(argv, "--pr");
  if (pr === null || pr === "") {
    process.stderr.write(`${formatCliError(parseError("--pr is required and must be non-empty."))}\n`);
    return 2;
  }
  const gateArg = resolveFlagValue(argv, "--gate");
  const gate = gateArg === null || gateArg === "" ? null : normalizeGate(gateArg);
  if (!gate) {
    process.stderr.write(`${formatCliError(parseError(`--gate is required and must be one of: draft_gate, pre_approval_gate, review${gateArg ? ` (got ${JSON.stringify(gateArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headShaArg = resolveFlagValue(argv, "--head-sha");
  if (headShaArg === null || headShaArg === "" || !HEAD_SHA_RE.test(headShaArg)) {
    process.stderr.write(`${formatCliError(parseError(`--head-sha is required and must be the FULL 40- or 64-character hex head SHA${headShaArg ? ` (got ${JSON.stringify(headShaArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headSha = headShaArg.toLowerCase();
  const scopeArg = resolveFlagValue(argv, "--scope");
  // Canonicalize a gate-id-derived scope (underscore → hyphen) before
  // validating and using it, so an underscore form validates on the first
  // attempt and matches its hyphenated twin (#1957).
  const scope = scopeArg === null || scopeArg === "" ? scopeArg : canonicalizeScope(scopeArg);
  if (scope === null || scope === "" || !VALID_SCOPE_RE.test(scope)) {
    process.stderr.write(`${formatCliError(parseError(`--scope is required and must be non-empty, alphanumeric/hyphen only${scopeArg ? ` (got ${JSON.stringify(scopeArg)})` : ""}.`))}\n`);
    return 2;
  }
  const angleSuffixFileArg = resolveFlagValue(argv, "--angle-suffix-file");
  if (angleSuffixFileArg === null || angleSuffixFileArg === "") {
    process.stderr.write(`${formatCliError(parseError("--angle-suffix-file is required and must be non-empty."))}\n`);
    return 2;
  }
  const tmpRootArg = resolveFlagValue(argv, "--tmp-root");
  if (tmpRootArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --tmp-root value: must be non-empty."))}\n`);
    return 2;
  }
  const tmpRoot = tmpRootArg ?? tmpRootDefault;
  const outArg = resolveFlagValue(argv, "--out");
  if (outArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --out value: must be non-empty."))}\n`);
    return 2;
  }
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  const finish = (payload, ok) => emitResult(payload, { jq, silent, ok });

  let result;
  try {
    result = await composeAndRecordReviewerPrompt({ repo, pr, gate, headSha, scope, angleSuffixFile: angleSuffixFileArg, tmpRoot, out: outArg ?? null });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  if (!result.composed) {
    return finish({ ok: true, composed: false, reason: result.reason }, false);
  }
  if (!result.recorded) {
    return finish({ ok: true, composed: true, recorded: false, promptPath: result.promptPath, prefixPath: result.prefixPath, reason: result.reason }, false);
  }
  return finish({
    ok: true,
    composed: true,
    recorded: true,
    scope,
    headSha,
    gate,
    repo,
    pr,
    promptPath: result.promptPath,
    prefixPath: result.prefixPath,
    promptLength: result.promptLength,
    truncated: result.truncated,
  }, true);
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
