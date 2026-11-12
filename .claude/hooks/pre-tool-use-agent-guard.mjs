#!/usr/bin/env node
/**
 * PreToolUse Agent/Task dispatch guard (GATE-EXEC-GATE-COORDINATOR, ADR 0112).
 *
 * Always on. Only callers whose `agent_type` is `dev-loop` or `gate-coordinator` are
 * constrained; the decision lives in the pure `decideAgentDispatch` decider.
 */
import { decideAgentDispatch } from "./_hook-decisions.mjs";
import { resolveIndexedWorkOrderRef } from "./_fixer-grants.mjs";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const prompt = input?.tool_input?.prompt ?? null;
// The short judge pointer carries no ref: resolve its identity through the execution index of every checkout (ADR 0267).
// A loose shape match: decideAgentDispatch validates the exact pointer.
const judgeIdentity = typeof prompt === "string" ? /pull-work-order\.mjs (j[\w-]+)`/.exec(prompt)?.[1] ?? null : null;
const decision = decideAgentDispatch({
  callerAgentType: typeof input?.agent_type === "string" ? input.agent_type : null,
  targetAgentType: input?.tool_input?.subagent_type ?? null,
  prompt,
  judgeWorkOrderRef: judgeIdentity ? resolveIndexedWorkOrderRef(judgeIdentity, typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd()) : null,
  agentOverrides: process.env.DEVLOOPS_AGENT_OVERRIDES ?? null,
});
if (decision.decision === "deny") emitDeny(decision.reason);
emitAllow();
