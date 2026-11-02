/**
 * fix-push-authority.mjs: during a gate fix sequence only the full-phase fixer pushes the fix
 * branch (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-PUSH-AUTHORITY).
 *
 * A sequence marker `<main worktree>/tmp/gate-delta/<baseline>.sequence` is written when the
 * `commit_only` fixer work order is emitted (ungranted) and rewritten with `fullGranted` when the
 * `full` work order is emitted. The git pre-push check reads it. Pure of git: the caller supplies the facts.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const sequenceMarkerPath = (tmpRoot, baselineHead) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence`);

/** The closure record of a sequence closed by close-gate-sequence; keyed by execution so a second close with another execution on one head keeps the first. An execution-less close writes `.none.json` and overwrites a prior execution-less record on the same head. */
export const sequenceClosurePath = (tmpRoot, baselineHead, executionIdentity) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence-closed.${executionIdentity ?? "none"}.json`);

/**
 * Runs `fn` holding a lock per baseline head (PRE-PUSH-DELTA-CLOSE-ADMISSION-ATOMIC), taken sorted and released in reverse.
 * The suffix must not end with `.sequence`: listBaselines reads that suffix as a marker.
 * ponytail: a mkdir lock with no owner token; a holder that dies blocks for at most `staleMs`, then the next taker steals it.
 */
export async function withSequenceLock(tmpRoot, baselineHeads, fn, { staleMs = 60000, waitMs = 10000 } = {}) {
  const held = [];
  try {
    for (const head of [...new Set(baselineHeads)].sort()) {
      const lock = path.join(tmpRoot, "gate-delta", `${head}.sequence-lock`);
      mkdirSync(path.dirname(lock), { recursive: true });
      for (const deadline = Date.now() + waitMs; ;) {
        try { mkdirSync(lock); held.push(lock); break; } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          let age = 0;
          try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; } // released meanwhile: retry
          if (age > staleMs) { rmSync(lock, { recursive: true, force: true }); continue; }
          if (Date.now() >= deadline) throw Object.assign(new Error(`the sequence lock ${lock} is held by a concurrent close or pull; rerun once it finishes`), { code: "SEQUENCE_LOCK_BUSY" });
          await sleep(25);
        }
      }
    }
    return await fn();
  } finally {
    for (const lock of held.reverse()) rmSync(lock, { recursive: true, force: true });
  }
}

/** Record that a fix sequence is active for a baseline head; a `commit_only` emit writes it ungranted, a `full` emit granted. */
export function writeSequenceMarker({ tmpRoot, baselineHead, fullGranted = false, branch, execution }) {
  const file = sequenceMarkerPath(tmpRoot, baselineHead);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ baselineHead, fullGranted, ...(typeof branch === "string" && branch ? { branch } : {}), ...(execution ? { execution } : {}) })}\n`);
  return file;
}

/** Remove the marker of a sequence that ended without a fix commit: nothing was committed, so nothing stays guarded. */
export function clearSequenceMarker(tmpRoot, baselineHead) {
  rmSync(sequenceMarkerPath(tmpRoot, baselineHead), { force: true });
}

/**
 * The recovery pointer the refusal reason carries (ADR 0218): the sanctioned no-commit close of the sequence. A `commit_only` fixer that handed back with no commit closes with the authenticated
 * `check-pre-push-delta.mjs` input-only run (`--fixer-plan` and `--site-coverage`, outcome `no_commit`; the marker records no route, so the hint names both the `--act-list` and the `--threads-file` form), which removes the marker. A fix commit keeps the marker and takes the normal delta review.
 * A marker that names no branch (unreadable or malformed) cannot be authenticated by that close, which requires the matching branch marker, so its hint names no close command and no deletion and points to the PRE-PUSH-DELTA-PUSH-AUTHORITY rule, which owns that recovery.
 */
const noCommitHint = (baselineHead, markerPath, branch) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baselineHead) ? ` The sequence marker is ${markerPath}. The marker names a baseline head that is not a full lowercase hex SHA, so no close command is rendered; the PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery.` : !branch ? ` The sequence marker is ${markerPath}. The marker is unreadable or names no branch, so the no-commit close cannot authenticate it; the PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery.` : ` The sequence marker is ${markerPath}. To close a commit_only sequence whose fixer made no commit, run \`check-pre-push-delta.mjs (--act-list <act-list> --findings-log <findings-log> | --threads-file <threads-file> --repo <owner/name> --pr <n>) --baseline ${baselineHead} --spec-identity <id> --fixer-plan <fixer-plan> --site-coverage <handback> --worktree <dir>\` (outcome no_commit); a fix commit takes the delta review and the full-phase push.`;

/** Adds the close-sequence recovery for an abandoned sequence (the PR head moved, or no fixer ever pulled the work order); a live sequence stays uncloseable (#2999). */
export const recoveryHint = (baselineHead, markerPath, branch) => noCommitHint(baselineHead, markerPath, branch) + (markerPath ? ` To close an abandoned sequence instead, run dev-loops-run cli/index.mjs gate close-sequence --head <baseline sha> --repo <owner/name> --pr <number>; it refuses a live sequence.` : "");

/** Approximates git check-ref-format for a branch name; an invalid name reads as no branch (fail closed). */
const isValidBranchName = (b) =>
  typeof b === "string" && b !== "" && b !== "@" && b !== "HEAD" &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(b) &&
  !b.includes("..") && !b.includes("@{") && !b.includes("//") &&
  !/^[/.-]|[/.]$|\.lock(\/|$)|(^|\/)\./.test(b);

const EXECUTION_IDENTITY = /^f[0-9]+-[0-9a-f]{8}$/u;
const isNonEmptyString = (v) => typeof v === "string" && v !== "";

/** The marker's fixer execution only when well formed (identity of the emitter's shape, non-empty refs); else undefined, so it proves nothing and names no path. */
const validExecution = (e) => e && typeof e === "object" && typeof e.executionIdentity === "string" && EXECUTION_IDENTITY.test(e.executionIdentity) && isNonEmptyString(e.workOrderRef) && isNonEmptyString(e.outputRef) ? e : undefined;

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
    if (marker?.baselineHead === baselineHead) return { baselineHead, fullGranted: marker.fullGranted === true, branch: isValidBranchName(marker.branch) ? marker.branch : undefined, execution: validExecution(marker.execution) };
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

