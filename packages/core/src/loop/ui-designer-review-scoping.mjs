// UI designer/vision recorded-evidence auto-scoping — UI half of ADR 0041
// (RFC issue #1438, decision #0041), tracked by issue #1443.
//
// Deterministic, path-triggered, fail-closed criterion modeled on the UI e2e
// scoping check (./ui-e2e-scoping.mjs, issue #976): a PR that adds or modifies
// a *rendered* HTML artifact (docs/articles/*.html or docs/presentations/*.html)
// MUST carry recorded designer/vision review evidence for every touched
// rendered artifact, and each recorded outcome MUST be the loop's satisfied
// state (`ui_review_satisfied`). The check is grounded in the designer/vision
// review loop's EXISTING outcome + artifact bundle contract — no new evidence
// schema (ADR 0041: "reuse the designer/vision loop's existing outcome +
// artifact contract rather than a new shape"). Accessibility facts come from
// the captured axe.json, never judged from pixels, and no human is required by
// default — the same autonomy the gate-evidence path already has.
//
// Inclusion is triggered by the changed-file set, never by annotating the PR.
// Light-mode and spike-mode relaxed-gate carve-outs are honored: when the PR
// is light-dispatched / under the light threshold or a spike run, the required
// designer/vision check is exempt (the requirement is relaxed exactly like the
// other gates), letting small and exploratory work stay cheap (ADR 0041).

import { classifyRenderedArtifactPath } from "./ui-e2e-scoping.mjs";

// The recorded outcome the required check treats as the satisfied state. The
// designer/vision loop emits exactly one of these (ui-designer-review-loop.md);
// any other recorded outcome (continue_ui_fix_loop, blocked_needs_human_decision)
// or an absent outcome blocks.
export const DESIGNER_REVIEW_SATISFIED_OUTCOME = "ui_review_satisfied";

// The loop's existing outcome enum, re-used verbatim (no new schema).
export const DESIGNER_REVIEW_OUTCOMES = Object.freeze([
  DESIGNER_REVIEW_SATISFIED_OUTCOME,
  "continue_ui_fix_loop",
  "blocked_needs_human_decision",
]);

/**
 * Normalize a designer/vision recorded-evidence value into an artifact-id →
 * outcome map, tolerating both the array and keyed-object shapes.
 *
 * The evidence reuses the loop's existing outcome + artifact-bundle record: an
 * entry identifies the rendered artifact by its full repo-relative path and
 * carries the loop's `outcome`. A  record may also carry its `artifactBundle`
 * (the loop's existing bundle) - carried through untouched, never validated to
 * a new shape here.
 *
 * @param {Array<{artifact:string,outcome:string,artifactBundle?:object}>|Record<string,{outcome:string,artifactBundle?:object}>|null} evidence
 * @returns {Map<string,{outcome:string,artifactBundle?:object}>}
 */
export function normalizeDesignerReviewEvidence(evidence) {
  const byArtifact = new Map();
  if (evidence == null) return byArtifact;
  if (Array.isArray(evidence)) {
    for (const entry of evidence) {
      if (entry && typeof entry === "object" && typeof entry.artifact === "string" && entry.artifact.length > 0) {
        byArtifact.set(entry.artifact, entry);
      }
    }
    return byArtifact;
  }
  if (typeof evidence === "object") {
    for (const [artifact, record] of Object.entries(evidence)) {
      if (record && typeof record === "object") {
        byArtifact.set(artifact, record);
      }
    }
  }
  return byArtifact;
}

/**
 * Deterministic designer/vision recorded-evidence scoping check.
 *
 * @param {string[]} changedPaths - PR changed-file paths.
 * @param {{
 *   designerReviewEvidence?: Array|Record|null,
 *   designerReviewExempt?: boolean,
 * }} [opts]
 *   designerReviewEvidence: the loop's recorded outcome + artifact bundle for
 *     the artifacts in scope (null/undefined = "not recorded" → fails closed).
 *   designerReviewExempt: true when a light-mode/spike relaxed-gate carve-out
 *     applies (relaxes the requirement entirely).
 * @returns {{
 *   required: boolean,
 *   artifacts: Array<{path,kind,id,registered}>,
 *   missing: string[],
 *   unsatisfied: string[],
 *   satisfied: boolean,
 *   reason: string|null,
 * }}
 */
export function evaluateUiDesignerReviewScoping(changedPaths = [], {
  designerReviewEvidence = null,
  designerReviewExempt = false,
} = {}) {
  const artifacts = [];
  const seen = new Set();
  for (const p of Array.isArray(changedPaths) ? changedPaths : []) {
    const descriptor = classifyRenderedArtifactPath(p);
    if (descriptor && !seen.has(descriptor.path)) {
      seen.add(descriptor.path);
      artifacts.push(descriptor);
    }
  }

  const required = artifacts.length > 0;
  if (!required) {
    return { required: false, artifacts, missing: [], unsatisfied: [], satisfied: true, reason: null };
  }

  // Honor the light/spike relaxed-gate carve-outs (ADR 0041): the requirement
  // is exempt, so a rendered artifact change in those runs does not block.
  if (designerReviewExempt === true) {
    return {
      required: true,
      artifacts,
      missing: [],
      unsatisfied: [],
      satisfied: true,
      reason: "exempted_by_relaxed_gate_profile",
    };
  }

  const byArtifact = normalizeDesignerReviewEvidence(designerReviewEvidence);

  // Fail closed: any touched rendered artifact with NO recorded designer/vision
  // evidence blocks and names itself so the fix is unambiguous (record the loop's
  // outcome+bundle for it).
  const missing = artifacts.filter((a) => !byArtifact.has(a.id)).map((a) => a.id);
  if (missing.length > 0) {
    return {
      required: true,
      artifacts,
      missing,
      unsatisfied: [],
      satisfied: false,
      reason:
        `Designer/vision review evidence is required: this PR changes rendered artifact(s) ` +
        `${missing.join(", ")} that have no recorded designer/vision review outcome + artifact bundle. ` +
        `Run the designer/vision review loop for the artifact(s) and record its outcome so the required ` +
        `recorded-evidence check can pass before this gate can proceed.`,
    };
  }

  // Fail closed: recorded evidence exists but the recorded outcome is not the
  // loop's satisfied state (continue_ui_fix_loop, blocked_needs_human_decision).
  const unsatisfied = artifacts
    .filter((a) => (byArtifact.get(a.id)?.outcome ?? null) !== DESIGNER_REVIEW_SATISFIED_OUTCOME)
    .map((a) => a.id);
  if (unsatisfied.length > 0) {
    return {
      required: true,
      artifacts,
      missing: [],
      unsatisfied,
      satisfied: false,
      reason:
        `Designer/vision review is not satisfied: this PR changes rendered artifact(s) ` +
        `${unsatisfied.join(", ")}, but the recorded designer/vision review outcome is not ` +
        `\`${DESIGNER_REVIEW_SATISFIED_OUTCOME}\`. Complete the designer/vision review loop until the ` +
        `recorded outcome is the satisfied state before this gate can proceed.`,
    };
  }

  return { required: true, artifacts, missing: [], unsatisfied: [], satisfied: true, reason: null };
}
