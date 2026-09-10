/**
 * cache-telemetry-evidence.mjs — cache telemetry adapter + before/after evidence
 * artifact (issue #1468 slice 4).
 *
 * Slices 1-3 produced the deterministic request plan, request-prefix fingerprints,
 * stable/volatile separation, per-model primer-group partitioning, and the
 * primer-dispatch ordering evidence + fail-closed fan-in validation. That
 * proves the ordering and request-fingerprint invariants a cache-aware dispatch
 * relies on, but it does not by itself MEASURE the provider cache reuse: whether
 * the N reviewers actually read the cache entry the primer wrote.
 *
 * This slice adds the harness-capability-aware telemetry surface (Section D of
 * #1468). Where a harness exposes cache creation/read usage telemetry, we
 * persist per-primer creation tokens and per-reviewer read tokens and emit an
 * aggregate read:create report. Where the harness is opaque or telemetry is
 * unavailable, we record `cacheReuseVerified: false` with the reason and NEVER
 * describe the result as a verified `1 write + N reads` outcome — only the
 * ordering + fingerprint invariants from the earlier slices may be claimed.
 *
 * This module is pure and offline (no GitHub, no harness, no clock). It owns:
 *
 *  1. before/after evidence artifact builder — a deterministic per-gate-run record
 *     ('<gate>-<headSha>.cache-telemetry.json') pairing the plan + capability
 *     record with the observed cache-creation (before) and cache-read (after)
 *     telemetry events, and deriving the aggregate read:create report.
 *  2. fail-closed validator — checks, named individually, that verified reuse is
 *     never claimed without the capability + at least one creation and one read
 *     event that telemetry can actually observe; an opaque/unavailable harness
 *     must fail closed to `cacheReuseVerified: false` (Section D honesty gate).
 *  3. deterministic path + writer — consumable by the gate ledger without
 *     re-derivation (GATE-EXEC-CACHE-TELEMETRY).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
  cacheReuseVeracity,
  normalizeHarnessCapabilities,
} from "./review-dispatch-plan.mjs";

export const CACHE_TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Deterministic artifact path for a gate run's cache-telemetry evidence.
 *
 * @param {object} input
 * @param {string} input.dir - directory to write under (e.g. the gate-context dir).
 * @param {string} input.gate - gate name (pre_approval_gate, draft_gate, ...).
 * @param {string} input.headSha - reviewed head SHA (hex, 7-64).
 * @returns {string} absolute-style path joined under `dir`.
 */
export function cacheTelemetryPath({ dir, gate, headSha } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("cacheTelemetryPath requires a dir");
  if (typeof gate !== "string" || gate.length === 0) throw new Error("cacheTelemetryPath requires a gate");
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha.trim())) {
    throw new Error("cacheTelemetryPath requires a hex headSha");
  }
  return path.join(dir, `${gate}-${headSha.trim().toLowerCase()}.cache-telemetry.json`);
}

/** Count of entries whose `tokens` is a finite non-negative number. Non-object/null entries are skipped so a malformed artifact element can never throw. */
function countTokens(entries) {
  return entries.filter(
    (e) => e != null && typeof e === "object" && Number.isFinite(e.tokens) && e.tokens >= 0,
  ).length;
}

/** Sum of finite non-negative `tokens` across entries. Non-object/null entries are skipped. */
function sumTokens(entries) {
  return entries.reduce((acc, e) => {
    const t =
      e != null && typeof e === "object" && Number.isFinite(e.tokens) && e.tokens >= 0 ? e.tokens : 0;
    return acc + t;
  }, 0);
}

/**
 * Build the before/after cache-telemetry evidence artifact for a gate run.
 *
 * "Before" = the cache-creation events (the primer write side); "after" = the
 * cache-read events (the reviewer read side). Where a harness does not expose
 * per-event token counts, callers may record the event with `tokens: null`; the
 * event still counts toward the create/read tally but not the token aggregates.
 *
 * @param {object} input
 * @param {object} input.plan - the dispatch plan from buildReviewDispatchPlan().
 * @param {object} [input.capabilities] - normalized harness capabilities (used
 *   to drive the veracity gate; defaults to the plan's capabilities when present).
 * @param {Array<object>} input.primerCacheCreations - [{ model, primerForm, tokens|null }]
 *   observed cache creations (the "before" write events).
 * @param {Array<object>} input.reviewerCacheReads - [{ model, angle, tokens|null }]
 *   observed cache reads (the "after" read events).
 * @returns {object} canonical evidence artifact.
 */
export function buildCacheTelemetryEvidence({
  plan,
  capabilities,
  primerCacheCreations = [],
  reviewerCacheReads = [],
} = {}) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.requestGroups)) {
    throw new Error("buildCacheTelemetryEvidence requires a plan with requestGroups");
  }
  if (typeof plan.gate !== "string" || plan.gate.length === 0) {
    throw new Error("buildCacheTelemetryEvidence requires a plan with a non-empty gate");
  }
  if (typeof plan.headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(plan.headSha.trim())) {
    throw new Error("buildCacheTelemetryEvidence requires a plan with a hex headSha");
  }
  if (typeof plan.planHash !== "string" || plan.planHash.length === 0) {
    throw new Error("buildCacheTelemetryEvidence requires a plan with a non-empty planHash");
  }
  if (!Array.isArray(primerCacheCreations)) throw new Error("primerCacheCreations must be an array");
  if (!Array.isArray(reviewerCacheReads)) throw new Error("reviewerCacheReads must be an array");

  // Resolve the capability record: an explicitly passed one wins, else fall back
  // to the plan's `capabilities` field. A missing capability record is itself a
  // fail-closed truth (cannot claim verified reuse without a capability record).
  let caps = capabilities ?? plan.capabilities ?? null;
  if (caps != null) {
    // A capability spec may carry a `harness` key plus dimension overrides
    // (parity with buildReviewDispatchPlan's handling).
    const hasHarness = typeof caps === "object" && !Array.isArray(caps) && typeof caps.harness === "string";
    if (hasHarness) {
      const { harness: harnessName, ...dims } = caps;
      caps = normalizeHarnessCapabilities({ harness: harnessName, capabilities: dims });
    } else {
      caps = normalizeHarnessCapabilities({ capabilities: caps });
    }
  }

  const normalizeTokens = (tokens, label) => {
    // Fail CLOSED on a non-null token that is not a finite non-negative
    // number (numeric strings, NaN, Infinity, negatives, other types): the
    // reported value is telemetry evidence and a silently-coerced token would
    // under-report the create/read contribution with no signal. `null` is the
    // honest "not observable" marker.
    if (tokens == null) return null;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`${label} tokens must be a finite non-negative number or null, got ${JSON.stringify(tokens)}`);
    }
    return tokens;
  };

  const normCreations = Object.freeze(
    primerCacheCreations.map((c, i) => {
      if (c == null || typeof c !== "object" || typeof c.model !== "string" || c.model.length === 0) {
        throw new Error(`primerCacheCreations[${i}] must be an object with a non-empty concrete model`);
      }
      return Object.freeze({
        model: c.model,
        primerForm: c.primerForm ?? null,
        tokens: normalizeTokens(c.tokens, `primerCacheCreations[${i}]`),
      });
    }),
  );
  const normReads = Object.freeze(
    reviewerCacheReads.map((r, i) => {
      if (r == null || typeof r !== "object" || typeof r.model !== "string" || r.model.length === 0) {
        throw new Error(`reviewerCacheReads[${i}] must be an object with a non-empty concrete model`);
      }
      return Object.freeze({
        model: r.model,
        angle: r.angle ?? null,
        tokens: normalizeTokens(r.tokens, `reviewerCacheReads[${i}]`),
      });
    }),
  );

  // Honesty gate (Section D): an opaque / unavailable telemetry harness can never
  // be described as verified 1 write + N reads. cacheReuseVeracity() refuses to
  // claim verified reuse unless usageTelemetry === "available".
  const veracity = cacheReuseVeracity(caps);

  const telemetryAvailable = caps != null && caps.usageTelemetry === "available";
  // Verified reuse requires BOTH the capability truth AND at least one observed
  // creation and one observed read. Without a create then a read for a
  // multi-reviewer group, even a telemetry-capable harness has no measured
  // reuse to report.
  const hasMeasuredSequence =
    normCreations.length > 0 && normReads.length > 0 && telemetryAvailable;
  const cacheReuseVerified = hasMeasuredSequence && veracity.verified;

  const creationsWithTokens = countTokens(normCreations);
  const readsWithTokens = countTokens(normReads);

  const baseReason = cacheReuseVeracity(caps).reason;
  const veracityReason = hasMeasuredSequence
    ? baseReason ?? null
    : (baseReason ?? "no measured create-then-read sequence observed");

  return Object.freeze({
    schemaVersion: CACHE_TELEMETRY_SCHEMA_VERSION,
    gate: plan.gate,
    headSha: String(plan.headSha).trim().toLowerCase(),
    planHash: plan.planHash,
    sharedPrefixHash: plan.sharedPrefixHash ?? null,
    cacheBoundary: plan.requestGroups[0]?.cacheBoundary ?? CACHE_BOUNDARY_AFTER_SHARED_PREFIX,
    capabilities: caps ? Object.freeze({ ...caps }) : null,
    telemetryAvailable,
    cacheReuseVerified,
    veracityReason,
    // "before" side
    primerCacheCreations: normCreations,
    creationCount: normCreations.length,
    creationTokens: sumTokens(normCreations),
    // "after" side
    reviewerCacheReads: normReads,
    readCount: normReads.length,
    readTokens: sumTokens(normReads),
    // aggregate read:create report
    aggregate: Object.freeze({
      creates: normCreations.length,
      reads: normReads.length,
      readToCreateRatio: normCreations.length > 0 ? normReads.length / normCreations.length : 0,
      creationsWithTokens,
      readsWithTokens,
      measured: cacheReuseVerified,
      report:
        cacheReuseVerified
          ? `verified ${normReads.length} cache read${normReads.length === 1 ? "" : "s"} after ${normCreations.length} cache creation${normCreations.length === 1 ? "" : "s"} (measurable read:create = ${normReads.length}:${normCreations.length})`
          : `provider reuse could not be verified (usageTelemetry=${caps?.usageTelemetry ?? "missing"}) — only ordering + request-fingerprint invariants may be claimed`,
    }),
  });
}

/**
 * Fail-closed validation of cache-telemetry evidence (Section D / GATE-EXEC-
 * CACHE-TELEMETRY). The honesty invariant: no code path may describe an opaque
 * harness's behaviour as a verified `1 write + N reads` result.
 *
 * @param {object} input
 * @param {object} input.evidence - artifact from buildCacheTelemetryEvidence().
 * @returns {{ ok: boolean, failures: Array<{check: string, reason: string}> }}
 */
export function validateCacheTelemetryEvidence({ evidence } = {}) {
  const failures = [];
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, failures: [{ check: "artifact", reason: "missing cache-telemetry evidence artifact" }] };
  }

  // Identity fields (gate/headSha/planHash/schemaVersion) must be present and
  // well-formed for the artifact to be accepted — fail closed on a structurally
  // incomplete artifact (missing/dropped identity fields) even when the event
  // arrays and aggregates are internally self-consistent. A hand-edited or
  // truncated artifact carrying none of its round identity is not
  // cache-telemetry evidence for any gate/head and must never be accepted by
  // fan-in as a valid artifact.
  const identityChecks = [
    { field: "gate", valid: (v) => typeof v === "string" && v.trim().length > 0 },
    { field: "headSha", valid: (v) => typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v.trim()) },
    { field: "planHash", valid: (v) => typeof v === "string" && v.trim().length > 0 },
    { field: "schemaVersion", valid: (v) => typeof v === "number" && Number.isInteger(v) },
  ];
  for (const { field, valid } of identityChecks) {
    if (!valid(evidence[field])) {
      failures.push({
        check: "identity_field",
        reason: `cache-telemetry evidence missing or malformed identity field "${field}" (${JSON.stringify(
          evidence[field],
        )}) — a structurally incomplete artifact must fail closed`,
      });
    }
  }

  // Capability record must be present to reason about veracity.
  if (!evidence.capabilities) {
    failures.push({
      check: "capability_record",
      reason: "cache-telemetry evidence has no capability record — provider cache reuse cannot be classified",
    });
  }

  // Events fields must be arrays (a malformed JSON artifact with a non-array
  // events field would otherwise make sumTokens/countTokens below throw a raw
  // TypeError instead of a structured fail-closed failure). Downstream the
  // enforce call re-throws as GATE-EXEC-CACHE-TELEMETRY, but the validator's
  // documented contract is "return failures, never throw".
  if (!Array.isArray(evidence.primerCacheCreations)) {
    failures.push({
      check: "aggregate_consistency",
      reason: `primerCacheCreations must be an array, got ${JSON.stringify(evidence.primerCacheCreations)}`,
    });
  }
  if (!Array.isArray(evidence.reviewerCacheReads)) {
    failures.push({
      check: "aggregate_consistency",
      reason: `reviewerCacheReads must be an array, got ${JSON.stringify(evidence.reviewerCacheReads)}`,
    });
  }
  // Safe, array-only view of the events fields for every downstream consumer
  // (length/sum/count checks). A truthy non-array field never reaches
  // sumTokens/countTokens (`.reduce`/`.filter` would throw on it) and its
  // `.length` is never read (a string would report its char count): the
  // validator keeps its documented "return failures, never throw" contract
  // even for an malformed artifact whose events field is a string/object/number.
  const creations = Array.isArray(evidence.primerCacheCreations)
    ? evidence.primerCacheCreations
    : [];
  const reads = Array.isArray(evidence.reviewerCacheReads) ? evidence.reviewerCacheReads : [];

  // Honesty gate: verified reuse requires the capability record's usage
  // telemetry to be available. The verdict is re-derived from
  // evidence.capabilities.usageTelemetry — NOT from the stored
  // evidence.telemetryAvailable boolean — so a hand-edited / forged artifact
  // that flips BOTH cacheReuseVerified AND telemetryAvailable to true still
  // fails closed (the capability record is the source of truth). The builder
  // always normalizes capabilities (usageTelemetry included), so this is
  // re-derivable here.
  const derivedTelemetryAvailable =
    evidence.capabilities != null && evidence.capabilities.usageTelemetry === "available";
  if (evidence.cacheReuseVerified && !derivedTelemetryAvailable) {
    failures.push({
      check: "opaque_veracity",
      reason: `cacheReuseVerified=true but usageTelemetry=${evidence.capabilities?.usageTelemetry ?? "missing"} — an opaque/unavailable harness must never claim verified provider reuse`,
    });
  }

  // Verified reuse requires a measured create-then-read sequence (at least one
  // creation and at least one read for a group). A claim of verified reuse with
  // no measured sequence is not derived from evidence.
  if (evidence.cacheReuseVerified) {
    if (!(evidence.creationCount > 0 && evidence.readCount > 0)) {
      failures.push({
        check: "measured_sequence",
        reason: `cacheReuseVerified=true but no measured create-then-read sequence (creations=${evidence.creationCount}, reads=${evidence.readCount})`,
      });
    }
  }

  // Self-consistency of the aggregate report against the recorded events.
  if (evidence.creationCount !== creations.length) {
    failures.push({
      check: "aggregate_consistency",
      reason: `creationCount ${evidence.creationCount} != recorded primerCacheCreations.length ${creations.length}`,
    });
  }
  if (evidence.readCount !== reads.length) {
    failures.push({
      check: "aggregate_consistency",
      reason: `readCount ${evidence.readCount} != recorded reviewerCacheReads.length ${reads.length}`,
    });
  }

  // Token aggregates must equal the sum over finite event tokens.
  const expectedCreationTokens = sumTokens(creations);
  if (evidence.creationTokens !== expectedCreationTokens) {
    failures.push({
      check: "token_aggregate",
      reason: `creationTokens ${evidence.creationTokens} != sum of primer creations ${expectedCreationTokens}`,
    });
  }
  const expectedReadTokens = sumTokens(reads);
  if (evidence.readTokens !== expectedReadTokens) {
    failures.push({
      check: "token_aggregate",
      reason: `readTokens ${evidence.readTokens} != sum of reviewer reads ${expectedReadTokens}`,
    });
  }

  // Aggregate reads/creates must mirror the counts, and every derived aggregate
  // value (readToCreateRatio, creationsWithTokens, readsWithTokens, measured)
  // must be re-derivable from the recorded events — a forged / hand-edited
  // aggregate that contradicts the evidence fails closed.
  const record = { creates: evidence.creationCount, reads: evidence.readCount };
  const expectedRatio = record.creates > 0 ? record.reads / record.creates : 0;
  // The human-readable report must agree with the machine verdict: a verified
  // report only when cacheReuseVerified is true, a could-not-verify report
  // otherwise. This closes the over-claim surface where a hand-edited artifact
  // keeps the numeric aggregates consistent (measured:false) while the report
  // prose claims "verified N reads after M creations" (informational, not a
  // gate-number bypass, but the human-facing surface must not contradict it).
  const expectedReportVerified = /^verified .+ cache read/.test(evidence.aggregate?.report ?? "");
  if (expectedReportVerified !== evidence.cacheReuseVerified) {
    failures.push({
      check: "aggregate_consistency",
      reason: `aggregate.report prose (${JSON.stringify(evidence.aggregate?.report)}) contradicts cacheReuseVerified=${evidence.cacheReuseVerified}`,
    });
  }
  if (
    evidence.aggregate?.creates !== evidence.creationCount ||
    evidence.aggregate?.reads !== evidence.readCount ||
    evidence.aggregate?.readToCreateRatio !== expectedRatio ||
    evidence.aggregate?.creationsWithTokens !== countTokens(creations) ||
    evidence.aggregate?.readsWithTokens !== countTokens(reads) ||
    evidence.aggregate?.measured !== evidence.cacheReuseVerified
  ) {
    failures.push({
      check: "aggregate_consistency",
      reason: `aggregate report does not mirror the recorded events (creates=${evidence.aggregate?.creates}, reads=${evidence.aggregate?.reads}, readToCreateRatio=${evidence.aggregate?.readToCreateRatio}, creationsWithTokens=${evidence.aggregate?.creationsWithTokens}, readsWithTokens=${evidence.aggregate?.readsWithTokens}, measured=${evidence.aggregate?.measured}); expected creates=${record.creates}, reads=${record.reads}, ratio=${expectedRatio}, creationsWithTokens=${countTokens(creations)}, readsWithTokens=${countTokens(reads)}, measured=${evidence.cacheReuseVerified}`,
    });
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Strict fail-closed enforcement surface (GATE-EXEC-CACHE-TELEMETRY): throws
 * when cache-telemetry evidence is missing or invalid, naming the failing check.
 * This is the refusal path a gate conductor calls after
 * validateCacheTelemetryEvidence returns ok:false — it turns a reported failure
 * into a hard stop.
 *
 * @param {object} input
 * @param {object} input.evidence - artifact from buildCacheTelemetryEvidence().
 * @returns {true}
 * @throws {Error} when any cache-telemetry check fails.
 */
export function enforceCacheTelemetryEvidence({ evidence } = {}) {
  const r = validateCacheTelemetryEvidence({ evidence });
  if (!r.ok) {
    throw new Error(
      `GATE-EXEC-CACHE-TELEMETRY: cache-telemetry evidence failed validation; refusing to proceed (${r.failures.map((f) => `${f.check}: ${f.reason}`).join("; ")})`,
    );
  }
  return true;
}

/**
 * Persist the evidence artifact to its deterministic path.
 *
 * @param {object} input
 * @param {string} input.dir
 * @param {object} input.evidence
 * @returns {Promise<{ path: string }>}
 */
export async function writeCacheTelemetryEvidence({ dir, evidence } = {}) {
  const target = cacheTelemetryPath({
    dir,
    gate: evidence.gate,
    headSha: evidence.headSha,
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { path: target };
}
