// Typed coordinator hand-back check (COORDINATOR-ROUND-BOUNDARY-HANDBACK, issue 3069).
const FIELD_CHECKS = {
  pr: (v) => Number.isInteger(v) && v > 0,
  head: (v) => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v),
  nextAction: (v) => typeof v === "string" && v.trim() !== "",
  workerRunning: (v) => typeof v === "boolean",
};

// A round whose verdict post was refused for red CI hands back the CI route.
export const CI_ROUTE_NEXT_ACTION = "fix_ci_failure";
const VERDICT_REFUSAL_RECOVERY = `Hand back verdictRefusal { reason: "ci_red", actListPath: <the round's judge-pass act list> } with nextAction "${CI_ROUTE_NEXT_ACTION}"; the fixer order then takes the act list and the CI failure together: scripts/loop/emit-fixer-work-order.mjs --phase full --ci-file <wait-pr-checks JSON> --act-list-file <actListPath> --gate <gate>.`;

/** Returns {ok:true}, or {ok:false, refusal, message, recovery[, missing]} for a malformed or premature hand-back. */
export function validateCoordinatorHandback(handback) {
  const missing = Object.keys(FIELD_CHECKS).filter((key) => !FIELD_CHECKS[key](handback?.[key]));
  if (missing.length) {
    return { ok: false, refusal: "missing_fields", missing, message: `Hand-back refused: missing or invalid ${missing.join(", ")} (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).`, recovery: `Fill ${missing.join(", ")} in the packet, then re-run scripts/loop/validate-coordinator-handback.mjs --packet <path>.` };
  }
  if (handback.workerRunning) {
    return { ok: false, refusal: "worker_running", message: "Hand-back refused: a dispatched worker is still running; join it first (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).", recovery: "Join the running worker (gate wait-for-units), then hand back with workerRunning false." };
  }
  const refusal = handback.verdictRefusal;
  if (refusal !== undefined) {
    const valid = refusal?.reason === "ci_red" && typeof refusal.actListPath === "string" && refusal.actListPath.trim() !== "";
    if (!valid || handback.nextAction !== CI_ROUTE_NEXT_ACTION) {
      return { ok: false, refusal: "verdict_refusal_route", message: `Hand-back refused: a verdict post refused for red CI needs verdictRefusal { reason: "ci_red", actListPath } and nextAction "${CI_ROUTE_NEXT_ACTION}" (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).`, recovery: VERDICT_REFUSAL_RECOVERY };
    }
  }
  return { ok: true };
}
