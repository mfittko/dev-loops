#!/usr/bin/env node
/**
 * PreToolUse guard for the ask-approval record directory (MERGE-ASK-APPROVAL, ADR 0315).
 * Denies every agent tool call that reads, writes or names the record directory or its key.
 * Only the PostToolUse hook touches it. Agent posts of the `approve merge` line stay denied by the
 * raw comment write deny and the comment writers (OPERATOR-OWNED-LINE).
 */
import path from "node:path";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";
import { isApprovalPath, commandNamesApprovalDir, ASK_APPROVAL_RECOVERY } from "./_ask-merge-approval.mjs";

const input = readHookInput();
const toolInput = input?.tool_input ?? {};
const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const targets = [toolInput.file_path, toolInput.notebook_path, toolInput.path].filter((p) => typeof p === "string" && p);
const hit = commandNamesApprovalDir(toolInput.command) || targets.some((p) => isApprovalPath(path.resolve(cwd, p)));
if (hit) {
  emitDeny(`MERGE-ASK-APPROVAL: the merge approval record directory is written by the harness hook only. No agent tool reads, writes or names it. ${ASK_APPROVAL_RECOVERY}`);
}
emitAllow();
