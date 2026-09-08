/**
 * gate-fanin.mjs — pure fan-in consolidation + cap/batch planning for the
 * gate-review fork sub-loop.
 *
 * PURE: no I/O, never spawns agents. It consolidates the per-angle findings
 * artifacts the fan-out produced, decides the gate verdict, plans the
 * parallel/sequential batching, and maps consolidated findings into the
 * `--findings` JSON shape understood by
 * scripts/github/write-gate-findings-log.mjs.
 *
 * Per-angle review artifact shape (produced by the scoped `review` agent):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present",
 *     headSha: string,   // reviewed head; consolidate-fanin --head-sha enforces it
 *     findings: [{ severity, file?, line?, summary, recommendation? }]
 *   }
 *
 * Severity vocabulary (owned here; consumers import SEVERITY_ORDER /
 * VALID_SEVERITIES / normalizeSeverity):
 *   "high" | "medium" | "low" (defects) | "question" | "nit" (non-defects)
 * Severity is the reviewer's advisory weight. Deferral is a DISPOSITION
 * (derived at fan-in, finalized by the fix cycle / gate close), never a
 * severity; pre-rename spellings are accepted on read and normalized (see
 * LEGACY_SEVERITY_ALIASES / normalizeSeverity). A question is answered (never
 * deferred) and an unanswered one blocks gate-close; a nit defers immediately,
 * with no fixer cycle.
 */

import { scheduleParallelWaves } from "./queue-parallel.mjs";
import { trimmedOrNull } from "./normalize.mjs";

/**
 * Schedule fan-out dispatch units into bounded-concurrency waves: each wave
 * holds at most `maxConcurrent` units, dispatched wave-by-wave (await a free
 * slot before the next) instead of fire-all-then-retry. Replaces the unbounded
 * concurrent fan-out that 429-stormed multi-angle gate rounds (issue #1601).
 *
 * Pure and deterministic: same input yields the same wave plan (stable order),
 * so a reviewer's recorded wave plan is byte-stable across fresh spawns for the
 * same head+config.
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
 * Adaptive concurrency backoff: halve the active batch before escalating to
 * foreground one-at-a-time fallback. A transient dispatch failure is first
 * retried on the SAME unit (idempotent single-write artifact); concurrency
 * drops ONLY after that unit's retries are exhausted. This "retry the unit
 * before reducing concurrency" ordering is owned by
 * GATE-EXEC-DISPATCH-RETRY-BACKOFF in
 * skills/docs/gate-review-sub-loop-contract.md. Pure; never returns 0 (a backoff
 * from 1 stays 1 → foreground fallback owns that path).
 * @param {number} maxConcurrent
 * @returns {number}
 */
export function backoffMaxConcurrent(maxConcurrent) {
  const cap = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 4;
  return Math.max(1, Math.floor(cap / 2));
}

/**
 * Reviewer-budget preflight for a gate fan-out (issue #1507).
 *
 * Derives how many reviewers the round needs (one per dispatch unit) and
 * compares against the harness's remaining budget. On a PROVEN shortfall it
 * reports the shortfall BEFORE any reviewer spawns; the shortfall is a recorded,
 * resumable state (completed per-angle artifacts stay valid, so a later session
 * resumes rather than restarts). A shortfall NEVER downgrades a required gate to
 * `inline_single_agent` and NEVER produces a clean verdict.
 *
 * Pure. `availableReviewers` null = harness exposes no budget → no shortfall
 * provable → preflight proceeds; it blocks only on a proven shortfall. The
 * returned `verdict` and `executionMode` are ALWAYS null: a shortfall is not a
 * verdict, and it fails closed at merge rather than yielding a clean/inline one.
 *
 * @param {{ name: string, angles: string[] }[]} dispatchGroups — `resolveFanoutGroups` output (fresh angles + re-verifications)
 * @param {number|null} [availableReviewers] — harness remaining reviewer budget; null/non-finite = unknown/unexposed
 * @param {{ completedAngles?: Iterable<string>, carriedAngles?: Iterable<string> }} [options] — angle names
 *   already resolved for THIS head: `completedAngles` have a clean per-angle artifact stamped for it,
 *   `carriedAngles` are proven carried forward from a prior clean head (that carry-forward runs AFTER this
 *   preflight, so a head-bump re-gate must feed its result back in). A group whose angles are ALL
 *   complete-or-carried is excluded from the required count and `pendingGroups`, so a later session
 *   dispatches only unresolved groups. Membership is matched trim+lowercase (mirrors consolidate-fanin.mjs's
 *   carried-key normalization) so a case difference still excludes the right group.
 * @returns {{ ok: boolean, dispatch: boolean, requiredReviewers: number, availableReviewers: number|null, shortfall: number|null, reason: string, verdict: null, executionMode: null, pendingGroups: { name: string, angles: string[] }[], skippedGroups: { name: string, angles: string[] }[], completedAngles: string[], carriedAngles: string[] }}
 */
export function reviewerBudgetPreflight(dispatchGroups, availableReviewers, { completedAngles, carriedAngles } = {}) {
  const groups = Array.isArray(dispatchGroups) ? dispatchGroups : [];
  const toSet = (iterable) =>
    new Set(Array.isArray(iterable) ? iterable : iterable == null ? [] : [...iterable]);
  const completedSet = toSet(completedAngles);
  const carriedSet = toSet(carriedAngles);
  // A group already RESOLVED for this round — every angle either clean-stamped
  // for this head or proven carried forward — needs no reviewer and drops from
  // the required count and the pending plan (the conductor dispatches only
  // `pendingGroups`). Membership is matched trim+lowercase (`normalizeAngleKey`),
  // the same normalization consolidate-fanin.mjs applies to its carried keys, so
  // a case difference still excludes the group instead of leaving it and its
  // exempted sibling silently disagreeing.
  const normalizeAngleKey = (a) => String(a).trim().toLowerCase();
  const completedKeys = new Set([...completedSet].map(normalizeAngleKey));
  const carriedKeys = new Set([...carriedSet].map(normalizeAngleKey));
  const groupIsComplete = (g) =>
    Array.isArray(g?.angles) &&
    g.angles.length > 0 &&
    g.angles.every((a) => {
      const key = normalizeAngleKey(a);
      return completedKeys.has(key) || carriedKeys.has(key);
    });
  const pendingGroups = groups.filter((g) => !groupIsComplete(g));
  const skippedGroups = groups.filter((g) => groupIsComplete(g));
  // One reviewer per dispatch unit: a group of N angles is one reviewer's
  // scoped dispatch, so the reviewer count is the pending dispatch-unit count,
  // not the raw angle count.
  const requiredReviewers = pendingGroups.length;
  const verdict = null;
  const executionMode = null;
  const resume = { pendingGroups, skippedGroups, completedAngles: [...completedSet], carriedAngles: [...carriedSet] };
  if (typeof availableReviewers !== "number" || !Number.isFinite(availableReviewers)) {
    return { ok: true, dispatch: true, requiredReviewers, availableReviewers: null, shortfall: null, reason: "budget_unknown", verdict, executionMode, ...resume };
  }
  // A negative/over-spent budget clamps to 0; a fractional budget truncates.
  const available = Math.max(0, Math.trunc(availableReviewers));
  if (requiredReviewers === 0) {
    return { ok: true, dispatch: true, requiredReviewers: 0, availableReviewers: available, shortfall: null, reason: "no_reviewers_needed", verdict, executionMode, ...resume };
  }
  if (available >= requiredReviewers) {
    return { ok: true, dispatch: true, requiredReviewers, availableReviewers: available, shortfall: null, reason: "budget_sufficient", verdict, executionMode, ...resume };
  }
  return {
    ok: false,
    dispatch: false,
    requiredReviewers,
    availableReviewers: available,
    shortfall: requiredReviewers - available,
    reason: "budget_shortfall",
    verdict,
    executionMode,
    ...resume,
  };
}

// Exported as the single ordered copy of the severity vocabulary so consumers
// (consolidate-fanin.mjs, upsert-checkpoint-verdict.mjs) rank against it rather
// than each re-listing — ORDER is part of the contract, not just membership.
// Ranked by gate-close urgency: "question" sits right after "high" because BOTH
// force gate-close to stay blocked; "medium"/"low" eventually defer. "nit"
// trails last: it defers immediately, with no fixer cycle.
export const SEVERITY_ORDER = Object.freeze(["high", "question", "medium", "low", "nit"]);

// The non-defect subset of SEVERITY_ORDER: a "question" is answered (see
// deriveDisposition) and a "nit" always defers regardless of any gate's
// blockCleanOnFindingSeverities (see isDefaultDeferrableSeverity) — neither
// belongs in a defect-only blocking vocabulary. The single source for that
// partition, so a consumer derives "defect severities" as SEVERITY_ORDER minus
// this set. Object.freeze on a Set locks only its OWN properties, not the
// add/delete that mutate its collection; it is applied for consistency with the
// other frozen exports and does stop a stray own property on the Set object.
export const NON_DEFECT_SEVERITIES = Object.freeze(new Set(["question", "nit"]));

// Marker gate name → gates.<key> config key. Owned here so every caller of
// resolveFanoutGroups maps the same way; passing the marker name verbatim
// resolves no groups and silently downgrades pairing enforcement.
export const GATE_CONFIG_KEY = Object.freeze({ draft_gate: "draft", pre_approval_gate: "preApproval" });
export const VALID_SEVERITIES = Object.freeze(new Set(SEVERITY_ORDER));

// Pre-rename spellings. Old ledgers, markers, and configs still carry them;
// every read boundary normalizes through this map. This is a read-side
// normalizer, not a write-side enforcement boundary: buildFindingMarker emits
// whatever severity string it is given verbatim, so a legacy-spelled marker
// built directly still parses correctly via normalizeSeverity on read.
export const LEGACY_SEVERITY_ALIASES = Object.freeze({
  "must-fix": "high",
  "worth-fixing-now": "medium",
  "nice-to-have": "low",
  defer: "low",
});

/**
 * Map a legacy severity spelling to its canonical name; unknown values pass
 * through trimmed (the caller's validation still rejects them), a non-string
 * unchanged. Trims BEFORE the alias lookup so every call site agrees on the
 * same value for a whitespace-varied input. Deliberately case-SENSITIVE: every
 * sanctioned writer emits lowercase, so a forged mixed-case value (e.g. "NIT")
 * must fail VALID_SEVERITIES validation and dangle fail-closed rather than be
 * silently coerced into a real severity that then auto-defers.
 * @param {unknown} severity
 * @returns {unknown}
 */
export function normalizeSeverity(severity) {
  if (typeof severity !== "string") return severity;
  const normalized = severity.trim();
  return Object.hasOwn(LEGACY_SEVERITY_ALIASES, normalized) ? LEGACY_SEVERITY_ALIASES[normalized] : normalized;
}

/**
 * Map a (possibly legacy-spelled/untrimmed) severity to its SEVERITY_ORDER
 * index — the one rank rule every sort/ordering consumer shares. An
 * unrecognized severity ranks LAST (`SEVERITY_ORDER.length`, never -1) so it
 * sorts after every known severity instead of floating above "high".
 * @param {unknown} severity
 * @returns {number}
 */
export function severityRank(severity) {
  const idx = SEVERITY_ORDER.indexOf(/** @type {string} */ (normalizeSeverity(severity)));
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

/**
 * A zero-initialized severity→count map, one key per SEVERITY_ORDER entry in
 * order. Single source so a severity added to SEVERITY_ORDER is zero-initialized
 * everywhere at once.
 * @returns {Record<string, number>}
 */
export function zeroSeverityCounts() {
  return Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
}

/**
 * Tally `findings` by normalized severity into a {@link zeroSeverityCounts}
 * map. A finding whose normalized severity is not a SEVERITY_ORDER member is
 * excluded (defensive floor; consolidateFanin validates before this runs). NOT
 * nullish-tolerant: a nullish `findings` or a nullish entry throws — fail-loud
 * rather than a silently wrong all-zero tally.
 * @param {Iterable<{severity: unknown}>} findings
 * @returns {Record<string, number>}
 */
export function tallySeverities(findings) {
  const counts = zeroSeverityCounts();
  for (const f of findings) {
    const severity = /** @type {string} */ (normalizeSeverity(f.severity));
    if (Object.hasOwn(counts, severity)) counts[severity] += 1;
  }
  return counts;
}

/**
 * Merge a severity→count map's legacy-spelled keys into their canonical keys
 * (summing) so CLI and programmatic callers share one merge rule. Values pass
 * through unvalidated.
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

/**
 * Resolve a finding's file path from either shape the floor accepts: `file`
 * (singular string) or `files[0]` (array shape). The value is TRIMMED and a
 * whitespace-only `file` is treated as ABSENT (falls back to `files[0]`), so the
 * path matches the trimmed commentable-line keys and is a valid GitHub
 * review-comment `path`. Returns `undefined` when neither shape names a
 * non-blank string path.
 * @param {{ file?: unknown, files?: unknown }} finding
 * @returns {string|undefined}
 */
export function resolveFindingFile(finding) {
  if (typeof finding?.file === "string" && finding.file.trim().length > 0) return finding.file.trim();
  if (Array.isArray(finding?.files) && typeof finding.files[0] === "string" && finding.files[0].trim().length > 0) {
    return finding.files[0].trim();
  }
  return undefined;
}

/**
 * A finding is LOCATABLE-SHAPED when it names a real file (via
 * {@link resolveFindingFile}) and a positive-integer `line`. NECESSARY but not
 * SUFFICIENT for a thread-locatable finding: `isLocatableFinding`
 * (scripts/github/_gate-finding-surface.mjs) additionally requires the file:line
 * to fall inside the reviewed diff, which only that caller can check.
 * @param {{ file?: unknown, files?: unknown, line?: unknown }} finding
 * @returns {boolean}
 */
export function hasLocatableShape(finding) {
  const file = resolveFindingFile(finding);
  return typeof file === "string" && file.trim().length > 0
    && Number.isInteger(finding?.line) && /** @type {number} */ (finding.line) >= 1;
}

/**
 * Derive the ledger disposition for a finding at `severity` (already
 * normalized) — the one rule every producer shares. A LOCATABLE `question` is
 * answered ("needs-answer") regardless of `isBlocking`; severity-first so that
 * invariant holds here, not just at the config boundary. A NON-LOCATABLE
 * question is body-filed and deferred, like every other non-`high` body-filed
 * finding (GATE-EXEC-DEFERRAL-RECORD). Every other severity ignores `locatable`:
 * `isBlocking` alone decides accepted-for-fix vs deferred.
 * @param {string} severity — already normalized
 * @param {{ isBlocking?: boolean, locatable?: boolean }} [options]
 * @returns {"accepted-for-fix"|"deferred"|"needs-answer"}
 */
export function deriveDisposition(severity, { isBlocking = false, locatable = false } = {}) {
  if (severity === "question") return locatable ? "needs-answer" : "deferred";
  return isBlocking ? "accepted-for-fix" : "deferred";
}

/**
 * Does `severity` (already normalized) have a default disposition
 * `deriveDisposition` can resolve WITHOUT `isBlocking` context? "low" and "nit"
 * always defer, and "question" resolves off `locatable` alone — so a CLI
 * validator with no config in scope can fill a default for these three only.
 * "high" and "medium" are excluded: whether either blocks a clean verdict
 * depends on config, so guessing "deferred" here would be wrong for a repo that
 * configures it as blocking.
 * @param {string} severity — already normalized
 * @returns {boolean}
 */
export function isDefaultDeferrableSeverity(severity) {
  return severity === "low" || severity === "nit" || severity === "question";
}

const VALID_VERDICTS = new Set(["clean", "findings_present"]);

/**
 * Canonical fail-closed signal for when a child/agent cannot perform real
 * parallel fan-out. The flow MUST fail closed with this message and route the
 * gate review to the conductor rather than silently degrading to a single-agent
 * inline review. Contract: skills/docs/gate-review-sub-loop-contract.md.
 */
export const FANOUT_UNAVAILABLE_MESSAGE = "fan-out unavailable — route to conductor";

/**
 * Build a fail-closed Error carrying the route-to-conductor signal. Callers
 * throw it (or check `.routeToConductor === true`) when real fan-out cannot be
 * performed. `detail` is appended for diagnostics; the matchable prefix is
 * always {@link FANOUT_UNAVAILABLE_MESSAGE}.
 *
 * @param {string} [detail] — optional diagnostic suffix
 * @returns {Error & { routeToConductor: true, code: "FANOUT_UNAVAILABLE" }}
 */
export function fanoutUnavailableError(detail) {
  const suffix = typeof detail === "string" && detail.trim().length > 0 ? ` (${detail.trim()})` : "";
  const error = new Error(`${FANOUT_UNAVAILABLE_MESSAGE}${suffix}`);
  return Object.assign(error, { routeToConductor: /** @type {const} */ (true), code: /** @type {const} */ ("FANOUT_UNAVAILABLE") });
}

/**
 * Count DISTINCT reviewer identities recorded in a `perAngle` array (identity
 * via {@link reviewerIdentity}); a bare `{angle}` contributes none. Pure.
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
 * `{ id, label }` (label names the carrying field, for error messages) or null.
 * Shared by countDistinctReviewers and fanoutReviewerPairingError so the two
 * never diverge.
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
 * Validate INTERNAL CONSISTENCY of a fan-out provenance object. Returns an
 * error string when malformed/self-inconsistent, else null. Shared by the write
 * path and the enforcement read path (buildPreMergeGateCheck) so both agree.
 *
 * Consistency rules (skills/docs/gate-review-sub-loop-contract.md):
 *   - `distinctReviewers` a non-negative integer.
 *   - `perAngle` an array, non-empty when `distinctReviewers > 0`.
 *   - `distinctReviewers` <= distinct reviewer identities recorded in `perAngle`.
 *
 * HONEST CAVEAT: this raises the bar but the provenance is self-reported (written
 * by the same agent whose independence it claims), so it stays forgeable by a
 * determined single agent. Un-forgeable recording is the Pi-harness bridge.
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
 * Yield `{ entry, angle, group }` for each "fresh" entry in a `perAngle` array:
 * a valid object naming a non-blank `angle` and carrying no `carriedFromHead`
 * (a carried angle's clean verdict was reused from a prior head, not reviewed
 * here). `group` is the normalized non-blank `group` string or `null`. The ONE
 * definition of "fresh" and "declared group" that {@link freshAngleNames},
 * {@link countFreshDispatchUnits}, and {@link fanoutReviewerPairingError} all
 * derive from, so the write-time floor and pairing check never drift. Pure.
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
    const group = trimmedOrNull(entry.group);
    yield { entry, angle, group };
  }
}

/**
 * Names of DISTINCT "fresh" angles in a `perAngle` array (see
 * {@link freshEntries}). Pure.
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
 * declaring a `group` counts once per DISTINCT group name (its group is one
 * reviewer's dispatch), an ungrouped fresh angle counts as its own unit. Shared
 * by the write path and the requireFanoutProvenance read path so the
 * `distinctReviewers` floor scales with what was DISPATCHED, not the angle count
 * a grouped round deliberately dispatches fewer reviewers than. Pure.
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
 * Validate the one-scoped-reviewer-per-fresh-angle contract (#1431): no two
 * FRESH angles (see {@link freshEntries}) may share one reviewer identity
 * (matching {@link countDistinctReviewers}'s rule), UNLESS every entry sharing
 * that identity declares the SAME `group` name (grouped fan-out dispatch). Two
 * fresh angles sharing a reviewer with differing or missing `group` still
 * violate; carried angles keep their prior reviewer and are exempt. Pure; shared
 * by the write path and the merge-evidence read path so both agree.
 *
 * Returns an actionable error string naming the offending angle(s) — an
 * ungrouped reviewer covering >1 fresh angle, inconsistent `group` values, or a
 * fresh angle recording no reviewer identity — or `null` when the contract holds
 * (including when there are no fresh angles).
 *
 * The recorded `group` is self-attested, so the grouped exception is only as
 * strong as the caller allows. An optional `resolvedGroups` (the round's
 * `resolveFanoutGroups` output) closes that: a shared identity is honored only
 * when every fresh angle it covers is a member of the SAME configured unit, so a
 * fabricated `group` label spanning angles the table splits apart no longer
 * passes. `resolveFanoutGroups` emits one-angle singletons for
 * `gates.fanout.mode: per-angle`, so passing its output rejects any shared
 * identity in that mode. Per ADR 0048, `gate:full` dispatches GROUPED, so a
 * shared identity within an auto-chunked unit is honored as for a configured
 * group. Omitting `resolvedGroups` keeps the permissive behavior (any one shared
 * non-null `group` accepted) for callers that don't load config.
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
    // One shared, non-null `group` across every entry is the grouped-dispatch
    // exception: a single reviewer legitimately covers its whole declared group.
    // Differing or missing `group` falls back to one-reviewer-per-angle.
    const sameGroup = groups.size === 1 && [...groups][0] !== null;
    if (!sameGroup) {
      details.push(`${label} "${id}" is recorded for fresh angles: ${[...angles].join(", ")}`);
      continue;
    }
    // resolvedGroups supplied: the claimed group is honest only when every angle
    // it covers is a member of the SAME configured group — a claimed group
    // spanning angles the table splits apart fails closed.
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
 * Base angle name for a delta-suffixed re-review entry (`<angle>-delta-at-...`):
 * a re-review scoped to only the current head's delta still counts toward its
 * base angle for both mandatory-angle coverage and pool-membership checks.
 *
 * @param {string} angle
 * @returns {string}
 */
export function baseAngleName(angle) {
  return angle.replace(/-delta-at-.+$/, "");
}

/**
 * Validate a recorded fan-out angle list against a gate's angle contract: every
 * mandatory angle must be represented, and — when a pool is supplied — every
 * recorded angle must be a member of it or of {@link FANIN_SYNTHETIC_ANGLES}
 * (delta-suffixed angles count toward their {@link baseAngleName}). Pure; shared
 * by the write path and the merge-evidence read path so all enforce identically.
 *
 * @param {unknown} recordedAngles — array of `{ angle: string, ... }` entries
 * @param {object} [gateAngleContract]
 * @param {string[]} [gateAngleContract.mandatoryAngles] — angles that must always be represented
 * @param {string[]|null} [gateAngleContract.pool] — configured angle pool; null/omitted/empty skips the foreign-angle check; {@link FANIN_SYNTHETIC_ANGLES} are unioned in first
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
 * `--pr-checklist clean` upsert) without appearing in any gate's configured
 * pool. Always legal in the foreign-angle check above.
 */
export const FANIN_SYNTHETIC_ANGLES = Object.freeze(["pr-checklist"]);

/**
 * Validate a round's RESOLVED angle set — the full angle list the round
 * targeted, independent of any gate's mandatory subset — against recorded
 * evidence: every resolved angle must have a per-angle artifact in
 * `recordedAngles` (matched by {@link baseAngleName} + case-insensitive compare)
 * or be named in `carriedAngles` (names a caller has already PROVEN carried
 * forward, e.g. after consolidate-fanin's `--carry-forward-plan` proof).
 *
 * Closes a gap {@link checkFanoutAngleCoverage} leaves open: that check protects
 * only a caller-supplied mandatory subset, so a wrong carry-forward naming only
 * NON-mandatory angles under-dispatches with no refusal. This protects every
 * resolved angle. Pure.
 *
 * @param {unknown} resolvedAngles — the round's full resolved angle-name list
 * @param {object} [evidence]
 * @param {unknown} [evidence.recordedAngles] — array of `{ angle: string, ... }` entries (per-angle artifacts this round consolidated)
 * @param {Iterable<string>} [evidence.carriedAngles] — angle names already proven carried forward
 * @returns {{ missingAngles: string[] }}
 */
export function checkResolvedAngleEvidence(resolvedAngles, { recordedAngles, carriedAngles } = {}) {
  const resolved = Array.isArray(resolvedAngles)
    ? [...new Set(
        resolvedAngles
          .map((a) => (typeof a === "string" ? a.trim() : ""))
          .filter((a) => a.length > 0),
      )]
    : [];
  const recorded = Array.isArray(recordedAngles)
    ? recordedAngles
      .map((e) => (e && typeof e === "object" && typeof e.angle === "string" ? e.angle.trim() : ""))
      .filter((a) => a.length > 0)
    : [];
  // Matched base+lowercase (per-angle artifacts are independently authored, so a
  // case difference must not read as missing), same rule as
  // checkFanoutAngleCoverage's callers and reviewerBudgetPreflight.
  const normalizeAngleBase = (a) => baseAngleName(a).toLowerCase();
  const recordedBases = new Set(recorded.map(normalizeAngleBase));
  const carriedBases = new Set(
    [...(carriedAngles ?? [])].map((a) => normalizeAngleBase(String(a).trim())),
  );
  const missingAngles = resolved.filter((a) => {
    const base = normalizeAngleBase(a);
    return !recordedBases.has(base) && !carriedBases.has(base);
  });
  return { missingAngles };
}

/**
 * Default cap on parallel fan-out reviewers when a caller supplies none. Mirrors
 * gates.maxFanoutReviewers.
 */
export const DEFAULT_MAX_FANOUT_REVIEWERS = 8;

// Every sanctioned angle name is a short hand-authored slug; nothing legitimate
// approaches this length. Bounding it at this trust boundary fails a
// pathological artifact closed as malformed — where every other angle-result
// defect is caught. A malformed-artifact guard, not a comment-budget guarantee:
// several angles each at this cap can still exceed the render budget, which the
// render budget's degradation ladder handles.
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
      return `angle '${r.angle}' has a finding with invalid severity (expected ${SEVERITY_ORDER.join("|")})`;
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
 * @param {string[]} [input.blockCleanOnFindingSeverities] — blocking severities (default ["high"])
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
  // so a legacy config spelling ("must-fix", "defer", …) still blocks the
  // renamed tier.
  const blocking = new Set(
    (Array.isArray(blockCleanOnFindingSeverities) && blockCleanOnFindingSeverities.length > 0
      ? blockCleanOnFindingSeverities
      : ["high"]
    ).map((s) => normalizeSeverity(s)),
  );

  const malformed = [];
  results.forEach((r, index) => {
    const err = validateAngleResult(r);
    if (err) malformed.push({ index, reason: err });
  });

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
        const entry = {
          severity,
          angle,
          summary: String(f.summary).trim(),
          // See deriveDisposition's own doc for the full rule; the fix cycle
          // / operator can override the disposition afterward.
          disposition: deriveDisposition(severity, { isBlocking, locatable: hasLocatableShape(f) }),
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

  // findings already carries each entry's normalized severity, so tallying it
  // directly reproduces the same counts via the one shared tally rule.
  return {
    verdict,
    findings,
    counts: {
      angles: results.length,
      findings: findings.length,
      blocking: blockingCount,
      bySeverity: tallySeverities(findings),
    },
    malformed,
  };
}

/**
 * The judge's relevance-based disposition vocabulary — distinct from the
 * severity-based `disposition` that `deriveDisposition` owns. The judge decides
 * *where* a finding is acted on (this PR or a follow-up), never *whether* it is
 * real: a `reject` is a relevance verdict (out-of-scope), not a reproduction
 * verdict. The fixer retains reproduction-based rejection; the judge owns
 * relevance (#1525).
 */
export const JUDGE_DISPOSITIONS = Object.freeze(["act", "defer", "reject"]);

/**
 * Validate a judge verdict artifact shape (the `judge` agent's only write).
 * Pure; throws on a malformed verdict rather than enriching findings with
 * garbage. The judge is the designated memory across rounds, so a malformed
 * artifact fails closed rather than degrading to severity-only disposition.
 *
 * Shape:
 * ```
 * {
 *   headSha: "<sha>",
 *   scopeDrift: { verdict: "within_scope"|"drift_detected", rationale: "...", driftedAreas: ["..."] },
 *   dispositions: [{ index, disposition: "act"|"defer"|"reject", rationale, criterion?, followUpDraft? }]
 * }
 * ```
 *
 * @param {unknown} verdict
 * @returns {{ headSha: string, scopeDrift: object, dispositions: Array<object> }}
 */
export function validateJudgeVerdict(verdict) {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("judge verdict must be a JSON object");
  }
  const v = /** @type {Record<string, unknown>} */ (verdict);
  if (typeof v.headSha !== "string" || v.headSha.trim().length === 0) {
    throw new Error("judge verdict.headSha must be a non-empty string");
  }
  if (!v.scopeDrift || typeof v.scopeDrift !== "object" || Array.isArray(v.scopeDrift)) {
    throw new Error("judge verdict.scopeDrift must be an object");
  }
  const sd = /** @type {Record<string, unknown>} */ (v.scopeDrift);
  if (sd.verdict !== "within_scope" && sd.verdict !== "drift_detected") {
    throw new Error("judge verdict.scopeDrift.verdict must be 'within_scope' or 'drift_detected'");
  }
  if (typeof sd.rationale !== "string" || sd.rationale.trim().length === 0) {
    throw new Error("judge verdict.scopeDrift.rationale must be a non-empty string");
  }
  if (!Array.isArray(sd.driftedAreas)) {
    throw new Error("judge verdict.scopeDrift.driftedAreas must be an array");
  }
  for (const [di, area] of sd.driftedAreas.entries()) {
    if (typeof area !== "string" || area.trim().length === 0) {
      throw new Error(`judge verdict.scopeDrift.driftedAreas[${di}] must be a non-empty string`);
    }
  }
  if (!Array.isArray(v.dispositions)) {
    throw new Error("judge verdict.dispositions must be an array");
  }
  const seenIndices = new Set();
  for (const [i, d] of v.dispositions.entries()) {
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      throw new Error(`judge verdict.dispositions[${i}] must be an object`);
    }
    const entry = /** @type {Record<string, unknown>} */ (d);
    if (!Number.isInteger(entry.index) || entry.index < 0) {
      throw new Error(`judge verdict.dispositions[${i}].index must be a non-negative integer`);
    }
    if (seenIndices.has(entry.index)) {
      throw new Error(`judge verdict.dispositions[${i}].index ${entry.index} is a duplicate — the contract is one disposition per finding`);
    }
    seenIndices.add(entry.index);
    if (!JUDGE_DISPOSITIONS.includes(entry.disposition)) {
      throw new Error(`judge verdict.dispositions[${i}].disposition must be one of: ${JUDGE_DISPOSITIONS.join(", ")}`);
    }
    if (typeof entry.rationale !== "string" || entry.rationale.trim().length === 0) {
      throw new Error(`judge verdict.dispositions[${i}].rationale must be a non-empty string naming the criterion, non-goal, or scope boundary`);
    }
    // followUpDraft is REQUIRED on a defer disposition (a deferred finding
    // carries a fileable follow-up draft). Optional otherwise.
    if (entry.disposition === "defer") {
      if (!entry.followUpDraft || typeof entry.followUpDraft !== "object" || Array.isArray(entry.followUpDraft)) {
        throw new Error(`judge verdict.dispositions[${i}].followUpDraft is required on a defer disposition`);
      }
      const draft = /** @type {Record<string, unknown>} */ (entry.followUpDraft);
      if (typeof draft.title !== "string" || draft.title.trim().length === 0 || typeof draft.body !== "string") {
        throw new Error(`judge verdict.dispositions[${i}].followUpDraft must have a non-empty title and a body string`);
      }
    }
  }
  return { headSha: v.headSha, scopeDrift: v.scopeDrift, dispositions: v.dispositions };
}

/**
 * Merge the judge's relevance-based dispositions into the flat consolidated
 * findings array. The judge runs AFTER fan-in and BEFORE the fix pass (#1525):
 * it emits a per-finding disposition (`act`/`defer`/`reject`) plus a scope-drift
 * verdict on the PR as a whole.
 *
 * Enriches each finding with `judgeDisposition`, `judgeRationale`, and (for
 * `defer`) `followUpDraft`. The severity-based `disposition` is LEFT INTACT —
 * the judge's relevance axis is complementary, not a replacement. The fix pass
 * consumes only the `act` list.
 *
 * Pure. Fails closed (throws) when a disposition references an out-of-range
 * index, and when the dispositions do not cover every finding — an undisposed
 * finding must never be silently dropped from the fixer's act list. An empty
 * findings + empty dispositions pair is vacuously covered.
 *
 * @param {Array<object>} findings — the flat consolidated findings array
 * @param {object} judgeVerdict — the validated judge verdict artifact
 * @returns {{ findings: Array<object>, scopeDrift: object }}
 */
export function applyJudgeDispositions(findings, judgeVerdict) {
  const validated = validateJudgeVerdict(judgeVerdict);
  const list = Array.isArray(findings) ? findings : [];
  const enriched = list.map((f) => ({ ...f }));
  for (const d of validated.dispositions) {
    if (d.index >= enriched.length) {
      throw new Error(`judge disposition index ${d.index} is out of range (findings has ${enriched.length} entries)`);
    }
    const target = enriched[d.index];
    // Reset judge-owned fields before the re-merge so a re-disposed finding
    // (defer -> act/reject) carries only what the current disposition provides,
    // never stale judgeCriterion/followUpDraft from a prior round.
    delete target.judgeCriterion;
    delete target.followUpDraft;
    target.judgeDisposition = d.disposition;
    target.judgeRationale = d.rationale;
    if (typeof d.criterion === "string" && d.criterion.trim().length > 0) {
      target.judgeCriterion = d.criterion.trim();
    }
    if (d.disposition === "defer" && d.followUpDraft) {
      target.followUpDraft = d.followUpDraft;
    }
  }
  // Coverage is judged against THIS verdict's disposed-index set, not field
  // presence on the merged copy, so an already-enriched ledger can't let a
  // verdict that disposes nothing pass silently. validateJudgeVerdict rejects
  // duplicate indexes, so the Set is exact.
  const disposed = new Set(validated.dispositions.map((d) => d.index));
  const uncovered = enriched.reduce((positions, _f, i) => {
    if (!disposed.has(i)) positions.push(i);
    return positions;
  }, /** @type {number[]} */ ([]));
  if (uncovered.length > 0) {
    throw new Error(
      `judge verdict does not dispose ${uncovered.length} finding(s) (indexes: ${uncovered.join(", ")}) — fail closed; an undisposed finding must never be silently dropped from the fixer act list`
    );
  }
  return { findings: enriched, scopeDrift: validated.scopeDrift };
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
    // Carry the judge's relevance-based dispositions through so the ledger and
    // posted findings comment show what was consciously not acted on.
    if (typeof f.judgeDisposition === "string" && f.judgeDisposition.trim().length > 0) {
      entry.judgeDisposition = f.judgeDisposition.trim();
    }
    if (typeof f.judgeRationale === "string" && f.judgeRationale.trim().length > 0) {
      entry.judgeRationale = f.judgeRationale.trim();
    }
    if (typeof f.judgeCriterion === "string" && f.judgeCriterion.trim().length > 0) {
      entry.judgeCriterion = f.judgeCriterion.trim();
    }
    if (f.followUpDraft && typeof f.followUpDraft === "object" && !Array.isArray(f.followUpDraft)) {
      entry.followUpDraft = f.followUpDraft;
    }
    return entry;
  });
}

/**
 * Plan how a resolved angle set fans out across the reviewer cap. Pure.
 *
 * SUPERSEDED by `scheduleFanoutWaves` (ADR 0048): the conductor now dispatches
 * wave-by-wave. Kept for back-compat only (zero non-test callers); no longer in
 * the dispatch path.
 *
 * When `angles.length <= maxReviewers`, all reviewers run in one parallel batch;
 * otherwise the overflow splits into sequential batches of at most `maxReviewers`
 * and `degraded` is true.
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
