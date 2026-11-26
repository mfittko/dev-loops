// Typed coordinator hand-back check (COORDINATOR-ROUND-BOUNDARY-HANDBACK, issue 3069).
const FIELD_CHECKS = {
  pr: (v) => Number.isInteger(v) && v > 0,
  head: (v) => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v),
  nextAction: (v) => typeof v === "string" && v.trim() !== "",
  workerRunning: (v) => typeof v === "boolean",
};

// A round whose verdict post was refused for red CI hands back the CI route.
export const CI_ROUTE_NEXT_ACTION = "fix_ci_failure";

// Issue 3097 (ADR 0325): a round-boundary packet with one of these nextActions continues in the same run until the cap.
export const ROUTINE_NEXT_ACTIONS = ["run_draft_gate", "address_review_feedback", "mark_ready_for_review", "run_pre_approval_gate", "wait_for_ci"];
export const ROUTINE_BOUNDARY_CAP = 3;
const ROUND_BOUNDARY_STATUSES = ["gate_round_end", "fix_pass_end", "gate_verdict_posted"];

// The pre-fan-out CI stop (GATE-EXEC-GATE-COORDINATOR): a wait-pr-checks result that is not settled green at the head stops the round with this observation.
export const CI_NOT_GREEN_OBSERVATION = "ci_not_green";
/** Returns null for settled green CI at headSha, else { observation, nextAction: "fix_ci_failure"|"wait_for_ci", ciStatus }. */
export function preFanoutCiObservation(ci, headSha) {
  if (ci?.ok === true && ci.headSha === headSha && ci.settled === true && ci.ciStatus === "success") return null;
  const red = ci?.ciStatus === "failure" && ci.headSha === headSha;
  return { observation: CI_NOT_GREEN_OBSERVATION, nextAction: red ? CI_ROUTE_NEXT_ACTION : "wait_for_ci", ciStatus: ci?.ciStatus ?? "unknown" };
}
const VERDICT_REFUSAL_RECOVERY = `Hand back verdictRefusal { reason: "ci_red", actListPath: <the round's judge-pass act list> } with nextAction "${CI_ROUTE_NEXT_ACTION}"; the fixer order then takes the act list and the CI failure together: dev-loops-run scripts/loop/emit-fixer-work-order.mjs --repo <owner/name> --pr <n> --head-sha <sha> --harness <claude|pi|codex> --phase full --ci-file <wait-pr-checks JSON> --act-list-file <tmp/gate-judge/<repo-slug>/pr-<N>/<gate>-<head>/act-list.json> --gate <gate>.`;

/** Returns {ok:true}, or {ok:false, refusal, message[, missing, recovery]} for a malformed or premature hand-back. */
export function validateCoordinatorHandback(handback) {
  const missing = Object.keys(FIELD_CHECKS).filter((key) => !FIELD_CHECKS[key](handback?.[key]));
  if (missing.length) {
    return { ok: false, refusal: "missing_fields", missing, message: `Hand-back refused: missing or invalid ${missing.join(", ")} (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).` };
  }
  if (handback.workerRunning) {
    return { ok: false, refusal: "worker_running", message: "Hand-back refused: a dispatched worker is still running; join it first (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK)." };
  }
  const refusal = handback.verdictRefusal;
  if (refusal !== undefined) {
    const valid = refusal?.reason === "ci_red" && typeof refusal.actListPath === "string" && refusal.actListPath.trim() !== "";
    if (!valid || handback.nextAction !== CI_ROUTE_NEXT_ACTION) {
      return { ok: false, refusal: "verdict_refusal_route", message: `Hand-back refused: a verdict post refused for red CI needs verdictRefusal { reason: "ci_red", actListPath } and nextAction "${CI_ROUTE_NEXT_ACTION}" (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).`, recovery: VERDICT_REFUSAL_RECOVERY };
    }
  }
  // A null, empty or non-string status counts as missing, so as a round-boundary packet; any other status is another run-ending case.
  const statusMissing = typeof handback.status !== "string" || handback.status.trim() === "";
  const crossed = Number.isInteger(handback.routineBoundaries) && handback.routineBoundaries > 0 ? handback.routineBoundaries : 0;
  if ((statusMissing || ROUND_BOUNDARY_STATUSES.includes(handback.status.trim())) && ROUTINE_NEXT_ACTIONS.includes(handback.nextAction) && crossed < ROUTINE_BOUNDARY_CAP) {
    return {
      ok: false,
      refusal: "routine_boundary",
      message: `Hand-back refused: nextAction "${handback.nextAction}" is routine and this run crossed ${crossed} of ${ROUTINE_BOUNDARY_CAP} routine boundaries (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).`,
      recovery: `Run \`loop gate-coordination --pr ${handback.pr} --repo <owner/name>\` and run its routine nextAction "${handback.nextAction}" in this run with the runner claim you hold; hand back at the first non-routine nextAction or at ${ROUTINE_BOUNDARY_CAP} routine boundaries, with routineBoundaries set to the count crossed.`,
    };
  }
  return { ok: true };
}
