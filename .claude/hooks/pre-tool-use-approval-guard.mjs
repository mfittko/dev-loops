#!/usr/bin/env node
/**
 * PreToolUse guard for the ask-approval record directory (MERGE-ASK-APPROVAL, ADR 0315).
 * Denies the tool calls it can judge that read, write or name the record directory or its key:
 * every string argument is compared case-folded and realpath-resolved, and scanned for the
 * directory name (this covers Bash commands, Glob patterns, Grep globs and MCP tool arguments).
 * It also denies arguments naming the parent `.config/dev-loops`. It cannot see through a wrapper
 * script, shell globbing or other shell indirection; in this repository the project settings
 * permission denies (and the sandbox read deny when the sandbox is enabled) are the second layer.
 * A plugin consumer gets this hook alone. It also denies arguments naming the record signing
 * functions (writeApprovalRecord, createKey, loadKey) as whole identifiers, so `uploadKey` or
 * `createKeyPair` pass. A bare mention in a commit message or body flag is denied too. An
 * error in this hook denies (exit 2), and so does an argument nested deeper than 6 levels. Only the PostToolUse hook touches the directory. Agent posts of
 * the `approve merge` line stay denied by the raw comment write deny and the comment writers
 * (OPERATOR-OWNED-LINE).
 */
import path from "node:path";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";
import { isApprovalPath, approvalNameHit, ASK_APPROVAL_RECOVERY } from "./_ask-merge-approval.mjs";

// File bodies are written, not addressed: scanning them would block a doc that mentions the directory.
const BODY_KEYS = new Set(["content", "new_string", "old_string", "new_source", "description"]);

const MAX_DEPTH = 6;

function stringArgs(value, key = "", depth = 0, out = []) {
  if (typeof value === "string") { if (!BODY_KEYS.has(key)) out.push(value); } else if (value && typeof value === "object") {
    // An unscanned deeper value could name the record: fail closed (the catch below denies with exit 2).
    if (depth >= MAX_DEPTH && Object.keys(value).length > 0) throw new Error(`a tool argument is nested deeper than ${MAX_DEPTH} levels and cannot be scanned`);
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
  let hit = null;
  for (const s of stringArgs(input?.tool_input)) {
    hit = approvalNameHit(s, env) ?? (isApprovalPath(path.resolve(cwd, s), env) ? s : null);
    if (hit !== null) break;
  }
  if (hit !== null) {
    emitDeny(`MERGE-ASK-APPROVAL: the merge approval record directory is written by the harness hook only. No agent tool reads, writes or names it. The call names \`${hit.slice(0, 80)}\`; rephrase it without that name or path. ${ASK_APPROVAL_RECOVERY}`);
  }
} catch (error) {
  process.stderr.write(`MERGE-ASK-APPROVAL: the approval guard failed (${error?.message ?? error}), so the call is denied. Retry the call; if it keeps failing, report it to the operator.\n`);
  process.exit(2);
}
emitAllow();
