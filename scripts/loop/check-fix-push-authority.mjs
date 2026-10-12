#!/usr/bin/env node
/**
 * check-fix-push-authority: harness-neutral push gate for PRE-PUSH-DELTA-PUSH-AUTHORITY
 * (skills/docs/pre-pr-review-contract.md). The generated git pre-push hook runs it with git's
 * `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin. Exit 1 refuses the push while
 * a gate fix sequence is active for any pushed sha and the full work order has not granted the push;
 * exit 0 allows it. A parse error or git failure refuses (fail closed). With no ref lines the HEAD of
 * the checkout is tested. Agent identity is unknown to git, so this layer binds every pusher; the
 * Claude Bash hook adds the per-agent-type check on top.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { findActiveSequence } from "@dev-loops/core/loop/fix-push-authority";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ZERO_SHA_RE = /^0+$/u;

/**
 * The local shas a push sends, from git's pre-push stdin lines. Deletions (all-zero sha) are skipped.
 * Throws on a malformed line (fail closed).
 */
export function parsePushedShas(text) {
  const shas = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4 || !(SHA_RE.test(fields[1]) || ZERO_SHA_RE.test(fields[1]))) throw new Error(`malformed pre-push line ${JSON.stringify(line)}`);
    if (!ZERO_SHA_RE.test(fields[1])) shas.push(fields[1]);
  }
  return shas;
}

/** @param {string} cwd @param {string[]|null} pushedShas the shas being pushed, or null to test the checkout HEAD */
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
  const isAncestor = (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
  const remoteAdvanced = (baseline) => git("for-each-ref", "--contains", baseline, "--format=%(objectname)", "refs/remotes").split("\n").some((sha) => sha && sha !== baseline);
  const heads = pushedShas ?? [git("rev-parse", "HEAD").trim()];
  const refused = heads.some((head) => {
    const sequence = findActiveSequence({ tmpRoot, head, listBaselines, isAncestor, remoteAdvanced });
    return sequence !== null && sequence.fullGranted !== true;
  });
  return refused
    ? { ok: false, reason: "PRE-PUSH-DELTA-PUSH-AUTHORITY: a gate fix sequence is active and the full work order has not been emitted; only the full-phase fixer pushes the fix branch." }
    : { ok: true };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    let stdin = "";
    if (!process.stdin.isTTY) {
      try { stdin = readFileSync(0, "utf8"); } catch (error) { if (error?.code !== "EAGAIN" && error?.code !== "EOF") throw error; }
    }
    const shas = parsePushedShas(stdin);
    // No ref lines: test the checkout HEAD. Only deletions: nothing is pushed that a sequence could cover.
    const result = checkFixPushAuthority(process.cwd(), stdin.trim() === "" ? null : shas);
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`PRE-PUSH-DELTA-PUSH-AUTHORITY: could not read the pushed refs or git state; refusing the push (fail closed). ${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
