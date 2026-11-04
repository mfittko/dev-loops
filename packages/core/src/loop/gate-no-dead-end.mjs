import { BLOCKED_ON, PR_CHECKPOINT_ACTION } from "./pr-gate-coordination.mjs";

// Issue 3105: no-dead-end invariant. Each entry names the slice that removes it.
// `input` is undefined when the caller has no evaluator input (the conformance validator).
export const KNOWN_GAPS = [
  {
    id: "draft-round-cap-refusal",
    slice: "5-6",
    matches: (input, result) => (input === undefined || input.draftRoundRefused === true)
      && result.reason.includes("Round N+1 never runs"),
  },
  {
    id: "copilot-cap-ci",
    slice: "9",
    matches: (_input, result) => result.reason.startsWith("round_cap_reached at"),
  },
  {
    id: "unmappable-state-default",
    slice: "9",
    matches: (_input, result) => result.reason.includes("could not map lifecycle state"),
  },
];

const hasRunnableCommand = (command) => typeof command === "string" && command.length > 0 && !/[<>]/.test(command);

export const isTypedOrKnownGap = (input, result) => result.nextAction !== PR_CHECKPOINT_ACTION.REPORT_BLOCKED
  || Object.values(BLOCKED_ON).includes(result.blockedOn)
  || hasRunnableCommand(result.agentRemedy?.command)
  || KNOWN_GAPS.some((gap) => gap.matches(input, result));
