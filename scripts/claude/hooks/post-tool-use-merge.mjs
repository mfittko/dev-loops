#!/usr/bin/env node
/**
 * PostToolUse Bash post-merge hook (#773).
 *
 * The Pi extension ran `pi update git:...` after a merge to self-update the installed package.
 * Claude Code has no equivalent self-update: plugin updates flow through the marketplace
 * (#774). So this is a documented no-op that only surfaces an informational, non-blocking note
 * when a merge command completes. It never blocks.
 */
import { isMergeCapableCommand } from "@dev-loops/core/loop/bash-command-classify";

import { readHookInput } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
if (typeof command === "string" && isMergeCapableCommand(command)) {
  process.stderr.write(
    "[dev-loops] merge detected — no self-update under Claude (plugin updates flow via the marketplace, #774).\n",
  );
}
process.exit(0);
