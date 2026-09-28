#!/usr/bin/env node
/**
 * PreToolUse Agent/Task dispatch guard (GATE-EXEC-GATE-COORDINATOR, ADR 0112, #2531).
 *
 * Always on. Only callers whose `agent_type` is `dev-loop` or `gate-coordinator` are
 * constrained; the decision lives in the pure `decideAgentDispatch` decider.
 */
import { decideAgentDispatch } from "./_hook-decisions.mjs";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const decision = decideAgentDispatch({
  callerAgentType: typeof input?.agent_type === "string" ? input.agent_type : null,
  targetAgentType: input?.tool_input?.subagent_type ?? null,
  prompt: input?.tool_input?.prompt ?? null,
});
if (decision.decision === "deny") emitDeny(decision.reason);
emitAllow();
