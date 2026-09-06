/**
 * spec-authority.mjs — the canonical shared contract surface for IMMUTABLE SPEC
 * AUTHORITY across the review / judge / fixer / gate / re-entry pipeline.
 *
 * This module is PURE and side-effect free. It owns, in one place (so no harness
 * prompt has to re-state normative rules that could drift):
 *
 *   1. The two INDEPENDENT revision identities every decision must pin:
 *      - `specDigest`     — a deterministic digest of the normalized canonical
 *        tracker AC / DoD / Non-goals. It identifies what the work is REQUIRED
 *        and FORBIDDEN to do. It is NEVER derived from a head SHA.
 *      - reviewed implementation revision — `headSha` plus a `contentDigest`.
 *        It identifies what the reviewer actually evaluated. A new head/content
 *        digest NEVER masquerades as a spec change.
 *
 *   2. The four named, machine-readable judge disposition outcomes. For every
 *      finding the judge evaluates the finding AND each proposed remediation
 *      against the COMPLETE spec (not one supportive criterion) and selects
 *      exactly one outcome.
 *
 *   3. Autonomous vs last-resort escalation: only a `spec_cannot_decide` outcome
 *      routes to a human-spec-decision state. A finding/remediation conflict
 *      resolves autonomously (reject the finding, or reject the remedy and route
 *      to a compliant alternative).
 *
 *   4. Human-only spec change: a material spec change/reinterpretation produces a
 *      NEW `specDigest`; every approval/disposition/gate result derived from the
 *      prior digest is stale and must be re-established.
 *
 *   5. Criterion-scoped invalidation: a fixer push stales only the approvals for
 *      the criteria whose covered content it changed; unaffected criteria carry
 *      forward ONLY with positive deterministic proof that both their governing
 *      spec text and their covered surface are unchanged. Unknown impact fails
 *      closed to fresh review.
 *
 * Persistence is the caller's job; this module validates and decides, it never
 * reads or writes files.
 */

import { sha256Hex } from "./review-dispatch-plan.mjs";
import { extractSection } from "./markdown-sections.mjs";
import { extractChecklistItems } from "./issue-refinement-artifact.mjs";

/**
 * Canonical spec category keys, in the fixed order the digest serializes them.
 * A criterion's identity is (category, source-index) under one `specDigest`; the
 * order here is therefore part of the contract, not incidental.
 */
export const SPEC_CATEGORIES = Object.freeze([
  "acceptanceCriteria",
  "definitionOfDone",
  "nonGoals",
]);

/**
 * Short stable id prefix per category. A criterion id is `<prefix>:<index>`
 * (0-based within its category, source order), e.g. `ac:0`, `dod:2`, `ng:1`.
 * Index-based ids are stable UNDER ONE `specDigest`: any insertion/removal that
 * would shift an index also changes the normalized spec text and therefore the
 * digest, which stales every derived approval anyway.
 */
export const CATEGORY_ID_PREFIX = Object.freeze({
  acceptanceCriteria: "ac",
  definitionOfDone: "dod",
  nonGoals: "ng",
});

/** Digest domain separators so the same bytes can never collide across the two
 * identity namespaces (a spec that happens to equal reviewed content still
 * produces two distinct digests). Carried as a field of the hashed object. */
const SPEC_DIGEST_DOMAIN = "spec-authority:spec:v1";
const CONTENT_DIGEST_DOMAIN = "spec-authority:content:v1";

/** Self-describing digest prefix. A `specDigest`/`contentDigest` is always
 * `sha256:<64 hex>`; a `headSha` is bare hex. The prefix makes it structurally
 * impossible to pass a head SHA where a spec digest is required (and vice
 * versa), which is the mechanical half of "specDigest is never derived from
 * headSha". */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** A git head SHA: bare hex, 7-64 chars (matches judge-pass's own --head-sha
 * validation), compared trim+lowercase everywhere. */
export const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * The four named judge disposition outcomes. Exactly one is selected per
 * finding after evaluating the finding AND each proposed remediation against
 * the COMPLETE spec.
 */
export const SPEC_AUTHORITY_OUTCOMES = Object.freeze({
  /** Finding valid and its remediation compliant with the whole spec: authorize
   * the compliant remedy (the fixer may choose among compliant alternatives). */
  VALID_COMPLIANT: "valid_compliant",
  /** The finding itself conflicts with an AC/DoD/non-goal: reject it
   * autonomously. It cannot trigger a fix or block a clean verdict by existing. */
  FINDING_CONFLICTS: "finding_conflicts",
  /** Finding valid but its PROPOSED remediation conflicts with the spec: keep
   * the finding, reject that remedy autonomously, route to a compliant
   * alternative. */
  REMEDIATION_CONFLICTS: "remediation_conflicts",
  /** The spec cannot decide the work (materially ambiguous, internally
   * contradictory, or progress requires changing/reinterpreting AC/DoD/non-goals):
   * escalate to an explicit human-spec-decision state. LAST RESORT only. */
  SPEC_CANNOT_DECIDE: "spec_cannot_decide",
});

export const SPEC_AUTHORITY_OUTCOME_VALUES = Object.freeze(
  Object.values(SPEC_AUTHORITY_OUTCOMES),
);

/** The ONLY outcome that escalates to a human-spec-decision state. The other
 * three resolve autonomously. Exported so no consumer re-hardcodes the set. */
export const HUMAN_SPEC_DECISION_OUTCOME = SPEC_AUTHORITY_OUTCOMES.SPEC_CANNOT_DECIDE;

/**
 * Does an outcome require the loop to stop at the human-spec-decision state?
 * Only `spec_cannot_decide` does — a finding/remediation conflict alone never
 * justifies escalation (the judge rejects it or routes to a compliant remedy).
 * @param {string} outcome
 * @returns {boolean}
 */
export function outcomeRequiresHumanDecision(outcome) {
  return outcome === HUMAN_SPEC_DECISION_OUTCOME;
}

/**
 * Normalize one criterion line into stable digest/compare text: strip a leading
 * bullet/checkbox marker (defensive — extractChecklistItems already does for
 * body-parsed specs, but a structured caller may pass raw lines), collapse
 * internal whitespace, and trim. Case is PRESERVED (it is semantic).
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeCriterionText(text) {
  return String(text ?? "")
    .replace(/^\s*(?:>|\s)*(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^\[[ xX]\]\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Normalize a spec into the canonical shape the digest serializes. Accepts a
 * `{ acceptanceCriteria, definitionOfDone, nonGoals }` object of string arrays.
 * Each item is normalized via {@link normalizeCriterionText}; empties are
 * dropped; SOURCE ORDER is preserved (order is criterion identity).
 *
 * Fail-closed: a spec with no acceptance criteria is not an authoritative spec
 * (there is nothing the work is required to do), so it throws rather than
 * digesting an empty authority.
 *
 * @param {{ acceptanceCriteria?: unknown, definitionOfDone?: unknown, nonGoals?: unknown }} spec
 * @returns {{ acceptanceCriteria: string[], definitionOfDone: string[], nonGoals: string[] }}
 */
export function normalizeSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("spec must be an object with acceptanceCriteria/definitionOfDone/nonGoals arrays");
  }
  const normalizeList = (value, label) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new Error(`spec.${label} must be an array of strings`);
    }
    return value
      .map((item) => normalizeCriterionText(item))
      .filter((item) => item.length > 0);
  };
  const normalized = {
    acceptanceCriteria: normalizeList(spec.acceptanceCriteria, "acceptanceCriteria"),
    definitionOfDone: normalizeList(spec.definitionOfDone, "definitionOfDone"),
    nonGoals: normalizeList(spec.nonGoals, "nonGoals"),
  };
  if (normalized.acceptanceCriteria.length === 0) {
    throw new Error("spec has no acceptance criteria — not an authoritative spec (fail closed)");
  }
  return normalized;
}

/**
 * The ordered criterion id list for a spec — the COMPLETE authoritative set the
 * judge must evaluate every finding against. `<prefix>:<index>` per item, in
 * SPEC_CATEGORIES order. Accepts either a raw or already-normalized spec.
 * @param {object} spec
 * @returns {string[]}
 */
export function specCriterionIds(spec) {
  // ALWAYS normalize — never trust the input to be pre-normalized. normalizeSpec
  // is idempotent on already-normalized text, and normalizing here is what keeps
  // the criterion id set byte-aligned with computeSpecDigest's own normalized
  // view: a raw spec carrying an empty/whitespace-only criterion would otherwise
  // yield a phantom id (and shift every later index) that the digested set does
  // not, so the two revision-identity views would disagree on the same input.
  const normalized = normalizeSpec(spec);
  const ids = [];
  for (const category of SPEC_CATEGORIES) {
    normalized[category].forEach((_item, index) => {
      ids.push(`${CATEGORY_ID_PREFIX[category]}:${index}`);
    });
  }
  return ids;
}

/**
 * Deterministic digest of the normalized AC/DoD/Non-goals. Identifies the spec
 * authority. Never takes or derives from a head SHA. Same normalized spec always
 * yields the same digest; any AC/DoD/non-goal text change yields a new one.
 * @param {object} spec
 * @returns {string} `sha256:<hex>`
 */
export function computeSpecDigest(spec) {
  const normalized = normalizeSpec(spec);
  return sha256Hex({
    domain: SPEC_DIGEST_DOMAIN,
    v: 1,
    acceptanceCriteria: normalized.acceptanceCriteria,
    definitionOfDone: normalized.definitionOfDone,
    nonGoals: normalized.nonGoals,
  });
}

/**
 * Deterministic digest of the reviewed implementation/prose content. A DISTINCT
 * identity from `specDigest` (separate domain tag), so identical bytes reviewed
 * as content never collide with the same bytes read as spec.
 * @param {unknown} content
 * @returns {string} `sha256:<hex>`
 */
export function computeContentDigest(content) {
  return sha256Hex({ domain: CONTENT_DIGEST_DOMAIN, v: 1, content: String(content ?? "") });
}

function assertDigestShape(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    throw new Error(`${label} must be a "sha256:<64 hex>" digest`);
  }
  return value;
}

function normalizeHeadSha(value, label = "headSha") {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!HEAD_SHA_RE.test(sha)) {
    throw new Error(`${label} must be a 7-64 char hex git SHA`);
  }
  return sha;
}

/**
 * Build (or validate) the two independent revision identities for a decision.
 * Enforces the core invariant fail-closed: `specDigest` and `contentDigest` are
 * both `sha256:`-prefixed and MUST differ from each other and from the bare
 * `headSha` — a head SHA can never stand in for a spec digest.
 *
 * @param {object} input
 * @param {object} [input.spec] — used to compute specDigest when not supplied
 * @param {string} [input.specDigest]
 * @param {string} input.headSha
 * @param {unknown} [input.content] — used to compute contentDigest when not supplied
 * @param {string} [input.contentDigest]
 * @returns {{ specDigest: string, headSha: string, contentDigest: string }}
 */
export function buildRevisionIdentity({ spec, specDigest, headSha, content, contentDigest } = {}) {
  const resolvedSpecDigest = assertDigestShape(
    specDigest ?? computeSpecDigest(spec),
    "specDigest",
  );
  const sha = normalizeHeadSha(headSha);
  const resolvedContentDigest = assertDigestShape(
    contentDigest ?? computeContentDigest(content),
    "contentDigest",
  );
  if (resolvedSpecDigest === resolvedContentDigest) {
    throw new Error("SPEC-AUTHORITY-REVISION-IDENTITIES: specDigest and contentDigest must be distinct identities (fail closed)");
  }
  // The domain separator in computeSpecDigest is the structural guarantee that a
  // specDigest is never derivable from a head SHA. This is the defensive tripwire
  // for an explicitly-SUPPLIED digest: reject when the digest's hex body equals or
  // embeds the head SHA (any length), not only the 64-hex exact case — the
  // exact-equality-only form was a no-op for a normal 40-hex Git SHA. The
  // false-positive probability of a real spec digest incidentally embedding the
  // head SHA is negligible, and the fail-closed direction is safe.
  if (resolvedSpecDigest.slice("sha256:".length).includes(sha)) {
    throw new Error("SPEC-AUTHORITY-REVISION-IDENTITIES: specDigest must not be derived from or embed headSha (fail closed)");
  }
  return { specDigest: resolvedSpecDigest, headSha: sha, contentDigest: resolvedContentDigest };
}

function normalizeIdSet(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of criterion ids`);
  }
  const set = new Set();
  for (const raw of value) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error(`${label} must contain only non-empty criterion id strings`);
    }
    set.add(raw.trim());
  }
  return set;
}

/**
 * Validate ONE judge decision for a single finding against the complete spec.
 * Pure and fail-closed: throws (never returns a partial decision) unless every
 * authority invariant holds. Returns the normalized decision on success.
 *
 * Decision shape:
 * ```
 * {
 *   index: <0-based finding index>,
 *   outcome: <one of SPEC_AUTHORITY_OUTCOME_VALUES>,
 *   specDigest, headSha, contentDigest,   // must match the run's current identities
 *   checkedCriteria: [<every criterion id>], // WHOLE-spec coverage; a partial /
 *                                            // supportive-only subset fails closed
 *   conflictingCriteria: [<ids>],         // required + non-empty for the two conflict outcomes
 *   rationale: "<non-empty>",
 *   authorizedRemediation: "<...>",       // required for valid_compliant
 *   rejectedRemediations: ["<...>"]       // optional audit of rejected options
 * }
 * ```
 *
 * @param {unknown} decision
 * @param {object} context
 * @param {string} context.specDigest — the run's current spec digest
 * @param {string} context.headSha — the run's current reviewed head
 * @param {string} context.contentDigest — the run's current reviewed content digest
 * @param {string[]} context.criterionIds — the COMPLETE ordered criterion id set
 * @returns {object} the normalized decision
 */
export function validateSpecAuthorityDecision(decision, { specDigest, headSha, contentDigest, criterionIds } = {}) {
  const currentSpecDigest = assertDigestShape(specDigest, "context.specDigest");
  const currentHead = normalizeHeadSha(headSha, "context.headSha");
  const currentContentDigest = assertDigestShape(contentDigest, "context.contentDigest");
  const fullCriteria = normalizeIdSet(criterionIds, "context.criterionIds");
  if (fullCriteria.size === 0) {
    throw new Error("context.criterionIds must be the non-empty complete criterion set (fail closed)");
  }

  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("spec-authority decision must be an object");
  }
  const d = /** @type {Record<string, unknown>} */ (decision);
  if (!Number.isInteger(d.index) || /** @type {number} */ (d.index) < 0) {
    throw new Error("spec-authority decision.index must be a non-negative integer");
  }
  if (!SPEC_AUTHORITY_OUTCOME_VALUES.includes(d.outcome)) {
    throw new Error(
      `spec-authority decision.outcome must be one of: ${SPEC_AUTHORITY_OUTCOME_VALUES.join(", ")}`,
    );
  }
  // Revision identities must be pinned AND current. A stale specDigest/headSha/
  // contentDigest fails closed — a decision made against an old revision must
  // never authorize a fix or a gate transition at the current one.
  if (assertDigestShape(d.specDigest, "decision.specDigest") !== currentSpecDigest) {
    throw new Error("SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED: decision.specDigest is stale/mismatched — re-decide against the current spec (fail closed)");
  }
  if (normalizeHeadSha(d.headSha, "decision.headSha") !== currentHead) {
    throw new Error("SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED: decision.headSha is stale/mismatched — re-decide against the current head (fail closed)");
  }
  if (assertDigestShape(d.contentDigest, "decision.contentDigest") !== currentContentDigest) {
    throw new Error("SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED: decision.contentDigest is stale/mismatched — re-decide against the current content (fail closed)");
  }
  if (typeof d.rationale !== "string" || d.rationale.trim().length === 0) {
    throw new Error("spec-authority decision.rationale must be a non-empty string");
  }

  // WHOLE-SPEC evaluation: checkedCriteria must cover EVERY criterion id. A
  // partial / supportive-only subset cannot produce a valid disposition — this
  // is the deterministic enforcement of "a citation to one supportive criterion
  // is insufficient".
  const checked = normalizeIdSet(d.checkedCriteria, "decision.checkedCriteria");
  const foreign = [...checked].filter((id) => !fullCriteria.has(id));
  if (foreign.length > 0) {
    throw new Error(`spec-authority decision.checkedCriteria names unknown criterion id(s): ${foreign.join(", ")}`);
  }
  const uncovered = [...fullCriteria].filter((id) => !checked.has(id));
  if (uncovered.length > 0) {
    throw new Error(`SPEC-AUTHORITY-WHOLE-SPEC-EVAL: decision did not evaluate the whole spec, so it cannot produce a valid disposition — uncovered criteria: ${uncovered.join(", ")} (supportive-only/partial citation is insufficient; fail closed)`);
  }

  // The two conflict outcomes require explicit conflict evidence: a non-empty
  // conflictingCriteria drawn from the spec. Autonomous rejection is only
  // legitimate when it names what the finding/remedy conflicts with.
  const isConflict =
    d.outcome === SPEC_AUTHORITY_OUTCOMES.FINDING_CONFLICTS ||
    d.outcome === SPEC_AUTHORITY_OUTCOMES.REMEDIATION_CONFLICTS;
  let conflictingCriteria = [];
  if (isConflict) {
    const conflicts = normalizeIdSet(d.conflictingCriteria, "decision.conflictingCriteria");
    if (conflicts.size === 0) {
      throw new Error(`SPEC-AUTHORITY-CONFLICT-EVIDENCE: ${d.outcome} decision requires non-empty conflictingCriteria (explicit conflict evidence; fail closed)`);
    }
    const unknownConflicts = [...conflicts].filter((id) => !fullCriteria.has(id));
    if (unknownConflicts.length > 0) {
      throw new Error(`spec-authority decision.conflictingCriteria names unknown criterion id(s): ${unknownConflicts.join(", ")}`);
    }
    conflictingCriteria = [...conflicts];
  } else if (d.conflictingCriteria !== undefined && d.conflictingCriteria !== null) {
    // A non-conflict outcome must not smuggle a conflict list.
    throw new Error(`spec-authority ${d.outcome} decision must not carry conflictingCriteria`);
  }

  // valid_compliant must name the authorized (compliant) remediation. The fixer
  // may choose among compliant alternatives, but the judge authorizes a concrete
  // compliant direction, not a blank check.
  let authorizedRemediation;
  if (d.outcome === SPEC_AUTHORITY_OUTCOMES.VALID_COMPLIANT) {
    if (typeof d.authorizedRemediation !== "string" || d.authorizedRemediation.trim().length === 0) {
      throw new Error("spec-authority valid_compliant decision requires a non-empty authorizedRemediation");
    }
    authorizedRemediation = d.authorizedRemediation.trim();
  }

  const rejectedRemediations = Array.isArray(d.rejectedRemediations)
    ? d.rejectedRemediations.filter((r) => typeof r === "string" && r.trim().length > 0).map((r) => r.trim())
    : [];

  return {
    index: d.index,
    outcome: d.outcome,
    specDigest: currentSpecDigest,
    headSha: currentHead,
    contentDigest: currentContentDigest,
    checkedCriteria: [...checked],
    conflictingCriteria,
    rationale: d.rationale.trim(),
    ...(authorizedRemediation ? { authorizedRemediation } : {}),
    ...(rejectedRemediations.length > 0 ? { rejectedRemediations } : {}),
    requiresHumanDecision: outcomeRequiresHumanDecision(d.outcome),
  };
}

/**
 * Validate a full spec-authority verdict block (the per-run judge record that
 * accompanies the relevance verdict): the pinned run identities plus one
 * validated decision per finding. Fail-closed: every finding index must be
 * disposed exactly once, and any `spec_cannot_decide` decision surfaces
 * `humanDecisionRequired` so the caller stops at the human-spec-decision state.
 *
 * @param {unknown} verdict — { specDigest, headSha, contentDigest, decisions: [...] }
 * @param {object} context
 * @param {number} context.findingsCount — number of findings the verdict must cover
 * @param {string[]} context.criterionIds — the complete criterion id set
 * @returns {{ specDigest: string, headSha: string, contentDigest: string,
 *   decisions: object[], humanDecisionRequired: boolean,
 *   humanDecisionIndices: number[], outcomeCounts: Record<string, number> }}
 */
export function validateSpecAuthorityVerdict(verdict, { findingsCount, criterionIds } = {}) {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("spec-authority verdict must be an object");
  }
  const v = /** @type {Record<string, unknown>} */ (verdict);
  const specDigest = assertDigestShape(v.specDigest, "verdict.specDigest");
  const headSha = normalizeHeadSha(v.headSha, "verdict.headSha");
  const contentDigest = assertDigestShape(v.contentDigest, "verdict.contentDigest");
  if (!Number.isInteger(findingsCount) || findingsCount < 0) {
    throw new Error("context.findingsCount must be a non-negative integer");
  }
  if (!Array.isArray(v.decisions)) {
    throw new Error("spec-authority verdict.decisions must be an array");
  }
  const decisions = [];
  const seen = new Set();
  const outcomeCounts = Object.fromEntries(SPEC_AUTHORITY_OUTCOME_VALUES.map((o) => [o, 0]));
  const humanDecisionIndices = [];
  for (const raw of v.decisions) {
    const decision = validateSpecAuthorityDecision(raw, { specDigest, headSha, contentDigest, criterionIds });
    if (decision.index >= findingsCount) {
      throw new Error(`spec-authority decision index ${decision.index} is out of range (findings has ${findingsCount} entries)`);
    }
    if (seen.has(decision.index)) {
      throw new Error(`spec-authority verdict has a duplicate decision for finding index ${decision.index}`);
    }
    seen.add(decision.index);
    outcomeCounts[decision.outcome] += 1;
    if (decision.requiresHumanDecision) humanDecisionIndices.push(decision.index);
    decisions.push(decision);
  }
  const uncovered = [];
  for (let i = 0; i < findingsCount; i += 1) {
    if (!seen.has(i)) uncovered.push(i);
  }
  if (uncovered.length > 0) {
    throw new Error(
      `spec-authority verdict does not dispose ${uncovered.length} finding(s) (indexes: ${uncovered.join(", ")}) — every finding needs a whole-spec outcome (fail closed)`,
    );
  }
  // Canonical ordering: sort by finding index so a verdict's decisions,
  // humanDecisionIndices, and any downstream join (e.g. the human-decision
  // reason string) are byte-stable regardless of the input's submission order —
  // required for cross-harness determinism.
  decisions.sort((a, b) => a.index - b.index);
  humanDecisionIndices.sort((a, b) => a - b);
  return {
    specDigest,
    headSha,
    contentDigest,
    decisions,
    humanDecisionRequired: humanDecisionIndices.length > 0,
    humanDecisionIndices,
    outcomeCounts,
  };
}

/**
 * Resolve which prior criterion approvals survive a revision change. This is the
 * one authority for both invalidation rules:
 *
 *  - SPEC CHANGE (currentSpecDigest !== priorSpecDigest): a human-approved spec
 *    change stales EVERY prior-derived approval. Nothing carries; all must be
 *    re-established against the new spec.
 *  - CONTENT CHANGE (same specDigest, a fixer push): only the approvals for the
 *    criteria whose covered content the push changed (`affectedCriteria`) are
 *    stale. An unaffected criterion carries forward ONLY when `carryForwardProof`
 *    positively proves BOTH its governing spec text is unchanged AND its covered
 *    surface is unchanged. Missing/incomplete/false proof for an unaffected
 *    criterion fails closed to fresh review (stale).
 *
 * Fully deterministic and fail-closed. Unknown impact always stales.
 *
 * @param {object} input
 * @param {string} input.priorSpecDigest
 * @param {string} input.currentSpecDigest
 * @param {string[]} input.priorApprovedCriteria — criterion ids approved under the prior revision
 * @param {string[]} [input.affectedCriteria] — ids whose covered content the push changed
 * @param {Record<string, { specTextUnchanged?: boolean, coveredSurfaceUnchanged?: boolean }>} [input.carryForwardProof]
 * @returns {{ specChanged: boolean, stale: string[], carried: string[], reasons: Record<string, string> }}
 */
export function resolveCriterionInvalidation({
  priorSpecDigest,
  currentSpecDigest,
  priorApprovedCriteria,
  affectedCriteria = [],
  carryForwardProof = {},
} = {}) {
  const prior = assertDigestShape(priorSpecDigest, "priorSpecDigest");
  const current = assertDigestShape(currentSpecDigest, "currentSpecDigest");
  const approved = [...normalizeIdSet(priorApprovedCriteria, "priorApprovedCriteria")];
  const reasons = {};

  if (prior !== current) {
    // Human-approved spec change: a new specDigest invalidates every derived
    // approval. Nothing carries.
    for (const id of approved) reasons[id] = "spec_digest_changed — prior approval derived from a superseded spec revision";
    return { specChanged: true, stale: approved, carried: [], reasons };
  }

  const affected = normalizeIdSet(affectedCriteria, "affectedCriteria");
  const stale = [];
  const carried = [];
  for (const id of approved) {
    if (affected.has(id)) {
      stale.push(id);
      reasons[id] = "fixer push changed content covered by this criterion — approval stale, fresh review required";
      continue;
    }
    const proof = carryForwardProof[id];
    const proven =
      proof && typeof proof === "object" &&
      proof.specTextUnchanged === true &&
      proof.coveredSurfaceUnchanged === true;
    if (proven) {
      carried.push(id);
      reasons[id] = "carried forward — proven spec text unchanged and covered surface unchanged";
    } else {
      stale.push(id);
      reasons[id] = "unaffected but carry-forward not positively proven (spec text and/or covered surface unproven) — fail closed to fresh review";
    }
  }
  return { specChanged: false, stale, carried, reasons };
}

/**
 * AC1 (issue 2008 / ADR 0061): the ONE shared identity-stamp helper every
 * gate/fixer record writer threads its revision identity + checked criteria
 * through, so the writers cannot drift from independently-recomputed fields.
 * Validates the pinned trio (reusing {@link assertDigestShape} /
 * {@link normalizeHeadSha}) plus the checked criteria (reusing
 * {@link normalizeIdSet}, sorted for byte-stable determinism), and returns a
 * NEW object — never mutates `record` — with the stamp nested under a
 * `specAuthority` key so it can never collide with a writer's own fields.
 * Fail-closed: throws on a missing/invalid identity rather than silently
 * stamping a partial/malformed trio.
 *
 * @param {object} record — the record to stamp (spread into the returned copy)
 * @param {object} identity
 * @param {string} identity.specDigest
 * @param {string} identity.headSha
 * @param {string} identity.contentDigest
 * @param {string[]} identity.checkedCriteria
 * @returns {object} `{ ...record, specAuthority: { specDigest, headSha, contentDigest, checkedCriteria } }`
 */
export function stampSpecAuthorityIdentity(record, { specDigest, headSha, contentDigest, checkedCriteria } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("stampSpecAuthorityIdentity: record must be an object");
  }
  const stampedSpecDigest = assertDigestShape(specDigest, "specDigest");
  const stampedHeadSha = normalizeHeadSha(headSha);
  const stampedContentDigest = assertDigestShape(contentDigest, "contentDigest");
  const checked = [...normalizeIdSet(checkedCriteria, "checkedCriteria")].sort();
  return {
    ...record,
    specAuthority: {
      specDigest: stampedSpecDigest,
      headSha: stampedHeadSha,
      contentDigest: stampedContentDigest,
      checkedCriteria: checked,
    },
  };
}

// ---------------------------------------------------------------------------
// AC7 (issue 2008 / ADR 0061): pure affected-criteria producer
// ---------------------------------------------------------------------------

// ponytail: minimal glob subset — exact path, a `dir/**` prefix, or a single
// `*` (matches any run of non-`/` characters) within one path segment. Every
// OTHER character, including every other regex metacharacter (`?`, `.`, `+`,
// `(`, `)`, `[`, `]`, `{`, `}`, `^`, `$`, `|`), is matched LITERALLY — a glob
// is never handed to RegExp unescaped. No glob/minimatch/picomatch util
// exists in this repo (checked packages/core/src and
// analysis/change-classifier.mjs); upgrade to picomatch/minimatch if a
// coverage map ever needs a richer subset (brace expansion, mid-pattern `**`).
function matchesCoverageGlob(pattern, filePath) {
  if (pattern === filePath) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/gu, "\\$&").replace(/\*/gu, "[^/]*");
    return new RegExp(`^${escaped}$`, "u").test(filePath);
  }
  return false;
}

/**
 * Pure, fail-closed producer: map a fixer push's changed paths to the
 * criteria whose declared coverage they touch. A changed path matching >=1
 * criterion's glob(s) marks those criteria affected. A changed path matching
 * ZERO criteria fails closed: it is recorded in `unmatchedPaths` and sets
 * `uncertain: true` so the caller (the judge-pass bridge) treats every
 * prior-approved criterion as affected (the pre-existing all-stale fallback)
 * instead of silently under-staling an unmapped change.
 *
 * @param {object} input
 * @param {string[]} input.changedPaths — repo-relative paths a fixer push changed
 * @param {Record<string, string[]>} input.criterionCoverage — criterionId -> glob pattern array
 * @returns {{ affectedCriteria: string[], uncertain: boolean, unmatchedPaths: string[] }}
 */
export function resolveAffectedCriteria({ changedPaths, criterionCoverage } = {}) {
  if (!Array.isArray(changedPaths)) {
    throw new Error("changedPaths must be an array of repo-relative path strings");
  }
  const paths = changedPaths.map((p, i) => {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new Error(`changedPaths[${i}] must be a non-empty string`);
    }
    return p.trim();
  });
  if (!criterionCoverage || typeof criterionCoverage !== "object" || Array.isArray(criterionCoverage)) {
    throw new Error("criterionCoverage must be an object mapping criterionId -> glob pattern array");
  }
  const coverageEntries = Object.entries(criterionCoverage).map(([criterionId, globs]) => {
    if (criterionId.trim().length === 0) {
      throw new Error("criterionCoverage keys must be non-empty criterion id strings");
    }
    if (!Array.isArray(globs)) {
      throw new Error(`criterionCoverage[${JSON.stringify(criterionId)}] must be an array of glob strings`);
    }
    const patterns = globs.map((g, i) => {
      if (typeof g !== "string" || g.trim().length === 0) {
        throw new Error(`criterionCoverage[${JSON.stringify(criterionId)}][${i}] must be a non-empty glob string`);
      }
      return g.trim();
    });
    return [criterionId, patterns];
  });

  const affected = new Set();
  const unmatchedPaths = [];
  for (const filePath of paths) {
    let matchedAny = false;
    for (const [criterionId, patterns] of coverageEntries) {
      if (patterns.some((pattern) => matchesCoverageGlob(pattern, filePath))) {
        affected.add(criterionId);
        matchedAny = true;
      }
    }
    if (!matchedAny) unmatchedPaths.push(filePath);
  }
  return {
    affectedCriteria: [...affected].sort(),
    uncertain: unmatchedPaths.length > 0,
    unmatchedPaths,
  };
}

/**
 * Convenience: extract a `{ acceptanceCriteria, definitionOfDone, nonGoals }`
 * spec from a canonical tracker issue body, reusing the shared section +
 * checklist parsers so the spec digest is computed from exactly the sections the
 * refinement gate already recognizes. Heading aliases mirror the refinement
 * artifact's own recognized set (Definition of done / DoD). Returns the raw
 * (un-normalized) lists; pass the result to {@link computeSpecDigest} /
 * {@link normalizeSpec}.
 *
 * @param {string} body — the tracker issue markdown body
 * @returns {{ acceptanceCriteria: string[], definitionOfDone: string[], nonGoals: string[] }}
 */
export function extractSpecFromBody(body) {
  const acSection = extractSection(body, "Acceptance criteria");
  const dodSection =
    extractSection(body, "Definition of done") ?? extractSection(body, "DoD");
  const nonGoalsSection =
    extractSection(body, "Non-goals") ?? extractSection(body, "Non goals");
  return {
    acceptanceCriteria: acSection ? extractChecklistItems(acSection) : [],
    definitionOfDone: dodSection ? extractChecklistItems(dodSection) : [],
    nonGoals: nonGoalsSection ? extractChecklistItems(nonGoalsSection) : [],
  };
}
