#!/usr/bin/env node
/**
 * close-gate-sequence: close an abandoned gate fix sequence marker (PRE-PUSH-DELTA-PUSH-AUTHORITY).
 * The tool removes `<tmp>/gate-delta/<head>.sequence` only after it proves one abandonment condition
 * from authoritative state, and writes the audit record `<head>.sequence-closed.<execution|none>.json` first.
 * Conditions: HEAD_MOVED (the marker's PR head differs from the marker baseline, so the baseline is
 * obsolete) and FIXER_NEVER_PULLED (the marker names a fixer execution whose work order was never
 * pulled within the dispatch grace, so no fixer ran and no commit on the branch is the fixer's).
 * A live sequence is never closed. Refusals: sequence_absent, sequence_live, fixer_running, abandonment_unproven.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { clearSequenceMarker, readSequenceMarker, sequenceClosurePath, sequenceMarkerPath } from "@dev-loops/core/loop/fix-push-authority";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { viewPr } from "../github/view-pr.mjs";
import { pullReceiptPath } from "../github/_work-order-protocol.mjs";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

export const FIXER_GRACE_MS = 30 * 60 * 1000; // The runner-lock TTL: a dispatch or a fixer younger than this may be live.

const USAGE = `usage: close-gate-sequence.mjs --head <marker baseline sha> --repo <owner/name> --pr <number> [--help]\n\n${JQ_OUTPUT_USAGE}`;
const refuse =(refusal, reason, remedy) => ({ ok: false, refusal, reason, remedy });
const mtimeMs = (file) => { try { return statSync(file).mtimeMs; } catch { return null; } };

/** The recorded actor: DEVLOOPS_RUN_ID, else the OS user; a uid without a passwd entry makes userInfo throw, so fall back to "unknown". */
export const defaultActor = (env = process.env, lookup = userInfo) => {
  if (env.DEVLOOPS_RUN_ID) return env.DEVLOOPS_RUN_ID;
  try { return lookup().username; } catch { return "unknown"; }
};

/** @param {{ tmpRoot: string, head: string, repo?: string, pr?: number, fetchPr?: Function, now?: () => number, actor?: string }} input */
export async function closeGateSequence({ tmpRoot, head, repo, pr, fetchPr = viewPr, now = Date.now, actor = defaultActor() }) {
  const marker = readSequenceMarker(tmpRoot, head);
  if (!marker) return refuse("sequence_absent", `no sequence marker exists for ${head}`, "Nothing to close here; the push block comes from another marker, so rerun with that marker's head.");
  const { executionIdentity, workOrderRef, outputRef } = marker.execution ?? {};
  // Only ENOENT proves the work order was never pulled; any other read or parse failure leaves the pull state unknown.
  let receipt = null;
  let receiptFound = false; // presence of the file, not its parsed content
  if (workOrderRef) {
    try { receipt = JSON.parse(readFileSync(pullReceiptPath(tmpRoot, workOrderRef), "utf8")); receiptFound = true; } catch (error) {
      if (error?.code !== "ENOENT") return refuse("fixer_running", `the pull receipt of fixer execution ${executionIdentity} is unreadable (${error?.code ?? "invalid JSON"}), so a pull cannot be ruled out`, "Rerun once the receipt is readable, or ask the operator.");
    }
    if (receiptFound && (receipt === null || typeof receipt !== "object" || Array.isArray(receipt))) return refuse("fixer_running", `the pull receipt of fixer execution ${executionIdentity} is not a JSON object, so a pull cannot be ruled out`, "Rerun once the receipt is readable, or ask the operator.");
  }
  const markerMtime = mtimeMs(sequenceMarkerPath(tmpRoot, head));
  const pulled = receipt !== null && receipt.executionIdentity === executionIdentity;
  const pulledAt = pulled ? Date.parse(receipt.pulledAt) : NaN;
  // A fixer that pulled its work order and has not handed back (no outputRef) inside the grace is running.
  if (pulled && !(Number.isFinite(pulledAt) && now() - pulledAt >= FIXER_GRACE_MS) && mtimeMs(outputRef) === null) {
    return refuse("fixer_running", `fixer execution ${executionIdentity} pulled its work order and has not handed back`, `Wait for the fixer to hand back, or for ${FIXER_GRACE_MS / 60000} minutes to pass, then rerun.`);
  }
  if (marker.branch === undefined || !repo || !pr) return refuse("abandonment_unproven", "the PR head cannot be checked without the marker's branch and --repo/--pr", "Pass --repo and --pr of the marker's PR. A marker without a branch cannot be proven abandoned, so ask the operator to delete it.");
  const { pr: facts } = await fetchPr({ repo, pr, fields: "headRefOid,headRefName" });
  if (!/^[0-9a-f]{40,64}$/u.test(facts.headRefOid ?? "")) return refuse("abandonment_unproven", `GitHub returned no valid head sha for PR #${pr}`, "Rerun when the PR head is readable.");
  if (facts.headRefName !== marker.branch) return refuse("abandonment_unproven", `PR #${pr} head branch ${facts.headRefName} is not the marker branch ${marker.branch}`, "Pass the --pr whose head branch the marker names.");
  let condition = null;
  if (facts.headRefOid !== head) condition = "HEAD_MOVED";
  else if (executionIdentity && !receiptFound && now() - (markerMtime ?? now()) >= FIXER_GRACE_MS) condition = "FIXER_NEVER_PULLED";
  if (condition === null) {
    return executionIdentity
      ? refuse("sequence_live", `the PR head is still ${head} and the fixer execution ${executionIdentity} is not proven abandoned`, "Finish the sequence with the pre-push delta review, or rerun after the dispatch grace if no fixer ever pulled the work order.")
      : refuse("abandonment_unproven", `the PR head is still ${head} and the marker names no fixer execution`, "Finish the sequence with the pre-push delta review, or ask the operator to delete the marker.");
  }
  // A concurrent re-emit rewrote the marker while the PR was read: that is a new sequence, never close it.
  const current = readSequenceMarker(tmpRoot, head);
  if (current?.execution?.executionIdentity !== executionIdentity || mtimeMs(sequenceMarkerPath(tmpRoot, head)) !== markerMtime) return refuse("sequence_live", `the marker for ${head} changed while it was checked`, "Rerun close-sequence; a re-emitted marker starts a live sequence.");
  // Record first, marker second: a failed write leaves the marker in place.
  const record = { baselineHead: head, executionIdentity: executionIdentity ?? null, condition, actor, closedAt: new Date(now()).toISOString() };
  const file = sequenceClosurePath(tmpRoot, head, executionIdentity);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  clearSequenceMarker(tmpRoot, head);
  return { ok: true, ...record, recordPath: file };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { head: { type: "string" }, repo: { type: "string" }, pr: { type: "string" }, help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (values.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    if (!/^[0-9a-f]{40,64}$/u.test(values.head ?? "") || (values.pr !== undefined && !/^[1-9][0-9]*$/u.test(values.pr))) throw new Error(USAGE);
    if (values.repo !== undefined) parseRepoSlug(values.repo, { errorMessage: USAGE });
    const result = await closeGateSequence({ tmpRoot: resolveGateArtifactTmpRoot(process.cwd()), head: values.head, repo: values.repo, pr: values.pr && Number(values.pr) });
    const emitted = emitResult(result, { jq: values.jq, silent: values.silent });
    process.exitCode = emitted === 2 ? 2 : result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
