#!/usr/bin/env node
/**
 * close-gate-sequence: close an abandoned gate fix sequence marker (PRE-PUSH-DELTA-PUSH-AUTHORITY).
 * The tool removes `<tmp>/gate-delta/<head>.sequence` only after it proves one abandonment condition
 * from authoritative state, and writes the audit record `<head>.sequence-closed.<execution|none>.json` first.
 * Conditions: HEAD_MOVED (the marker's PR head differs from the marker baseline, so the baseline is
 * obsolete) and FIXER_NEVER_PULLED (the marker names a fixer execution whose work order was never
 * pulled within the dispatch grace, so no fixer ran and no commit on the branch is the fixer's).
 * A live sequence is never closed. Refusals: sequence_absent, baseline_unknown, sequence_live, fixer_running, abandonment_unproven.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { clearSequenceMarker, readSequenceMarker, sequenceClosurePath, sequenceMarkerPath, withSequenceLock } from "@dev-loops/core/loop/fix-push-authority";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, preflightFieldsSpec, preflightJqFilter } from "../lib/jq-output.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { viewPr } from "../github/view-pr.mjs";
import { pullReceiptPath } from "../github/_work-order-protocol.mjs";
import { STALE_RUNNER_DEFAULT_MAX_AGE_MS, resolveStaleRunnerMaxAgeMs } from "./_stale-runner-detection.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

/** The grace is the runner-lock TTL, floored at the 30 minute default: DEVLOOPS_STALE_RUNNER_MAX_AGE_MS can only lengthen it, so a caller cannot close a live sequence early. */
export const fixerGraceMs = () => Math.max(STALE_RUNNER_DEFAULT_MAX_AGE_MS, resolveStaleRunnerMaxAgeMs());
const isFullSha = (sha) => normalizeFullHeadSha(sha) === sha;

const USAGE = `usage: close-gate-sequence.mjs --head <marker baseline sha> --repo <owner/name> --pr <number> [--help]\n\n${JQ_OUTPUT_USAGE}`;
const refuse =(refusal, reason, remedy) => ({ ok: false, refusal, reason, remedy });
/** True when the sha is a commit object in the local repository. */
export const localCommitExists = (sha) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore", env: gitEnvNoDirOverrides() }).status === 0;
const mtimeMs = (file) => { try { return statSync(file).mtimeMs; } catch { return null; } };
/** The mtime of the fixer branch reflog, which every fixer commit updates; null when the reflog is absent or git fails. */
export const branchReflogMs = (branch) => {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", env: gitEnvNoDirOverrides() });
  return common.status === 0 ? mtimeMs(path.resolve(common.stdout.trim(), "logs", "refs", "heads", branch)) : null;
};

/** The recorded actor: DEVLOOPS_RUN_ID, else the OS user; a uid without a passwd entry makes userInfo throw, so fall back to "unknown". */
export const defaultActor = (env = process.env, lookup = userInfo) => {
  if (env.DEVLOOPS_RUN_ID) return env.DEVLOOPS_RUN_ID;
  try { return lookup().username; } catch { return "unknown"; }
};

/** @param {{ tmpRoot: string, head: string, repo?: string, pr?: number, fetchPr?: Function, now?: () => number, actor?: string }} input */
export async function closeGateSequence({ tmpRoot, head, repo, pr, fetchPr = viewPr, now = Date.now, actor = defaultActor(), hasCommit = localCommitExists, branchActivityMs = branchReflogMs, lock }) {
  const marker = readSequenceMarker(tmpRoot, head);
  if (!marker) return refuse("sequence_absent", `no sequence marker exists for ${head}`, "Nothing to close here; the push block comes from another marker, so rerun with that marker's head.");
  const { executionIdentity, workOrderRef, outputRef } = marker.execution ?? {};
  // Only ENOENT proves the work order was never pulled; any other read or parse failure leaves the pull state unknown.
  // The receipt as raw text (null = ENOENT, undefined = unreadable): any later difference means a fixer pulled meanwhile.
  const snapshot = () => { if (!workOrderRef) return null; try { return readFileSync(pullReceiptPath(tmpRoot, workOrderRef), "utf8"); } catch (error) { return error?.code === "ENOENT" ? null : undefined; } };
  const receiptBefore = snapshot();
  const pulledMeanwhile = () => snapshot() !== receiptBefore ? refuse("sequence_live", `fixer execution ${executionIdentity} pulled its work order while the PR was read`, "Wait for the fixer to hand back, then rerun.") : null;
  let receipt = null;
  let receiptFound = false; // presence of the file, not its parsed content
  if (workOrderRef) {
    try { receipt = JSON.parse(readFileSync(pullReceiptPath(tmpRoot, workOrderRef), "utf8")); receiptFound = true; } catch (error) {
      if (error?.code !== "ENOENT") return refuse("fixer_running", `the pull receipt of fixer execution ${executionIdentity} is unreadable (${error?.code ?? "invalid JSON"}), so a pull cannot be ruled out`, "Rerun once the receipt is readable, or ask the operator.");
    }
    if (receiptFound && (receipt === null || typeof receipt !== "object" || Array.isArray(receipt))) return refuse("fixer_running", `the pull receipt of fixer execution ${executionIdentity} is not a JSON object, so a pull cannot be ruled out`, "Rerun once the receipt is readable, or ask the operator.");
  }
  const markerMtime = mtimeMs(sequenceMarkerPath(tmpRoot, head));
  const pulled = receiptFound; // any receipt object at the work order ref proves a pull, whatever its content
  const pulledAt = pulled ? Date.parse(receipt.pulledAt) : NaN;
  const grace = fixerGraceMs();
  // A fixer that pulled its work order is running unless it handed back (outputRef exists) or its last activity (the pull, or the last write to its branch reflog; a fixer that never commits shows only its pull) is older than the grace.
  // An unparseable pulledAt makes the activity NaN, which reads as running (fail closed). The runner claim updatedAt is no signal: the closing coordinator heartbeats it itself.
  if (pulled && mtimeMs(outputRef) === null && !(now() - Math.max(pulledAt, (marker.branch && branchActivityMs(marker.branch)) ?? -Infinity) >= grace)) {
    return refuse("fixer_running", `fixer execution ${executionIdentity} pulled its work order, has not handed back, and was active within ${grace / 60000} minutes (activity-based: the pull or the last write to the fixer branch reflog)`, `Wait for the fixer to hand back, or for ${grace / 60000} minutes without fixer activity, then rerun.`);
  }
  if (marker.branch === undefined || !repo || !pr) return refuse("abandonment_unproven", "the PR head cannot be checked without the marker's branch and --repo/--pr", "Pass --repo and --pr of the marker's PR. A marker without a branch cannot be proven abandoned, so ask the operator to delete it.");
  const { pr: facts } = await fetchPr({ repo, pr, fields: "headRefOid,headRefName" });
  if (!isFullSha(facts.headRefOid ?? "")) return refuse("abandonment_unproven", `GitHub returned no valid head sha for PR #${pr}`, "Rerun when the PR head is readable.");
  // The work order ref `fixer:<owner/name>#<pr>:...` names the marker's PR; a same-named branch in another repo or PR is no proof.
  const owner = /^fixer:([^#:]+)#([0-9]+):/u.exec(workOrderRef ?? "");
  if (owner && (owner[1] !== repo || Number(owner[2]) !== pr)) return refuse("abandonment_unproven", `the marker belongs to ${owner[1]}#${owner[2]}, not ${repo}#${pr}`, "Pass the --repo and --pr the marker names.");
  if (facts.headRefName !== marker.branch) return refuse("abandonment_unproven", `PR #${pr} head branch ${facts.headRefName} is not the marker branch ${marker.branch}`, "Pass the --pr whose head branch the marker names.");
  // Without a work order ref nothing ties the marker to this repo, so the baseline sha must be a commit here.
  if (!owner && facts.headRefOid !== head && !hasCommit(head)) return refuse("baseline_unknown", `the marker names no work order ref and its baseline ${head} is not a commit in this repository`, "Run the close from a checkout of the marker's repository, or ask the operator to delete the marker.");
  let condition = null;
  if (facts.headRefOid !== head) condition = "HEAD_MOVED";
  else if (executionIdentity && !receiptFound && now() - (markerMtime ?? now()) >= grace) condition = "FIXER_NEVER_PULLED";
  if (condition === null) {
    return executionIdentity
      ? refuse("sequence_live", `the PR head is still ${head} and the fixer execution ${executionIdentity} is not proven abandoned`, "Finish the sequence with the pre-push delta review, or rerun after the dispatch grace if no fixer ever pulled the work order.")
      : refuse("abandonment_unproven", `the PR head is still ${head} and the marker names no fixer execution`, "Finish the sequence with the pre-push delta review, or ask the operator to delete the marker.");
  }
  // The rest runs under the head's sequence lock (PRE-PUSH-DELTA-CLOSE-ADMISSION-ATOMIC): a pull admission and a marker re-emit take the same lock, so neither interleaves with the checks below.
  try {
    return await withSequenceLock(tmpRoot, [head], () => {
      // A concurrent re-emit rewrote the marker while the PR was read: that is a new sequence, never close it (compare-and-delete: identity and mtime).
      const current = readSequenceMarker(tmpRoot, head);
      if (current?.execution?.executionIdentity !== executionIdentity || mtimeMs(sequenceMarkerPath(tmpRoot, head)) !== markerMtime) return refuse("sequence_live", `the marker for ${head} changed while it was checked`, "Rerun close-sequence; a re-emitted marker starts a live sequence.");
      const record = { baselineHead: head, executionIdentity: executionIdentity ?? null, condition, actor, closedAt: new Date(now()).toISOString() };
      // The last pull receipt recheck precedes the record write, so a refused close leaves no record.
      const pulledAfterRead = pulledMeanwhile();
      if (pulledAfterRead) return pulledAfterRead;
      // Record first, marker second: a failed write leaves the marker in place.
      const file = sequenceClosurePath(tmpRoot, head, executionIdentity);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      clearSequenceMarker(tmpRoot, head);
      return { ok: true, ...record, recordPath: file };
    }, lock);
  } catch (error) {
    if (error?.code === "SEQUENCE_LOCK_BUSY") return refuse("sequence_live", error.message, "Rerun close-sequence once the concurrent pull or emission finishes.");
    throw error;
  }
}

if (isDirectCliRun(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { head: { type: "string" }, repo: { type: "string" }, pr: { type: "string" }, help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (values.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    if (!isFullSha(values.head ?? "") || (values.pr !== undefined && !/^[1-9][0-9]*$/u.test(values.pr))) throw new Error(USAGE);
    // Validate the output flags before the close writes the record and removes the marker.
    const preflight = preflightJqFilter(values.jq) ?? preflightFieldsSpec(values.fields, { jq: values.jq, silent: values.silent });
    if (preflight !== undefined) process.exitCode = preflight;
    else {
      const slug = values.repo === undefined ? undefined : parseRepoSlug(values.repo, { errorMessage: USAGE });
      const result = await closeGateSequence({ tmpRoot: resolveGateArtifactTmpRoot(process.cwd()), head: values.head, repo: slug && `${slug.owner}/${slug.name}`, pr: values.pr && Number(values.pr) });
      const emitted = emitResult(result, { jq: values.jq, silent: values.silent, fields: values.fields });
      process.exitCode = emitted; // 0/1 by result or --silent predicate, 2 for an invalid output flag
    }
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
