/**
 * gate-fanin.mjs — pure fan-in consolidation + cap/batch planning for the
 * gate-review fork sub-loop (epic #867, Phase 3 / #878).
 *
 * IMPORTANT: this module is PURE. It performs no I/O and never spawns agents.
 * Spawning the per-angle scoped `review` subagents is an agent-orchestrated
 * skill procedure (a node script cannot spawn Claude subagents). This module
 * only consolidates the structured per-angle findings artifacts the fan-out
 * produced, decides the gate verdict, plans the parallel/sequential batching of
 * the fan-out, and maps consolidated findings into the `--findings` JSON shape
 * understood by scripts/github/write-gate-findings-log.mjs.
 *
 * Per-angle review artifact shape (produced by the scoped `review` agent):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present",
 *     headSha: string,   // reviewed head; consolidate-fanin --head-sha enforces it (GATE-EXEC-ARTIFACT-HEAD-STAMP)
 *     findings: [{ severity, file?, line?, summary, recommendation? }]
 *   }
 *
 * Severity vocabulary (owned here; consumers import SEVERITY_ORDER /
 * VALID_SEVERITIES / normalizeSeverity):
 *   "must-fix" | "worth-fixing-now" | "nice-to-have"
 * Severity is the reviewer's advisory weight only. Deferral is a DISPOSITION
 * (derived at fan-in for non-blocking findings, finalized per thread by the
 * fix cycle / gate close), never a severity — the legacy severity spelling
 * "defer" is accepted on read and normalized to "nice-to-have" (see
 * LEGACY_SEVERITY_ALIASES / normalizeSeverity).
 */

import { scheduleParallelWaves } from "./queue-parallel.mjs";

/**
 * Schedule fan-out dispatch units into bounded-concurrency waves (issue #1601).
 *
 * Reuses the existing wave scheduler `scheduleParallelWaves`
 * (packages/core/src/loop/queue-parallel.mjs, originally the queue-mode parallel
 * scheduler): each wave holds at most `maxConcurrent` dispatch units, and the
 * conductor dispatches wave-by-wave — awaiting a free slot (wave completion)
 * before launching the next — instead of fire-all-then-retry. This replaces
 * the unbounded concurrent fan-out that 429-stormed multi-angle gate rounds
 * (issue #1588 drive: 5–6 reviewers 429'd per round).
 *
 * Pure: same input always yields the same wave plan (deterministic order, so
 * the wave plan a reviewer's gate-context artifact records is byte-stable
 * across fresh reviewer spawns for the same head+config).
 *
 * @param {{ name: string, angles: string[] }[]} dispatchGroups — `resolveFanoutGroups` output
 * @param {number} [maxConcurrent] — `gates.fanout.maxConcurrent` (default 4, min 1)
 * @returns {{ name: string, angles: string[] }[][]} waves of dispatch units (at most `maxConcurrent` per wave)
 */
export function scheduleFanoutWaves(dispatchGroups, maxConcurrent = 4) {
  const groups = Array.isArray(dispatchGroups) ? dispatchGroups : [];
  const cap = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 4;
  if (groups.length === 0) return [];
  return scheduleParallelWaves(groups, cap);
}

/**
 * Adaptive 429-backoff concurrency (issue #1601): halve the active batch before
 * escalating to foreground one-at-a-time fallback. On a 429, the conductor
 * recomputes the wave plan with `backoffMaxConcurrent(maxConcurrent)` and
 * retries the failed wave; if a single-unit wave still 429s, it falls back to
 * foreground (one-at-a-time) dispatch. The backoff is recorded in the round's
 * provenance (see skills/docs/gate-review-sub-loop-contract.md). Pure; never
 * returns 0 (a backoff from 1 stays 1 → foreground fallback owns that path).
 * @param {number} maxConcurrent
 * @returns {number}
 */
export function backoffMaxConcurrent(maxConcurrent) {
  const cap = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 4;
  return Math.max(1, Math.floor(cap / 2));
}

// Exported so other tools (e.g. scripts/loop/consolidate-fanin.mjs,
// scripts/github/upsert-checkpoint-verdict.mjs) sort/rank/validate against
// this single ordered copy of the severity vocabulary instead of each
// hand-copying its own list (and its own load-time drift guard) — ORDER is
// part of the contract here (most blocking first), not just membership, so a
// consumer that only checked membership against a Set could accept a
// silently reordered copy.
export const SEVERITY_ORDER = ["must-fix", "worth-fixing-now", "nice-to-have"];

// Marker gate name → gates.<key> config key. Owned here so every caller of
// resolveFanoutGroups maps the same way; passing the marker name verbatim
// resolves no groups and silently downgrades pairing enforcement.
export const GATE_CONFIG_KEY = Object.freeze({ draft_gate: "draft", pre_approval_gate: "preApproval" });
export const VALID_SEVERITIES = new Set(SEVERITY_ORDER);

// Pre-rename spelling of the lowest tier. Old ledgers, markers, and configs
// still carry it; every read boundary normalizes through this map and no
// writer ever emits it again.
export const LEGACY_SEVERITY_ALIASES = Object.freeze({ defer: "nice-to-have" });

/**
 * Map a legacy severity spelling to its canonical name; unknown values pass
 * through unchanged (the caller's validation still rejects them).
 * @param {unknown} severity
 * @returns {unknown}
 */
export function normalizeSeverity(severity) {
  return typeof severity === "string" && Object.hasOwn(LEGACY_SEVERITY_ALIASES, severity)
    ? LEGACY_SEVERITY_ALIASES[severity]
    : severity;
}

/**
 * Merge a severity→count map's legacy-spelled keys into their canonical keys
 * (summing counts) so both the CLI parser and direct programmatic callers of
 * the verdict poster share ONE merge rule. Values pass through unvalidated —
 * the caller keeps its own integer/shape checks.
 * @param {Record<string, number>} counts
 * @returns {Record<string, number>} null-prototype object with canonical keys
 */
export function normalizeSeverityCounts(counts) {
  const normalized = Object.create(null);
  for (const [key, value] of Object.entries(counts)) {
    const canonicalKey = /** @type {string} */ (normalizeSeverity(key));
    normalized[canonicalKey] = (normalized[canonicalKey] ?? 0) + value;
  }
  return normalized;
}
const VALID_VERDICTS = new Set(["clean", "findings_present"]);

/**
 * Canonical fail-closed signal for when a child/agent cannot perform real
 * parallel fan-out (e.g. the harness does not honor the subagent tool at child
 * depth). The flow MUST fail closed with this message and route the gate review
 * to the conductor rather than silently degrading to a single-agent inline
 * review (which requireFanoutProvenance is designed to reject). Documented as a
 * contract in skills/docs/gate-review-sub-loop-contract.md.
 */
export const FANOUT_UNAVAILABLE_MESSAGE = "fan-out unavailable — route to conductor";

/**
 * Build a fail-closed Error carrying the route-to-conductor contract signal.
 * Callers throw this (or check `.routeToConductor === true`) when real fan-out
 * cannot be performed. `detail` is appended for diagnostics but the stable,
 * matchable prefix is always {@link FANOUT_UNAVAILABLE_MESSAGE}.
 *
 * @param {string} [detail] — optional diagnostic suffix (e.g. why fan-out failed)
 * @returns {Error & { routeToConductor: true, code: "FANOUT_UNAVAILABLE" }}
 */
export function fanoutUnavailableError(detail) {
  const suffix = typeof detail === "string" && detail.trim().length > 0 ? ` (${detail.trim()})` : "";
  const error = new Error(`${FANOUT_UNAVAILABLE_MESSAGE}${suffix}`);
  return Object.assign(error, { routeToConductor: /** @type {const} */ (true), code: /** @type {const} */ ("FANOUT_UNAVAILABLE") });
}

/**
 * Count DISTINCT reviewer identities actually recorded in a `perAngle` array.
 * An entry contributes an identity via `reviewer` (preferred) or `dispatchId`;
 * entries carrying neither are not countable reviewers (a bare `{angle}` proves
 * nothing about who reviewed it). Pure.
 *
 * @param {unknown} perAngle
 * @returns {number}
 */
export function countDistinctReviewers(perAngle) {
  if (!Array.isArray(perAngle)) return 0;
  const ids = new Set();
  for (const e of perAngle) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const identity = reviewerIdentity(e);
    if (identity) ids.add(identity.id);
  }
  return ids.size;
}

/**
 * The single identity-selection rule for a perAngle entry: a non-empty
 * `reviewer` wins, else a non-empty `dispatchId`, else no identity. Returns
 * `{ id, label }` (label = which field carried the identity, for error
 * messages) or null. Shared by countDistinctReviewers and
 * fanoutReviewerPairingError so the two can never diverge.
 *
 * @param {object} entry — a perAngle entry
 * @returns {{ id: string, label: "reviewer"|"dispatchId" }|null}
 */
function reviewerIdentity(entry) {
  if (typeof entry.reviewer === "string" && entry.reviewer.trim().length > 0) {
    return { id: entry.reviewer.trim(), label: "reviewer" };
  }
  if (typeof entry.dispatchId === "string" && entry.dispatchId.trim().length > 0) {
    return { id: entry.dispatchId.trim(), label: "dispatchId" };
  }
  return null;
}

/**
 * Validate INTERNAL CONSISTENCY of a fan-out provenance object. Returns an error
 * string when the provenance is malformed or self-inconsistent, or null when it
 * is well-formed and consistent. Shared by the write path (write-gate-findings-log)
 * and the enforcement read path (buildPreMergeGateCheck) so both agree.
 *
 * Consistency rule (documented in skills/docs/gate-review-sub-loop-contract.md):
 *   - `distinctReviewers` must be a non-negative integer.
 *   - `perAngle` must be an array, and non-empty when `distinctReviewers > 0`.
 *   - `distinctReviewers` must be <= the count of DISTINCT reviewer identities
 *     actually recorded in `perAngle` — you cannot claim more reviewers than you
 *     recorded dispatch entries for.
 *
 * HONEST CAVEAT: this makes recorded provenance internally consistent and raises
 * the bar, but the provenance is self-reported (written by the same agent whose
 * independence it claims), so it remains forgeable by a determined single agent.
 * Un-forgeable recording is the Pi-harness bridge (subagent tool at child depth).
 *
 * @param {unknown} prov
 * @returns {string|null}
 */
export function provenanceConsistencyError(prov) {
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) {
    return "provenance must be an object";
  }
  const p = /** @type {Record<string, unknown>} */ (prov);
  if (!Number.isInteger(p.distinctReviewers) || /** @type {number} */ (p.distinctReviewers) < 0) {
    return "provenance.distinctReviewers must be a non-negative integer";
  }
  if (!Array.isArray(p.perAngle)) {
    return "provenance.perAngle must be an array";
  }
  const claimed = /** @type {number} */ (p.distinctReviewers);
  if (claimed > 0 && p.perAngle.length === 0) {
    return "provenance.perAngle must be non-empty when distinctReviewers > 0";
  }
  const recorded = countDistinctReviewers(p.perAngle);
  if (claimed > recorded) {
    return `provenance.distinctReviewers (${claimed}) exceeds distinct recorded reviewer identities (${recorded})`;
  }
  return null;
}

/**
 * Yield `{ entry, angle, group }` for each "fresh" entry in a `perAngle`
 * array — a valid object entry naming a non-blank `angle` and carrying no
 * `carriedFromHead` (a carried angle's clean verdict was reused from a prior
 * head's review, see @dev-loops/core/loop/gate-carry-forward, not freshly
 * reviewed here). `group` is the entry's normalized, non-blank `group`
 * string, or `null`. This is the ONE definition of "fresh" and "declared
 * group" — {@link freshAngleNames}, {@link countFreshDispatchUnits}, and
 * {@link fanoutReviewerPairingError} all derive from it so the write-time
 * floor and the pairing check can never silently drift apart on what either
 * term means. Pure.
 * @param {unknown} perAngle
 * @returns {Generator<{ entry: object, angle: string, group: string|null }>}
 */
function* freshEntries(perAngle) {
  if (!Array.isArray(perAngle)) return;
  for (const entry of perAngle) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.carriedFromHead === "string" && entry.carriedFromHead.trim().length > 0) continue;
    const angle = typeof entry.angle === "string" ? entry.angle.trim() : "";
    if (!angle) continue;
    const group = typeof entry.group === "string" && entry.group.trim().length > 0 ? entry.group.trim() : null;
    yield { entry, angle, group };
  }
}

/**
 * Names of DISTINCT "fresh" angles in a `perAngle` array — see
 * {@link freshEntries}. Used by callers that need the names themselves (e.g.
 * resolving this round's dispatch groups via `resolveFanoutGroups` for
 * {@link fanoutReviewerPairingError}'s cross-check). Pure.
 *
 * @param {unknown} perAngle
 * @returns {string[]}
 */
export function freshAngleNames(perAngle) {
  const angles = new Set();
  for (const { angle } of freshEntries(perAngle)) angles.add(angle);
  return [...angles];
}

/**
 * Count distinct FRESH dispatch units in a `perAngle` array: a fresh angle
 * that declares a `group` counts once per DISTINCT group name (its whole
 * group is one reviewer's dispatch), and a fresh angle with no `group`
 * counts as its own dispatch unit (today's one-reviewer-per-angle shape).
 * This is the grouping-aware generalization of counting distinct fresh
 * angle names via {@link freshAngleNames} — for an ungrouped ledger the two
 * are identical; for a grouped ledger this is <= the ungrouped count, since
 * one group of N angles is one dispatch unit, not N. Shared by the write
 * path (write-gate-findings-log.mjs) and the
 * requireFanoutProvenance read path (detect-checkpoint-evidence.mjs) so the
 * `distinctReviewers` floor scales with what was actually DISPATCHED, not
 * with the angle count a grouped round deliberately dispatches fewer
 * reviewers than. Pure.
 *
 * @param {unknown} perAngle
 * @returns {number}
 */
export function countFreshDispatchUnits(perAngle) {
  const groups = new Set();
  const ungroupedAngles = new Set();
  for (const { angle, group } of freshEntries(perAngle)) {
    if (group) groups.add(group);
    else ungroupedAngles.add(angle);
  }
  return groups.size + ungroupedAngles.size;
}

/**
 * Validate the one-scoped-reviewer-per-fresh-angle contract (fanout_fanin
 * execution mandates one independent reviewer per resolved angle; #1431): no
 * two FRESH angles (angles without `carriedFromHead` — see
 * {@link freshEntries}) may share one reviewer identity (`reviewer`,
 * else `dispatchId` — matching {@link countDistinctReviewers}'s identity
 * rule), UNLESS every entry sharing that identity declares the SAME `group`
 * name (grouped fan-out dispatch, AC6/AC7 — see resolveFanoutGroups). The
 * recorded `group` is self-attested at write time; when `resolvedGroups` is
 * supplied (both call sites always supply it) it is also checked against
 * the CURRENT `gates.fanout.groups` table, so an edit to that table between
 * the round and a later read (e.g. a merge-evidence check) can invalidate a
 * ledger's group claim that was honest when written — see the
 * `resolvedGroups` paragraph below. Two
 * fresh angles sharing a reviewer with differing or missing `group` values
 * still violate the contract. Carried angles keep their prior reviewer and
 * are exempt. Pure; shared by the write path (write-gate-findings-log.mjs,
 * always-on) and the merge-evidence read path (detect-checkpoint-evidence.mjs,
 * scaling the `requireFanoutProvenance` floor) so both agree.
 *
 * Returns an actionable error string naming the offending angle(s) when the
 * contract is violated (an ungrouped reviewer covering >1 fresh angle, angles
 * sharing a reviewer under inconsistent `group` values, or a fresh angle
 * recording no reviewer identity at all — which also silently lowers the
 * distinct-reviewer count below the fresh-angle count), or `null` when it
 * holds (including when `perAngle` has no fresh angles).
 *
 * The recorded `group` is self-attested (any non-empty string the writer
 * chooses), so the grouped exception above is only as strong as the caller
 * lets it be. An optional `resolvedGroups` (the round's `resolveFanoutGroups`
 * output, `{ name, angles }[]`) closes that: a shared identity is only
 * honored when every fresh angle it covers is a member of the SAME
 * configured dispatch unit — a fabricated `group` label spanning angles the
 * table splits apart (or never groups at all) no longer passes.
 * `resolveFanoutGroups` itself emits one-angle-per-unit singletons for
 * `gates.fanout.mode: per-angle` (bypasses configured groups), so passing its
 * output here rejects ANY shared identity in that mode — no separate mode flag
 * needed. As of #1601 (ADR 0048) `gate:full` dispatches GROUPED (fullLabel is a
 * no-op for dispatch shape), so a shared identity within an auto-chunked
 * dispatch unit is honored exactly as for a configured group.
 * Omitting `resolvedGroups` entirely keeps today's fully permissive behavior (any one
 * shared non-null `group` value is accepted, unchecked against config) — both
 * call sites already load config, so they should always supply it; this
 * default only preserves callers (and old ledgers) that don't.
 *
 * @param {unknown} perAngle
 * @param {{name: string, angles: string[]}[]|null} [resolvedGroups]
 * @returns {string|null}
 */
export function fanoutReviewerPairingError(perAngle, resolvedGroups = null) {
  if (!Array.isArray(perAngle)) return null;
  const configuredGroupOf = new Map();
  for (const g of Array.isArray(resolvedGroups) ? resolvedGroups : []) {
    for (const a of Array.isArray(g?.angles) ? g.angles : []) configuredGroupOf.set(a, g.name);
  }
  const freshAngles = new Set();
  const anglesByIdentity = new Map();
  const anonymousAngles = [];
  for (const { entry, angle, group } of freshEntries(perAngle)) {
    freshAngles.add(angle);
    const identity = reviewerIdentity(entry);
    if (identity) {
      if (!anglesByIdentity.has(identity.id)) anglesByIdentity.set(identity.id, { angles: new Set(), label: identity.label, groups: new Set() });
      const record = anglesByIdentity.get(identity.id);
      record.angles.add(angle);
      record.groups.add(group);
    } else {
      anonymousAngles.push(angle);
    }
  }
  const freshAngleCount = freshAngles.size;
  const distinctFreshReviewers = anglesByIdentity.size;
  // Enforce the relation itself, not its cardinality shadow: a padded ledger
  // (duplicate-angle entries) can satisfy distinctReviewers >= freshAngleCount
  // while one identity still covers two fresh angles.
  const details = [];
  for (const [id, { angles, label, groups }] of anglesByIdentity) {
    if (angles.size <= 1) continue;
    // One shared, non-null `group` across every entry for this identity is
    // the grouped-dispatch exception: a single reviewer legitimately covers
    // its whole declared group. Differing or missing `group` values fall
    // back to the one-reviewer-per-angle rule.
    const sameGroup = groups.size === 1 && [...groups][0] !== null;
    if (!sameGroup) {
      details.push(`${label} "${id}" is recorded for fresh angles: ${[...angles].join(", ")}`);
      continue;
    }
    // resolvedGroups supplied: the claimed group is only honest when every
    // angle it covers is a member of the SAME configured group — a claimed
    // group spanning angles the table splits apart (or never groups) fails
    // closed even though the audit record itself is internally consistent.
    if (configuredGroupOf.size > 0) {
      const configuredGroups = new Set([...angles].map((a) => configuredGroupOf.get(a) ?? null));
      if (configuredGroups.size !== 1 || configuredGroups.has(null)) {
        details.push(`${label} "${id}" declares group "${[...groups][0]}" for fresh angles: ${[...angles].join(", ")}, but the configured gates.fanout.groups table does not place all of them in one group`);
      }
    }
  }
  if (anonymousAngles.length > 0) {
    details.push(`fresh angle(s) with no recorded reviewer identity: ${anonymousAngles.join(", ")}`);
  }
  if (details.length === 0) return null;
  return `fan-out provenance violates the one-scoped-reviewer-per-angle contract (${distinctFreshReviewers} distinct reviewer(s) for ${freshAngleCount} fresh angle(s)): ${details.join("; ")} — use executionMode inline_single_agent + --inline-reason for a sanctioned single-reviewer run`;
}

/**
 * Base angle name for a delta-suffixed re-review entry (`<angle>-delta-at-...`,
 * e.g. `pr-checklist-matrix-delta-at-current-head`): a re-review scoped to only
 * the current head's delta still counts toward its base angle for both
 * mandatory-angle coverage and pool-membership checks.
 *
 * @param {string} angle
 * @returns {string}
 */
export function baseAngleName(angle) {
  return angle.replace(/-delta-at-.+$/, "");
}

/**
 * Validate a recorded fan-out angle list against a gate's configured angle
 * contract: every mandatory angle must be represented, and — when a pool is
 * supplied — every recorded angle must be a member of it or of
 * {@link FANIN_SYNTHETIC_ANGLES} (delta-suffixed angles count toward their
 * {@link baseAngleName}). Pure; shared by the write
 * path (write-gate-findings-log's `provenance.perAngle`, upsert-checkpoint-verdict's
 * `--findings-json` per-angle results) and the merge-evidence read path
 * (detect-checkpoint-evidence re-validating the ledger's `provenance.perAngle`)
 * so all three enforce identically.
 *
 * @param {unknown} recordedAngles — array of `{ angle: string, ... }` entries (provenance.perAngle or normalized per-angle findings)
 * @param {object} [gateAngleContract]
 * @param {string[]} [gateAngleContract.mandatoryAngles] — angles that must always be represented
 * @param {string[]|null} [gateAngleContract.pool] — configured angle pool; null/omitted/empty skips the foreign-angle check; {@link FANIN_SYNTHETIC_ANGLES} are unioned in before membership is checked
 * @returns {{ missingMandatory: string[], foreignAngles: string[] }}
 */
export function checkFanoutAngleCoverage(recordedAngles, { mandatoryAngles = [], pool = null } = {}) {
  const recorded = Array.isArray(recordedAngles)
    ? recordedAngles
      .map((e) => (e && typeof e === "object" && typeof e.angle === "string" ? e.angle.trim() : ""))
      .filter((a) => a.length > 0)
    : [];
  const recordedBases = new Set(recorded.map(baseAngleName));
  const missingMandatory = mandatoryAngles.filter((a) => !recordedBases.has(a));
  let foreignAngles = [];
  if (Array.isArray(pool) && pool.length > 0) {
    const poolSet = new Set([...pool, ...FANIN_SYNTHETIC_ANGLES]);
    foreignAngles = [...new Set(recorded.filter((a) => !poolSet.has(baseAngleName(a))))];
  }
  return { missingMandatory, foreignAngles };
}

/**
 * Angles the fan-in itself mandates and may synthesize (consolidate-fanin's
 * `--pr-checklist-matrix clean` upsert) without them appearing in any gate's
 * configured `angles` pool. Always legal in the foreign-angle check above —
 * requiring every consumer repo to also list them per-gate would make the two
 * tools contradict the shared contract they implement.
 */
export const FANIN_SYNTHETIC_ANGLES = Object.freeze(["pr-checklist-matrix"]);

/**
 * Default cap on parallel fan-out reviewers when a caller does not supply one.
 * Mirrors the config default (gates.maxFanoutReviewers).
 */
export const DEFAULT_MAX_FANOUT_REVIEWERS = 8;

// Every sanctioned angle name is a short, hand-authored slug (e.g.
// "contradiction-lens", "pr-checklist-matrix"); nothing legitimate ever
// approaches this length. Bounding it here, at the trust boundary this
// function already owns, fails a pathological artifact closed as malformed —
// the same place every other angle-result defect is caught — instead of
// leaving an unbounded reviewer-supplied string to reach the render path,
// where consolidate-fanin.mjs's per-angle budget marking cannot compress it.
// This is a malformed-artifact guard, not a comment-budget guarantee: several
// angles each right at this cap can still exceed the render budget on their
// headers alone and force the withheld tier — that outcome is the render
// budget's degradation ladder doing its job, not something this cap prevents.
const MAX_ANGLE_NAME_LENGTH = 200;

/**
 * Validate a single per-angle review result. Returns an error string when the
 * result is malformed, or null when it is well-formed.
 *
 * @param {unknown} result
 * @returns {string|null}
 */
function validateAngleResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "angle result must be an object";
  }
  const r = /** @type {Record<string, unknown>} */ (result);
  if (typeof r.angle !== "string" || r.angle.trim().length === 0) {
    return "angle result is missing a non-empty 'angle'";
  }
  if (r.angle.trim().length > MAX_ANGLE_NAME_LENGTH) {
    return `angle result's 'angle' exceeds ${MAX_ANGLE_NAME_LENGTH} chars`;
  }
  if (typeof r.verdict !== "string" || !VALID_VERDICTS.has(r.verdict)) {
    return `angle '${r.angle}' has invalid verdict (expected clean|findings_present)`;
  }
  if (!Array.isArray(r.findings)) {
    return `angle '${r.angle}' is missing a 'findings' array`;
  }
  for (const f of r.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      return `angle '${r.angle}' has a non-object finding`;
    }
    const finding = /** @type {Record<string, unknown>} */ (f);
    if (typeof finding.severity !== "string" || !VALID_SEVERITIES.has(normalizeSeverity(finding.severity))) {
      return `angle '${r.angle}' has a finding with invalid severity (expected must-fix|worth-fixing-now|nice-to-have)`;
    }
    if (typeof finding.summary !== "string" || finding.summary.trim().length === 0) {
      return `angle '${r.angle}' has a finding without a summary`;
    }
  }
  // findings_present must carry at least one finding; clean must carry none.
  if (r.verdict === "findings_present" && r.findings.length === 0) {
    return `angle '${r.angle}' reported findings_present but has no findings`;
  }
  if (r.verdict === "clean" && r.findings.length > 0) {
    return `angle '${r.angle}' reported clean but carries findings`;
  }
  return null;
}

/**
 * Consolidate the parallel per-angle review results into one gate verdict +
 * a merged, flattened findings list. Pure.
 *
 * Verdict rules:
 *   - "blocked": any angle result is malformed/missing (the gate could not
 *     produce a trustworthy verdict).
 *   - "clean": all results valid AND no finding carries a severity present in
 *     `blockCleanOnFindingSeverities`.
 *   - "findings_present": all results valid AND at least one finding carries a
 *     blocking severity.
 *
 * @param {object} input
 * @param {Array<unknown>} input.angleResults — per-angle review artifacts
 * @param {string[]} [input.blockCleanOnFindingSeverities] — blocking severities (default ["must-fix"])
 * @returns {{
 *   verdict: "clean"|"findings_present"|"blocked",
 *   findings: Array<{severity: string, angle: string, summary: string, file?: string, line?: number, recommendation?: string, disposition: string}>,
 *   counts: { angles: number, findings: number, blocking: number, bySeverity: Record<string, number> },
 *   malformed: Array<{ index: number, reason: string }>
 * }}
 */
export function consolidateFanin({ angleResults, blockCleanOnFindingSeverities } = {}) {
  const results = Array.isArray(angleResults) ? angleResults : [];
  // Config values normalize through the same alias map as finding severities,
  // so a legacy config spelling ("defer") still blocks the renamed tier.
  const blocking = new Set(
    (Array.isArray(blockCleanOnFindingSeverities) && blockCleanOnFindingSeverities.length > 0
      ? blockCleanOnFindingSeverities
      : ["must-fix"]
    ).map((s) => normalizeSeverity(s)),
  );

  const malformed = [];
  results.forEach((r, index) => {
    const err = validateAngleResult(r);
    if (err) malformed.push({ index, reason: err });
  });

  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  /** @type {Array<{severity: string, angle: string, summary: string, file?: string, line?: number, recommendation?: string, disposition: string}>} */
  const findings = [];
  let blockingCount = 0;

  if (malformed.length === 0) {
    for (const r of results) {
      const angle = r.angle.trim();
      for (const f of r.findings) {
        const severity = /** @type {string} */ (normalizeSeverity(f.severity));
        const isBlocking = blocking.has(severity);
        if (isBlocking) blockingCount += 1;
        bySeverity[severity] += 1;
        const entry = {
          severity,
          angle,
          summary: String(f.summary).trim(),
          // Blocking findings default to accepted-for-fix; non-blocking default
          // to deferred. The fix cycle / operator can override the disposition.
          disposition: isBlocking ? "accepted-for-fix" : "deferred",
        };
        if (typeof f.file === "string" && f.file.trim().length > 0) entry.file = f.file.trim();
        if (typeof f.line === "number" && Number.isFinite(f.line)) entry.line = f.line;
        if (typeof f.recommendation === "string" && f.recommendation.trim().length > 0) {
          entry.recommendation = f.recommendation.trim();
        }
        findings.push(entry);
      }
    }
  }

  let verdict;
  if (malformed.length > 0) {
    verdict = "blocked";
  } else if (blockingCount > 0) {
    verdict = "findings_present";
  } else {
    verdict = "clean";
  }

  return {
    verdict,
    findings,
    counts: {
      angles: results.length,
      findings: findings.length,
      blocking: blockingCount,
      bySeverity,
    },
    malformed,
  };
}

/**
 * Map consolidated findings into the `--findings` JSON shape consumed by
 * scripts/github/write-gate-findings-log.mjs (severity, angle, summary,
 * disposition, optional files, optional line). Pure.
 *
 * @param {Array<{severity: string, angle: string, summary: string, file?: string, disposition?: string, recommendation?: string, line?: number}>} findings
 * @returns {Array<{severity: string, angle: string, summary: string, disposition?: string, files?: string[], recommendation?: string, line?: number}>}
 */
export function toFindingsLogShape(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return list.map((f) => {
    const entry = {
      severity: f.severity,
      angle: f.angle,
      summary: f.summary,
    };
    if (typeof f.disposition === "string" && f.disposition.trim().length > 0) {
      entry.disposition = f.disposition.trim();
    }
    if (typeof f.recommendation === "string" && f.recommendation.trim().length > 0) {
      entry.recommendation = f.recommendation.trim();
    }
    if (typeof f.file === "string" && f.file.trim().length > 0) {
      entry.files = [f.file.trim()];
    } else if (Array.isArray(f.files)) {
      const files = f.files.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
      if (files.length > 0) entry.files = files;
    }
    if (Number.isInteger(f.line) && f.line > 0) {
      entry.line = f.line;
    }
    return entry;
  });
}

/**
 * Plan how a resolved angle set fans out across the reviewer cap. Pure.
 *
 * SUPERSEDED by `scheduleFanoutWaves` (#1601, ADR 0048): the gate fan-out
 * conductor now dispatches wave-by-wave at most `gates.fanout.maxConcurrent`
 * (M) dispatch units per wave, using the wave plan emitted by
 * `write-gate-context.mjs`. This helper is kept only for back-compat (zero
 * non-test callers) and no longer participates in the dispatch path.
 *
 * When `angles.length <= maxReviewers`, all reviewers run in a single parallel
 * batch (no degradation). When it exceeds the cap, the overflow is split into
 * sequential batches of at most `maxReviewers` each, and `degraded` is true so
 * the skill can record the sequential degradation in the gate evidence.
 *
 * @param {string[]} angles
 * @param {number} [maxReviewers] — default DEFAULT_MAX_FANOUT_REVIEWERS (8)
 * @returns {{ batches: string[][], degraded: boolean }}
 */
export function planFanoutBatches(angles, maxReviewers = DEFAULT_MAX_FANOUT_REVIEWERS) {
  const list = Array.isArray(angles)
    ? angles.filter((a) => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())
    : [];
  const cap = Number.isInteger(maxReviewers) && maxReviewers > 0
    ? maxReviewers
    : DEFAULT_MAX_FANOUT_REVIEWERS;

  if (list.length === 0) {
    return { batches: [], degraded: false };
  }

  const batches = [];
  for (let i = 0; i < list.length; i += cap) {
    batches.push(list.slice(i, i + cap));
  }
  return { batches, degraded: batches.length > 1 };
}
