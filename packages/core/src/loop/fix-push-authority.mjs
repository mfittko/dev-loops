/**
 * fix-push-authority.mjs: during a gate fix sequence only the full-phase fixer pushes the fix
 * branch (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-PUSH-AUTHORITY).
 *
 * A sequence marker `<main worktree>/tmp/gate-delta/<baseline>.sequence` is written when the
 * `commit_only` fixer work order is emitted (ungranted) and rewritten with `fullGranted` when the
 * `full` work order is emitted. The git pre-push check reads it. Pure of git: the caller supplies the facts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const sequenceMarkerPath = (tmpRoot, baselineHead) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence`);

/** Record that a fix sequence is active for a baseline head; a `commit_only` emit writes it ungranted, a `full` emit granted. */
export function writeSequenceMarker({ tmpRoot, baselineHead, fullGranted = false, branch }) {
  const file = sequenceMarkerPath(tmpRoot, baselineHead);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ baselineHead, fullGranted, ...(typeof branch === "string" && branch ? { branch } : {}) })}\n`);
  return file;
}

/** Remove the marker of a sequence that ended without a fix commit: nothing was committed, so nothing stays guarded. */
export function clearSequenceMarker(tmpRoot, baselineHead) {
  rmSync(sequenceMarkerPath(tmpRoot, baselineHead), { force: true });
}

/** The recovery pointer the refusal reason carries. `--phase full` works only after a clearing delta record, so deleting the marker is the general recovery. */
export const recoveryHint = (markerPath) => markerPath ? ` To recover an abandoned sequence, delete the marker ${markerPath} (emit-fixer-work-order.mjs --phase full grants the push only after a clearing delta record).` : "";

/** The marker for a baseline head, or null when none exists (ENOENT only). A malformed or unreadable marker reads as active, not granted (fail closed). */
export function readSequenceMarker(tmpRoot, baselineHead) {
  let text;
  try {
    text = readFileSync(sequenceMarkerPath(tmpRoot, baselineHead), "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? null : { baselineHead, fullGranted: false };
  }
  try {
    const marker = JSON.parse(text);
    if (marker?.baselineHead === baselineHead) return { baselineHead, fullGranted: marker.fullGranted === true, branch: typeof marker.branch === "string" ? marker.branch : undefined };
  } catch {
    // Falls through to the fail-closed reading.
  }
  return { baselineHead, fullGranted: false };
}

/**
 * The marker of the sequence that is active at `head`, or null. A sequence is active while the
 * tested commit is its baseline or descends from it, or when the push targets the marker's branch
 * (`remoteRef`, whatever the pushed sha is, so a force-push of a rewritten commit is covered), and the remote ref
 * of the marker's branch has not advanced past the baseline (a push ended it). A marker that names no branch
 * (unreadable or malformed) cannot be ended by a remote ref: it stays active until deleted (fail closed).
 * With several active markers a non-granted one wins, so a stale
 * granted marker cannot admit a commit_only fixer push.
 * @param {{ tmpRoot: string, head: string, remoteRef?: string, listBaselines: () => string[], isAncestor: (a: string, b: string) => boolean, remoteAdvanced: (baseline: string, branch: string) => boolean }} input
 */
export function findActiveSequence({ tmpRoot, head, remoteRef, listBaselines, isAncestor, remoteAdvanced }) {
  const active = [];
  for (const baseline of listBaselines()) {
    const marker = readSequenceMarker(tmpRoot, baseline);
    if (!marker) continue;
    let covered;
    try {
      covered = baseline === head || isAncestor(baseline, head) || (marker.branch !== undefined && remoteRef === `refs/heads/${marker.branch}`);
    } catch {
      // The ancestry test failed (missing object, invalid ref): refuse under this marker, which the refusal reason names (fail closed).
      active.push({ ...marker, fullGranted: false });
      continue;
    }
    if (covered && (marker.branch === undefined || !remoteAdvanced(baseline, marker.branch))) active.push(marker);
  }
  return active.find((m) => !m.fullGranted) ?? active[0] ?? null;
}

