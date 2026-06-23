#!/usr/bin/env node
/**
 * PreToolUse Bash gate hook (#773).
 *
 * Reproduces the Pi extension's `onUserBash` draft-gate guard for Claude Code: blocks
 * `gh pr ready` for the target repo unless a clean draft_gate checkpoint verdict exists for the
 * PR (via scripts/loop/pre-pr-ready-gate.mjs). Merges are NOT blocked here (they trigger the
 * post-merge hook). All other commands pass through.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { decideBashGate } from "@dev-loops/core/claude/hook-decisions";
import {
  isGhPrReadyCommand,
  extractPrNumberFromGhPrReady,
  normalizeGitHubRepoSlug,
  TARGET_REPO_SLUG,
} from "@dev-loops/core/loop/bash-command-classify";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
if (typeof command !== "string" || !isGhPrReadyCommand(command)) {
  emitAllow();
}

const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

let repoRoot = null;
let repoSlug = null;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  repoSlug = normalizeGitHubRepoSlug(remote);
} catch {
  // Not a git repo / no remote — repoSlug stays null; decider passes through.
}

let gatePassed = false;
let gateError = null;
if (repoSlug === TARGET_REPO_SLUG) {
  const pr = extractPrNumberFromGhPrReady(command);
  if (pr !== null && repoRoot) {
    try {
      execFileSync(
        "node",
        [path.join(repoRoot, "scripts/loop/pre-pr-ready-gate.mjs"), "--repo", repoSlug, "--pr", String(pr)],
        { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] },
      );
      gatePassed = true;
    } catch (error) {
      // Exit 1 from the guard = no clean draft_gate evidence (gatePassed stays false).
      // A missing/unspawnable guard (no numeric status) = could-not-run → gateError.
      if (typeof error?.status !== "number") {
        gateError = "could not run the draft-gate guard script";
      }
    }
  }
}

const decision = decideBashGate({ command, repoSlug, gatePassed, gateError });
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}
emitAllow();
