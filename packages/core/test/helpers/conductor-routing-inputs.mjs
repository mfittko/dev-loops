// Shared input product for the conductor routing golden and statechart tests.
import { STATE } from "../../src/loop/copilot-loop-state.mjs";
import { REVIEWER_STATE } from "../../src/loop/reviewer-loop-state.mjs";

export const ABSENT = Symbol("absent");

export const dims = {
  copilotState: [...Object.values(STATE), "", "unknown_sentinel_state"],
  reviewerState: [...Object.values(REVIEWER_STATE), "", "unknown_sentinel_state"],
  ownershipState: [ABSENT, "live_owner", "duplicate_local_owners", "some_other_ownership"],
  requiresLocalIsolation: [true, false],
  target: [{ repo: "Acme/Widgets", pr: 42 }, null, { repo: "Acme/Widgets", pr: -1 }],
  sourceMode: ["authoritative", "local", "snapshot", ABSENT],
};

export function buildInputs() {
  let inputs = [{}];
  for (const [key, values] of Object.entries(dims)) {
    inputs = inputs.flatMap((base) => values.map((v) => (v === ABSENT ? { ...base } : { ...base, [key]: v })));
  }
  return inputs;
}
