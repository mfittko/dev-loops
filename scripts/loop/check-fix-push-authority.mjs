#!/usr/bin/env node
/**
 * check-fix-push-authority: harness-neutral push gate for PRE-PUSH-DELTA-PUSH-AUTHORITY
 * (skills/docs/pre-pr-review-contract.md). The generated git pre-push hook runs it with git's
 * `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin. Exit 1 refuses the push while
 * a gate fix sequence is active for any pushed sha (the sha is the baseline or descends from it, and the PR
 * branch's remote ref has not advanced past the baseline) and the full work order has not granted the push;
 * exit 0 allows it. A marker that names a branch covers a push only when the known push target is
 * refs/heads/<branch>; a branchless marker, or an unknown push target, keeps the ancestry rule (fail closed).
 * A parse error or git failure refuses (fail closed). With no ref lines the HEAD of
 * the checkout is tested. Agent identity is unknown to git, so this check binds every pusher.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { findActiveSequence, recoveryHint, sequenceMarkerPath } from "@dev-loops/core/loop/fix-push-authority";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ZERO_SHA_RE = /^0+$/u;

/**
 * The local shas a push sends, from git's pre-push stdin lines. Deletions (all-zero sha) are skipped.
 * Throws on a malformed line (fail closed).
 */
export const parsePushedShas = (text) => parsePushes(text).map((p) => p.sha);

/** The `{ sha, remoteRef }` of each non-deletion push line. Throws on a malformed line (fail closed). */
export function parsePushes(text) {
  const pushes = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4 || !(SHA_RE.test(fields[1]) || ZERO_SHA_RE.test(fields[1]))) throw new Error(`malformed pre-push line ${JSON.stringify(line)}`);
    if (!ZERO_SHA_RE.test(fields[1])) pushes.push({ sha: fields[1], remoteRef: fields[2] });
  }
  return pushes;
}

/** @param {string} cwd @param {Array<string|{ sha: string, remoteRef?: string }>|null} pushedShas the pushes (a bare sha, or a sha with the remote ref it updates), or null to test the checkout HEAD */
export function checkFixPushAuthority(cwd = process.cwd(), pushedShas = null) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), stdio: ["ignore", "pipe", "ignore"] });
  const tmpRoot = resolveGateArtifactTmpRoot(cwd);
  const listBaselines = () => {
    try {
      return readdirSync(path.join(tmpRoot, "gate-delta")).filter((n) => n.endsWith(".sequence")).map((n) => n.slice(0, -".sequence".length));
    } catch (error) {
      if (error?.code === "ENOENT") return []; // No gate-delta directory: no sequence was ever started.
      throw error;
    }
  };
  // Exit 1 means "not an ancestor"; any other failure (missing object, invalid ref) throws and findActiveSequence refuses under that marker unless it is granted (fail closed).
  const isAncestor = (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch (error) { if (error?.status === 1) return false; throw error; } };
  const remoteAdvanced = (baseline, branch) => git("for-each-ref", "--contains", baseline, "--format=%(objectname)", `refs/remotes/*/${branch}`).split("\n").some((sha) => sha && sha !== baseline);
  const heads = (pushedShas ?? [git("rev-parse", "HEAD").trim()]).map((p) => typeof p === "string" ? { sha: p } : p);
  let refusedBy = null;
  for (const { sha: head, remoteRef } of heads) {
    const sequence = findActiveSequence({ tmpRoot, head, remoteRef, listBaselines, isAncestor, remoteAdvanced });
    if (sequence !== null && sequence.fullGranted !== true) { refusedBy = sequence; break; }
  }
  return refusedBy
    ? { ok: false, reason: `PRE-PUSH-DELTA-PUSH-AUTHORITY: a gate fix sequence is active and the full work order has not been emitted; only the full-phase fixer pushes the fix branch.${recoveryHint(refusedBy.baselineHead, sequenceMarkerPath(tmpRoot, refusedBy.baselineHead))}` }
    : { ok: true };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    let stdin = "";
    if (!process.stdin.isTTY) {
      try { stdin = readFileSync(0, "utf8"); } catch (error) { if (error?.code !== "EAGAIN" && error?.code !== "EOF") throw error; }
    }
    const pushes = parsePushes(stdin);
    // No ref lines: test the checkout HEAD. Only deletions: nothing is pushed that a sequence could cover.
    const result = checkFixPushAuthority(process.cwd(), stdin.trim() === "" ? null : pushes);
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`PRE-PUSH-DELTA-PUSH-AUTHORITY: could not read the pushed refs or git state; refusing the push (fail closed). ${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
