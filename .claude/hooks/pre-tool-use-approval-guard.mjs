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
 * functions (writeApprovalRecord, createApprovalHmacKey, loadApprovalHmacKey) as whole identifiers, so a
 * consumer's own `loadKey` or `createKey` passes. A bare mention in a commit message or body flag is denied too. An
 * error in this hook denies (exit 2), and so does a tool_input with more than 10000 nodes (the whole
 * tree is scanned, object keys included, except the string values under content, new_string, old_string,
 * new_source and description, which are skipped for every tool). Only the PostToolUse hook touches the directory. Agent posts of
 * the `approve merge` line stay denied by the raw comment write deny and the comment writers
 * (OPERATOR-OWNED-LINE).
 */
import path from "node:path";
import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";
import { isApprovalPath, approvalNameHit, ASK_APPROVAL_RECOVERY } from "./_ask-merge-approval.mjs";

// File bodies are written, not addressed: scanning them would block a doc that mentions the directory.
const BODY_KEYS = new Set(["content", "new_string", "old_string", "new_source", "description"]);

const MAX_NODES = 10000;

// Scan the whole argument tree, bounded by a total node count (not depth): ordinary nested MCP payloads pass.
function stringArgs(root) {
  const out = [];
  const stack = [["", root]];
  let nodes = 0;
  while (stack.length > 0) {
    const [key, value] = stack.pop();
    // An unscanned value could name the record: fail closed (the catch below denies with exit 2).
    if ((nodes += 1) > MAX_NODES) throw new Error(`a tool argument has more than ${MAX_NODES} nodes and cannot be scanned; split or shrink the arguments`);
    if (typeof value === "string") { if (!BODY_KEYS.has(key)) out.push(value); } else if (value && typeof value === "object") {
      // Object keys are addressable too (`{ "<record dir>": ... }`): scan them like values.
      for (const entry of Object.entries(value)) { out.push(entry[0]); stack.push(entry); }
    }
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
  process.stderr.write(`MERGE-ASK-APPROVAL: the approval guard failed (${error?.message ?? error}), so the call is denied. If the message names the node limit, split or shrink the arguments and call again; otherwise report it to the operator.\n`);
  process.exit(2);
}
emitAllow();
