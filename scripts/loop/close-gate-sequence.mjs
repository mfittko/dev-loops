#!/usr/bin/env node
/**
 * close-gate-sequence: close an abandoned gate fix sequence marker (PRE-PUSH-DELTA-PUSH-AUTHORITY).
 * The tool removes `<tmp>/gate-delta/<head>.sequence` only after it proves one abandonment condition
 * from authoritative state, and writes the evidence record `<head>.sequence-closed.json` first.
 * Conditions: HEAD_MOVED (the marker's PR head differs from the marker baseline, so the baseline is
 * obsolete) and FIXER_NEVER_PULLED (the marker names a fixer execution whose work order was never
 * pulled within the dispatch grace, so no fixer ran and no commit on the branch is the fixer's).
 * A live sequence is never closed. Refusals: SEQUENCE-ABSENT, SEQUENCE-LIVE, FIXER-RUNNING, ABANDONMENT-UNPROVEN.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { clearSequenceMarker, readSequenceMarker, sequenceMarkerPath } from "@dev-loops/core/loop/fix-push-authority";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, emitResult } from "../lib/jq-output.mjs";
import { viewPr } from "../github/view-pr.mjs";
import { pullReceiptPath } from "../github/_work-order-protocol.mjs";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

export const FIXER_GRACE_MS = 30 * 60 * 1000; // The runner-lock TTL: a dispatch or a fixer younger than this may be live.
export const sequenceClosurePath = (tmpRoot, head) => path.join(tmpRoot, "gate-delta", `${head}.sequence-closed.json`);

const refuse = (refusal, reason, remedy) => ({ ok: false, refusal, reason, remedy });
const mtimeMs = (file) => { try { return statSync(file).mtimeMs; } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** @param {{ tmpRoot: string, head: string, repo?: string, pr?: number, fetchPr?: Function, now?: () => number, actor?: string }} input */
export async function closeGateSequence({ tmpRoot, head, repo, pr, fetchPr = viewPr, now = Date.now, actor = process.env.DEVLOOPS_RUN_ID ?? userInfo().username }) {
  const marker = readSequenceMarker(tmpRoot, head);
  if (!marker) return refuse("SEQUENCE-ABSENT", `no sequence marker exists for ${head}`, "Nothing to close here; the push block comes from another marker, so rerun with that marker's head.");
  const { executionIdentity, workOrderRef, outputRef } = marker.execution ?? {};
  const receipt = workOrderRef ? readJson(pullReceiptPath(tmpRoot, workOrderRef)) : null;
  const pulled = receipt !== null && receipt.executionIdentity === executionIdentity;
  const pulledAt = pulled ? Date.parse(receipt.pulledAt) : NaN;
  // A fixer that pulled its work order and has not handed back (no outputRef) inside the grace is running.
  if (pulled && !(Number.isFinite(pulledAt) && now() - pulledAt >= FIXER_GRACE_MS) && mtimeMs(outputRef) === null) {
    return refuse("FIXER-RUNNING", `fixer execution ${executionIdentity} pulled its work order and has not handed back`, `Wait for the fixer to hand back, or for ${FIXER_GRACE_MS / 60000} minutes to pass, then rerun.`);
  }
  if (marker.branch === undefined || !repo || !pr) return refuse("ABANDONMENT-UNPROVEN", "the PR head cannot be checked without the marker's branch and --repo/--pr", "Pass --repo and --pr of the marker's PR. A marker without a branch cannot be proven abandoned, so ask the operator to delete it.");
  const { pr: facts } = await fetchPr({ repo, pr, fields: "headRefOid,headRefName" });
  if (facts.headRefName !== marker.branch) return refuse("ABANDONMENT-UNPROVEN", `PR #${pr} head branch ${facts.headRefName} is not the marker branch ${marker.branch}`, "Pass the --pr whose head branch the marker names.");
  let condition = null;
  if (facts.headRefOid !== head) condition = "HEAD_MOVED";
  else if (executionIdentity && !receipt && now() - (mtimeMs(sequenceMarkerPath(tmpRoot, head)) ?? now()) >= FIXER_GRACE_MS) condition = "FIXER_NEVER_PULLED";
  if (condition === null) {
    return executionIdentity
      ? refuse("SEQUENCE-LIVE", `the PR head is still ${head} and the fixer execution ${executionIdentity} is not proven abandoned`, "Finish the sequence with the pre-push delta review, or rerun after the dispatch grace if no fixer ever pulled the work order.")
      : refuse("ABANDONMENT-UNPROVEN", `the PR head is still ${head} and the marker names no fixer execution`, "Finish the sequence with the pre-push delta review, or ask the operator to delete the marker.");
  }
  // Record first, marker second: a failed write leaves the marker in place.
  const record = { baselineHead: head, executionIdentity: executionIdentity ?? null, condition, actor, closedAt: new Date(now()).toISOString() };
  const file = sequenceClosurePath(tmpRoot, head);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  clearSequenceMarker(tmpRoot, head);
  return { ok: true, ...record, recordPath: file };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { head: { type: "string" }, repo: { type: "string" }, pr: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (!/^[0-9a-f]{40,64}$/u.test(values.head ?? "")) throw new Error("usage: close-gate-sequence.mjs --head <marker baseline sha> --repo <owner/name> --pr <number>");
    const result = await closeGateSequence({ tmpRoot: resolveGateArtifactTmpRoot(process.cwd()), head: values.head, repo: values.repo, pr: values.pr && Number(values.pr) });
    const emitted = emitResult(result, { jq: values.jq, silent: values.silent });
    process.exitCode = emitted === 2 ? 2 : result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
