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
import { findOperatorOwnedLineRefusal } from "../github/operator-owned-lines.mjs";

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
// The exact first-line heading a results comment must carry -- SKILL.md Step 4
// and the output artifact contract require exactly "## " (one hash pair, one
// space), never a bare title or a different heading level.
const RESULTS_COMMENT_HEADING = `## ${RESULTS_COMMENT_TITLE}`;
// A results comment's recorded bypass line: "bypass: operator-authorized by <handle>",
// with an optional leading @ before the handle and a case-insensitive "bypass:" key.
const BYPASS_LINE_RE = /^bypass: operator-authorized by @?([A-Za-z0-9][A-Za-z0-9-]{0,38})\s*$/i;

function normalizeCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function commentBody(comment) {
  if (typeof comment === "string") return comment;
  return comment && typeof comment.body === "string" ? comment.body : null;
}

function firstNonEmptyLine(body) {
  return body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

// A comment counts as a results comment only when its FIRST non-empty line,
// trimmed, is EXACTLY the "## " heading -- this rejects a bare title, a
// different heading level (`###`), a missing space (`##🔬`), the title merely
// quoted in a code fence, or the title appearing later in an unrelated reply.
function isResultsComment(body) {
  return firstNonEmptyLine(body) === RESULTS_COMMENT_HEADING;
}

export const SPEC_CHANGED_SINCE_GRILL_REASON = "spec_changed_since_grill";

// Loop-owned comments never change the spec (GRILL-SUBLOOP-SPEC-CHANGED-SINCE-GRILL):
// a `<!-- dev-loops:` marker comment, a merge record, an operator-owned line,
// and the grill's own results comment.
function isLoopOwnedComment(body) {
  const first = firstNonEmptyLine(body);
  return first.startsWith("<!-- dev-loops:")
    || first.startsWith("merge-pr record:")
    || isResultsComment(body)
    || findOperatorOwnedLineRefusal(body) !== null;
}

function timestampOrNull(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : time;
}

/**
 * True when the spec changed after the latest `🔬 Grill / refinement results`
 * comment: a counted (not loop-owned) comment was posted after it, or the body
 * `lastEditedAt` is after it. No dated results comment means false; the
 * provenance check owns that case. Pure.
 *
 * @param {{comments?: Array<string|{body?: string, createdAt?: string}>, bodyLastEditedAt?: string|null}} input
 * @returns {boolean}
 */
export function detectSpecChangedSinceGrill({ comments = [], bodyLastEditedAt = null } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  let latestGrill = null;
  for (const comment of list) {
    const body = commentBody(comment);
    const time = timestampOrNull(comment?.createdAt);
    if (body !== null && time !== null && isResultsComment(body) && (latestGrill === null || time > latestGrill)) {
      latestGrill = time;
    }
  }
  if (latestGrill === null) return false;
  const edited = timestampOrNull(bodyLastEditedAt);
  if (edited !== null && edited > latestGrill) return true;
  return list.some((comment) => {
    const body = commentBody(comment);
    const time = timestampOrNull(comment?.createdAt);
    return body !== null && time !== null && time > latestGrill && !isLoopOwnedComment(body);
  });
}

// shortcut: reads the last 100 comments only; page the connection if a target outgrows that.
const SPEC_CHANGE_FACTS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){
... on Issue { body lastEditedAt comments(last:100) { nodes { body createdAt } } }
... on PullRequest { body lastEditedAt comments(last:100) { nodes { body createdAt } } }
}}}`;

/**
 * `gh` args that read an issue or PR body, its GraphQL `lastEditedAt` and its
 * comments with `createdAt`. `gh issue view --json` does not expose `lastEditedAt`.
 *
 * @param {{repo: string, number: number|string}} input
 * @returns {string[]}
 */
export function buildSpecChangeFactsGhArgs({ repo, number }) {
  const [owner, name] = String(repo).split("/");
  return [
    "api", "graphql",
    "-f", `query=${SPEC_CHANGE_FACTS_QUERY}`,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${number}`,
    "--jq", ".data.repository.issueOrPullRequest",
  ];
}

/**
 * Normalize the `buildSpecChangeFactsGhArgs` output node. Pure.
 *
 * @param {unknown} node
 * @returns {{body: string, lastEditedAt: string|null, comments: Array<{body?: string, createdAt?: string}>}}
 */
export function parseSpecChangeFacts(node) {
  const comments = node?.comments?.nodes ?? node?.comments;
  return {
    body: typeof node?.body === "string" ? node.body : "",
    lastEditedAt: typeof node?.lastEditedAt === "string" ? node.lastEditedAt : null,
    comments: Array.isArray(comments) ? comments : [],
  };
}

/**
 * Run `buildSpecChangeFactsGhArgs` through an injected async `runChild`
 * (`{code, stdout, stderr}`) and parse the result. A failed or unparseable
 * read throws with code `GH_API_ERROR`.
 */
export async function fetchSpecChangeFacts({ repo, number, env, runChild }) {
  const result = await runChild("gh", buildSpecChangeFactsGhArgs({ repo, number }), env);
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || `exit code ${result.code}`;
    throw Object.assign(new Error(`gh api graphql failed: ${detail}`), { code: "GH_API_ERROR" });
  }
  try {
    return parseSpecChangeFacts(JSON.parse(result.stdout));
  } catch {
    throw Object.assign(new Error("gh api graphql returned invalid JSON"), { code: "GH_API_ERROR" });
  }
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
    const body = commentBody(comment);
    if (body === null || !isResultsComment(body)) continue;
    const lines = body.split(/\r?\n/);

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
    // a counted comment or a body edit after the latest results comment
    // (detectSpecChangedSinceGrill); meaningless without recorded provenance.
    specChangedSinceGrill: Boolean(raw.provenanceRecorded) && Boolean(raw.specChangedSinceGrill),
  };
}

const PROVENANCE_MISSING_NEXT_ACTION =
  "Run the semantic gap pass on the loaded spec, then post the \"🔬 Grill / refinement results\" comment recording the outcome — including a zero-gap pass, which states that no gaps were found";
const SPEC_CHANGED_NEXT_ACTION =
  "Re-grill: read the comments and body edits after the latest \"🔬 Grill / refinement results\" comment, fold the accepted content into the body and its AC / DoD matrix, then post a new results comment";

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
    } else if (s.specChangedSinceGrill) {
      // The spec changed after the latest grill: the grill owes another pass,
      // with or without a bypass line on an earlier results comment.
      state = GRILL_STATE.DETECT_GAPS;
      reason = SPEC_CHANGED_SINCE_GRILL_REASON;
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
    : reason === SPEC_CHANGED_SINCE_GRILL_REASON
      ? SPEC_CHANGED_NEXT_ACTION
      : GRILL_NEXT_ACTIONS[state];

  return {
    state,
    allowedTransitions: [...GRILL_TRANSITIONS[state]],
    nextAction,
    reason,
    bypass,
  };
}
