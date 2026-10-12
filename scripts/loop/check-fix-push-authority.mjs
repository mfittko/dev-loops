#!/usr/bin/env node
/**
 * check-fix-push-authority: harness-neutral push gate for PRE-PUSH-DELTA-PUSH-AUTHORITY
 * (skills/docs/pre-pr-review-contract.md). The generated git pre-push hook runs it. Exit 1 refuses
 * the push while a gate fix sequence is active and the full work order has not granted the push;
 * exit 0 allows it. Git failures refuse (fail closed). Agent identity is unknown to git, so this
 * layer binds every pusher; the Claude Bash hook adds the per-agent-type check on top.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

import { findActiveSequence } from "@dev-loops/core/loop/fix-push-authority";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

export function checkFixPushAuthority(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), stdio: ["ignore", "pipe", "ignore"] });
  const tmpRoot = resolveGateArtifactTmpRoot(cwd);
  const sequence = findActiveSequence({
    tmpRoot,
    head: git("rev-parse", "HEAD").trim(),
    listBaselines: () => {
      try {
        return readdirSync(path.join(tmpRoot, "gate-delta")).filter((n) => n.endsWith(".sequence")).map((n) => n.slice(0, -".sequence".length));
      } catch (error) {
        if (error?.code === "ENOENT") return []; // No gate-delta directory: no sequence was ever started.
        throw error;
      }
    },
    isAncestor: (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } },
    remoteAdvanced: (baseline) => git("for-each-ref", "--contains", baseline, "--format=%(objectname)", "refs/remotes").split("\n").some((sha) => sha && sha !== baseline),
  });
  return sequence !== null && sequence.fullGranted !== true
    ? { ok: false, reason: "PRE-PUSH-DELTA-PUSH-AUTHORITY: a gate fix sequence is active and the full work order has not been emitted; only the full-phase fixer pushes the fix branch." }
    : { ok: true };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    const result = checkFixPushAuthority();
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`PRE-PUSH-DELTA-PUSH-AUTHORITY: could not read git state; refusing the push (fail closed). ${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
