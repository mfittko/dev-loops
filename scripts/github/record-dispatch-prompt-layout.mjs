import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GATE_NAMES } from "./_gate-names.mjs";
import { DISPATCH_PROMPT_LEADING_CAP_BYTES, sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";

// Records the LEADING bytes of a dispatched reviewer's ACTUAL composed prompt
// (GATE-EXEC-BRIEFING-PREFIX layout) as a fan-in
// dispatch artifact — the minimal capture point that gives
// verify-dispatch-prompt-layout.mjs / consolidate-fanin.mjs's fan-in something
// mechanical to check: whether the prompt actually LEADS with the round's
// byte-identical invariant prefix (inline mode) or its byte-identical pointer
// line (pointer-seeding mode), never angle-first.
//
// The sanctioned fan-out path is emit-fanout-dispatch.mjs,
// whose composer core (compose-reviewer-prompt.mjs's exported
// composeAndRecordReviewerPrompt) composes the prompt AND records this capture
// atomically via the exported recordDispatchPromptLayout, so a canonical-path
// dispatch is never left unrecorded by agent discretion. This module has no CLI.

// Exported so emit-fanout-dispatch.mjs validates scope/head-sha with the
// IDENTICAL rules every caller uses, never a hand-copied regex that could
// drift from this one.
export const HEAD_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export const VALID_SCOPE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Validate that `prefixPath`'s BASENAME is a canonical
 * `<gate>-<headSha>.briefing-prefix.txt` record name for the given head SHA
 * (write-gate-context.mjs's `buildGateBriefingPrefixPath` naming). Pure and
 * path-resolution-free by design: the caller's directory portion
 * of `prefixPath` is NEVER trusted as ground truth — only the gate name it
 * encodes is extracted, and the ACTUAL bytes are always re-discovered from the
 * real on-disk `<tmp-root>/gate-context/**` record (see
 * verify-dispatch-prompt-layout.mjs's `findGateBriefingPrefixBytes`), so a
 * captured record naming a directory that doesn't exist (or has since moved)
 * can never smuggle in different ground-truth bytes. Shared by
 * recordDispatchPromptLayout and by verify-dispatch-prompt-layout.mjs so the
 * naming rule cannot drift.
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

/**
 * Core record-writing logic. A programmatic caller that already holds the
 * composed prompt TEXT in memory (compose-reviewer-prompt.mjs, driven by
 * emit-fanout-dispatch.mjs) calls this directly. `scope`/`headSha` are assumed
 * ALREADY validated/normalized by the caller (VALID_SCOPE_RE/HEAD_SHA_RE +
 * lowercase); this function's own fail-closed surface is the canonical-basename
 * check (`validateBriefingPrefixPath`) plus a non-empty `promptText`, both
 * "recorded: false" refusals.
 *
 * @param {object} input
 * @param {string} input.scope
 * @param {string} input.headSha — already lowercased
 * @param {string} input.prefixPath
 * @param {string} input.promptText — the ACTUAL composed prompt bytes (UTF-8)
 * @param {string} [input.tmpRoot]
 * @returns {Promise<{ok: true, recorded: boolean, scope: string, headSha: string, prefixPath?: string, reason?: string, truncated?: boolean}>}
 */
export async function recordDispatchPromptLayout({ scope, headSha, prefixPath, promptText, tmpRoot = path.join(process.cwd(), "tmp") } = {}) {
  const pathCheck = validateBriefingPrefixPath(prefixPath, headSha);
  if (!pathCheck.ok) {
    return { ok: true, recorded: false, scope, headSha, reason: pathCheck.reason };
  }
  if (typeof promptText !== "string" || promptText.length === 0) {
    return { ok: true, recorded: false, scope, headSha, reason: "promptText is empty" };
  }
  const truncated = promptText.length > DISPATCH_PROMPT_LEADING_CAP_BYTES;
  const leading = truncated ? promptText.slice(0, DISPATCH_PROMPT_LEADING_CAP_BYTES) : promptText;
  // Full-content hash of the delivered/recorded prompt (never truncated). The
  // fan-in re-discovers the sanctioned emitter's canonical emitted-prompt file
  // on disk and requires this hash to equal that file's hash, so a record whose
  // captured prompt is not byte-identical to the emitted unit — a paraphrased
  // suffix or any mismatched delivered prompt — fails closed here. (A
  // pointer-seeded prompt, where record and emitted file agree but neither
  // inlines the prefix, is instead rejected by the separate inline-alignment
  // leg.) Together these bind provenance to the emitted unit
  // (GATE-EXEC-FANOUT-DISPATCH-EMIT / GATE-EXEC-BRIEFING-PREFIX), never to a
  // coordinator-authored record alone. Neither proves delivered-task identity
  // (that the subagent actually received the bytes); that hop is the documented
  // best-effort boundary.
  const promptContentHash = sha256Hex(promptText);
  const recordPath = dispatchPromptLayoutRecordPath(tmpRoot, scope, headSha);
  await mkdir(path.dirname(recordPath), { recursive: true });
  const record = {
    scope,
    headSha,
    prefixPath,
    gate: pathCheck.gate,
    leading,
    truncated,
    promptContentHash,
    capturedAt: new Date().toISOString(),
  };
  await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { ok: true, recorded: true, scope, headSha, prefixPath, truncated };
}
