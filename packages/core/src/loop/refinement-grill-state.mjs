/**
 * Deterministic state machine for the refinement/grill sub-loop.
 *
 * The refinement loop runs the grill as a CLOSED, DETERMINISTIC sub-loop:
 * detect-gaps -> auto-answer -> synthesize -> re-grill -> terminal. The
 * iteration lives entirely in the transition graph below; the LLM answer and
 * synthesis enter ONLY as a bounded input consumed at the `await_answers`
 * state (and reflected in the `synthesized` snapshot flag), never as hidden
 * orchestration inside a deterministic coordinator script (keeps
 * OPS-NO-INLINE-INTERPRETER, #1224, clean).
 *
 * Mirrors the shape of `reviewer-loop-state.mjs` / `copilot-loop-state.mjs`:
 * a frozen STATE vocabulary, a frozen TRANSITIONS adjacency table, a
 * `normalize*Snapshot` canonicalizer, and a pure `interpret*State` that maps a
 * point-in-time snapshot to exactly one current state plus its legal exits.
 *
 * Honest handoff: when a gap is genuinely unanswerable (only-`inferred`, no
 * citation), the machine reaches `needs_human_handoff` naming the question
 * rather than fabricating an answer to force convergence.
 */

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
// terminates honestly at needs_human_handoff.
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

function normalizeCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeStringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
    targetRef: normalizeStringOrNull(raw.targetRef),

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
  };
}

/**
 * Deterministically interpret the current refinement-grill state.
 *
 * @param {object} snapshot
 * @returns {{state: string, allowedTransitions: string[], nextAction: string}}
 */
export function interpretRefinementGrillState(snapshot) {
  const s = normalizeGrillSnapshot(snapshot);

  let state;

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
    // Detection ran with no unresolved and no pending answers:
    // open gaps -> await answers; zero gaps -> clean fixed point
    // (also the already-refined, zero-iteration path).
    state = s.openGapCount > 0 ? GRILL_STATE.AWAIT_ANSWERS : GRILL_STATE.GRILL_CLEAN;
  } else {
    state = GRILL_STATE.DETECT_GAPS;
  }

  return {
    state,
    allowedTransitions: [...GRILL_TRANSITIONS[state]],
    nextAction: GRILL_NEXT_ACTIONS[state],
  };
}
