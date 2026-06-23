#!/usr/bin/env node
/**
 * PreToolUse Write/Edit read-only guard hook (#773).
 *
 * Makes the main-agent read-only boundary (main-agent-contract.md) mechanical under Claude:
 * denies a Write/Edit whose target is inside the repo working tree AND not gitignored when the
 * call originates from the MAIN agent, and allows it inside the dev-loop subagent context (CA2
 * `DEVLOOPS_RUN_ID`, or a Claude `agent_id`). Strict enforcement is opt-in via
 * `DEVLOOPS_MAIN_AGENT_READONLY=1` (default fail-open) so enabling the harness does not
 * retroactively break a repo's own interactive dev.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { decideWriteGuard } from "@dev-loops/core/claude/hook-decisions";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || !filePath) {
  emitAllow();
}

const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const enforce = process.env.DEVLOOPS_MAIN_AGENT_READONLY === "1";
// Claude exposes `agent_type` (the agent name) only inside a subagent. Only the dev-loop
// subagent is authorized to mutate — a generic subagent must not bypass the boundary.
const agentType = typeof input?.agent_type === "string" ? input.agent_type : null;

// Repo mutation = inside the repo working tree AND not gitignored.
let isRepoMutation = false;
try {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const abs = path.resolve(cwd, filePath);
  if (abs === repoRoot || abs.startsWith(repoRoot + path.sep)) {
    let ignored = false;
    try {
      // `git check-ignore -q` exits 0 when ignored, 1 when not ignored.
      execFileSync("git", ["check-ignore", "-q", "--", abs], { cwd: repoRoot, stdio: "ignore" });
      ignored = true;
    } catch {
      ignored = false;
    }
    isRepoMutation = !ignored;
  }
} catch {
  isRepoMutation = false; // not a git repo / path outside any repo
}

const decision = decideWriteGuard({ filePath, isRepoMutation, enforce, env: process.env, agentType });
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}
emitAllow();
