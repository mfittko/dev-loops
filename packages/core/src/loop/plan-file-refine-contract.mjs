/**
 * Local-planning plan-file refine + human-review checkpoint (off-tracker).
 *
 * This is the P3 core noise-reduction step. It generalizes the proposal-first
 * intake pattern (emit a local artifact, human-gate it, make zero tracker
 * mutation, stop and ask) to plan files: the refined plan is written in-place to
 * the single canonical plan file, the autonomous docs-grill runs as a step
 * within refinement, and the loop stops at a local human-review checkpoint with
 * the intake state advanced to `plan_refined_ready_for_promotion`.
 *
 * This module is pure: it transforms markdown text and reports a disposition. It
 * performs no GitHub mutation, no network calls, and no filesystem I/O. The
 * caller supplies the section-presence facts it already read (mirroring the
 * `evaluatePlanFileIntakeState` precedent) and the refiner-produced payload, and
 * writes the returned markdown back. That keeps the zero-tracker-mutation
 * guarantee structural: there is no gh/network surface to reach from here.
 *
 * It composes the already-shipped contracts: P2 `evaluatePlanFileIntakeState` +
 * `PLAN_FILE_REFINEMENT_SECTIONS` (this step acts on `new_plan_needs_refinement`
 * and drives the transition to `plan_refined_ready_for_promotion`) and #948
 * `classifyDocsGrillFinding` (the docs-grill runs as a step of refinement and
 * its findings are recorded into the plan file).
 */

import { classifyDocsGrillFinding } from "../../../../scripts/loop/docs-grill-contract.mjs";
import {
  evaluatePlanFileIntakeState,
  PLAN_FILE_INTAKE_STATE,
  PLAN_FILE_REFINEMENT_SECTIONS,
} from "./plan-file-intake-contract.mjs";

/** The local human-review checkpoint surface the loop stops at on success. */
export const PLAN_FILE_REFINE_STOP = Object.freeze({
  /** Refinement wrote the plan in-place; stop for local human review before any promotion. */
  LOCAL_HUMAN_REVIEW: "local_human_review",
});

/** The heading the recorded docs-grill findings live under in the plan file. */
export const DOCS_GRILL_FINDINGS_HEADING = "Docs-grill findings";

/** The heading the refiner coverage matrix lives under in the plan file. */
export const COVERAGE_MATRIX_HEADING = "Coverage matrix";

/**
 * Remove an existing `## <heading>` section (heading + body up to the next H2)
 * from markdown so a refine re-run replaces it rather than appending a duplicate.
 * Returns the markdown unchanged when the heading is absent.
 */
function stripSection(markdownText, headingText) {
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, "imu");
  const match = headingPattern.exec(markdownText);
  if (!match || match.index === undefined) return markdownText;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const remaining = markdownText.slice(afterHeading);
  const nextHeadingMatch = /^##\s+/imu.exec(remaining);
  const end = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? afterHeading + nextHeadingMatch.index
    : markdownText.length;
  // Drop the section and collapse the blank-line gap it leaves behind.
  return `${markdownText.slice(0, start)}${markdownText.slice(end)}`.replace(/\n{3,}/gu, "\n\n");
}

/** Append a `## <heading>` section with the given body to markdown. */
function appendSection(markdownText, headingText, body) {
  const trimmed = markdownText.replace(/\s+$/u, "");
  return `${trimmed}\n\n## ${headingText}\n\n${String(body).trim()}\n`;
}

/**
 * Render recorded docs-grill findings as a markdown body. Each finding lists the
 * disposition `classifyDocsGrillFinding` assigned it. When the grill produced no
 * findings, an explicit "none recorded" line keeps the section idempotent and
 * non-empty so the plan file always carries the grill evidence.
 */
function renderGrillFindings(classified) {
  if (classified.length === 0) {
    return "- None recorded; the docs-grill step ran and surfaced no findings.";
  }
  return classified
    .map((entry) => {
      const summary = String(entry.summary ?? "").trim() || "(no summary)";
      return `- [${entry.disposition}] (${entry.kind}) ${summary}`;
    })
    .join("\n");
}

/**
 * Refine a plan file in-place and advance its intake state, then stop at the
 * local human-review checkpoint.
 *
 * The caller reads the plan file and supplies the section-presence facts plus
 * the refiner payload. On success it writes `refinedMarkdown` back to the same
 * path (the single canonical artifact) and stops; it never promotes here.
 *
 * @param {object} params
 * @param {string} params.markdownText  current plan-file markdown
 * @param {boolean} params.baseSectionsValid  whether the plan passes the base-section validator
 * @param {boolean} params.hasAcceptanceCriteria  whether the plan already carries an Acceptance criteria section
 * @param {boolean} params.hasDefinitionOfDone  whether the plan already carries a Definition of done section
 * @param {object} params.payload  refiner-produced refinement output
 * @param {string} params.payload.acceptanceCriteria  Acceptance criteria section body
 * @param {string} params.payload.definitionOfDone  Definition of done section body
 * @param {string} params.payload.coverageMatrix  AC/DoD/Non-goal coverage matrix (markdown table)
 * @param {object[]} [params.payload.grillFindings]  docs-grill findings (classified via #948)
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   planFileIntakeState?: string,
 *   refinedMarkdown?: string,
 *   grillDispositions?: object[],
 *   stop?: { kind: string },
 * }}
 */
export function refinePlanFileInPlace({
  markdownText,
  baseSectionsValid,
  hasAcceptanceCriteria,
  hasDefinitionOfDone,
  payload,
} = {}) {
  if (typeof markdownText !== "string" || markdownText.length === 0) {
    return { ok: false, reason: "missing_plan_markdown" };
  }

  // Gate on the starting intake state: this step only acts on a base-valid plan
  // that has not yet been refined. A plan already carrying refinement markers, a
  // partially-refined plan, or one failing the base contract is ambiguous here;
  // fail closed without writing or advancing.
  const startState = evaluatePlanFileIntakeState({
    baseSectionsValid,
    hasAcceptanceCriteria,
    hasDefinitionOfDone,
  }).state;
  if (startState !== PLAN_FILE_INTAKE_STATE.NEW_PLAN_NEEDS_REFINEMENT) {
    return { ok: false, reason: "not_in_new_plan_needs_refinement", planFileIntakeState: startState };
  }

  // The refiner payload must carry the refinement contract: AC, DoD, and the
  // coverage matrix. A missing/empty piece is a failed refine; fail closed.
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "missing_refinement_payload", planFileIntakeState: startState };
  }
  const acceptanceCriteria = String(payload.acceptanceCriteria ?? "").trim();
  const definitionOfDone = String(payload.definitionOfDone ?? "").trim();
  const coverageMatrix = String(payload.coverageMatrix ?? "").trim();
  if (!acceptanceCriteria) {
    return { ok: false, reason: "missing_acceptance_criteria", planFileIntakeState: startState };
  }
  if (!definitionOfDone) {
    return { ok: false, reason: "missing_definition_of_done", planFileIntakeState: startState };
  }
  if (!coverageMatrix) {
    return { ok: false, reason: "missing_coverage_matrix", planFileIntakeState: startState };
  }

  // The docs-grill runs as a step of refinement. Classify each finding with
  // #948's classifier; an invalid finding kind fails the grill closed so a
  // malformed grill cannot advance the state.
  const rawFindings = Array.isArray(payload.grillFindings) ? payload.grillFindings : [];
  const grillDispositions = [];
  for (const finding of rawFindings) {
    const classified = classifyDocsGrillFinding(finding);
    if (!classified.ok) {
      return { ok: false, reason: "docs_grill_failed", planFileIntakeState: startState };
    }
    grillDispositions.push({
      kind: finding?.kind,
      summary: typeof finding?.summary === "string" ? finding.summary : "",
      disposition: classified.disposition,
    });
  }

  // Write the refinement sections in-place. Strip any prior copy first so a
  // re-run replaces rather than duplicates (idempotency), then append the fresh
  // sections in a stable order.
  const [acHeading, dodHeading] = PLAN_FILE_REFINEMENT_SECTIONS;
  let refinedMarkdown = markdownText;
  for (const heading of [acHeading, dodHeading, COVERAGE_MATRIX_HEADING, DOCS_GRILL_FINDINGS_HEADING]) {
    refinedMarkdown = stripSection(refinedMarkdown, heading);
  }
  refinedMarkdown = appendSection(refinedMarkdown, acHeading, acceptanceCriteria);
  refinedMarkdown = appendSection(refinedMarkdown, dodHeading, definitionOfDone);
  refinedMarkdown = appendSection(refinedMarkdown, COVERAGE_MATRIX_HEADING, coverageMatrix);
  refinedMarkdown = appendSection(refinedMarkdown, DOCS_GRILL_FINDINGS_HEADING, renderGrillFindings(grillDispositions));

  // Re-classify against the refined text using the facts the write just created.
  // A correct refine carries the base sections forward (untouched) and adds both
  // refinement markers, flipping the intake state to ready.
  const endState = evaluatePlanFileIntakeState({
    baseSectionsValid,
    hasAcceptanceCriteria: true,
    hasDefinitionOfDone: true,
  }).state;
  if (endState !== PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION) {
    return { ok: false, reason: "refine_did_not_reach_ready", planFileIntakeState: endState };
  }

  return {
    ok: true,
    planFileIntakeState: endState,
    refinedMarkdown,
    grillDispositions,
    // Generalized proposal-first stop: the refined plan is the local artifact,
    // it is written in-place, and the loop stops here for human review before
    // any promotion. No tracker artifact is created or mutated.
    stop: { kind: PLAN_FILE_REFINE_STOP.LOCAL_HUMAN_REVIEW },
  };
}
