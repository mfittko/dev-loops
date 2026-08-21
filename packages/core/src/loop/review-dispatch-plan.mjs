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
 *     briefing content (Section A). `buildAngleRequestGroups` partitions a
 *     caller's angle -> concrete-model resolutions into that plan's
 *     `requestGroups` shape, bucketing angles with no override into an
 *     explicit "inherit" key rather than merging them into a concrete group.
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

/** True for a non-null value whose prototype is exactly Object.prototype or null (a JSON-shaped record, never a Date/Map/Set/class instance). */
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively sort object keys for a byte-deterministic serialization (arrays
 * keep their order — order is itself cache-relevant for tool definitions and
 * content-block boundaries).
 *
 * Trust-boundary validation, refusing loudly rather than silently colliding
 * two distinct inputs onto one fingerprint: a non-finite number (NaN/
 * Infinity) is rejected rather than let `JSON.stringify` collapse it to
 * `null`, a non-plain object (Date/Map/Set/...) is rejected rather than let
 * `Object.keys` see it as keyless (and therefore indistinguishable from
 * `{}`), and undefined/function/symbol/bigint are rejected rather than
 * silently dropped or crash-serialized by `JSON.stringify` itself. The
 * accumulator is null-prototype so an own `__proto__` key (a realistic shape
 * for JSON.parse'd input) is kept as a plain data property instead of
 * vanishing into the prototype chain.
 * @param {*} value
 * @param {string} [keyPath] — dotted path to `value`, for the error message
 * @returns {*}
 */
function stableStringify(value, keyPath = "$") {
  if (Array.isArray(value)) return value.map((entry, i) => stableStringify(entry, `${keyPath}[${i}]`));
  // Canonicalize nested Buffers to hex (the `__buffer:` prefix keeps a Buffer
  // distinct from a string that happens to equal its hex, so bytes and text can
  // never collide). Mirrors sha256Hex's top-level Buffer handling so a push/pull
  // through memory vs disk yields identical bytes even for nested buffers.
  if (Buffer.isBuffer(value)) return `__buffer:${value.toString("hex")}`;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`sha256Hex: fingerprint input at ${keyPath} is a non-finite number (${value}) — refusing to collapse it to JSON null`);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`sha256Hex: fingerprint input at ${keyPath} is a ${typeof value} — refusing to silently drop or crash-serialize it`);
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new Error(`sha256Hex: fingerprint input at ${keyPath} is not a plain object (got ${Object.prototype.toString.call(value)}) — refusing to canonicalize a keyless collision`);
    }
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = stableStringify(value[key], `${keyPath}.${key}`);
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
  // Fail closed on out-of-enum cacheBoundary/ttlIntent: a caller typo would
  // fold an undefinable value into the fingerprint that no other caller could
  // ever reproduce/validate, silently undermining the mechanically-checkable
  // contract (AC-2 parity with validateRequestGroups).
  const boundary = input.cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX;
  const ttl = input.ttlIntent ?? "harness_managed";
  if (!CACHE_BOUNDARY_VALUES.includes(boundary)) {
    throw new Error(`fingerprintRequestPrefix invalid cacheBoundary ${JSON.stringify(boundary)}`);
  }
  if (!TTL_INTENT_VALUES.includes(ttl)) {
    throw new Error(`fingerprintRequestPrefix invalid ttlIntent ${JSON.stringify(ttl)}`);
  }
  const canonical = {
    model: input.model.trim(),
    tools: input.tools ?? [],
    systemInstructions: input.systemInstructions ?? null,
    settings: input.settings ?? null,
    contentBlocks: input.contentBlocks ?? null,
    sharedArtifact: input.sharedArtifact ?? null,
    cacheBoundary: boundary,
    ttlIntent: ttl,
    // angleSuffix is excluded from the STABLE prefix fingerprint but is always
    // folded into this full request-prefix fingerprint when present, so the
    // claimed volatile difference stays assertable.
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
    // Canonicalize through stableStringify so a Buffer stablePrefix/briefingBlock
    // becomes `__buffer:<hex>` here too — raw JSON.stringify would expand Buffers
    // into large {type:"Buffer",data:[…]} decimal arrays (byte-unstable + costly),
    // reintroducing exactly what sha256Hex avoids.
    briefedBytes: JSON.stringify(stableStringify({
      cacheBoundary: cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
      ttlIntent: ttlIntent ?? "harness_managed",
      stableBytes: parts,
    })),
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
  const ttl = ttlIntent ?? "harness_managed";
  // Fail closed on out-of-enum cacheBoundary/ttlIntent (parity with
  // fingerprintRequestPrefix / validateRequestGroups) so a caller typo cannot
  // silently flow into the returned structure and break later parity checks.
  if (!CACHE_BOUNDARY_VALUES.includes(boundary)) {
    throw new Error(`composeCacheAwareRequest invalid cacheBoundary ${JSON.stringify(boundary)}`);
  }
  if (!TTL_INTENT_VALUES.includes(ttl)) {
    throw new Error(`composeCacheAwareRequest invalid ttlIntent ${JSON.stringify(ttl)}`);
  }
  const { stableFingerprint, briefedBytes } = fingerprintStablePrefix({
    stablePrefix,
    briefingBlock,
    cacheBoundary: boundary,
    ttlIntent: ttl,
  });
  const late = (typeof volatileState === "object" && volatileState !== null && !Buffer.isBuffer(volatileState))
    ? JSON.stringify(volatileState)
    : (volatileState ?? "");
  const segments = [
    { slot: "stablePrefix", bytes: stablePrefix ?? "" },
    { slot: "briefingBlock", bytes: briefingBlock ?? "" },
  ];
  // The cache boundary sits AFTER the stable prefix + briefing block. The marker
  // segment is a structural pointer, NOT request bytes: it is byte-empty so a
  // consumer concatenating segment bytes never injects the boundary label into
  // the provider-visible prompt (the label lives in the separate cacheBoundary
  // field).
  const boundaryIndex = segments.length;
  segments.push({ slot: "<cache boundary>", bytes: "" });
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
  // Normalize the stored artifact to a single canonical `sha256:<hex>` form so
  // the plan (and its planHash) never depends on whether the caller passed a
  // raw 64-hex string or an already-prefixed one for identical bytes (mixed-
  // format artifacts are byte-non-deterministic across callers).
  const normalizedSharedPrefixHash = sharedPrefixHash != null
    ? `sha256:${String(sharedPrefixHash).replace(/^sha256:/, "").trim().toLowerCase()}`
    : null;
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
    ...(normalizedSharedPrefixHash != null ? { sharedPrefixHash: normalizedSharedPrefixHash } : {}),
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
    const fpRaw = typeof g.requestPrefixFingerprint === "string" ? g.requestPrefixFingerprint.trim() : null;
    if (fpRaw != null && !isSha256Hex(fpRaw.replace(/^sha256:/, ""))) {
      throw new Error(`requestGroups[${i}].requestPrefixFingerprint must be sha256:<hex> or absent`);
    }
    // Normalize to a single canonical `sha256:<hex>` form (same rationale as
    // sharedPrefixHash) so the grouping/partition logic and the plan artifact
    // see byte-identical fingerprints regardless of caller format.
    const fp = fpRaw != null
      ? `sha256:${fpRaw.replace(/^sha256:/, "").toLowerCase()}`
      : null;
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
      ...(fpRaw != null ? { requestPrefixFingerprint: fp } : {}),
      cacheBoundary,
      ttlIntent,
      angles: [...new Set(g.angles.map(String))],
    });
  });
}

/* ------------------------------------------------------------------ *
 * 4b. Angle model bucketing (per-caller angle -> concrete model resolution)
 * ------------------------------------------------------------------ */

/**
 * `requestGroups` bucket key for angles whose model resolution is "no
 * override" (inherit). Reserved: a caller-resolved concrete model literally
 * named this would otherwise collide with the "no override" bucket and
 * become indistinguishable from genuine inherit.
 */
export const INHERIT_MODEL_KEY = "inherit";

/**
 * Partition a caller's angle -> concrete-model resolutions into fingerprinted
 * request groups ready for {@link buildReviewDispatchPlan}'s `requestGroups`
 * input. Angles resolving to the same concrete model id share one group;
 * angles with no override (`model: null`/`undefined`) form their own explicit
 * {@link INHERIT_MODEL_KEY} bucket, never merged with a concrete id. An angle
 * listed twice with two DIFFERENT models is a caller bug and throws (an angle
 * cannot honestly belong to two request groups). A concrete model literally
 * named {@link INHERIT_MODEL_KEY} also throws — it would otherwise silently
 * collide with the reserved bucket key and become indistinguishable from
 * genuine no-override.
 *
 * Each group's `requestPrefixFingerprint` is computed via
 * {@link fingerprintRequestPrefix} over every cache-relevant input this layer
 * observes for that group (the bucket's model, tool set/order, instructions,
 * settings, content-block boundaries, the shared-prefix bytes, and the
 * declared cache boundary/TTL intent) — changing only the angle set within a
 * bucket never changes its fingerprint.
 *
 * @param {object} input
 * @param {Array<{angle: string, model: string|null}>} input.angleModels
 * @param {string} [input.sharedPrefixHash] — folded in as the fingerprint's shared-artifact reference.
 * @param {Array<string|object>} [input.toolDefinitions] — tool names/definitions in dispatch order
 * @param {string|string[]} [input.instructions] — system/project/agent instruction bytes (or a digest)
 * @param {object} [input.settings] — thinking/tool-choice settings
 * @param {string[]} [input.blockBoundaries] — content-block boundary markers, in order
 * @param {string} [input.cacheBoundary]
 * @param {string} [input.ttlIntent] — one of TTL_INTENT_VALUES
 * @returns {RequestGroup[]} sorted by model (code-unit order, never localeCompare — ICU-dependent
 *   sorting could order the same two model ids differently across runtimes); angles sorted within a group.
 */
export function buildAngleRequestGroups({
  angleModels,
  sharedPrefixHash,
  toolDefinitions = [],
  instructions = "",
  settings = {},
  blockBoundaries = [],
  cacheBoundary = CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  ttlIntent = "harness_managed",
} = {}) {
  if (!Array.isArray(angleModels)) {
    throw new Error("buildAngleRequestGroups: angleModels must be an array of { angle, model }");
  }

  const angleToModelKey = new Map();
  const anglesByModelKey = new Map();
  for (const entry of angleModels) {
    const angle = typeof entry?.angle === "string" ? entry.angle.trim() : "";
    if (angle.length === 0) {
      throw new Error("buildAngleRequestGroups: every angleModels entry needs a non-empty string angle");
    }
    const rawModel = entry.model;
    if (rawModel != null && (typeof rawModel !== "string" || rawModel.trim().length === 0)) {
      throw new Error(`buildAngleRequestGroups: angleModels entry for "${angle}" has an invalid model (must be a non-empty string, or null/undefined for inherit)`);
    }
    const modelKey = rawModel == null ? INHERIT_MODEL_KEY : rawModel.trim();
    if (rawModel != null && modelKey === INHERIT_MODEL_KEY) {
      throw new Error(`buildAngleRequestGroups: angle "${angle}" has a concrete model literally named ${JSON.stringify(INHERIT_MODEL_KEY)}, which collides with the bucket key reserved for "no override" — rename the model, or resolve it to null/undefined instead of the literal string`);
    }

    const priorKey = angleToModelKey.get(angle);
    if (priorKey !== undefined && priorKey !== modelKey) {
      throw new Error(`buildAngleRequestGroups: angle "${angle}" is listed with two different models ("${priorKey}" and "${modelKey}") — an angle cannot belong to two request groups`);
    }
    angleToModelKey.set(angle, modelKey);

    if (!anglesByModelKey.has(modelKey)) anglesByModelKey.set(modelKey, new Set());
    anglesByModelKey.get(modelKey).add(angle);
  }

  return [...anglesByModelKey.entries()]
    .map(([model, angleSet]) => {
      const angles = [...angleSet].sort();
      const { fingerprint } = fingerprintRequestPrefix({
        model,
        tools: toolDefinitions,
        systemInstructions: instructions,
        settings,
        contentBlocks: blockBoundaries,
        sharedArtifact: sharedPrefixHash,
        cacheBoundary,
        ttlIntent,
      });
      return { model, requestPrefixFingerprint: fingerprint, cacheBoundary, ttlIntent, angles };
    })
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
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
    const reason = adequateTtl
      ? "barrierSignal=first_output and an adequate TTL is available — a real lead reviewer may prime the group"
      : "barrierSignal=first_output with cacheTtlControl=5m_1h capability — a real lead reviewer fits the cache control window";
    return {
      primerForm: PRIMER_FORM_LEAD_REVIEWER,
      reason,
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
  // concrete model's provider cache under a specific request prefix. Groups that
  // share a model AND a real (`sha256:<hex>`) fingerprint collapse into one
  // bucket; groups without a proven fingerprint never collapse (see below). Use
  // a nested Map keyed by model then by fingerprint (never a single delimiter-joined
  // string), so a model id that itself contains "::" stays intact and two distinct
  // (model, fp) pairs can never collide onto one bucket (dedup/identity safety).
  const byModel = new Map();
  for (let i = 0; i < requestGroups.length; i++) {
    const g = requestGroups[i];
    if (!byModel.has(g.model)) byModel.set(g.model, new Map());
    const fpMap = byModel.get(g.model);
    // Fail closed: only groups carrying a REAL (`sha256:<hex>`) fingerprint may
    // share a primer bucket (that proves a common cache-relevant prefix). A
    // fingerprint-less group is keyed by its own index so it NEVER collapses
    // with another — without a fingerprint you cannot prove two groups share the
    // same prefix, so merging them would let one primer silently cover multiple
    // unknown prefixes (at best wasted priming, at worst misleading evidence).
    const hasRealFp = typeof g.requestPrefixFingerprint === "string"
      && g.requestPrefixFingerprint.startsWith("sha256:");
    const key = hasRealFp ? g.requestPrefixFingerprint : `__unkeyed:${i}`;
    if (!fpMap.has(key)) fpMap.set(key, []);
    fpMap.get(key).push(g);
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
