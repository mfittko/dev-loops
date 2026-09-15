/**
 * execution-record.mjs — compact per-execution-unit telemetry record, the
 * dev-loop execution-cap effort's final telemetry slice.
 *
 * Earlier execution-cap slices bounded the dev-loop's execution units (child
 * launch, reviewer unit, role budget) and enforced single watcher ownership.
 * None of them measure what a unit actually cost. This module adds one
 * compact, honesty-gated telemetry RECORD per execution unit (coordinator
 * phase, reviewer unit, judge round, fixer pass, watch cycle).
 *
 * Modeled on ./cache-telemetry-evidence.mjs: LOCAL/harness-observable
 * metrics (prompt/context bytes, turns, tool calls, local tool time) are
 * always measured — a genuine local zero is a real zero. PROVIDER-owned
 * metrics (input/output/cache-read tokens, child wall time) are
 * honesty-gated: a harness that cannot observe a dimension must report it
 * `{ available:false, reason }`, NEVER a coerced/estimated zero, and — the
 * core fidelity guard — must never be handed a numeric value for a
 * dimension its profile marks unavailable (fail closed).
 *
 * Pure and offline: no GitHub, no clock, no file reads except the writer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { HARNESS_VALUES } from "./role-budget-bound.mjs";

export const EXECUTION_RECORD_SCHEMA_VERSION = 1;

/** The five execution-unit kinds this record covers (superset of role-budget-bound's ROLE_VALUES). */
export const EXECUTION_UNIT_ROLES = Object.freeze([
  "coordinator_phase",
  "reviewer_unit",
  "judge_round",
  "fixer_pass",
  "watch_cycle",
]);

/**
 * Per-harness provider-token-telemetry capability. Conservative honest
 * defaults: `claude` observes provider token usage; `pi` and `codex` do not
 * — we have no ground truth that either exposes per-unit provider token
 * usage, so a record for them must never claim a measured token value (the
 * dev-loop execution-cap telemetry non-goal: never claim telemetry a harness
 * does not expose). Kept separate from review-dispatch-plan's own harness
 * capability map on purpose (different concern: cache reuse vs. per-unit cost).
 */
export const TELEMETRY_HARNESS_PROFILES = Object.freeze({
  claude: Object.freeze({ providerTokens: "available" }),
  codex: Object.freeze({ providerTokens: "unavailable" }),
  pi: Object.freeze({ providerTokens: "unavailable" }),
});

const profileKeys = Object.keys(TELEMETRY_HARNESS_PROFILES).slice().sort();
const harnessKeys = HARNESS_VALUES.slice().sort();
if (profileKeys.length !== harnessKeys.length || profileKeys.some((k, i) => k !== harnessKeys[i])) {
  throw new Error("execution-record.mjs: TELEMETRY_HARNESS_PROFILES must cover exactly HARNESS_VALUES");
}

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
/** @param {unknown} value @returns {boolean} */
function isHexHeadSha(value) {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value.trim());
}
/** @param {unknown} value @returns {boolean} discrete non-negative counter. */
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/** @param {unknown} value @returns {boolean} a genuine measurable non-negative duration/count. */
function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/**
 * Own-property-only harness profile lookup. A plain `[]` read plus
 * truthiness would let an inherited name (`toString`, `constructor`,
 * `__proto__`) resolve to a non-nullish value from Object.prototype and
 * bypass the "unknown harness" fail-closed check — this gates strictly on
 * the three real harness keys.
 * @param {unknown} harness @returns {object|undefined}
 */
function getHarnessProfile(harness) {
  return typeof harness === "string" && Object.hasOwn(TELEMETRY_HARNESS_PROFILES, harness)
    ? TELEMETRY_HARNESS_PROFILES[harness]
    : undefined;
}
/** @param {unknown} value @returns {boolean} rejects an empty string, a path separator, or a ".." traversal segment — a fail-closed guard for any value interpolated into a filesystem path. */
function isSafePathSegment(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

/**
 * Recursively freeze a plain object/array's own nested plain objects/arrays.
 * Mirrors reviewer-unit-bound.mjs / role-budget-bound.mjs / watcher-exclusivity.mjs.
 * @param {unknown} value @param {WeakSet<object>} [seen] @returns {unknown}
 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/**
 * Resolve one PROVIDER-token dimension's honesty-gated value. `null` means
 * "not observed" and is recorded as `{available:false, reason}` — never
 * coerced to 0. A non-null value is only accepted when the harness profile
 * marks the dimension observable; otherwise this is the core fidelity guard
 * and fails closed (a harness that cannot observe the metric must never
 * report a number for it).
 */
function resolveProviderTokenDimension({ harness, dim, value, reason, role, observable }) {
  if (value === null || value === undefined) {
    const defaultReason = observable
      ? `harness ${harness} exposes token telemetry but no value was reported for this ${role}`
      : `harness ${harness} does not expose provider token usage telemetry`;
    return Object.freeze({ available: false, value: null, reason: isNonEmptyString(reason) ? reason.trim() : defaultReason });
  }
  if (!observable) {
    throw new Error(`harness ${harness} does not expose provider token usage telemetry — providerTokens.${dim} must never report a value, got ${JSON.stringify(value)}`);
  }
  if (!isNonNegativeFiniteNumber(value)) {
    throw new TypeError(`providerTokens.${dim} must be a finite non-negative number or null, got ${JSON.stringify(value)}`);
  }
  return Object.freeze({ available: true, value, reason: null });
}

/**
 * Resolve childWallTimeMs. Any harness may report it (a wall-clock
 * measurement, not provider telemetry) — measured-or-unavailable-with-reason,
 * never gated on the provider-token profile.
 */
function resolveChildWallTime({ value, reason, role }) {
  if (value === null || value === undefined) {
    const defaultReason = `child wall time not reported by harness for this ${role}`;
    return Object.freeze({ available: false, value: null, reason: isNonEmptyString(reason) ? reason.trim() : defaultReason });
  }
  if (!isNonNegativeFiniteNumber(value)) {
    throw new TypeError(`childWallTimeMs must be a finite non-negative number or null, got ${JSON.stringify(value)}`);
  }
  return Object.freeze({ available: true, value, reason: null });
}

/**
 * Build one compact per-execution-unit telemetry record.
 *
 * @param {object} input
 * @param {"pi"|"claude"|"codex"} input.harness
 * @param {"coordinator_phase"|"reviewer_unit"|"judge_round"|"fixer_pass"|"watch_cycle"} input.role
 * @param {{headSha:string, phase?, round?, unit?, unitId?}} input.identity
 * @param {number} input.promptBytes @param {number} input.contextBytes
 * @param {number} input.turns @param {number} input.toolCalls
 * @param {{input:number|null, output:number|null, cacheRead:number|null, reasons?:object}} input.providerTokens
 * @param {number} input.localToolTimeMs @param {number|null} input.childWallTimeMs
 * @param {string|null} input.waitOwner @param {string} input.outcome
 * @returns {object} frozen record.
 */
export function buildExecutionUnitRecord({
  harness,
  role,
  identity,
  promptBytes,
  contextBytes,
  turns,
  toolCalls,
  providerTokens = {},
  localToolTimeMs,
  childWallTimeMs = null,
  childWallTimeMsReason,
  waitOwner = null,
  outcome,
} = {}) {
  if (!HARNESS_VALUES.includes(harness)) {
    throw new TypeError(`buildExecutionUnitRecord requires harness to be one of ${HARNESS_VALUES.join(", ")}, got ${JSON.stringify(harness)}`);
  }
  if (!EXECUTION_UNIT_ROLES.includes(role)) {
    throw new TypeError(`buildExecutionUnitRecord requires role to be one of ${EXECUTION_UNIT_ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  }
  if (!identity || typeof identity !== "object" || !isHexHeadSha(identity.headSha)) {
    throw new TypeError("buildExecutionUnitRecord requires identity.headSha to be a hex string (7-64 chars)");
  }
  const headSha = identity.headSha.trim().toLowerCase();
  const derivedUnitId = identity.unitId ?? identity.unit ?? identity.round ?? identity.phase;
  if (derivedUnitId === null || derivedUnitId === undefined || (typeof derivedUnitId === "string" && derivedUnitId.trim().length === 0)) {
    throw new TypeError("buildExecutionUnitRecord requires identity to carry at least one of unitId/unit/round/phase");
  }
  const unitId = String(derivedUnitId).trim();
  if (!isNonEmptyString(outcome)) {
    throw new TypeError("buildExecutionUnitRecord requires a non-empty outcome");
  }
  if (waitOwner !== null && !isNonEmptyString(waitOwner)) {
    throw new TypeError("buildExecutionUnitRecord requires waitOwner to be a non-empty string or null");
  }

  const localMetric = (value, label) => {
    if (!isNonNegativeInteger(value)) {
      throw new TypeError(`${label} must be a finite non-negative integer, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  if (!isNonNegativeFiniteNumber(localToolTimeMs)) {
    throw new TypeError(`localToolTimeMs must be a finite non-negative number, got ${JSON.stringify(localToolTimeMs)}`);
  }
  const metrics = Object.freeze({
    promptBytes: localMetric(promptBytes, "promptBytes"),
    contextBytes: localMetric(contextBytes, "contextBytes"),
    turns: localMetric(turns, "turns"),
    toolCalls: localMetric(toolCalls, "toolCalls"),
    localToolTimeMs,
  });

  const observable = getHarnessProfile(harness)?.providerTokens === "available";
  const reasons = providerTokens.reasons ?? {};
  const providerTokensNorm = Object.freeze({
    input: resolveProviderTokenDimension({ harness, dim: "input", value: providerTokens.input ?? null, reason: reasons.input, role, observable }),
    output: resolveProviderTokenDimension({ harness, dim: "output", value: providerTokens.output ?? null, reason: reasons.output, role, observable }),
    cacheRead: resolveProviderTokenDimension({ harness, dim: "cacheRead", value: providerTokens.cacheRead ?? null, reason: reasons.cacheRead, role, observable }),
  });
  const childWallTimeNorm = resolveChildWallTime({ value: childWallTimeMs, reason: childWallTimeMsReason, role });

  const availability = Object.freeze({
    providerTokensInput: Object.freeze({ available: providerTokensNorm.input.available, reason: providerTokensNorm.input.reason }),
    providerTokensOutput: Object.freeze({ available: providerTokensNorm.output.available, reason: providerTokensNorm.output.reason }),
    providerTokensCacheRead: Object.freeze({ available: providerTokensNorm.cacheRead.available, reason: providerTokensNorm.cacheRead.reason }),
    childWallTimeMs: Object.freeze({ available: childWallTimeNorm.available, reason: childWallTimeNorm.reason }),
  });
  const hasUnavailableProviderMetric = !providerTokensNorm.input.available
    || !providerTokensNorm.output.available
    || !providerTokensNorm.cacheRead.available;

  return deepFreeze({
    schemaVersion: EXECUTION_RECORD_SCHEMA_VERSION,
    role,
    harness,
    headSha,
    unitId,
    identity: {
      headSha,
      unitId,
      phase: identity.phase ?? null,
      round: identity.round ?? null,
      unit: identity.unit ?? null,
    },
    metrics,
    providerTokens: providerTokensNorm,
    childWallTimeMs: childWallTimeNorm,
    waitOwner,
    outcome,
    availability,
    hasUnavailableProviderMetric,
  });
}

/**
 * Fail-closed validation (never throws). Re-derives provider-token
 * availability from `record.harness`'s profile — NOT from a stored
 * `available:true` flag — so a hand-edited record that flips availability
 * while the harness profile says unavailable fails closed, mirroring
 * validateCacheTelemetryEvidence's capability re-derivation.
 *
 * @param {object} input @param {object} input.record
 * @returns {{ok:boolean, failures:Array<{check:string, reason:string}>}}
 */
export function validateExecutionUnitRecord({ record } = {}) {
  const failures = [];
  if (!record || typeof record !== "object") {
    return { ok: false, failures: [{ check: "record", reason: "missing execution-unit record" }] };
  }
  if (record.schemaVersion !== EXECUTION_RECORD_SCHEMA_VERSION) {
    failures.push({ check: "schema_version", reason: `schemaVersion must be ${EXECUTION_RECORD_SCHEMA_VERSION}, got ${JSON.stringify(record.schemaVersion)}` });
  }
  if (!EXECUTION_UNIT_ROLES.includes(record.role)) {
    failures.push({ check: "role", reason: `role must be one of ${EXECUTION_UNIT_ROLES.join(", ")}, got ${JSON.stringify(record.role)}` });
  }
  const profile = getHarnessProfile(record.harness);
  if (!profile) {
    failures.push({ check: "harness", reason: `harness must be one of ${HARNESS_VALUES.join(", ")}, got ${JSON.stringify(record.harness)}` });
  }
  if (!isHexHeadSha(record.headSha)) {
    failures.push({ check: "head_sha", reason: `headSha must be a hex string (7-64 chars), got ${JSON.stringify(record.headSha)}` });
  }
  if (!isNonEmptyString(record.unitId)) {
    failures.push({ check: "unit_id", reason: `unitId must be a non-empty string, got ${JSON.stringify(record.unitId)}` });
  }
  if (!record.identity || typeof record.identity !== "object" || record.identity.headSha !== record.headSha || record.identity.unitId !== record.unitId) {
    failures.push({ check: "identity", reason: "identity.headSha/identity.unitId must equal the record's own headSha/unitId" });
  }
  const metrics = record.metrics ?? {};
  for (const dim of ["promptBytes", "contextBytes", "turns", "toolCalls"]) {
    if (!isNonNegativeInteger(metrics[dim])) {
      failures.push({ check: "local_metric", reason: `metrics.${dim} must be a finite non-negative integer, got ${JSON.stringify(metrics[dim])}` });
    }
  }
  if (!isNonNegativeFiniteNumber(metrics.localToolTimeMs)) {
    failures.push({ check: "local_metric", reason: `metrics.localToolTimeMs must be a finite non-negative number, got ${JSON.stringify(metrics.localToolTimeMs)}` });
  }

  const checkHonestyGatedDim = (label, dimRecord, { gateOnProfile } = {}) => {
    if (!dimRecord || typeof dimRecord !== "object" || typeof dimRecord.available !== "boolean") {
      failures.push({ check: `${label}_shape`, reason: `${label} must be an object with a boolean available field` });
      return;
    }
    if (dimRecord.available) {
      if (gateOnProfile && profile && profile.providerTokens !== "available") {
        failures.push({ check: `${label}_honesty`, reason: `${label}.available=true but harness ${record.harness} does not expose provider token telemetry — an unavailable harness must never claim a measured value` });
      }
      if (!isNonNegativeFiniteNumber(dimRecord.value)) {
        failures.push({ check: `${label}_value`, reason: `${label}.value must be a finite non-negative number when available=true, got ${JSON.stringify(dimRecord.value)}` });
      }
    } else {
      if (dimRecord.value !== null) {
        failures.push({ check: `${label}_value`, reason: `${label}.value must be null when available=false, got ${JSON.stringify(dimRecord.value)}` });
      }
      if (!isNonEmptyString(dimRecord.reason)) {
        failures.push({ check: `${label}_reason`, reason: `${label}.reason must be a non-empty string when available=false` });
      }
    }
  };
  checkHonestyGatedDim("providerTokens.input", record.providerTokens?.input, { gateOnProfile: true });
  checkHonestyGatedDim("providerTokens.output", record.providerTokens?.output, { gateOnProfile: true });
  checkHonestyGatedDim("providerTokens.cacheRead", record.providerTokens?.cacheRead, { gateOnProfile: true });
  checkHonestyGatedDim("childWallTimeMs", record.childWallTimeMs, {});

  // Re-derive availability from the already-validated per-dimension records
  // (never trust a stored availability object on its own) — deleting or
  // forging this field must fail closed rather than silently pass.
  const expectedAvailability = {
    providerTokensInput: record.providerTokens?.input,
    providerTokensOutput: record.providerTokens?.output,
    providerTokensCacheRead: record.providerTokens?.cacheRead,
    childWallTimeMs: record.childWallTimeMs,
  };
  for (const [key, dim] of Object.entries(expectedAvailability)) {
    const avail = record.availability?.[key];
    if (!avail || typeof avail !== "object" || typeof avail.available !== "boolean") {
      failures.push({ check: `availability.${key}`, reason: `availability.${key} must be an object with a boolean available field` });
      continue;
    }
    const expectedAvailable = dim && typeof dim === "object" ? dim.available : undefined;
    const expectedReason = dim && typeof dim === "object" ? dim.reason : undefined;
    if (avail.available !== expectedAvailable) {
      failures.push({ check: `availability.${key}`, reason: `availability.${key}.available=${JSON.stringify(avail.available)} does not match the re-derived ${key} availability (expected ${JSON.stringify(expectedAvailable)})` });
    } else if (avail.reason !== expectedReason) {
      failures.push({ check: `availability.${key}`, reason: `availability.${key}.reason=${JSON.stringify(avail.reason)} does not match the re-derived ${key} reason (expected ${JSON.stringify(expectedReason)})` });
    }
  }

  if (record.waitOwner !== null && !isNonEmptyString(record.waitOwner)) {
    failures.push({ check: "wait_owner", reason: `waitOwner must be a non-empty string or null, got ${JSON.stringify(record.waitOwner)}` });
  }
  if (!isNonEmptyString(record.outcome)) {
    failures.push({ check: "outcome", reason: `outcome must be a non-empty string, got ${JSON.stringify(record.outcome)}` });
  }

  const expectedHasUnavailable = ["input", "output", "cacheRead"].some((dim) => record.providerTokens?.[dim]?.available !== true);
  if (record.hasUnavailableProviderMetric !== expectedHasUnavailable) {
    failures.push({ check: "aggregate_consistency", reason: `hasUnavailableProviderMetric=${record.hasUnavailableProviderMetric} does not match the re-derived providerTokens availability (expected ${expectedHasUnavailable})` });
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Strict fail-closed enforcement surface (GATE-EXEC-EXECUTION-RECORD): throws
 * when the record is missing or invalid, naming every failing check.
 * @param {object} input @param {object} input.record
 * @returns {true}
 */
export function enforceExecutionUnitRecord({ record } = {}) {
  const r = validateExecutionUnitRecord({ record });
  if (!r.ok) {
    throw new Error(
      `GATE-EXEC-EXECUTION-RECORD: execution-unit record failed validation; refusing to proceed (${r.failures.map((f) => `${f.check}: ${f.reason}`).join("; ")})`,
    );
  }
  return true;
}

/**
 * Deterministic artifact path for one execution unit's record.
 * @param {object} input @param {string} input.dir @param {string} input.role
 * @param {string} input.headSha @param {string} input.unitId
 * @returns {string}
 */
export function executionRecordPath({ dir, role, headSha, unitId } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("executionRecordPath requires a dir");
  if (!EXECUTION_UNIT_ROLES.includes(role) || !isSafePathSegment(role)) {
    throw new Error(`executionRecordPath requires role to be one of ${EXECUTION_UNIT_ROLES.join(", ")}`);
  }
  if (!isHexHeadSha(headSha) || !isSafePathSegment(headSha)) throw new Error("executionRecordPath requires a hex headSha");
  if (!isSafePathSegment(unitId)) {
    throw new Error("executionRecordPath requires a non-empty unitId without path separators or '..' segments");
  }
  return path.join(dir, `${role}-${String(unitId).trim()}-${headSha.trim().toLowerCase()}.execution-record.json`);
}

/**
 * Persist the record to its deterministic path.
 * @param {object} input @param {string} input.dir @param {object} input.record
 * @returns {Promise<{path:string}>}
 */
export async function writeExecutionUnitRecord({ dir, record } = {}) {
  const target = executionRecordPath({ dir, role: record.role, headSha: record.headSha, unitId: record.unitId });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { path: target };
}
