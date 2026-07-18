#!/usr/bin/env node
/**
 * PreToolUse Bash gate hook (#773).
 *
 * Blocks these commands on the target repo; everything else passes through:
 *   - `gh pr create` — blocked outright (no gate evidence to check): PR creation must flow through
 *     the canonical wrapper scripts/github/create-pr.mjs (dev-loops pr create), which always drafts
 *     and self-assigns. Closes the hole where raw `gh pr create` opens a ready PR (draft-first breach).
 *   - `gh pr ready` — needs a clean draft_gate verdict (via scripts/loop/pre-pr-ready-gate.mjs).
 *   - `gh pr merge` — needs full pre-merge evidence (clean current-head draft_gate +
 *     pre_approval_gate, via scripts/github/detect-checkpoint-evidence.mjs). This closes the hole
 *     where a hand-run merge skips the loop's pre-merge gate check (and thus the pre-approval gate).
 *   - raw `gh issue create` / `gh issue comment` / `gh pr comment` — blocked only from a SUBAGENT
 *     context (agent_type present); the main agent/operator retains direct issue creation (#1051).
 *   - `git stash` — blocked outright: `refs/stash` is shared across every worktree over this
 *     repo's one `.git` directory (skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { decideBashGate } from "./_hook-decisions.mjs";
import {
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  commandContainsRawExternalWrite,
  commandContainsGitStash,
  extractPrNumberFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  normalizeGitHubRepoSlug,
  TARGET_REPO_SLUG,
} from "./_bash-command-classify.mjs";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
// Claude exposes `agent_type` only inside a subagent; null in the main agent. Scopes the
// external-write guard (raw `gh issue create` etc. is blocked only from a subagent).
const agentType = typeof input?.agent_type === "string" ? input.agent_type : null;
const isReady = typeof command === "string" && commandContainsGhPrReady(command);
const isMerge = typeof command === "string" && commandContainsGhPrMerge(command);
const isCreate = typeof command === "string" && commandContainsGhPrCreate(command);
const isExternalWrite = typeof command === "string" && commandContainsRawExternalWrite(command);
const isStash = typeof command === "string" && commandContainsGitStash(command);
if (!isReady && !isMerge && !isCreate && !isExternalWrite && !isStash) {
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
  // When both verbs appear (compound command), apply the stricter merge gate.
  const pr = isMerge ? extractPrNumberFromGhPrMergeAnywhere(command) : extractPrNumberFromGhPrReadyAnywhere(command);
  if (pr !== null && repoRoot) {
    // Each gate script is overridable for deterministic testing (stub instead of the
    // network-touching real guard). `gh pr ready` → draft-gate only; `gh pr merge` → the full
    // pre-merge evidence check (draft_gate + pre_approval_gate).
    const gateScript = isMerge
      ? process.env.DEVLOOPS_PRE_MERGE_GATE_SCRIPT ||
        path.join(repoRoot, "scripts/github/detect-checkpoint-evidence.mjs")
      : process.env.DEVLOOPS_PRE_PR_READY_GATE_SCRIPT || path.join(repoRoot, "scripts/loop/pre-pr-ready-gate.mjs");
    try {
      execFileSync("node", [gateScript, "--repo", repoSlug, "--pr", String(pr)], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
      gatePassed = true;
    } catch (error) {
      // Exit 1 from the guard = gate evidence missing/insufficient (gatePassed stays false).
      // A missing/unspawnable guard (no numeric status) = could-not-run → gateError.
      if (typeof error?.status !== "number") {
        gateError = "could not run the gate guard script";
      }
    }
  }
}

const decision = decideBashGate({ command, repoSlug, gatePassed, gateError, agentType });
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}
emitAllow();
