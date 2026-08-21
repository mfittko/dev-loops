/**
 * gate-request-plan.mjs — deterministic per-gate-round request-plan builder.
 *
 * Sibling to `gate-fanin.mjs`/`gate-carry-forward.mjs`: pure logic, no I/O. The
 * request plan fingerprints the complete observable request prefix a fan-out
 * reviewer's dispatch will use — model, tool set/order, instructions,
 * settings, content-block boundaries, the shared briefing bytes, and
 * breakpoint/TTL intent — so identical inputs at a given head always produce
 * byte-identical plan output.
 *
 * Non-claim: a fingerprint proves request-SHAPE identity (two dispatches with
 * the same fingerprint sent the same observable request prefix). It never
 * proves a provider actually served a cache read — that requires telemetry,
 * which a harness may not expose (see the harness-capability section below).
 */
import { createHash } from "node:crypto";

// ── Harness capability ──────────────────────────────────────────────────────

const STREAMING_VALUES = Object.freeze(["streaming", "non_streaming", "opaque"]);
const CACHE_TELEMETRY_VALUES = Object.freeze(["available", "unavailable"]);
const TTL_OWNERSHIP_VALUES = Object.freeze(["caller_controlled", "harness_managed"]);

/**
 * @typedef {object} HarnessCapability
 * @property {"streaming"|"non_streaming"|"opaque"} streaming
 * @property {"available"|"unavailable"} cacheTelemetry
 * @property {"caller_controlled"|"harness_managed"} ttlOwnership
 */

/**
 * Construct an explicit {@link HarnessCapability}. Every field is required and
 * validated against its declared vocabulary — there is no default-filling: a
 * capability this layer has not been told about must be passed as `"opaque"`
 * (streaming) rather than inferred as yes/no. Frozen to prevent accidental
 * mutation of a shared constant.
 * @param {{ streaming: string, cacheTelemetry: string, ttlOwnership: string }} input
 * @returns {HarnessCapability}
 */
export function makeHarnessCapability({ streaming, cacheTelemetry, ttlOwnership } = {}) {
  if (!STREAMING_VALUES.includes(streaming)) {
    throw new Error(`makeHarnessCapability: streaming must be one of ${STREAMING_VALUES.join(", ")}, got ${JSON.stringify(streaming)}`);
  }
  if (!CACHE_TELEMETRY_VALUES.includes(cacheTelemetry)) {
    throw new Error(`makeHarnessCapability: cacheTelemetry must be one of ${CACHE_TELEMETRY_VALUES.join(", ")}, got ${JSON.stringify(cacheTelemetry)}`);
  }
  if (!TTL_OWNERSHIP_VALUES.includes(ttlOwnership)) {
    throw new Error(`makeHarnessCapability: ttlOwnership must be one of ${TTL_OWNERSHIP_VALUES.join(", ")}, got ${JSON.stringify(ttlOwnership)}`);
  }
  return Object.freeze({ streaming, cacheTelemetry, ttlOwnership });
}

/**
 * Conservative, honest default for the current Claude Code harness: this
 * layer cannot observe streaming first-output timing for cache-priming
 * purposes, cache creation/read telemetry is not exposed, and the cache
 * TTL/breakpoint lifecycle is managed by the harness rather than settable by
 * the caller. Do NOT upgrade any of these fields without an actual observed
 * capability — see the module doc comment's non-claim.
 * @type {HarnessCapability}
 */
export const CLAUDE_CODE_HARNESS_CAPABILITY = makeHarnessCapability({
  streaming: "opaque",
  cacheTelemetry: "unavailable",
  ttlOwnership: "harness_managed",
});

// ── Request plan ────────────────────────────────────────────────────────────

/** The one supported physical cache boundary: end of the materialized shared prefix. */
export const CACHE_BOUNDARY_AFTER_SHARED_PREFIX = "after_shared_prefix";

/** TTL intent stamped when the harness owns the cache lifecycle (opaque to the caller). */
export const TTL_INTENT_HARNESS_MANAGED = "harness_managed";

/** Default caller-controlled TTL intent when the harness allows the caller to choose. */
export const DEFAULT_CALLER_TTL_INTENT = "5m";

/** requestGroups bucket key for angles whose model resolution is "no override" (inherit). */
export const INHERIT_MODEL_KEY = "inherit";

/**
 * Recursively sort object keys (arrays keep their order — order is itself
 * cache-relevant for tool definitions and content-block boundaries) so two
 * structurally-equal inputs always serialize to the same JSON string.
 * @param {*} value
 * @returns {*}
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * sha256 over the canonical JSON serialization of every cache-relevant input
 * for one request group: concrete model (or the "inherit" bucket key), the
 * shared-prefix hash, tool definitions/order, instructions, settings,
 * content-block boundaries, TTL intent, and the cache boundary itself.
 * Deliberately excludes the angle list and any angle-specific prompt text —
 * those are the volatile per-angle suffix, never part of the fingerprint.
 * @param {object} input
 * @returns {string} `sha256:<hex>`
 */
function computeRequestPrefixFingerprint({
  model, sharedPrefixHash, toolDefinitions, instructions, settings, blockBoundaries, ttlIntent, cacheBoundary,
}) {
  const payload = canonicalize({
    model, sharedPrefixHash, toolDefinitions, instructions, settings, blockBoundaries, ttlIntent, cacheBoundary,
  });
  const hex = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return `sha256:${hex}`;
}

/**
 * @typedef {object} RequestPlanAngleModel
 * @property {string} angle
 * @property {string|null} model — concrete resolved model id, or `null` for inherit
 */

/**
 * @typedef {object} RequestGroup
 * @property {string} model — concrete model id, or `"inherit"` for the unresolved bucket
 * @property {string} requestPrefixFingerprint
 * @property {string} cacheBoundary
 * @property {string} ttlIntent
 * @property {string[]} angles — sorted, deduplicated
 */

/**
 * Build the deterministic per-gate-round request plan (#1468-A shape). Pure:
 * identical input always produces byte-identical output (stable key order,
 * angles sorted within a group, groups sorted by model).
 *
 * Angles partition into `requestGroups` BY CONCRETE MODEL: angles resolving to
 * the same model id share one group; angles with no override (`model: null`,
 * i.e. inherit) form their own explicit `"inherit"` bucket — never merged with
 * a concrete id. An angle listed twice with two DIFFERENT models is a caller
 * bug and throws (an angle cannot honestly belong to two request groups).
 *
 * Every cache-relevant input this layer can observe is folded into each
 * group's `requestPrefixFingerprint` (model, the shared-prefix bytes via
 * `sharedPrefixHash`, tool set/order, instructions, settings,
 * content-block boundaries, and TTL intent) — see
 * {@link computeRequestPrefixFingerprint}. Changing the angle SUFFIX alone
 * never changes the fingerprint; it is not a fingerprint input.
 *
 * @param {object} input
 * @param {string} input.gate
 * @param {string} input.headSha
 * @param {string} input.sharedPrefixPath
 * @param {string} input.sharedPrefixHash
 * @param {RequestPlanAngleModel[]} input.angleModels
 * @param {HarnessCapability} input.harnessCapability
 * @param {Array<string|object>} [input.toolDefinitions] — tool names/definitions in dispatch order
 * @param {string} [input.instructions] — system/project/agent instruction bytes (or a digest)
 * @param {object} [input.settings] — thinking/tool-choice settings
 * @param {string[]} [input.blockBoundaries] — content-block boundary markers, in order
 * @param {string|null} [input.ttlIntent] — explicit override; else derived from harnessCapability
 * @returns {{ gate: string, headSha: string, sharedPrefixPath: string, sharedPrefixHash: string, requestGroups: RequestGroup[] }}
 */
export function buildRequestPlan({
  gate,
  headSha,
  sharedPrefixPath,
  sharedPrefixHash,
  angleModels,
  harnessCapability,
  toolDefinitions = [],
  instructions = "",
  settings = {},
  blockBoundaries = [],
  ttlIntent = null,
} = {}) {
  if (typeof gate !== "string" || gate.trim().length === 0) {
    throw new Error("buildRequestPlan: gate is required");
  }
  if (typeof headSha !== "string" || headSha.trim().length === 0) {
    throw new Error("buildRequestPlan: headSha is required");
  }
  if (typeof sharedPrefixPath !== "string" || sharedPrefixPath.trim().length === 0) {
    throw new Error("buildRequestPlan: sharedPrefixPath is required");
  }
  if (typeof sharedPrefixHash !== "string" || sharedPrefixHash.trim().length === 0) {
    throw new Error("buildRequestPlan: sharedPrefixHash is required");
  }
  if (!Array.isArray(angleModels)) {
    throw new Error("buildRequestPlan: angleModels must be an array of { angle, model }");
  }
  if (!harnessCapability || typeof harnessCapability !== "object") {
    throw new Error("buildRequestPlan: harnessCapability is required (see makeHarnessCapability)");
  }

  const resolvedTtlIntent = ttlIntent
    ?? (harnessCapability.ttlOwnership === "harness_managed" ? TTL_INTENT_HARNESS_MANAGED : DEFAULT_CALLER_TTL_INTENT);

  const angleToModelKey = new Map();
  const anglesByModelKey = new Map();
  for (const entry of angleModels) {
    const angle = typeof entry?.angle === "string" ? entry.angle.trim() : "";
    if (angle.length === 0) {
      throw new Error("buildRequestPlan: every angleModels entry needs a non-empty string angle");
    }
    const rawModel = entry.model;
    if (rawModel != null && (typeof rawModel !== "string" || rawModel.trim().length === 0)) {
      throw new Error(`buildRequestPlan: angleModels entry for "${angle}" has an invalid model (must be a non-empty string, or null/undefined for inherit)`);
    }
    const modelKey = rawModel == null ? INHERIT_MODEL_KEY : rawModel.trim();

    const priorKey = angleToModelKey.get(angle);
    if (priorKey !== undefined && priorKey !== modelKey) {
      throw new Error(`buildRequestPlan: angle "${angle}" is listed with two different models ("${priorKey}" and "${modelKey}") — an angle cannot belong to two request groups`);
    }
    angleToModelKey.set(angle, modelKey);

    if (!anglesByModelKey.has(modelKey)) anglesByModelKey.set(modelKey, new Set());
    anglesByModelKey.get(modelKey).add(angle);
  }

  const requestGroups = [...anglesByModelKey.entries()]
    .map(([model, angleSet]) => {
      const angles = [...angleSet].sort();
      const requestPrefixFingerprint = computeRequestPrefixFingerprint({
        model,
        sharedPrefixHash,
        toolDefinitions,
        instructions,
        settings,
        blockBoundaries,
        ttlIntent: resolvedTtlIntent,
        cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
      });
      return {
        model,
        requestPrefixFingerprint,
        cacheBoundary: CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
        ttlIntent: resolvedTtlIntent,
        angles,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));

  return { gate, headSha, sharedPrefixPath, sharedPrefixHash, requestGroups };
}
