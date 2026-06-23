/**
 * Shared IO for Claude Code hook scripts (#773).
 *
 * Hooks receive the event payload as JSON on stdin and signal a PreToolUse decision either via
 * exit code 2 (stderr → Claude) or exit 0 with a `hookSpecificOutput` JSON object. We use the
 * structured JSON form so the deny reason is explicit. The decision logic itself lives in the
 * pure `@dev-loops/core/claude/hook-decisions` deciders — these helpers are only the edge IO.
 */
import { readFileSync } from "node:fs";

/** Read and parse the hook payload from stdin (fd 0). Returns {} on empty/invalid input. */
export function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Emit a PreToolUse "deny" decision and exit 0. */
export function emitDeny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
  process.exit(0);
}

/** Allow the tool call (no objection) and exit 0. */
export function emitAllow() {
  process.exit(0);
}
