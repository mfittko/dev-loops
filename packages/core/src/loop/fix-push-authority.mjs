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

/**
 * The recovery pointer the refusal reason carries (ADR 0216): the sanctioned no-commit close of the sequence. A `commit_only` fixer that handed back with no commit closes with the authenticated
 * `check-pre-push-delta.mjs` input-only run (`--fixer-plan` and `--site-coverage`, outcome `no_commit`; the marker records no route, so the hint names both the `--act-list` and the `--threads-file` form), which removes the marker. A fix commit keeps the marker and takes the normal delta review.
 * A marker that names no branch (unreadable or malformed) cannot be authenticated by that close, which requires the matching branch marker, so its hint names no close command and no deletion and points to the PRE-PUSH-DELTA-PUSH-AUTHORITY rule, which owns that recovery.
 */
export const recoveryHint = (baselineHead, markerPath, branch) => !baselineHead ? "" : !branch ? ` The sequence marker is ${markerPath}. The marker is unreadable or names no branch, so the no-commit close cannot authenticate it; the PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery.` : ` The sequence marker is ${markerPath}. To close a commit_only sequence whose fixer made no commit, run \`check-pre-push-delta.mjs (--act-list <act-list> --findings-log <findings-log> | --threads-file <threads-file> --repo <owner/name> --pr <n>) --baseline ${baselineHead} --spec-identity <id> --fixer-plan <fixer-plan> --site-coverage <handback> --worktree <dir>\` (outcome no_commit); a fix commit takes the delta review and the full-phase push.`;

/** Approximates git check-ref-format for a branch name; an invalid name reads as no branch (fail closed). */
const isValidBranchName = (b) =>
  typeof b === "string" && b !== "" && b !== "@" && b !== "HEAD" &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(b) &&
  !b.includes("..") && !b.includes("@{") && !b.includes("//") &&
  !/^[/.-]|[/.]$|\.lock(\/|$)|(^|\/)\./.test(b);

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
    if (marker?.baselineHead === baselineHead) return { baselineHead, fullGranted: marker.fullGranted === true, branch: isValidBranchName(marker.branch) ? marker.branch : undefined };
  } catch {
    // Falls through to the fail-closed reading.
  }
  return { baselineHead, fullGranted: false };
}

/**
 * The marker of the sequence that is active at `head`, or null. A marker that names a branch is skipped when the
 * push target `remoteRef` is known and differs from refs/heads/<branch> (a stacked branch is not covered). Otherwise
 * (push target equals the marker's branch, or is unknown, or the marker names no branch) a sequence is active while
 * the tested commit is its baseline or descends from it, or when `remoteRef` is the marker's branch (whatever the
 * pushed sha is, so a force-push is covered); a branch marker ends once the remote ref has advanced past the baseline.
 * A marker that names no branch cannot be ended by a remote ref: it stays active until deleted (fail closed).
 * With several active markers a non-granted one wins, so a stale
 * granted marker cannot admit a commit_only fixer push.
 * @param {{ tmpRoot: string, head: string, remoteRef?: string, listBaselines: () => string[], isAncestor: (a: string, b: string) => boolean, remoteAdvanced: (baseline: string, branch: string) => boolean }} input
 */
export function findActiveSequence({ tmpRoot, head, remoteRef, listBaselines, isAncestor, remoteAdvanced }) {
  const active = [];
  for (const baseline of listBaselines()) {
    const marker = readSequenceMarker(tmpRoot, baseline);
    if (!marker) continue;
    if (marker.branch !== undefined && remoteRef !== undefined && remoteRef !== `refs/heads/${marker.branch}`) continue;
    let covered;
    try {
      covered = baseline === head || isAncestor(baseline, head) || (marker.branch !== undefined && remoteRef === `refs/heads/${marker.branch}`);
    } catch {
      // The ancestry test failed (missing object, invalid ref). A granted marker never refuses, so skip it; any other marker refuses and the refusal reason names it (fail closed).
      if (!marker.fullGranted) active.push(marker);
      continue;
    }
    if (covered && (marker.branch === undefined || !remoteAdvanced(baseline, marker.branch))) active.push(marker);
  }
  return active.find((m) => !m.fullGranted) ?? active[0] ?? null;
}

