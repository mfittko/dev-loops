// Typed coordinator hand-back check (COORDINATOR-ROUND-BOUNDARY-HANDBACK, issue 3069).
const FIELD_CHECKS = {
  pr: (v) => Number.isInteger(v) && v > 0,
  head: (v) => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v),
  nextAction: (v) => typeof v === "string" && v.trim() !== "",
  workerRunning: (v) => typeof v === "boolean",
};

/** Returns {ok:true}, or {ok:false, refusal, message[, missing]} for a malformed or premature hand-back. */
export function validateCoordinatorHandback(handback) {
  const missing = Object.keys(FIELD_CHECKS).filter((key) => !FIELD_CHECKS[key](handback?.[key]));
  if (missing.length) {
    return { ok: false, refusal: "missing_fields", missing, message: `Hand-back refused: missing or invalid ${missing.join(", ")} (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK).` };
  }
  if (handback.workerRunning) {
    return { ok: false, refusal: "worker_running", message: "Hand-back refused: a dispatched worker is still running; join it first (required by COORDINATOR-ROUND-BOUNDARY-HANDBACK)." };
  }
  return { ok: true };
}
