/**
 * review-dispatch-plan.mjs — cache-aware review dispatch plan + request-prefix
 * fingerprinting + stable/volatile request separation (issue #1468 slices 1-2).
 *
 * This module is the mechanically-checkable foundation for the cache-efficient
 * review dispatch design (Section A/B/C/D of the #1468 spec). It owns:
 *
 *  1. Harness capability model — explicit representation of what a harness can
 *     observe/control about provider prompt caching
 *     (breakpointControl / barrierSignal / cacheTtlControl / usageTelemetry).
 *     Opaque capabilities are represented as such and are NEVER described as
 *     verified cache hits.
 *  2. Request-prefix fingerprinting — a deterministic sha256 over every
 *     cache-relevant value the dev-loops layer observes or controls (concrete
 *     model, tool definitions/order, system/project/agent instructions,
 *     thinking/tool-choice settings, content-block boundaries, shared artifact
 *     bytes, and breakpoint/TTL intent). Values owned opaquely by a harness are
 *     represented as a placeholder, never assumed identical.
 *  3. Stable/volatile request separation — physically separates stable handoff
 *     content from volatile `gateState` at the request/artifact boundary, so a
 *     provider-visible cache boundary sits after the stable materialized
 *     briefing block and before the late volatile tail + angle suffix.
 *  4. Dispatch-plan builder — one deterministic per-gate-round artifact that
 *     records the complete cache-relevant request shape without duplicating
 *     briefing content (Section A).
 *  5. Primer-form default — deterministic default by harness capability
 *     (Section C/D): first-output-observable harnesses may let a lead reviewer
 *     prime; completion-only harnesses default to a short dedicated primer
 *     unless an adequate TTL is explicit; multiple concrete models partition
 *     into one primer group per model/request-prefix.
 *
 * This module is pure and offline: no GitHub, no harness, no clock. All runtime
 * execution adapters consume it; it never executes a reviewer itself.
 */
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ *
 * 1. Harness capability model
 * ------------------------------------------------------------------ */

/** Allowed values for each capability dimension (Section D). */
export const BREAKPOINT_CONTROL_VALUES = Object.freeze(["explicit", "automatic", "opaque"]);
export const BARRIER_SIGNAL_VALUES = Object.freeze(["first_output", "completion_only"]);
export const CACHE_TTL_CONTROL_VALUES = Object.freeze(["5m_1h", "fixed", "opaque"]);
export const USAGE_TELEMETRY_VALUES = Object.freeze(["available", "unavailable"]);

/** Allowed breakpoint/TTL intents a consumer may declare for a request group. */
export const TTL_INTENT_VALUES = Object.freeze(["5m", "1h", "harness_managed"]);

/** Cache boundary markers; the only current boundary is after the shared prefix. */
export const CACHE_BOUNDARY_AFTER_SHARED_PREFIX = "after_shared_prefix";
export const CACHE_BOUNDARY_VALUES = Object.freeze([CACHE_BOUNDARY_AFTER_SHARED_PREFIX]);

/**
 * Default capability posture per harness name. These are conservative defaults:
 * any harness whose provider-cache controls we cannot assert explicitly is
 * represented with `opaque` / `unavailable` capabilities, which fail closed
 * rather than over-claim. Consumers may pass explicit capabilities to
 * {normalizeHarnessCapabilities}.
 */
export const HARNESS_DEFAULT_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    breakpointControl: "automatic",
    barrierSignal: "completion_only",
    cacheTtlControl: "fixed",
    usageTelemetry: "available",
  }),
  pi: Object.freeze({
    breakpointControl: "opaque",
    barrierSignal: "completion_only",
    cacheTtlControl: "opaque",
    usageTelemetry: "unavailable",
  }),
});

const CAPABILITY_DIMENSIONS = [
  ["breakpointControl", BREAKPOINT_CONTROL_VALUES],
  ["barrierSignal", BARRIER_SIGNAL_VALUES],
  ["cacheTtlControl", CACHE_TTL_CONTROL_VALUES],
  ["usageTelemetry", USAGE_TELEMETRY_VALUES],
];

/**
 * Normalize + validate a harness capability object. Fails closed on unknown
 * dimension names, unknown values, or a non-object. Returns a frozen canonical
 * object.
 *
 * @param {object} input
 * @param {string} [input.harness] - harness name; used only for the default merge
 *   (matches HARNESS_DEFAULT_CAPABILITIES keys, else fails closed on unknown).
 * @param {object} [input.capabilities] - explicit per-dimension overrides.
 * @returns {Readonly<Record<string,string>>} frozen capability object.
 */
export function normalizeHarnessCapabilities({ harness, capabilities } = {}) {
  let base = {};
  if (harness != null) {
    const key = String(harness).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(HARNESS_DEFAULT_CAPABILITIES, key)) {
      throw new Error(
        `Unknown harness ${JSON.stringify(harness)} — must be one of ${Object.keys(HARNESS_DEFAULT_CAPABILITIES).join(", ")} or supply explicit capabilities`,
      );
    }
    base = HARNESS_DEFAULT_CAPABILITIES[key];
  }
  const merged = { ...base };
  if (capabilities != null) {
    if (typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw new Error("capabilities must be an object of dimension -> value pairs");
    }
    for (const [dim, value] of Object.entries(capabilities)) {
      const known = CAPABILITY_DIMENSIONS.find(([name]) => name === dim);
      if (!known) {
        throw new Error(`Unknown capability dimension ${JSON.stringify(dim)}`);
      }
      const [, allowed] = known;
      if (!allowed.includes(value)) {
        throw new Error(
          `Invalid ${dim} ${JSON.stringify(value)} — must be one of ${allowed.join(", ")}`,
        );
      }
      merged[dim] = value;
    }
  }
  // Fail closed if any dimension was never resolved to a real value.
  for (const [dim] of CAPABILITY_DIMENSIONS) {
    if (merged[dim] == null) {
      throw new Error(`Capability dimension ${dim} was not resolved (must be explicit or from a known harness)`);
    }
  }
  return Object.freeze({
    breakpointControl: merged.breakpointControl,
    barrierSignal: merged.barrierSignal,
    cacheTtlControl: merged.cacheTtlControl,
    usageTelemetry: merged.usageTelemetry,
  });
}

/**
 * Is this capability set honest about provider cache reuse? A harness whose
 * usage telemetry is `unavailable` cannot claim verified `1 write + N reads`.
 * This is the fail-closed honesty gate for telemetry evidence (Section D).
 *
 * @param {Readonly<Record<string,string>>} caps - normalized capabilities.
 * @returns {{ verified: boolean, reason: string|null }}
 */
export function cacheReuseVeracity(caps) {
  if (!caps) return { verified: false, reason: "missing capability record" };
  if (caps.usageTelemetry !== "available") {
    return {
      verified: false,
      reason: `usageTelemetry=${caps.usageTelemetry} — provider reuse cannot be verified, only ordering + fingerprint invariants may be claimed`,
    };
  }
  return { verified: true, reason: null };
}

/* ------------------------------------------------------------------ *
 * 2. Request-prefix fingerprinting
 * ------------------------------------------------------------------ */

const HEX = /^[0-9a-f]{64}$/;

/** @param {string} value @returns {boolean} */
function isSha256Hex(value) {
  return typeof value === "string" && HEX.test(value.trim().toLowerCase());
}

/**
 * Deterministic sha256 hex of a canonical-JSON serialization. Content may be a
 * string, Buffer, or the live object; buffers are canonicalized by hex so a
 * push/pull through memory vs disk yields identical bytes.
 *
 * @param {unknown} content
 * @returns {string} `sha256:<64-hex>`
 */
export function sha256Hex(content) {
  const h = createHash("sha256");
  if (Buffer.isBuffer(content)) {
    h.update(content);
  } else if (typeof content === "string") {
    h.update(content);
  } else {
    // Deterministic canonical key ordering via stable stringify.
    const canonical = stableStringify(content);
    h.update(JSON.stringify(canonical));
  }
  return `sha256:${h.digest("hex")}`;
}

const isPlainObject = (v) =>
  v != null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v);

/** Recursively sort object keys for a byte-deterministic serialization. */
function stableStringify(value) {
  if (Array.isArray(value)) return value.map(stableStringify);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableStringify(value[key]);
    return out;
  }
  return value;
}

/**
 * Fingerprint the complete observable request prefix (Section A). Every
 * cache-relevant value the dev-loops layer observes or controls is folded into
 * the hash: concrete model, tool definitions/order, system/project/agent
 * instructions, thinking/tool-choice settings, content-block boundaries, shared
 * artifact bytes, and breakpoint/TTL intent. Values owned opaquely by a harness
 * should be passed as `null`-free opaque markers (see `opaqueMarker`).
 *
 * @param {object} input
 * @param {string} input.model - concrete model id for this request group.
 * @param {string[]|object[]} [input.tools] - tool definitions/order.
 * @param {string|string[]} [input.systemInstructions] - system/project/agent instructions.
 * @param {object|string} [input.settings] - thinking/tool-choice settings.
 * @param {object[]} [input.contentBlocks] - content-block boundaries + shared bytes.
 * @param {string} [input.sharedArtifact] - shared artifact reference (path) or bytes.
 * @param {string} [input.cacheBoundary] - e.g. `after_shared_prefix`.
 * @param {string} [input.ttlIntent] - one of TTL_INTENT_VALUES.
 * @param {string[]} [input.angleSuffix] - angle-specific suffix (excluded from the
 *   STABLE prefix fingerprint; included here only when invasive).
 * @returns {{ fingerprint: string, canonical: object }}
 */
export function fingerprintRequestPrefix(input) {
  if (!input || typeof input !== "object") {
    throw new Error("fingerprintRequestPrefix requires an object input");
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new Error("fingerprintRequestPrefix requires a non-empty concrete model");
  }
  // Fail closed on invalid shapes (AC-2: the fingerprint covers the COMPLETE
  // observable prefix). A silently-coerced non-array tools/contentBlocks would
  // collapse two genuinely different request prefixes into one fingerprint, so
  // reject rather than quietly omit.
  if (input.tools != null && !Array.isArray(input.tools)) {
    throw new Error("fingerprintRequestPrefix tools must be an array of tool definitions");
  }
  if (input.contentBlocks != null && !Array.isArray(input.contentBlocks)) {
    throw new Error("fingerprintRequestPrefix contentBlocks must be an array");
  }
  const canonical = {
    model: input.model.trim(),
    tools: input.tools ?? [],
    systemInstructions: input.systemInstructions ?? null,
    settings: input.settings ?? null,
    contentBlocks: input.contentBlocks ?? null,
    sharedArtifact: input.sharedArtifact ?? null,
    cacheBoundary: input.cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
    ttlIntent: input.ttlIntent ?? "harness_managed",
    // angleSuffix is excluded from the STABLE prefix fingerprint but, when the
    // caller marks it invasive, it IS folded into this full request-prefix
    // fingerprint so the claimed difference stays assertable.
    ...(input.angleSuffix != null ? { angleSuffix: input.angleSuffix } : {}),
  };
  return { fingerprint: sha256Hex(canonical), canonical };
}

/**
 * Opaque placeholder for a value owned opaquely by the harness. Using this in a
 * fingerprint input records that the value existed but was not byte-observable,
 * so two runs that differ only in an unobservable harness value STILL collapse
 * to the same fingerprint (they cannot be proven different) — and, symmetrically,
 * a claimed difference under an opaque value is not assertable.
 *
 * @param {string} label
 * @returns {string}
 */
export function opaqueMarker(label) {
  return `__opaque:${String(label)}`;
}

/* ------------------------------------------------------------------ *
 * 3. Stable/volatile request separation
 * ------------------------------------------------------------------ */

/**
 * The stable-prefix fingerprint is computed ONLY over the stable prefix +
 * materialized briefing block — never the volatile tail or angle suffix. This
 * is the mechanical proof for AC-1: changing only `gateState` (or the angle
 * suffix) MUST NOT change the shared request prefix block.
 *
 * @param {object} input
 * @param {string|Buffer} input.stablePrefix - stable review-agent/system/tool prefix.
 * @param {string|Buffer} input.briefingBlock - materialized shared briefing block bytes.
 * @param {string} [input.cacheBoundary]
 * @param {string} [input.ttlIntent]
 * @returns {{ stableFingerprint: string, briefedBytes: string }}
 */
export function fingerprintStablePrefix({ stablePrefix, briefingBlock, cacheBoundary, ttlIntent } = {}) {
  const parts = [stablePrefix ?? "", briefingBlock ?? ""];
  const stableFingerprint = sha256Hex({ stablePrefix: parts[0], briefingBlock: parts[1] });
  return {
    stableFingerprint,
    briefedBytes: JSON.stringify({ cacheBoundary: cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX, ttlIntent: ttlIntent ?? "harness_managed", stableBytes: parts }),
  };
}

/**
 * Compose a cache-aware request as ordered segments with a declared cache
 * boundary after the stable briefing block (Section B):
 *
 *   [stable review-agent/system/tool prefix]
 *   [materialized shared briefing block]
 *   <cache boundary>
 *   [late volatile gate state, when needed]
 *   [angle-specific suffix]
 *
 * Returns the ordered segment list plus the boundary index and the stable
 * fingerprints, so a consumer can render the request and a verifier can assert
 * stable-prefix equality byte-for-byte regardless of volatile/angle changes.
 *
 * @param {object} input
 * @param {string|Buffer} input.stablePrefix
 * @param {string|Buffer} input.briefingBlock
 * @param {object} [input.volatileState] - late volatile gate state (serialized AFTER the boundary).
 * @param {string|Buffer} [input.angleSuffix]
 * @param {string} [input.cacheBoundary]
 * @param {string} [input.ttlIntent]
 * @returns {object} ordered segments + boundary + fingerprints.
 */
export function composeCacheAwareRequest({ stablePrefix, briefingBlock, volatileState, angleSuffix, cacheBoundary, ttlIntent } = {}) {
  const boundary = cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX;
  const { stableFingerprint, briefedBytes } = fingerprintStablePrefix({
    stablePrefix,
    briefingBlock,
    cacheBoundary: boundary,
    ttlIntent: ttlIntent ?? "harness_managed",
  });
  const late = (typeof volatileState === "object" && volatileState !== null && !Buffer.isBuffer(volatileState))
    ? JSON.stringify(volatileState)
    : (volatileState ?? "");
  const segments = [
    { slot: "stablePrefix", bytes: stablePrefix ?? "" },
    { slot: "briefingBlock", bytes: briefingBlock ?? "" },
  ];
  // The cache boundary sits AFTER the stable prefix + briefing block.
  const boundaryIndex = segments.length;
  segments.push({ slot: "<cache boundary>", bytes: boundary });
  if (late.length > 0) segments.push({ slot: "volatileState", bytes: late });
  if (angleSuffix != null && String(angleSuffix).length > 0) {
    segments.push({ slot: "angleSuffix", bytes: String(angleSuffix) });
  }
  return {
    cacheBoundary: boundary,
    boundaryIndex,
    stableFingerprint,
    briefedBytes,
    segments,
  };
}

/* ------------------------------------------------------------------ *
 * 4. Dispatch-plan builder (Section A)
 * ------------------------------------------------------------------ */

/**
 * Build a deterministic per-gate-round dispatch plan. The plan records the
 * complete cache-relevant request shape WITHOUT duplicating briefing content
 * (it stores the shared-prefix path + hash, not the bytes).
 *
 * @param {object} input
 * @param {string} input.gate - draft_gate | pre_approval_gate | ...
 * @param {string} input.headSha - full reviewed head SHA.
 * @param {string} [input.sharedPrefixPath] - path to the materialized briefing-prefix file.
 * @param {string} [input.sharedPrefixHash] - `sha256:<hex>` of those bytes.
 * @param {Array<object>} [input.requestGroups] - each { model, requestPrefixFingerprint, cacheBoundary, ttlIntent, angles[] }.
 * @param {object} [input.capabilities] - normalized harness capabilities.
 * @param {object} [input.extra] - opaque consumer fields folded into the canonical hash but ignored by validation.
 * @returns {object} validated dispatch-plan object.
 */
export function buildReviewDispatchPlan({ gate, headSha, sharedPrefixPath, sharedPrefixHash, requestGroups = [], capabilities, extra } = {}) {
  if (typeof gate !== "string" || gate.length === 0) {
    throw new Error("buildReviewDispatchPlan requires a non-empty gate");
  }
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha.trim())) {
    throw new Error("buildReviewDispatchPlan requires a hex headSha");
  }
  if (sharedPrefixHash != null && !isSha256Hex(String(sharedPrefixHash).replace(/^sha256:/, ""))) {
    throw new Error(`sharedPrefixHash must be sha256:<64 hex> or absent, got ${JSON.stringify(sharedPrefixHash)}`);
  }
  const groups = validateRequestGroups(requestGroups);
  let caps = capabilities;
  if (caps != null) {
    // A capability spec may carry a `harness` key plus dimension overrides.
    const hasHarness = typeof caps === "object" && !Array.isArray(caps) && typeof caps.harness === "string";
    if (hasHarness) {
      const { harness: harnessName, ...dims } = caps;
      caps = normalizeHarnessCapabilities({ harness: harnessName, capabilities: dims });
    } else {
      caps = normalizeHarnessCapabilities({ capabilities: caps });
    }
  }
  const plan = {
    gate,
    headSha: headSha.trim().toLowerCase(),
    ...(sharedPrefixPath != null ? { sharedPrefixPath } : {}),
    ...(sharedPrefixHash != null ? { sharedPrefixHash: String(sharedPrefixHash) } : {}),
    requestGroups: groups,
    ...(caps != null ? { capabilities: caps } : {}),
  };
  // Deterministic plan hash over the canonical plan, with opaque `extra` folded
  // under its own namespace so an `extra` key can never shadow a real plan
  // field (the fingerprint must always pin the plan's actual values).
  const planHash = sha256Hex({ ...plan, extra: extra ?? {} }).replace(/^sha256:/, "");
  return Object.freeze({ ...plan, planHash: `sha256:${planHash}` });
}

function validateRequestGroups(requestGroups) {
  if (!Array.isArray(requestGroups)) {
    throw new Error("requestGroups must be an array");
  }
  return requestGroups.map((g, i) => {
    if (typeof g.model !== "string" || g.model.trim().length === 0) {
      throw new Error(`requestGroups[${i}].model must be a non-empty concrete model`);
    }
    const fp = typeof g.requestPrefixFingerprint === "string" ? g.requestPrefixFingerprint.trim() : null;
    if (fp != null && !isSha256Hex(fp.replace(/^sha256:/, ""))) {
      throw new Error(`requestGroups[${i}].requestPrefixFingerprint must be sha256:<hex> or absent`);
    }
    const cacheBoundary = g.cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX;
    if (!CACHE_BOUNDARY_VALUES.includes(cacheBoundary)) {
      throw new Error(`requestGroups[${i}] invalid cacheBoundary ${JSON.stringify(cacheBoundary)}`);
    }
    const ttlIntent = g.ttlIntent ?? "harness_managed";
    if (!TTL_INTENT_VALUES.includes(ttlIntent)) {
      throw new Error(`requestGroups[${i}] invalid ttlIntent ${JSON.stringify(ttlIntent)}`);
    }
    if (!Array.isArray(g.angles) || g.angles.length === 0) {
      throw new Error(`requestGroups[${i}].angles must be a non-empty array of angle names`);
    }
    return Object.freeze({
      model: g.model.trim(),
      ...(fp != null ? { requestPrefixFingerprint: fp } : {}),
      cacheBoundary,
      ttlIntent,
      angles: [...new Set(g.angles.map(String))],
    });
  });
}

/* ------------------------------------------------------------------ *
 * 5. Primer-form default (Section C/D)
 * ------------------------------------------------------------------ */

export const PRIMER_FORM_LEAD_REVIEWER = "lead_reviewer";
export const PRIMER_FORM_DEDICATED = "dedicated_primer";

/**
 * Resolve the primer form for a request group by harness capability (Section
 * C/D default-by-harness-capability):
 *  - first_output-observable harness + an adequate TTL (5m/1h) → may prime with
 *    a lead reviewer (`lead_reviewer`).
 *  - completion_only harness without an adequate explicit TTL → short dedicated
 *    primer (`dedicated_primer`) so a full review wait cannot silently outrun
 *    the cache TTL.
 *  - usageTelemetry unavailable + opaque controls → conservative dedicated
 *    primer (cannot observe barrier evidence), failing toward the safe option.
 *
 * @param {object} input
 * @param {Readonly<Record<string,string>>} input.capabilities - normalized capabilities.
 * @param {string} [input.ttlIntent] - declared TTL intent for the group.
 * @returns {{ primerForm: "lead_reviewer"|"dedicated_primer", reason: string }}
 */
export function resolvePrimerForm({ capabilities, ttlIntent } = {}) {
  const caps = capabilities ?? {};
  const adequateTtl = ttlIntent === "5m" || ttlIntent === "1h";
  if (caps.barrierSignal === "first_output" && (adequateTtl || caps.cacheTtlControl === "5m_1h")) {
    return {
      primerForm: PRIMER_FORM_LEAD_REVIEWER,
      reason: "barrierSignal=first_output and an adequate TTL is available — a real lead reviewer may prime the group",
    };
  }
  if (caps.barrierSignal === "completion_only" && caps.cacheTtlControl === "5m_1h" && ttlIntent === "1h") {
    return {
      primerForm: PRIMER_FORM_LEAD_REVIEWER,
      reason: "completion_only harness with an explicit one-hour TTL — a long lead review fits the cache window",
    };
  }
  return {
    primerForm: PRIMER_FORM_DEDICATED,
    reason: "completion_only or opaque controls without an adequate explicit TTL — a short dedicated primer avoids a full review outrunning the cache TTL",
  };
}

/**
 * Partition request groups into primer groups — one per distinct concrete
 * model/request-prefix (Section C: heterogeneous per-angle model routing cannot
 * silently reuse one model's primer to warm another).
 *
 * @param {object[]} requestGroups - validated request groups.
 * @param {Readonly<Record<string,string>>} [capabilities]
 * @returns {Array<{ model: string, requestPrefixFingerprint: string|null, groups: object[] }>}
 */
export function partitionPrimerGroups(requestGroups, capabilities = {}) {
  if (!Array.isArray(requestGroups)) throw new Error("partitionPrimerGroups requires an array");
  // One primer group per distinct (model, request-prefix) — a primer warms ONE
  // concrete model's provider cache under a specific request prefix, so two
  // groups cannot share a primer even when their fingerprints coincide. Use a
  // nested Map keyed by model then by fingerprint (never a single delimiter-joined
  // string), so a model id that itself contains "::" stays intact and two distinct
  // (model, fp) pairs can never collide onto one bucket (dedup/identity safety).
  const byModel = new Map();
  for (const g of requestGroups) {
    if (!byModel.has(g.model)) byModel.set(g.model, new Map());
    const fpMap = byModel.get(g.model);
    const fp = g.requestPrefixFingerprint ?? opaqueMarker(`model:${g.model}`);
    if (!fpMap.has(fp)) fpMap.set(fp, []);
    fpMap.get(fp).push(g);
  }
  const out = [];
  for (const [model, fpMap] of byModel.entries()) {
    for (const [fp, groups] of fpMap.entries()) {
      // Resolve the primer form CONSERVATIVELY across every collapsed group's TTL
      // intent: a partition primes with a lead reviewer only when ALL its groups
      // would; any group that needs a dedicated primer forces the whole partition
      // down, so a mixed-TTL collapse is never decided by the first group alone.
      const allLead = groups.every(
        (g) => resolvePrimerForm({ capabilities, ttlIntent: g.ttlIntent }).primerForm === PRIMER_FORM_LEAD_REVIEWER,
      );
      out.push({
        model,
        requestPrefixFingerprint: fp.startsWith("sha256:") ? fp : null,
        primerForm: allLead ? PRIMER_FORM_LEAD_REVIEWER : PRIMER_FORM_DEDICATED,
        groups: groups.map((g) => ({ model: g.model, angles: g.angles, ttlIntent: g.ttlIntent })),
      });
    }
  }
  return out;
}
