/**
 * review-lineage.mjs — additive review-lineage base + per-fix-round delta
 * composition (issue #1468 slice 5).
 *
 * A new head after a fix used to rebuild a full head-specific briefing. This
 * module introduces a stable review-lineage base plus deterministic per-round
 * delta artifacts, so round 2+ appends only what changed instead of replacing
 * the whole context.
 *
 * Artifact model (Section E of the #1468 spec):
 *
 *   review-lineage-base
 *     lineage identity + gate + stable contracts/instructions + original
 *     review target + original full diff.
 *
 *   round-N-delta
 *     exact base/reviewed SHAs + the fix diff + validation evidence + an
 *     independent findings verification checklist.
 *
 * Composition contract:
 *
 *   round-N request = [lineage base][delta 1][delta 2]...[delta N][angle suffix]
 *
 * Composition is append-only and byte-deterministic: the composed request is
 * the ordered concatenation of the lineage base and the individual delta
 * artifacts, never a parse/reserialize of the full PR context as a replacement
 * block. Round N+1 appends exactly one new delta segment; every prior segment
 * is byte-identical (same ref + same hash) — that is what the
 * "does not rebuild the full PR context" test asserts.
 *
 * Carry-forward semantics are unchanged: a carried clean angle still records
 * its original reviewer and prior head. This module only preserves that
 * provenance in the composed request; it does not decide carry-forward (that
 * stays in gate-carry-forward.mjs) and it never fabricates a verdict.
 *
 * This module is pure and offline: no GitHub, no harness, no clock.
 */
import { sha256Hex } from "./review-dispatch-plan.mjs";

// Full-length SHA only: GitHub abbreviated prefixes (7-39 hex) must NOT validate
// as an "exact SHA" (findings: input-validation). Accept only a full 40-hex
// (SHA-1) or 64-hex (SHA-256) digest.
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** @param {string} value @returns {boolean} */
function isHexSha(value) {
  return typeof value === "string" && HEX.test(value.trim().toLowerCase());
}

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v);

/**
 * Recursively sort object keys for a byte-deterministic serialization. Nested
 * caller-supplied objects (validationEvidence, findingsChecklist entries) may
 * arrive with arbitrary key insertion order; canonicalizing here guarantees the
 * rendered segment bytes are key-order-independent (findings: determinism).
 */
function stableStringify(value) {
  if (Array.isArray(value)) return value.map(stableStringify);
  if (Buffer.isBuffer(value)) return `__buffer:${value.toString("hex")}`;
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableStringify(value[key]);
    return out;
  }
  return value;
}

/** Canonical byte-serialization of an artifact (sorted keys, JSON). */
function canonicalJson(value) {
  return JSON.stringify(stableStringify(value));
}


/** Normalize a text-ish field (string | string[] | Buffer) to a canonical string. */
function normalizeText(value, label) {
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return `__buffer:${value.toString("hex")}`;
  if (Array.isArray(value)) return value.map((s) => String(s)).join("\n");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const HEX64 = /^sha256:[0-9a-f]{64}$/;

/** @param {string} v */
function isSha256(v) {
  return typeof v === "string" && HEX64.test(v);
}

function requireLineageId(lineageId) {
  if (typeof lineageId !== "string" || lineageId.trim().length === 0) {
    throw new Error("review-lineage requires a non-empty lineageId");
  }
}

function requireGate(gate) {
  if (typeof gate !== "string" || gate.trim().length === 0) {
    throw new Error("review-lineage requires a non-empty gate");
  }
}

/* ------------------------------------------------------------------ *
 * Review-lineage base
 * ------------------------------------------------------------------ */

/**
 * Build a deterministic review-lineage base artifact for a PR review lineage.
 *
 * The base holds the stable material that is identical across every fix round
 * of the lineage: the gate, the stable contracts/instructions, and the ORIGINAL
 * review target with the ORIGINAL full diff. `baseHash` is a deterministic
 * fingerprint over the canonicalized base so any consumer can prove two runs
 * share a byte-identical base without re-comparing bodies.
 *
 * @param {object} input
 * @param {string} input.lineageId - lineage identity (per PR review lineage).
 * @param {string} input.gate - draft_gate | pre_approval_gate | ...
 * @param {string} input.originalHead - the head SHA the original (round-1) review targeted.
 * @param {string|string[]|Buffer} input.originalDiff - the original full diff.
 * @param {string|string[]|Buffer} [input.stableContracts] - stable contracts/instructions.
 * @returns {Readonly<object>} frozen review-lineage-base artifact.
 */
export function buildReviewLineageBase({ lineageId, gate, originalHead, originalDiff, stableContracts } = {}) {
  requireLineageId(lineageId);
  requireGate(gate);
  if (!isHexSha(originalHead)) {
    throw new Error(`review-lineage originalHead must be a hex sha, got ${JSON.stringify(originalHead)}`);
  }
  if (originalDiff == null || String(originalDiff).length === 0) {
    throw new Error("review-lineage base requires an originalDiff (the original full diff)");
  }
  const base = {
    kind: "review-lineage-base",
    lineageId,
    gate,
    originalHead: originalHead.trim().toLowerCase(),
    originalDiff: normalizeText(originalDiff, "originalDiff"),
    stableContracts: normalizeText(stableContracts, "stableContracts"),
  };
  return Object.freeze({
    ...base,
    baseHash: sha256Hex(base),
  });
}

/* ------------------------------------------------------------------ *
 * Per-fix-round delta
 * ------------------------------------------------------------------ */

/**
 * Build a deterministic per-fix-round delta artifact.
 *
 * A delta records, for one fix round, the exact base/head SHAs, the actual fix
 * diff, the validation evidence, and an INDEPENDENT findings verification
 * checklist (not agreement-seeking verdict prose). `deltaHash` fingerprints the
 * canonicalized delta so identical inputs always yield byte-identical deltas.
 *
 * @param {object} input
 * @param {string} input.lineageId - must match the owning lineage.
 * @param {number} input.round - 1-based fix-round number.
 * @param {string} input.gate
 * @param {string} input.baseHead - the head assumed as the delta's base.
 * @param {string} input.reviewedHead - the head actually reviewed in this round.
 * @param {string|string[]|Buffer} input.fixDiff - the actual fix diff for this round.
 * @param {string|string[]|Buffer|object} [input.validationEvidence] - validation evidence.
 * @param {Array<object>} [input.findingsChecklist] - independent findings checklist.
 * @returns {Readonly<object>} frozen round-delta artifact.
 */
export function buildFixRoundDelta({ lineageId, round, gate, baseHead, reviewedHead, fixDiff, validationEvidence, findingsChecklist } = {}) {
  requireLineageId(lineageId);
  requireGate(gate);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`buildFixRoundDelta round must be a positive integer, got ${JSON.stringify(round)}`);
  }
  if (!isHexSha(baseHead) || !isHexSha(reviewedHead)) {
    throw new Error("buildFixRoundDelta baseHead and reviewedHead must be hex shas");
  }
  if (fixDiff == null || String(fixDiff).length === 0) {
    throw new Error("buildFixRoundDelta requires a fixDiff (the actual fix diff)");
  }
  if (findingsChecklist != null) {
    if (!Array.isArray(findingsChecklist)) {
      throw new Error("buildFixRoundDelta findingsChecklist must be an array");
    }
    for (let i = 0; i < findingsChecklist.length; i++) {
      const f = findingsChecklist[i];
      if (typeof f !== "object" || f === null || Array.isArray(f)) {
        throw new Error(`findingsChecklist[${i}] must be an object entry`);
      }
    }
  }
  const delta = {
    kind: "round-delta",
    lineageId,
    round,
    gate,
    baseHead: baseHead.trim().toLowerCase(),
    reviewedHead: reviewedHead.trim().toLowerCase(),
    fixDiff: normalizeText(fixDiff, "fixDiff"),
    ...(validationEvidence != null
      ? {
          validationEvidence:
            typeof validationEvidence === "object" &&
            !Array.isArray(validationEvidence) &&
            !Buffer.isBuffer(validationEvidence)
              ? JSON.parse(JSON.stringify(validationEvidence))
              : normalizeText(validationEvidence, "validationEvidence"),
        }
      : {}),
    ...(findingsChecklist != null ? { findingsChecklist: JSON.parse(JSON.stringify(findingsChecklist)) } : {}),
  };
  return Object.freeze({
    ...delta,
    deltaHash: sha256Hex(delta),
  });
}

/* ------------------------------------------------------------------ *
 * Append-only round request composition
 * ------------------------------------------------------------------ */

export const LINEAGE_BASE_SLOT = "lineageBase";
export const ROUND_DELTA_SLOT = "roundDelta";
export const ANGLE_SUFFIX_SLOT = "angleSuffix";

/**
 * Compose the round-N request as an append-only ordered segment list:
 *
 *   [lineage base][delta 1]...[delta N][angle suffix]
 *
 * The returned `segments` carry individual artifact bytes + hashes so a
 * consumer can render the request by concatenating segment bytes IN ORDER
 * (never parsing/reserializing prior segments). Round N+1 appends exactly one
 * new delta segment: callers should REUSE the prior composed segments (or the
 * base + prior deltas) rather than rebuilding the full PR context, and this
 * function's contract + tests pin that reuse property.
 *
 * Segments before the new delta are byte-identical to the prior round's
 * (same `ref` + same `hash`), which is the mechanical proof of append-only
 * composition (AC-2: does not rebuild the full PR context as a replacement
 * block).
 *
 * `carriedAngles` provenance is preserved unchanged (carry-forward semantics):
 * each entry is { angle, originalReviewer, priorHead } and is folded into the
 * composed hash so a carried angle's provenance is pinned — but never
 * fabricated. A carried clean angle keeps exactly the original reviewer and
 * prior head it was recorded with.
 *
 * @param {object} input
 * @param {object} input.lineageBase - a valid review-lineage-base artifact.
 * @param {object[]} [input.priorDeltas] - ordered round deltas (1..N-1).
 * @param {object} input.newDelta - the delta being appended for this round.
 * @param {string|Buffer} [input.angleSuffix] - angle-specific suffix.
 * @param {Array<{angle:string, originalReviewer:string, priorHead:string}>} [input.carriedAngles]
 * @returns {Readonly<object>} composed round request.
 */
export function composeRoundRequest({ lineageBase, priorDeltas = [], newDelta, angleSuffix, carriedAngles = [] } = {}) {
  if (!lineageBase || lineageBase.kind !== "review-lineage-base" || !isSha256(lineageBase.baseHash)) {
    throw new Error("composeRoundRequest requires a valid lineage base artifact");
  }
  if (!Array.isArray(priorDeltas)) throw new Error("composeRoundRequest priorDeltas must be an array");
  if (!newDelta || newDelta.kind !== "round-delta" || !isSha256(newDelta.deltaHash)) {
    throw new Error("composeRoundRequest requires a valid round-delta artifact");
  }
  if (newDelta.lineageId !== lineageBase.lineageId) {
    throw new Error("composeRoundRequest newDelta lineageId must match the lineage base");
  }
  if (!Array.isArray(carriedAngles)) throw new Error("composeRoundRequest carriedAngles must be an array");
  // Every delta in the lineage (prior + new) must share the base's gate
  // (findings: scope — gate consistency) and carry a valid deltaHash
  // (findings: input-validation — prior-delta hash validation).
  const allDeltas = [...priorDeltas, newDelta];
  for (let i = 0; i < priorDeltas.length; i++) {
    const d = priorDeltas[i];
    if (!d || d.kind !== "round-delta" || d.lineageId !== lineageBase.lineageId) {
      throw new Error("composeRoundRequest priorDeltas must be valid round-delta artifacts of the same lineage");
    }
    if (!isSha256(d.deltaHash)) {
      throw new Error(`composeRoundRequest priorDeltas[${i}].deltaHash must be a valid sha256:<64hex>`);
    }
    if (d.gate !== lineageBase.gate) {
      throw new Error("composeRoundRequest priorDeltas gate must match the lineage base gate");
    }
    if (d.round !== i + 1) {
      throw new Error(`composeRoundRequest priorDeltas must be contiguous from round 1; expected round ${i + 1}, got ${d.round}`);
    }
  }
  if (newDelta.round !== priorDeltas.length + 1) {
    throw new Error(
      `composeRoundRequest newDelta.round must follow the prior deltas; expected ${priorDeltas.length + 1}, got ${newDelta.round}`,
    );
  }
  if (newDelta.gate !== lineageBase.gate) {
    throw new Error("composeRoundRequest newDelta gate must match the lineage base gate");
  }
  // SHA-chain continuity (findings: correctness / scope): the delta chain must
  // be anchored to the lineage base and head-linked end-to-end — round-1's
  // baseHead must equal the base's originalHead, and each later delta's
  // baseHead must equal the immediately prior delta's reviewedHead. This keeps
  // the "exact SHAs" record truthful: a composed request can never claim a base
  // that was not actually the prior reviewed head.
  for (let i = 0; i < allDeltas.length; i++) {
    const d = allDeltas[i];
    if (i === 0) {
      if (d.baseHead !== lineageBase.originalHead) {
        throw new Error(
          `composeRoundRequest round-1 baseHead ${d.baseHead} must equal the lineage base originalHead ${lineageBase.originalHead}`,
        );
      }
    } else if (d.baseHead !== allDeltas[i - 1].reviewedHead) {
      throw new Error(
        `composeRoundRequest round-${d.round} baseHead ${d.baseHead} must equal prior round reviewedHead ${allDeltas[i - 1].reviewedHead}`,
      );
    }
  }

  const segments = [
    {
      slot: LINEAGE_BASE_SLOT,
      ref: "lineage-base",
      hash: lineageBase.baseHash,
      bytes: canonicalJson(lineageBase),
    },
  ];
  const deltas = [...priorDeltas, newDelta];
  for (const d of deltas) {
    segments.push({
      slot: ROUND_DELTA_SLOT,
      ref: `round-${String(d.round).padStart(2, "0")}`,
      round: d.round,
      hash: d.deltaHash,
      bytes: canonicalJson(d),
    });
  }
  if (angleSuffix != null && String(angleSuffix).length > 0) {
    segments.push({
      slot: ANGLE_SUFFIX_SLOT,
      ref: "angle-suffix",
      bytes: Buffer.isBuffer(angleSuffix) ? angleSuffix.toString("utf8") : String(angleSuffix),
    });
  }

  const normalizedCarried = carriedAngles.map((c) => {
    if (typeof c !== "object" || c === null) throw new Error("composeRoundRequest carriedAngles entries must be objects");
    if (typeof c.angle !== "string" || typeof c.originalReviewer !== "string" || !isHexSha(c.priorHead)) {
      throw new Error("composeRoundRequest carriedAngles entries require { angle, originalReviewer, priorHead }");
    }
    return {
      angle: c.angle,
      originalReviewer: c.originalReviewer,
      priorHead: c.priorHead.trim().toLowerCase(), // trim + lower, consistent with other SHA fields
    };
  });

  const composedRequest = {
    kind: "composed-round-request",
    lineageId: lineageBase.lineageId,
    gate: lineageBase.gate,
    round: newDelta.round,
    segments,
    carriedAngles: normalizedCarried,
  };
  return Object.freeze({
    ...composedRequest,
    composedHash: sha256Hex(composedRequest),
  });
}

/**
 * Render a composed round request to a single byte string by concatenating the
 * ordered segment bytes. Purely a convenience for consumers that need a flat
 * briefing block; the append-only/exact-reuse contract is honored by the
 * segment list itself (callers may also render segments individually).
 *
 * @param {object} composed - a composed-round-request artifact.
 * @returns {string} concatenated segment bytes in order.
 */
export function renderComposedRequest(composed) {
  if (!composed || composed.kind !== "composed-round-request" || !Array.isArray(composed.segments)) {
    throw new Error("renderComposedRequest requires a composed-round-request artifact");
  }
  return composed.segments.map((s) => (s.bytes == null ? "" : String(s.bytes))).join("");
}

/* ------------------------------------------------------------------ *
 * Compaction / rebase policy (issue #1468 slice 6)
 * ------------------------------------------------------------------ */

/**
 * Default lineage compaction threshold: the maximum number of accumulated
 * round-delta segments a review lineage may carry before it MUST be compacted
 * (rebased). Provider prompt caches are bounded by breakpoint/lookback limits
 * and context-window size; unbounded delta accumulation would eventually
 * overflow them. Consumers may raise or lower this, and may additionally set a
 * byte budget (`maxLineageBytes`) to bound provider-visible context size
 * directly.
 *
 * A rebase is triggered when EITHER bound is exceeded:
 *   - round-delta count exceeds `maxRounds` (default 20), OR
 *   - the composed lineage byte size exceeds `maxLineageBytes` when provided.
 */
export const DEFAULT_LINEAGE_MAX_ROUNDS = 20;

/**
 * Total byte size of a lineage's accumulated artifact content (base + all
 * accumulated deltas), using the same canonical byte-serialization that
 * `composeRoundRequest` renders. Used to enforce a byte budget on the only part
 * of a round request that grows across fix rounds (round-delta accumulation).
 * It counts the lineage artifacts themselves, not the per-round angle-suffix /
 * carried-angle context (constant regardless of round count).
 *
 * @param {object} input
 * @param {object} input.lineageBase - valid review-lineage-base.
 * @param {object[]} [input.deltas] - accumulated round deltas.
 * @returns {number} total composed byte size.
 */
export function lineageByteSize({ lineageBase, deltas = [] } = {}) {
  if (!lineageBase || lineageBase.kind !== "review-lineage-base" || !isSha256(lineageBase.baseHash)) {
    throw new Error("lineageByteSize requires a valid lineage base artifact");
  }
  if (!Array.isArray(deltas)) throw new Error("lineageByteSize deltas must be an array");
  const utf8Length = (v) => Buffer.byteLength(canonicalJson(v), "utf8");
  let total = utf8Length(lineageBase);
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (!d || d.kind !== "round-delta" || !isSha256(d.deltaHash)) {
      throw new Error(`lineageByteSize deltas[${i}] must be a valid round-delta artifact`);
    }
    total += utf8Length(d);
  }
  return total;
}

/**
 * Decide whether a review lineage must be compacted (rebased) now, against the
 * compaction threshold(s). Pure predicate — it never mutates the lineage.
 *
 * @param {object} input
 * @param {object} input.lineageBase - valid review-lineage-base.
 * @param {object[]} [input.deltas] - accumulated round deltas.
 * @param {number} [input.maxRounds] - max delta rounds before a rebase (default
 *   {@link DEFAULT_LINEAGE_MAX_ROUNDS}).
 * @param {number} [input.maxLineageBytes] - optional byte budget over the
 *   accumulated lineage (base + deltas — the ONLY part of a round request that
 *   grows with fix rounds); a lineage whose accumulated size exceeds it must
 *   be rebased. Per-round angle-suffix and carried-angle context are constant
 *   regardless of round count, so they are deliberately not part of this
 *   growing-lineage bound.
 * @returns {{ requiresCompaction: boolean, reason: string|null, deltaCount: number, lineageBytes: number, maxRounds: number, maxLineageBytes: number|null }}
 */
export function checkLineageCompaction({ lineageBase, deltas = [], maxRounds = DEFAULT_LINEAGE_MAX_ROUNDS, maxLineageBytes } = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`checkLineageCompaction maxRounds must be a positive integer, got ${JSON.stringify(maxRounds)}`);
  }
  if (maxLineageBytes != null && (!Number.isInteger(maxLineageBytes) || maxLineageBytes < 1)) {
    throw new Error(`checkLineageCompaction maxLineageBytes must be a positive integer, got ${JSON.stringify(maxLineageBytes)}`);
  }
  if (!Array.isArray(deltas)) throw new Error("checkLineageCompaction deltas must be an array");
  const deltaCount = deltas.length;
  const lineageBytes = lineageByteSize({ lineageBase, deltas });
  let reason = null;
  if (deltaCount > maxRounds) {
    reason = `delta count ${deltaCount} exceeds maxRounds ${maxRounds}`;
  } else if (maxLineageBytes != null && lineageBytes > maxLineageBytes) {
    reason = `composed lineage bytes ${lineageBytes} exceed maxLineageBytes ${maxLineageBytes}`;
  }
  return {
    requiresCompaction: reason !== null,
    reason,
    deltaCount,
    lineageBytes,
    maxRounds,
    maxLineageBytes: maxLineageBytes ?? null,
  };
}

/**
 * Compact (rebase) a review lineage.
 *
 * When the delta accumulation crosses the compaction threshold, the lineage is
 * rebased: the accumulated deltas are folded into a NEW compacted base whose
 * `originalHead` advances to the current (latest reviewed) head and whose
 * `originalDiff` becomes the cumulative diff (the base's original full diff
 * merged with every accepted fix diff, in order). Future rounds append fresh
 * deltas to this compacted base, so the COMPOSED request stays within the
 * provider breakpoint/lookback + context budget instead of growing unbounded.
 *
 * Rebase behaviour guarantees:
 *   - The compacted base keeps the same `lineageId` and `gate` and is itself a
 *     valid `review-lineage-base`; `composeRoundRequest` accepts it unchanged.
 *   - Composition rules are preserved: a new round-1 delta whose `baseHead`
 *     equals the compacted base's `originalHead` composes cleanly and
 *     byte-deterministically (SHA-chain continuity + append-only contract).
 *   - The rebase is traceable: the compacted base records `rebaseSourceBaseHash`
 *     (the base it was compacted from) and `compactedRoundCount` (the total
 *     number of fix rounds folded into this compacted lineage so far). Prior
 *     delta artifacts remain available (append-only history); only the COMPOSED
 *     request is recomposed from the compacted base.
 *
 * @param {object} input
 * @param {object} input.lineageBase - valid review-lineage-base.
 * @param {object[]} [input.deltas] - all accumulated round deltas in order.
 * @param {string|string[]|Buffer} [input.currentDiff] - optional cumulative diff
 *   for the rebased `originalDiff`; defaults to the base's original diff merged
 *   with every delta's fix diff.
 * @returns {Readonly<object>} compacted review-lineage-base artifact.
 */
export function rebaseLineage({ lineageBase, deltas = [], currentDiff } = {}) {
  if (!lineageBase || lineageBase.kind !== "review-lineage-base" || !isSha256(lineageBase.baseHash)) {
    throw new Error("rebaseLineage requires a valid lineage base artifact");
  }
  if (!Array.isArray(deltas)) throw new Error("rebaseLineage deltas must be an array");
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (!d || d.kind !== "round-delta" || d.lineageId !== lineageBase.lineageId) {
      throw new Error("rebaseLineage deltas must be valid round-delta artifacts of the same lineage");
    }
    if (!isSha256(d.deltaHash)) {
      throw new Error(`rebaseLineage deltas[${i}].deltaHash must be a valid sha256:<64hex>`);
    }
    if (!isHexSha(d.baseHead) || !isHexSha(d.reviewedHead)) {
      throw new Error(`rebaseLineage deltas[${i}].baseHead/reviewedHead must be full hex SHAs`);
    }
    if (d.gate !== lineageBase.gate) {
      throw new Error("rebaseLineage deltas gate must match the lineage base gate");
    }
    if (d.round !== i + 1) {
      throw new Error(`rebaseLineage deltas must be contiguous from round 1; expected round ${i + 1}, got ${d.round}`);
    }
  }
  // SHA-chain continuity across the accumulated deltas (keep the composed
  // request truthful — same rule `composeRoundRequest` enforces).
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (i === 0) {
      if (d.baseHead !== lineageBase.originalHead) {
        throw new Error(
          `rebaseLineage round-1 baseHead ${d.baseHead} must equal the lineage base originalHead ${lineageBase.originalHead}`,
        );
      }
    } else if (d.baseHead !== deltas[i - 1].reviewedHead) {
      throw new Error(
        `rebaseLineage round-${d.round} baseHead ${d.baseHead} must equal prior round reviewedHead ${deltas[i - 1].reviewedHead}`,
      );
    }
  }

  let newOriginalHead = lineageBase.originalHead;
  if (deltas.length > 0) newOriginalHead = deltas[deltas.length - 1].reviewedHead.trim().toLowerCase();

  let diff;
  if (currentDiff != null) {
    diff = normalizeText(currentDiff, "currentDiff");
    if (diff.length === 0) {
      throw new Error("rebaseLineage currentDiff must be non-empty");
    }
  } else if (deltas.length === 0) {
    diff = lineageBase.originalDiff;
  } else {
    diff = [lineageBase.originalDiff, ...deltas.map((d) => normalizeText(d.fixDiff, "fixDiff"))].join("\n");
  }

  const compacted = {
    kind: "review-lineage-base",
    lineageId: lineageBase.lineageId,
    gate: lineageBase.gate,
    originalHead: newOriginalHead,
    originalDiff: diff,
    stableContracts: lineageBase.stableContracts,
    compaction: true,
    rebaseSourceBaseHash: lineageBase.baseHash,
    compactedRoundCount: (lineageBase.compactedRoundCount ?? 0) + deltas.length,
  };
  return Object.freeze({
    ...compacted,
    baseHash: sha256Hex(compacted),
  });
}
