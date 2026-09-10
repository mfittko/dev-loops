/**
 * UI-review lens set + the pure converge/dedupe seam (Stage 5).
 *
 * The ui_review pass judges ONE enriched named-state bundle through four
 * parallel LENSES, each grounded in a different artifact:
 *
 *   - `a11y`            grounded in `axe.json` (computed accessibility facts)
 *   - `layout-geometry` grounded in `snapshot.json` (the a11y tree + geometry)
 *   - `visual`          grounded in `screenshot.png` (the pixels)
 *   - `interaction`     grounded in `console.json` (console/network + interaction state)
 *
 * Lens EXECUTION stays in the existing designer/vision review route: each lens
 * is a named producer that takes the enriched bundle and returns a findings
 * array. This module owns only the DETERMINISTIC tail: it validates the raw
 * lens-result set fail-closed, then MERGES the four findings arrays into one
 * DEDUPED set and maps it to the existing outcome enum. No browser, no model.
 *
 * The converge seam is pure so the mergeable/testable core stays
 * harness-agnostic while model orchestration lives in the route.
 */

/** The four lenses, in canonical (documented, stable) order. A lens result set
 * MUST carry exactly these — no more, no fewer — or the validator rejects it,
 * so a dropped lens is never silently converged as a partial review. */
export const UI_REVIEW_LENSES = Object.freeze([
  Object.freeze({ name: "a11y", groundedIn: "axe.json", judges: "computed accessibility facts (contrast, missing names/roles)" }),
  Object.freeze({ name: "layout-geometry", groundedIn: "snapshot.json", judges: "layout, spacing, clipping, overlap from the a11y tree + geometry" }),
  Object.freeze({ name: "visual", groundedIn: "screenshot.png", judges: "visual hierarchy, callouts, state-transition clarity from the pixels" }),
  Object.freeze({ name: "interaction", groundedIn: "console.json", judges: "console errors, failed network requests, and interaction-state signals" }),
]);

export const UI_REVIEW_LENS_NAMES = Object.freeze(UI_REVIEW_LENSES.map((lens) => lens.name));

/** Canonical lens index — the deterministic tie-break when two lenses report the
 * SAME defect at EQUAL severity: the earlier lens supplies the representative's
 * descriptive fields, so the merge result is independent of input lens order. */
const LENS_ORDER = new Map(UI_REVIEW_LENS_NAMES.map((name, index) => [name, index]));

/** Severity ladder — the SAME four values the vision template allows
 * (`must-fix` from the interaction lens; `high`/`medium`/`low` from the
 * axe-impact and judgment lenses). Lower rank = higher severity = wins on a
 * cross-lens duplicate. */
const SEVERITY_RANK = Object.freeze({
  "must-fix": 0,
  high: 1,
  medium: 2,
  low: 3,
});

export const UI_REVIEW_FINDING_SEVERITIES = Object.freeze(Object.keys(SEVERITY_RANK));

/** Severities that BLOCK "satisfied": a `must-fix` (mechanical) or `high`
 * (a critical/serious axe impact, or a high-severity judgment finding) means the
 * review cannot be satisfied — the fix loop continues. */
const MUST_FIX_SEVERITIES = new Set(["must-fix", "high"]);

/** The outcome enum is UNCHANGED from the designer/vision review contract. */
export const UI_REVIEW_OUTCOMES = Object.freeze({
  CONTINUE: "continue_ui_fix_loop",
  SATISFIED: "ui_review_satisfied",
  BLOCKED: "blocked_needs_human_decision",
});

/** Dedupe-key field separator. The U+0000 NUL cannot appear in real
 * stateName/region/category text, so joining the triple with it is unambiguous —
 * and `validateUiReviewLensResults` rejects any finding that DOES contain it, so
 * a crafted value can never forge a collision. */
const DEDUPE_KEY_SEPARATOR = "\u0000";

/** Acceptance-criterion reference tokens. Every finding (and every affirmative
 * "checked" mark) references ONE acceptance criterion from the provided list by
 * its 1-based position as `AC<n>` (`AC1` is `acceptanceCriteria[0]`). Compact and
 * stable within a single review pass, and trivially auditable back to the
 * criterion text — so per-criterion coverage is computable, not a gestalt call.
 *
 * Resolve + fail-closed-validate the acceptance-criteria list into the canonical
 * trimmed criteria and the set of valid `AC<n>` refs. Returns null when the list
 * is not a non-empty array of non-empty strings (the seam's precondition — the
 * same non-empty AC list `validateUiDesignerReviewInput` already requires); a hole
 * (a non-string/empty entry) is rejected rather than silently dropped, so a ref
 * can never map to a phantom criterion. The caller distinguishes an ABSENT list
 * (`acceptance_criteria_missing`) from a PRESENT-but-malformed one
 * (`acceptance_criteria_malformed`) for an accurate fail-closed reason.
 */
function resolveAcceptanceCriteria(acceptanceCriteria) {
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) return null;
  const criteria = acceptanceCriteria.map((c) => (typeof c === "string" ? c.trim() : ""));
  if (criteria.some((c) => c.length === 0)) return null;
  const validRefs = new Set(criteria.map((_, i) => `AC${i + 1}`));
  return { criteria, validRefs };
}

function acRefFromValue(value) {
  return typeof value === "string" ? value.trim() : value;
}

function normalizeKeyPart(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The dedupe key. Two findings — from any lenses — are the SAME defect when they
 * share a normalized (stateName, region/selector, category/rule) triple. The
 * separator cannot appear in the normalized parts (the validator rejects any
 * finding that contains it), so the join is unambiguous.
 */
export function lensFindingDedupeKey(finding) {
  return [normalizeKeyPart(finding?.stateName), normalizeKeyPart(finding?.region), normalizeKeyPart(finding?.category)].join(DEDUPE_KEY_SEPARATOR);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fail-closed validator for a raw lens-result set. Rejects a set that is missing
 * a lens, carries an unknown/duplicate lens, or holds a malformed finding —
 * rather than letting the converge seam silently merge a partial review.
 *
 * Also requires the acceptance-criteria list (the same non-empty list
 * `validateUiDesignerReviewInput` requires) and that EVERY finding carries an
 * `acceptanceCriterionRef` mapping to a criterion in it — a finding with no
 * mappable criterion is itself a fail-closed signal, never silently converged.
 *
 * @param {{lens:string, findings:object[]}[]} lensResults
 * @param {string[]} acceptanceCriteria - the criteria findings must map to
 * @returns {{ok:boolean, status:string, reason:string, missing:string[]}}
 */
export function validateUiReviewLensResults(lensResults, acceptanceCriteria) {
  if (!Array.isArray(lensResults)) {
    return { ok: false, status: "blocked_malformed_lens_results", reason: "lens_results_not_array", missing: ["lensResults"] };
  }
  const acResolved = resolveAcceptanceCriteria(acceptanceCriteria);
  if (!acResolved) {
    // Distinguish a genuinely ABSENT list from a PRESENT-but-malformed one (empty
    // array, a non-string/blank entry) so the fail-closed reason is diagnostically
    // accurate — both still block, this only sharpens the "why".
    const absent = acceptanceCriteria === undefined || acceptanceCriteria === null;
    return absent
      ? { ok: false, status: "blocked_missing_acceptance_criteria", reason: "acceptance_criteria_missing", missing: ["acceptanceCriteria"] }
      : { ok: false, status: "blocked_malformed_acceptance_criteria", reason: "acceptance_criteria_malformed", missing: ["acceptanceCriteria"] };
  }
  const seen = new Map();
  const problems = [];
  lensResults.forEach((result, index) => {
    const lensName = result?.lens;
    if (!isNonEmptyString(lensName)) {
      problems.push(`lensResults[${index}].lens`);
      return;
    }
    const name = lensName.trim();
    if (!UI_REVIEW_LENS_NAMES.includes(name)) {
      problems.push(`lensResults[${index}].lens=${name} (unknown lens)`);
      return;
    }
    if (seen.has(name)) {
      problems.push(`lensResults[${index}].lens=${name} (duplicate lens)`);
      return;
    }
    seen.set(name, index);
    if (!Array.isArray(result.findings)) {
      problems.push(`lensResults[${index}].findings`);
      return;
    }
    result.findings.forEach((finding, fIndex) => {
      const where = `lensResults[${index}].findings[${fIndex}]`;
      if (!finding || typeof finding !== "object") {
        problems.push(where);
        return;
      }
      if (!isNonEmptyString(finding.stateName)) problems.push(`${where}.stateName`);
      if (!isNonEmptyString(finding.region)) problems.push(`${where}.region`);
      if (!isNonEmptyString(finding.category)) problems.push(`${where}.category`);
      // The dedupe key joins these three fields with DEDUPE_KEY_SEPARATOR and relies
      // on it never appearing inside a field; a crafted value containing it could
      // forge a key collision (distinct findings merging), so reject it fail-closed.
      for (const field of ["stateName", "region", "category"]) {
        if (typeof finding[field] === "string" && finding[field].includes(DEDUPE_KEY_SEPARATOR)) problems.push(`${where}.${field}`);
      }
      // `includes` on own known keys, NOT `in` — `in` walks Object.prototype, so
      // `severity: "toString"`/"constructor"/"__proto__" would pass and then resolve
      // to a prototype fn in SEVERITY_RANK[...], silently downgrading a real defect.
      if (!isNonEmptyString(finding.severity) || !UI_REVIEW_FINDING_SEVERITIES.includes(finding.severity.trim())) problems.push(`${where}.severity`);
      // `blocking` is REQUIRED (a boolean on every finding): the seam derives
      // blocked_needs_human_decision solely from `blocking: true`, so a finding
      // that OMITS it would silently read as non-blocking and hide a human-decision
      // signal — reject a missing/non-boolean `blocking` fail-closed.
      if (typeof finding.blocking !== "boolean") problems.push(`${where}.blocking`);
      // acceptanceCriterionRef is REQUIRED and MUST map to a criterion in the
      // provided AC list (an `AC<n>` within range). A missing or unmappable ref is
      // a fail-closed malformed finding — coverage is auditable only when every
      // finding names the criterion it speaks to.
      if (!isNonEmptyString(finding.acceptanceCriterionRef) || !acResolved.validRefs.has(finding.acceptanceCriterionRef.trim())) {
        problems.push(`${where}.acceptanceCriterionRef`);
      }
    });
  });
  const missingLenses = UI_REVIEW_LENS_NAMES.filter((name) => !seen.has(name)).map((name) => `lens:${name}`);
  const missing = [...missingLenses, ...problems];
  if (missing.length > 0) {
    return {
      ok: false,
      status: missingLenses.length > 0 && problems.length === 0 ? "blocked_missing_lens" : "blocked_malformed_lens_results",
      reason: missingLenses.length > 0 && problems.length === 0 ? "lens_missing" : "lens_finding_malformed",
      missing,
    };
  }
  return { ok: true, status: "lens_results_complete", reason: "lens_results_complete", missing: [] };
}

/** A finding blocks "satisfied" when its severity is must-fix/high. */
function isMustFixFinding(finding) {
  return MUST_FIX_SEVERITIES.has(finding.severity);
}

/**
 * Pick the representative between a merge candidate and the incumbent: the worse
 * severity wins; on a severity TIE the finding from the earlier canonical lens
 * (`_srcLens`) wins, so the representative's descriptive fields are deterministic
 * regardless of the order the lens results arrive in.
 */
function pickRepresentative(incoming, existing) {
  const bySeverity = SEVERITY_RANK[incoming.severity] - SEVERITY_RANK[existing.severity];
  if (bySeverity !== 0) return bySeverity < 0 ? incoming : existing;
  return LENS_ORDER.get(incoming._srcLens) < LENS_ORDER.get(existing._srcLens) ? incoming : existing;
}

/**
 * Fail-closed-validate the affirmative per-AC "checked" marks: each mark names an
 * AC that maps to the list (`AC<n>` in range) over a NAMED STATE. A "checked" mark
 * is how a criterion is covered by a PASS (an affirmative review with no finding);
 * a malformed mark cannot silently satisfy a criterion, so converge throws on one.
 * An absent/empty list is fine (no passes). Returns the malformed paths (empty ⇒ ok).
 */
function validateCheckedCriteria(checkedCriteria, validRefs) {
  if (checkedCriteria === undefined || checkedCriteria === null) return [];
  if (!Array.isArray(checkedCriteria)) return ["checkedCriteria"];
  const problems = [];
  checkedCriteria.forEach((mark, index) => {
    const where = `checkedCriteria[${index}]`;
    if (!mark || typeof mark !== "object") {
      problems.push(where);
      return;
    }
    if (!isNonEmptyString(mark.acceptanceCriterionRef) || !validRefs.has(mark.acceptanceCriterionRef.trim())) problems.push(`${where}.acceptanceCriterionRef`);
    if (!isNonEmptyString(mark.stateName)) problems.push(`${where}.stateName`);
  });
  return problems;
}

/**
 * The per-criterion coverage audit. An acceptance criterion is COVERED when it is
 * referenced by >=1 converged finding OR by >=1 affirmative "checked" mark over a
 * named state. The full bar (`satisfiedBarMet`) is met only when EVERY criterion
 * is covered — the gate `ui_review_satisfied` sits behind. The audit is emitted on
 * the result so which AC each finding maps to and which ACs are covered vs
 * uncovered are readable straight from the structured output.
 *
 * Attribution note: this runs on the DEDUPED findings, and the dedupe key
 * (stateName, region, category) excludes acceptanceCriterionRef — so a merged
 * defect is credited to its primary (winning) criterion only. A co-flagged loser
 * criterion on a merged finding may still read as an uncovered gap and keep the
 * loop iterating (continue); that is intentional fail-closed behavior (it can only
 * flip satisfied→continue, never the reverse). Reworking the dedupe key is a non-goal.
 */
function computeCoverage(findings, criteria, checkedCriteria) {
  const perRef = new Map(criteria.map((criterion, i) => [`AC${i + 1}`, { ref: `AC${i + 1}`, criterion, findingCount: 0, checked: false }]));
  for (const finding of findings) {
    const entry = perRef.get(finding.acceptanceCriterionRef);
    if (entry) entry.findingCount += 1;
  }
  for (const mark of checkedCriteria ?? []) {
    const entry = perRef.get(acRefFromValue(mark?.acceptanceCriterionRef));
    if (entry) entry.checked = true;
  }
  const perCriterion = [...perRef.values()].map((entry) => ({ ...entry, covered: entry.findingCount > 0 || entry.checked }));
  const covered = perCriterion.filter((entry) => entry.covered).map((entry) => entry.ref);
  const uncovered = perCriterion.filter((entry) => !entry.covered).map((entry) => entry.ref);
  return { perCriterion, covered, uncovered, satisfiedBarMet: uncovered.length === 0 };
}

/**
 * Map the deduped findings to the UNCHANGED outcome enum, by the same rules the
 * designer/vision contract states, now GATED on per-criterion coverage:
 *   - any fail-closed signal (`blocking: true`)   ⇒ blocked_needs_human_decision
 *   - else any must-fix finding                   ⇒ continue_ui_fix_loop (not satisfied)
 *   - else any UNCOVERED acceptance criterion      ⇒ continue_ui_fix_loop (coverage gap)
 *   - else                                         ⇒ ui_review_satisfied
 * Precedence: blocked > continue > satisfied. An unaudited criterion (no finding
 * AND no affirmative check) is a coverage GAP, not a human-decision blocker, so it
 * downgrades satisfaction to continue rather than escalating.
 */
function deriveOutcome(findings, coverage) {
  if (findings.some((f) => f.blocking === true)) return UI_REVIEW_OUTCOMES.BLOCKED;
  if (findings.some(isMustFixFinding)) return UI_REVIEW_OUTCOMES.CONTINUE;
  if (!coverage.satisfiedBarMet) return UI_REVIEW_OUTCOMES.CONTINUE;
  return UI_REVIEW_OUTCOMES.SATISFIED;
}

/**
 * Converge N lens findings into one DEDUPED set + the outcome enum. Pure.
 *
 * Dedupe: findings that share the (stateName, region, category) key collapse to
 * one representative — the highest-severity finding wins (ties broken by the
 * canonical lens order), and every contributing lens is recorded on
 * `lenses` (sorted) so provenance survives the merge.
 *
 * Ordering is stable and deterministic: by stateName, then severity (worst
 * first), then region, then category.
 *
 * Fails closed: a malformed/partial lens-result set (or a missing acceptance-
 * criteria list, an unmappable finding ref, or a malformed checked mark) throws
 * rather than converging a partial/unauditable review (see
 * validateUiReviewLensResults / validateCheckedCriteria).
 *
 * `ui_review_satisfied` is GATED on per-criterion coverage: it is returned only
 * when every acceptance criterion is covered by >=1 finding-or-affirmative-check
 * (and there are no must-fix/blocking findings). The coverage audit is emitted on
 * the result so satisfaction is auditable rather than a gestalt call.
 *
 * @param {{lens:string, findings:object[]}[]} lensResults
 * @param {{acceptanceCriteria:string[], checkedCriteria?:{acceptanceCriterionRef:string, stateName:string}[]}} options
 * @returns {{findings:object[], outcome:string, coverage:object}}
 */
export function convergeUiReviewLenses(lensResults, { acceptanceCriteria, checkedCriteria } = {}) {
  const validation = validateUiReviewLensResults(lensResults, acceptanceCriteria);
  if (!validation.ok) {
    throw new Error(`convergeUiReviewLenses: refusing to converge a ${validation.reason} lens-result set; missing/malformed: ${validation.missing.join(", ")}`);
  }
  const { criteria, validRefs } = resolveAcceptanceCriteria(acceptanceCriteria);
  const checkedProblems = validateCheckedCriteria(checkedCriteria, validRefs);
  if (checkedProblems.length > 0) {
    throw new Error(`convergeUiReviewLenses: refusing to converge with malformed checked-criteria; malformed: ${checkedProblems.join(", ")}`);
  }

  const byKey = new Map();
  for (const result of lensResults) {
    const lens = result.lens.trim();
    for (const raw of result.findings) {
      const finding = {
        stateName: raw.stateName,
        region: raw.region,
        category: raw.category,
        acceptanceCriterionRef: raw.acceptanceCriterionRef.trim(),
        severity: raw.severity.trim(),
        blocking: raw.blocking === true,
        problem: isNonEmptyString(raw.problem) ? raw.problem : null,
        suggestedFix: isNonEmptyString(raw.suggestedFix) ? raw.suggestedFix : null,
        evidence: raw.evidence && typeof raw.evidence === "object" ? raw.evidence : null,
        lenses: [lens],
        _srcLens: lens,
      };
      const key = lensFindingDedupeKey(finding);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, finding);
        continue;
      }
      // Merge: keep the worse severity as the representative (its problem/
      // suggestedFix/evidence follow via the `...winner` spread); on a severity
      // tie the earlier canonical lens wins (pickRepresentative) so the result is
      // input-order-independent; a blocking signal from any contributing lens
      // survives; union the contributing lenses. The representative keeps its own
      // acceptanceCriterionRef (the same defect maps to one primary criterion).
      const lenses = [...new Set([...existing.lenses, lens])].sort();
      const winner = pickRepresentative(finding, existing);
      byKey.set(key, { ...winner, blocking: existing.blocking || finding.blocking, lenses });
    }
  }

  const findings = [...byKey.values()].map(({ _srcLens, ...finding }) => finding).sort((a, b) => {
    return (
      a.stateName.localeCompare(b.stateName) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.region.localeCompare(b.region) ||
      a.category.localeCompare(b.category)
    );
  });

  const coverage = computeCoverage(findings, criteria, checkedCriteria);
  return { findings, outcome: deriveOutcome(findings, coverage), coverage };
}

/**
 * Route entrypoint: converge the FLAT per-lens findings array the review route
 * (the vision template) emits into the same `{findings, outcome}` the seam owns.
 *
 * The template emits one findings array where every finding is tagged with the
 * `lens` that produced it; the converge seam consumes findings GROUPED by lens
 * (all four lenses present). This is the seam's real caller: it groups the flat
 * route output into the canonical four-lens result set — seeding an empty bucket
 * for every canonical lens so an all-clean lens is still present — then hands it
 * to `convergeUiReviewLenses`. A finding tagged with an unknown/missing lens
 * lands in its own bucket, so the fail-closed validator rejects it rather than
 * dropping it.
 *
 * The acceptance-criteria list and the affirmative per-AC `checkedCriteria` marks
 * pass straight through to `convergeUiReviewLenses`, which gates
 * `ui_review_satisfied` on per-criterion coverage and emits the coverage audit.
 *
 * @param {object[]} routeFindings - the template's flat `findings[]` (each `{lens, ...}`)
 * @param {{acceptanceCriteria:string[], checkedCriteria?:{acceptanceCriterionRef:string, stateName:string}[]}} options
 * @returns {{findings:object[], outcome:string, coverage:object}}
 */
export function convergeUiReviewRouteFindings(routeFindings, options = {}) {
  if (!Array.isArray(routeFindings)) {
    throw new Error("convergeUiReviewRouteFindings: expected a findings array from the review route");
  }
  const byLens = new Map(UI_REVIEW_LENS_NAMES.map((name) => [name, []]));
  for (const finding of routeFindings) {
    const lens = typeof finding?.lens === "string" ? finding.lens.trim() : finding?.lens;
    if (!byLens.has(lens)) byLens.set(lens, []);
    byLens.get(lens).push(finding);
  }
  const lensResults = [...byLens.entries()].map(([lens, findings]) => ({ lens, findings }));
  return convergeUiReviewLenses(lensResults, options);
}
