#!/usr/bin/env node
/**
 * PostToolUse Bash post-merge hook (#773).
 *
 * The Pi extension ran `pi update git:...` after a merge to self-update the installed package.
 * It split this across two events: detect the merge (tool_result/user_bash), then run the
 * update at agent end (agent_end / the Stop/SubagentStop class). Claude Code has no equivalent
 * self-update — plugin updates flow through the marketplace (#774) — so the deferred-at-end
 * action is a no-op. There is therefore nothing to run on Stop/SubagentStop; the merge is simply
 * detected here on PostToolUse and an informational, non-blocking note is surfaced. Never blocks.
 */
import { isMergeCapableCommand } from "./_bash-command-classify.mjs";

import { readHookInput } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
if (typeof command === "string" && isMergeCapableCommand(command)) {
  process.stderr.write(
    "[dev-loops] merge detected — no self-update under Claude (plugin updates flow via the marketplace, #774).\n",
  );
}
process.exit(0);
