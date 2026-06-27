// Bounded docs-grill disposition classifier behind `dev-loop`. Sibling of
// scripts/loop/slides-story-review-contract.mjs: this one codifies the keep/fix
// rule for the autonomous docs-grill step (claims vs the actual contracts,
// code-vs-doc drift, stale references, contract-surface accuracy). Pure module,
// no I/O. See docs/docs-grill-step.md.

// What each finding asserts is wrong. `drift` covers any divergence between a
// claim/reference and the contract surface it points at; `stale_reference`
// covers a link/path/command that no longer resolves; `cosmetic` covers
// wording-only nits with no behavioral or reference impact.
export const DOCS_GRILL_FINDING_KINDS = Object.freeze([
  'drift',
  'stale_reference',
  'cosmetic',
]);

// The bounded disposition the step assigns to each finding.
export const DOCS_GRILL_DISPOSITIONS = Object.freeze([
  'record_finding', // real drift between code/behavior and a contract claim — record it
  'fix_in_place', // doc-only drift the loop can correct on this branch
  'route_followup', // doc-only drift too large for this branch — route a follow-up
  'ignore_cosmetic', // wording nit that does not justify a block or a fix here
]);

/**
 * Classify one docs-grill finding into its keep/fix disposition.
 *
 * The keep/fix rule (docs/docs-grill-step.md):
 *   - real drift between code/behavior and a contract claim   -> record_finding
 *   - doc-only drift the loop can correct here                -> fix_in_place
 *   - doc-only drift too large for this branch                -> route_followup
 *   - cosmetic wording nit                                    -> ignore_cosmetic
 *
 * A coerced/invalid finding returns a structured invalid result rather than
 * throwing (the module's contract is a structured result, never an exception).
 *
 * @param {object} finding
 * @param {string} finding.kind - one of DOCS_GRILL_FINDING_KINDS
 * @param {boolean} [finding.docOnly] - true when only docs (no code/behavior) diverge
 * @param {boolean} [finding.fixableHere] - true when a doc-only fix is small enough for this branch
 * @returns {{ ok: boolean, disposition?: string, status: string, reason: string, invalid?: string[] }}
 */
export function classifyDocsGrillFinding(finding = {}) {
  if (!finding || typeof finding !== 'object') finding = {};
  if (!DOCS_GRILL_FINDING_KINDS.includes(finding.kind)) {
    return {
      ok: false,
      status: 'invalid_finding',
      reason: 'unknown_finding_kind',
      invalid: ['kind'],
    };
  }

  if (finding.kind === 'cosmetic') {
    return { ok: true, disposition: 'ignore_cosmetic', status: 'classified', reason: 'cosmetic_nit' };
  }

  // drift | stale_reference against live code/behavior is always recorded; the
  // reason reflects the kind so downstream filtering stays accurate.
  if (finding.docOnly !== true) {
    const reason = finding.kind === 'stale_reference' ? 'stale_reference' : 'real_drift';
    return { ok: true, disposition: 'record_finding', status: 'classified', reason };
  }

  // Doc-only drift: fix it here when small, otherwise route a follow-up.
  if (finding.fixableHere === true) {
    return { ok: true, disposition: 'fix_in_place', status: 'classified', reason: 'doc_only_fixable_here' };
  }
  return { ok: true, disposition: 'route_followup', status: 'classified', reason: 'doc_only_too_large' };
}
