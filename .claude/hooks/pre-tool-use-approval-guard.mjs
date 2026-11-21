#!/usr/bin/env node
/**
 * PreToolUse guard for the ask-approval record directory (MERGE-ASK-APPROVAL, ADR 0315).
 * Denies the tool calls it can judge that read, write or name the record directory or its key:
 * every string argument is compared case-folded and realpath-resolved, and scanned for the
 * directory name (this covers Bash commands, Glob patterns, Grep globs and MCP tool arguments).
 * It also denies arguments naming the parent `.config/dev-loops`. It cannot see through a wrapper
 * script, shell globbing or other shell indirection; the shipped permission denies (and the sandbox
 * read deny when the sandbox is enabled) are the second layer. A bare mention in a commit message
 * or body flag is denied too. An error in this hook denies (exit 2). Only the PostToolUse hook touches the directory. Agent posts of
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

// A hook error must not fall through to allow: deny with exit 2 (stderr reaches the model).
try {
  const input = readHookInput();
  const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  // A copy of the harness env, so the test override widens the guard next to the default directory.
  const env = { ...process.env };
  const hit = stringArgs(input?.tool_input).some((s) => commandNamesApprovalDir(s, env) || isApprovalPath(path.resolve(cwd, s), env));
  if (hit) {
    emitDeny(`MERGE-ASK-APPROVAL: the merge approval record directory is written by the harness hook only. No agent tool reads, writes or names it. ${ASK_APPROVAL_RECOVERY}`);
  }
} catch (error) {
  process.stderr.write(`MERGE-ASK-APPROVAL: the approval guard failed (${error?.message ?? error}), so the call is denied. Retry the call; if it keeps failing, report it to the operator.\n`);
  process.exit(2);
}
emitAllow();
