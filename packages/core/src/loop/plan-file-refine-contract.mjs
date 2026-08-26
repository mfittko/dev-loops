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
 * and drives the transition to `plan_refined_ready_for_promotion`) and #948's
 * docs-grill: the caller classifies each finding with `classifyDocsGrillFinding`
 * and passes the dispositions in, and this module validates and records them.
 */

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

/** The heading the per-phase size estimate lives under in the plan file. */
export const SIZE_ESTIMATE_HEADING = "Size estimate";

/** Size-budget tiers this contract accepts — the same enum check-size-budget.mjs's
 * `resolveFileTier` resolves a changed file into (Phase 1 of #1480). */
const VALID_SIZE_TIERS = new Set(["default", "t1", "t3"]);

// Fallback default-tier soft-LOC threshold, used only when the caller omits
// `sizeSoftLoc`. Mirrors check-size-budget.mjs's exported `DEFAULT_TIER_DEFAULTS.softLoc`
// value exactly (400) — duplicated as a literal rather than imported because this module
// is published as @dev-loops/core and must not import a scripts/ CLI module (same
// import-boundary rule the docs-grill classifier note above documents). A repo-configured
// `gates.size.tiers.default.softLoc` should always be threaded through by the caller
// instead of relying on this fallback.
const DEFAULT_SIZE_SOFT_LOC = 400;

/**
 * Parse a refiner-authored size-estimate payload into the rendered section body,
 * validating it against the SAME vocabulary/thresholds check-size-budget.mjs's
 * `computeSizeBudget` uses for the actual post-hoc diff measurement: `logicLoc`,
 * tier (`default`|`t1`|`t3`), and the default tier's `softLoc` escalation threshold.
 *
 * This is the plan-time counterpart of that post-hoc computation (see the issue's
 * "Refinement budget (plan time)" design intent): an over-`softLoc` estimate must
 * carry an explicit, non-empty `oversizeJustification` — the refiner looked for a
 * seam to split the phase and, finding none, records why the phase is cohesive.
 * A missing justification on an over-budget estimate fails closed rather than
 * silently accepting an unexplained oversize phase.
 *
 * @param {object} sizeEstimate
 * @param {number} sizeEstimate.logicLoc  estimated logic LOC for the phase (non-negative integer)
 * @param {string} [sizeEstimate.tier]  "default" (implicit) | "t1" | "t3"
 * @param {string} [sizeEstimate.oversizeJustification]  required non-empty text when logicLoc exceeds softLoc
 * @param {number} [softLoc]  default-tier soft-LOC escalation threshold (falls back to DEFAULT_SIZE_SOFT_LOC)
 * @returns {{ ok: boolean, reason?: string, logicLoc?: number, tier?: string, softLoc?: number, overBudget?: boolean, oversizeNote?: string|null, body?: string }}
 */
export function validatePhaseSizeEstimate(sizeEstimate, softLoc = DEFAULT_SIZE_SOFT_LOC) {
  if (!sizeEstimate || typeof sizeEstimate !== "object") {
    return { ok: false, reason: "missing_size_estimate" };
  }
  const { logicLoc, tier = "default", oversizeJustification } = sizeEstimate;
  if (!Number.isInteger(logicLoc) || logicLoc < 0) {
    return { ok: false, reason: "invalid_size_estimate_loc" };
  }
  if (!VALID_SIZE_TIERS.has(tier)) {
    return { ok: false, reason: "invalid_size_estimate_tier" };
  }
  const effectiveSoftLoc = typeof softLoc === "number" && softLoc > 0 ? softLoc : DEFAULT_SIZE_SOFT_LOC;
  const overBudget = logicLoc > effectiveSoftLoc;
  const justification = typeof oversizeJustification === "string" ? oversizeJustification.trim() : "";
  if (overBudget && justification.length === 0) {
    // Fail closed: this is the refiner's prompt to look for a seam and split the
    // phase before proceeding; a cohesive phase must say so explicitly instead.
    return { ok: false, reason: "size_estimate_oversize_not_justified" };
  }
  const oversizeNote = overBudget ? justification : null;
  const body = [
    `- Estimated logic LOC: ${logicLoc}`,
    `- Tier: ${tier}`,
    overBudget
      ? `- Oversize: justified — ${oversizeNote}`
      : `- Oversize: n/a (within default tier's softLoc budget of ${effectiveSoftLoc})`,
  ].join("\n");
  return { ok: true, logicLoc, tier, softLoc: effectiveSoftLoc, overBudget, oversizeNote, body };
}

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

/**
 * Whether markdown carries a `## <heading>` section marker. Used to re-derive
 * the section-presence facts from the freshly-written text so the end-state
 * check verifies the append actually happened (rather than re-asserting the
 * inputs). ponytail: local copy of the section-detect regex; the shared section
 * helper belongs in core once extractSection is lifted out of scripts/.
 */
function hasSection(markdownText, headingText) {
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^##\\s+${escaped}\\s*$`, "imu").test(markdownText);
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
 * @param {boolean} params.hasAcceptanceCriteria  whether the plan already carries a non-empty Acceptance criteria section marker (per the intake contract)
 * @param {boolean} params.hasDefinitionOfDone  whether the plan already carries a non-empty Definition of done section marker (per the intake contract)
 * @param {object} params.payload  refiner-produced refinement output
 * @param {string} params.payload.acceptanceCriteria  Acceptance criteria section body
 * @param {string} params.payload.definitionOfDone  Definition of done section body
 * @param {string} params.payload.coverageMatrix  AC/DoD/Non-goal coverage matrix (markdown table)
 * @param {object} params.payload.sizeEstimate  per-phase size estimate (see `validatePhaseSizeEstimate`); an over-`sizeSoftLoc` estimate must carry a non-empty `oversizeJustification` or the refine fails closed, prompting a seam search
 * @param {object[]} [params.payload.grillDispositions]  docs-grill dispositions the caller pre-classified via #948's `classifyDocsGrillFinding`; each entry is `{ kind, summary, disposition }` and a null/invalid `disposition` fails the grill closed
 * @param {number} [params.sizeSoftLoc]  default-tier soft-LOC escalation threshold the size estimate is checked against — the caller threads this from `gates.size.tiers.default.softLoc` (falls back to check-size-budget.mjs's own default when config carries none)
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   planFileIntakeState?: string,
 *   refinedMarkdown?: string,
 *   grillDispositions?: object[],
 *   sizeEstimate?: { logicLoc: number, tier: string, softLoc: number, overBudget: boolean, oversizeNote: string|null },
 *   stop?: { kind: string },
 * }}
 */
export function refinePlanFileInPlace({
  markdownText,
  baseSectionsValid,
  hasAcceptanceCriteria,
  hasDefinitionOfDone,
  payload,
  sizeSoftLoc,
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

  // Plan-time size estimate (phase 4 of #1480): the same fail-closed check as an
  // over-budget PR, run at plan time instead of on a real diff. `validatePhaseSizeEstimate`
  // owns the vocabulary/threshold and the oversize-without-justification fail-closed reason.
  const sizeEstimateResult = validatePhaseSizeEstimate(payload.sizeEstimate, sizeSoftLoc);
  if (!sizeEstimateResult.ok) {
    return { ok: false, reason: sizeEstimateResult.reason, planFileIntakeState: startState };
  }

  // The docs-grill runs as a step of refinement. The caller (the CLI, which owns
  // I/O and the scripts/ boundary) classifies each finding with #948's
  // `classifyDocsGrillFinding` and passes the dispositions in. This core module
  // validates and renders them but does NOT import the classifier — keeping it
  // free of any scripts/ import so the published @dev-loops/core package does not
  // break for consumers. A missing or invalid disposition fails the grill closed
  // so a malformed grill cannot advance the state.
  const grillDispositions = Array.isArray(payload.grillDispositions) ? payload.grillDispositions : [];
  for (const d of grillDispositions) {
    if (!d || typeof d.disposition !== "string" || d.disposition.length === 0) {
      return { ok: false, reason: "docs_grill_failed", planFileIntakeState: startState };
    }
  }

  // A managed section body must not contain a top-level `## ` heading: stripSection
  // finds a section's end by scanning to the next `## `, so an embedded H2 in a body
  // would break the strip-then-append idempotency on a re-run (the inner heading and
  // its text would orphan into the document body). Fail closed on such a payload.
  const grillBody = renderGrillFindings(grillDispositions);
  if ([acceptanceCriteria, definitionOfDone, coverageMatrix, sizeEstimateResult.body, grillBody].some((b) => /^##\s/mu.test(String(b)))) {
    return { ok: false, reason: "section_body_contains_heading", planFileIntakeState: startState };
  }

  // Write the refinement sections in-place. Strip any prior copy first so a
  // re-run replaces rather than duplicates (idempotency), then append the fresh
  // sections in a stable order.
  const [acHeading, dodHeading] = PLAN_FILE_REFINEMENT_SECTIONS;
  let refinedMarkdown = markdownText;
  for (const heading of [acHeading, dodHeading, SIZE_ESTIMATE_HEADING, COVERAGE_MATRIX_HEADING, DOCS_GRILL_FINDINGS_HEADING]) {
    refinedMarkdown = stripSection(refinedMarkdown, heading);
  }
  refinedMarkdown = appendSection(refinedMarkdown, acHeading, acceptanceCriteria);
  refinedMarkdown = appendSection(refinedMarkdown, dodHeading, definitionOfDone);
  refinedMarkdown = appendSection(refinedMarkdown, SIZE_ESTIMATE_HEADING, sizeEstimateResult.body);
  refinedMarkdown = appendSection(refinedMarkdown, COVERAGE_MATRIX_HEADING, coverageMatrix);
  refinedMarkdown = appendSection(refinedMarkdown, DOCS_GRILL_FINDINGS_HEADING, grillBody);

  // Re-derive the section-presence facts from the text the write just produced
  // (not from the inputs) so this check actually verifies the append landed: a
  // correct refine carries the base sections forward and adds both refinement
  // markers, flipping the intake state to ready. A buggy rewrite that dropped a
  // section is caught here and fails closed rather than advancing the state.
  const endState = evaluatePlanFileIntakeState({
    baseSectionsValid,
    hasAcceptanceCriteria: hasSection(refinedMarkdown, acHeading),
    hasDefinitionOfDone: hasSection(refinedMarkdown, dodHeading),
  }).state;
  if (endState !== PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION) {
    return { ok: false, reason: "refine_did_not_reach_ready", planFileIntakeState: endState };
  }

  return {
    ok: true,
    planFileIntakeState: endState,
    refinedMarkdown,
    grillDispositions,
    sizeEstimate: {
      logicLoc: sizeEstimateResult.logicLoc,
      tier: sizeEstimateResult.tier,
      softLoc: sizeEstimateResult.softLoc,
      overBudget: sizeEstimateResult.overBudget,
      oversizeNote: sizeEstimateResult.oversizeNote,
    },
    // Generalized proposal-first stop: the refined plan is the local artifact,
    // it is written in-place, and the loop stops here for human review before
    // any promotion. No tracker artifact is created or mutated.
    stop: { kind: PLAN_FILE_REFINE_STOP.LOCAL_HUMAN_REVIEW },
  };
}
