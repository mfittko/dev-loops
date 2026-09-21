#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { emitResult } from "../lib/jq-output.mjs";
import { composeReviewerPromptText } from "@dev-loops/core/loop/review-dispatch-plan";
import { buildGateBriefingPrefixPath, buildGateBriefingVolatilePath } from "./write-gate-context.mjs";
import { recordDispatchPromptLayout } from "./record-dispatch-prompt-layout.mjs";

const USAGE = `Usage: compose-reviewer-prompt.mjs [--help]
NOT a conductor-invocable fan-out dispatch step. This module's CLI refuses
every direct invocation (see main() below) — it exists only to export
composeAndRecordReviewerPrompt, the compose-and-record CORE that
scripts/github/emit-fanout-dispatch.mjs drives internally for every dispatch
unit of a round. Run scripts/github/emit-fanout-dispatch.mjs instead: it is
the ONE sanctioned whole-round fan-out dispatch path (issue #2092/#2166),
because it both drives this composer core AND persists the keyed
\`<gate>-<headSha>.emit-plan.json\` fan-in requires (GATE-EXEC-FANOUT-DISPATCH-EMIT)
— something a per-unit CLI call to this file can never do, which is why a
round dispatched directly through this CLI would fail closed only at
consolidate-fanin.`.trim();

const REFUSAL_MESSAGE = "scripts/github/compose-reviewer-prompt.mjs's CLI is not a conductor-invocable "
  + "fan-out dispatch step: it composes ONE reviewer prompt but never writes the keyed "
  + "<gate>-<headSha>.emit-plan.json fan-in requires (GATE-EXEC-FANOUT-DISPATCH-EMIT), so a "
  + "round dispatched directly through this CLI fails closed only at consolidate-fanin. Use "
  + "scripts/github/emit-fanout-dispatch.mjs instead — the ONE sanctioned whole-round fan-out "
  + "dispatch path, which drives this composer's core (composeAndRecordReviewerPrompt) "
  + "internally for every dispatch unit AND persists the emit-plan.";

/**
 * Compose one reviewer prompt (invariant prefix + volatile tail + angle suffix,
 * in that fixed order) and record its dispatch-prompt layout ATOMICALLY — the
 * reusable core driven ONLY by scripts/github/emit-fanout-dispatch.mjs, once
 * per dispatch unit of a round, so a canonical-path dispatch prompt is NEVER
 * produced by two independent code paths that could drift. All inputs are
 * pre-validated by the emitter, which derives them from the gate-context
 * artifact + resolveFanoutGroups units.
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

// This CLI refuses every direct fan-out invocation: the composer above is a
// legitimate internal building block (emit-fanout-dispatch.mjs's
// compose-and-record core), but calling it once per dispatch unit from the
// command line produces reviewer prompts with NO keyed emit-plan.json, so a
// round dispatched this way fails closed only at fan-in
// (GATE-EXEC-FANOUT-DISPATCH-EMIT). Refuse unconditionally (except --help)
// rather than compose anything, so this latent trap can no longer be
// reached via the CLI.
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  return emitResult({ ok: false, error: REFUSAL_MESSAGE });
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
