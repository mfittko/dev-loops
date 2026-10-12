/**
 * fix-push-authority.mjs: during a gate fix sequence only the full-phase fixer pushes the fix
 * branch (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-PUSH-AUTHORITY).
 *
 * `sequenceActive` means the worktree head is a delta candidate that awaits the full phase. The
 * caller derives it from the delta decision record. Pure; a hook or a CLI supplies the facts.
 */
const PUSH_RE = /(^|[;&|(\s])git\s+(?:-C\s+\S+\s+)?push(\s|$)/u;

/** @returns {{ decision: "allow"|"deny", reason?: string }} */
export function decideFixPushAuthority({ command, agentType, sequenceActive }) {
  if (typeof command !== "string" || !PUSH_RE.test(command) || sequenceActive !== true) return { decision: "allow" };
  // The main agent (no subagent type) is the operator; only subagents are bound by the sequence.
  if (typeof agentType !== "string" || agentType.length === 0) return { decision: "allow" };
  if (agentType.split(":").pop() === "fixer") return { decision: "allow" };
  return {
    decision: "deny",
    reason: "PRE-PUSH-DELTA-PUSH-AUTHORITY: a delta candidate awaits the full phase; only the full-phase fixer pushes the fix branch. Hand the committed candidate back unpushed.",
  };
}
