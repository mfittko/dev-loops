#!/usr/bin/env node
/**
 * PreToolUse guard for the ask-approval record directory (MERGE-ASK-APPROVAL, ADR 0315).
 * Denies the tool calls it can judge that read, write or name the record directory or its key:
 * every string argument is compared case-folded and realpath-resolved, and scanned for the
 * directory name (this covers Bash commands, Glob patterns, Grep globs and MCP tool arguments).
 * It cannot see through a wrapper script or shell indirection; the shipped permission and sandbox
 * read denies are the second layer. Only the PostToolUse hook touches the directory. Agent posts of
 * the `approve merge` line stay denied by the raw comment write deny and the comment writers
 * (OPERATOR-OWNED-LINE).
 */
import path from "node:path";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";
import { isApprovalPath, commandNamesApprovalDir, ASK_APPROVAL_RECOVERY } from "./_ask-merge-approval.mjs";

// File bodies are written, not addressed: scanning them would block a doc that mentions the directory.
const BODY_KEYS = new Set(["content", "new_string", "old_string", "new_source", "description"]);

function stringArgs(value, key = "", depth = 0, out = []) {
  if (typeof value === "string") { if (!BODY_KEYS.has(key)) out.push(value); } else if (depth < 6 && value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) stringArgs(v, k, depth + 1, out);
  }
  return out;
}

const input = readHookInput();
const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const hit = stringArgs(input?.tool_input).some((s) => commandNamesApprovalDir(s) || isApprovalPath(path.resolve(cwd, s)));
if (hit) {
  emitDeny(`MERGE-ASK-APPROVAL: the merge approval record directory is written by the harness hook only. No agent tool reads, writes or names it. ${ASK_APPROVAL_RECOVERY}`);
}
emitAllow();
