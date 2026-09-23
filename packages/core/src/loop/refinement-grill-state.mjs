/**
 * Deterministic state machine for the refinement/grill sub-loop.
 *
 * The refinement loop runs the grill as a CLOSED, DETERMINISTIC sub-loop:
 * detect-gaps -> auto-answer -> synthesize -> re-grill -> terminal. The
 * iteration lives entirely in the transition graph below; the LLM answer and
 * synthesis enter ONLY as a bounded input consumed at the `await_answers`
 * state (and reflected in the `synthesized` snapshot flag), never as hidden
 * orchestration inside a deterministic coordinator script (keeps
 * OPS-NO-INLINE-INTERPRETER clean).
 *
 * Mirrors the shape of `reviewer-loop-state.mjs` / `copilot-loop-state.mjs`:
 * a frozen STATE vocabulary, a frozen TRANSITIONS adjacency table, a
 * `normalize*Snapshot` canonicalizer, and a pure `interpret*State` that maps a
 * point-in-time snapshot to exactly one current state plus its legal exits.
 *
 * Honest handoff: when a gap is genuinely unanswerable (only-`inferred`, no
 * citation), the machine reaches `needs_human_handoff` naming the question
 * rather than fabricating an answer to force convergence.
 *
 * Zero-gap provenance (see ADR 0084, which amends ADR 0029): a zero-open-gap
 * `detect_gaps` pass resolves to `grill_clean` only for a `plan` surface
 * (shape-only, no comment surface) or when a `🔬 Grill / refinement results`
 * comment is already recorded on the target; otherwise it stays at
 * `detect_gaps` so the semantic pass still runs and records its own
 * provenance, including a zero-gap outcome. `detectIssueRefinementArtifact`
 * stays the sole shape/completeness predicate; provenance is a separate
 * recorded fact, not a second refinedness detector.
 */

import { trimmedOrNull } from "./normalize.mjs";

export const GRILL_STATE = Object.freeze({
  LOAD_TARGET: "load_target",
  DETECT_GAPS: "detect_gaps",
  AWAIT_ANSWERS: "await_answers",
  SYNTHESIZE: "synthesize",
  RE_GRILL: "re_grill",
  GRILL_CLEAN: "grill_clean",
  NEEDS_HUMAN_HANDOFF: "needs_human_handoff",
  BLOCKED_NEEDS_USER_DECISION: "blocked_needs_user_decision",
});

// The iterate-to-clean loop: detect_gaps -> await_answers -> synthesize ->
// re_grill, with re_grill either re-entering detect_gaps (a new answerable gap
// surfaced) or terminating at grill_clean (fixed point). Any I/O/parse failure
// fails closed to blocked_needs_user_decision; any unresolved (uncitable) gap
// terminates honestly at needs_human_handoff. A zero-open-gap detect_gaps pass
// terminates at grill_clean only with recorded provenance (plan surface, or a
// posted results comment); otherwise it stays at detect_gaps for the owed
// semantic pass (ADR 0084).
export const GRILL_TRANSITIONS = Object.freeze({
  [GRILL_STATE.LOAD_TARGET]: [
    GRILL_STATE.DETECT_GAPS,
    GRILL_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [GRILL_STATE.DETECT_GAPS]: [
    GRILL_STATE.AWAIT_ANSWERS,
    GRILL_STATE.GRILL_CLEAN,
    GRILL_STATE.NEEDS_HUMAN_HANDOFF,
    GRILL_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [GRILL_STATE.AWAIT_ANSWERS]: [
    GRILL_STATE.SYNTHESIZE,
    GRILL_STATE.NEEDS_HUMAN_HANDOFF,
    GRILL_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [GRILL_STATE.SYNTHESIZE]: [
    GRILL_STATE.RE_GRILL,
    GRILL_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [GRILL_STATE.RE_GRILL]: [
    GRILL_STATE.DETECT_GAPS,
    GRILL_STATE.GRILL_CLEAN,
    GRILL_STATE.NEEDS_HUMAN_HANDOFF,
    GRILL_STATE.BLOCKED_NEEDS_USER_DECISION,
  ],
  [GRILL_STATE.GRILL_CLEAN]: [],
  [GRILL_STATE.NEEDS_HUMAN_HANDOFF]: [],
  [GRILL_STATE.BLOCKED_NEEDS_USER_DECISION]: [],
});

const GRILL_NEXT_ACTIONS = Object.freeze({
  [GRILL_STATE.LOAD_TARGET]: "Load the target issue/PR/plan body for grilling",
  [GRILL_STATE.DETECT_GAPS]: "Run the loop-grill gap detectors on the loaded spec",
  [GRILL_STATE.AWAIT_ANSWERS]: "Consume the bounded answer input: --auto self-answer with a citation, or ask the human interactively",
  [GRILL_STATE.SYNTHESIZE]: "Synthesize Acceptance criteria / Definition of done / Non-goals into the body; write raw Q&A only to the ephemeral tmp artifact",
  [GRILL_STATE.RE_GRILL]: "Re-run gap detection to check for a fixed point",
  [GRILL_STATE.GRILL_CLEAN]: "Grill reached a fixed point; synthesized spec is clean",
  [GRILL_STATE.NEEDS_HUMAN_HANDOFF]: "Stop and hand off the named unanswerable question(s) to the human; headless parks with the recorded reason",
  [GRILL_STATE.BLOCKED_NEEDS_USER_DECISION]: "Stop and request explicit user direction",
});

const VALID_SURFACES = new Set(["issue", "pr", "plan"]);

// The exact comment title provenance is keyed on (GRILL-SUBLOOP-RATIONALE-COMMENT).
const RESULTS_COMMENT_TITLE = "🔬 Grill / refinement results";
// A results comment's recorded bypass line: "bypass: operator-authorized by <handle>",
// with an optional leading @ before the handle and a case-insensitive "bypass:" key.
const BYPASS_LINE_RE = /^bypass: operator-authorized by @?([A-Za-z0-9][A-Za-z0-9-]{0,38})\s*$/i;

function normalizeCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Detect recorded grill provenance from a target's comments: a durable
 * `🔬 Grill / refinement results` comment, optionally carrying an
 * `bypass: operator-authorized by <handle>` line. The ephemeral
 * `tmp/issues/issue-<n>/grill/` transcript is never a comment, so it never
 * counts here.
 *
 * @param {Array<string|{body?: string}>} comments
 * @returns {{provenanceRecorded: boolean, bypass: boolean, bypassBy: string|null}}
 */
export function detectGrillProvenance(comments) {
  if (!Array.isArray(comments)) {
    return { provenanceRecorded: false, bypass: false, bypassBy: null };
  }

  let provenanceRecorded = false;
  let bypass = false;
  let bypassBy = null;

  for (const comment of comments) {
    const body = typeof comment === "string"
      ? comment
      : (comment && typeof comment.body === "string" ? comment.body : null);
    if (body === null) continue;

    const lines = body.split(/\r?\n/);
    // A comment counts as a results comment only when its FIRST non-empty
    // line (after trimming and stripping leading `#` characters) IS the
    // title -- this rejects the title merely quoted in a code fence or
    // appearing later in an unrelated reply.
    const firstNonEmpty = lines.find((line) => line.trim().length > 0);
    const isResultsComment = firstNonEmpty !== undefined
      && firstNonEmpty.trim().replace(/^#+/, "").trim() === RESULTS_COMMENT_TITLE;
    if (!isResultsComment) continue;

    provenanceRecorded = true;
    if (!bypass) {
      // Take the first bypass-line match across all results comments; a
      // later comment's bypass line never overwrites an earlier one.
      for (const line of lines) {
        const match = line.trim().match(BYPASS_LINE_RE);
        if (match) {
          bypass = true;
          bypassBy = match[1];
          break;
        }
      }
    }
  }

  return { provenanceRecorded, bypass, bypassBy };
}

/**
 * Canonicalize a raw grill snapshot into a deterministic shape.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeGrillSnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Snapshot must be a non-null object");
  }

  return {
    surface: VALID_SURFACES.has(raw.surface) ? raw.surface : "issue",
    targetRef: trimmedOrNull(raw.targetRef),

    loaded: Boolean(raw.loaded),
    loadFailed: Boolean(raw.loadFailed),

    detectRan: Boolean(raw.detectRan),
    // answerable gaps still awaiting an answer this pass
    openGapCount: normalizeCount(raw.openGapCount),
    // uncitable gaps that must hand off honestly (never fabricated)
    unresolvedGapCount: normalizeCount(raw.unresolvedGapCount),

    // the bounded LLM answer input, consumed at await_answers
    answersReady: Boolean(raw.answersReady),
    // synthesized AC/DoD/Non-goals applied to the body this iteration
    synthesized: Boolean(raw.synthesized),

    // post-synthesis re-grill fixed-point signals
    reGrillRan: Boolean(raw.reGrillRan),
    reGrillFixedPoint: Boolean(raw.reGrillFixedPoint),

    // recorded provenance: a posted `🔬 Grill / refinement results` comment
    // (see detectGrillProvenance), and whether it carries a recorded bypass line.
    // A bypass line only ever means anything alongside a recorded comment, so
    // provenanceBypass is forced false when provenanceRecorded is false --
    // never a standalone shortcut to grill_clean.
    provenanceRecorded: Boolean(raw.provenanceRecorded),
    provenanceBypass: Boolean(raw.provenanceRecorded) && Boolean(raw.provenanceBypass),
  };
}

const PROVENANCE_MISSING_NEXT_ACTION =
  "Run the semantic gap pass on the loaded spec, then post the \"🔬 Grill / refinement results\" comment recording the outcome — including a zero-gap pass, which states that no gaps were found";

/**
 * Deterministically interpret the current refinement-grill state.
 *
 * @param {object} snapshot
 * @returns {{state: string, allowedTransitions: string[], nextAction: string, reason: string|null, bypass: boolean}}
 */
export function interpretRefinementGrillState(snapshot) {
  const s = normalizeGrillSnapshot(snapshot);

  let state;
  let reason = null;
  let bypass = false;

  if (s.loadFailed) {
    // Fail closed on any load/parse failure, from any point in the loop.
    state = GRILL_STATE.BLOCKED_NEEDS_USER_DECISION;
  } else if (!s.loaded) {
    state = GRILL_STATE.LOAD_TARGET;
  } else if (s.unresolvedGapCount > 0) {
    // Honest handoff outranks everything else: never fabricate to converge.
    state = GRILL_STATE.NEEDS_HUMAN_HANDOFF;
  } else if (s.synthesized) {
    if (!s.reGrillRan) {
      // Synthesis applied -> re-grill to check the fixed point.
      state = GRILL_STATE.RE_GRILL;
    } else if (s.reGrillFixedPoint) {
      state = GRILL_STATE.GRILL_CLEAN;
    } else {
      // Re-grill surfaced a new answerable gap -> iterate.
      state = GRILL_STATE.DETECT_GAPS;
    }
  } else if (s.answersReady) {
    // Bounded answer input present -> apply synthesis.
    state = GRILL_STATE.SYNTHESIZE;
  } else if (s.detectRan) {
    if (s.openGapCount > 0) {
      // Detection ran; answerable gaps still open -> await answers.
      state = GRILL_STATE.AWAIT_ANSWERS;
    } else if (s.surface === "plan") {
      // Local plan files have no comment surface: shape-only, zero-iteration clean.
      state = GRILL_STATE.GRILL_CLEAN;
      reason = "plan_shape_only";
    } else if (s.provenanceBypass) {
      // A recorded bypass line still counts as recorded provenance.
      state = GRILL_STATE.GRILL_CLEAN;
      reason = "provenance_bypass_recorded";
      bypass = true;
    } else if (s.provenanceRecorded) {
      state = GRILL_STATE.GRILL_CLEAN;
      reason = "provenance_recorded";
    } else {
      // Zero open gaps but no recorded provenance: the semantic pass is still
      // owed (ADR 0084) — stay at detect_gaps rather than short-circuiting.
      state = GRILL_STATE.DETECT_GAPS;
      reason = "provenance_missing";
    }
  } else {
    state = GRILL_STATE.DETECT_GAPS;
  }

  const nextAction = reason === "provenance_missing"
    ? PROVENANCE_MISSING_NEXT_ACTION
    : GRILL_NEXT_ACTIONS[state];

  return {
    state,
    allowedTransitions: [...GRILL_TRANSITIONS[state]],
    nextAction,
    reason,
    bypass,
  };
}
