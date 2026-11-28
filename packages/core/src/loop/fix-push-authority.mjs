/**
 * fix-push-authority.mjs: during a gate fix sequence only the full-phase fixer pushes the fix
 * branch (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-PUSH-AUTHORITY).
 *
 * A sequence marker `<main worktree>/tmp/gate-delta/<baseline>.sequence` is written when the
 * `commit_only` fixer work order is emitted (ungranted) and rewritten with `fullGranted` when the
 * `full` work order is emitted. The git pre-push check reads it. Pure of git: the caller supplies the facts.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { parseRepoSlugParts, repoSlugEquals } from "../github/repo-slug.mjs";

export const sequenceMarkerPath = (tmpRoot, baselineHead) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence`);

/** The closure record of a sequence closed by close-gate-sequence; keyed by execution so a second close with another execution on one head keeps the first. An execution-less close writes `.none.json` and overwrites a prior execution-less record on the same head. */
export const sequenceClosurePath = (tmpRoot, baselineHead, executionIdentity) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence-closed.${executionIdentity ?? "none"}.json`);

/**
 * Runs `fn` holding a lock per baseline head (PRE-PUSH-DELTA-CLOSE-ADMISSION-ATOMIC), taken sorted and released in reverse.
 * The suffix must not end with `.sequence`: listBaselines reads that suffix as a marker.
 * ponytail: a mkdir lock with an owner token file; every removal is a compare-and-delete on that token (release, and the `.steal` lock's release with its own token). A stale lock is stolen under a separate `.steal` mkdir lock: re-check the age, read the owner token, rename the lock to a unique name, and delete the renamed directory only when its mtime is still older than `staleMs` and its token equals the one read (a missing owner file equals only a missing owner file and still needs the stale mtime); otherwise it is renamed back. A stale `.steal` directory is reclaimed by the same rename-and-verify step. Every retry sleeps 25 ms after the deadline check.
 * Ceilings: a holder that stalls past `staleMs` while a live contender exists can still overlap a stealer; a holder that dies blocks for at most `staleMs`; a fresh holder that acquires between the stealer's read and its rename loses the path until the rename-back, and if a contender took the path in that window the two overlap (the renamed directory is left on disk, never deleted); a stealer that dies holding the `.steal` lock blocks stealing for at most `staleMs`, after which the next contender reclaims that directory.
 */
export async function withSequenceLock(tmpRoot, baselineHeads, fn, { staleMs = 60000, waitMs = 10000, beforeStealRename, afterStealLock, beforeStealLockRename, sleep: sleepFn = sleep, now = () => Date.now() } = {}) {
  const held = [];
  const readOwner = (dir) => { try { return readFileSync(path.join(dir, "owner"), "utf8"); } catch { return null; } };
  const removeIfOwned = (dir, token) => { if (readOwner(dir) === token) rmSync(dir, { recursive: true, force: true }); };
  // Reclaims a directory that looked stale: read its owner, rename it away, then delete only when the renamed directory is still stale and carries the same owner (a missing owner is equal only to a missing owner AND needs a stale mtime). Otherwise rename it back.
  const reclaim = async (dir, beforeRename) => {
    let ownerBefore;
    try { if (now() - statSync(dir).mtimeMs <= staleMs) return; ownerBefore = readOwner(dir); } catch { return; } // released meanwhile
    await beforeRename?.(dir);
    const moved = `${dir}.stale-${randomUUID()}`;
    try { renameSync(dir, moved); } catch { return; } // released or replaced: the caller retries
    let unchanged = false;
    try { unchanged = now() - statSync(moved).mtimeMs > staleMs && readOwner(moved) === ownerBefore; } catch { /* vanished: nothing to delete */ }
    if (unchanged) rmSync(moved, { recursive: true, force: true });
    else { try { renameSync(moved, dir); } catch { /* ponytail: a contender took the path meanwhile; the renamed fresh directory stays on disk and its holder's token check still protects release */ } }
  };
  try {
    for (const head of [...new Set(baselineHeads)].sort()) {
      const lock = path.join(tmpRoot, "gate-delta", `${head}.sequence-lock`);
      mkdirSync(path.dirname(lock), { recursive: true });
      for (const deadline = now() + waitMs; ;) {
        // Every retry goes through backoff (deadline check, then a 25 ms sleep), so a persistent stat, mkdir or rename failure refuses SEQUENCE_LOCK_BUSY instead of spinning.
        const backoff = async () => {
          if (now() >= deadline) throw Object.assign(new Error(`the sequence lock ${lock} is held by a concurrent close or pull; rerun once it finishes (PRE-PUSH-DELTA-CLOSE-ADMISSION-ATOMIC)`), { code: "SEQUENCE_LOCK_BUSY" });
          await sleepFn(25);
        };
        try { mkdirSync(lock); const token = randomUUID(); writeFileSync(path.join(lock, "owner"), token); held.push({ lock, token }); break; } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          let age = 0;
          try { age = now() - statSync(lock).mtimeMs; } catch { await backoff(); continue; } // released meanwhile: retry
          if (age > staleMs) {
            // Stealers serialize on a steal lock with its own owner token; a stale steal lock is reclaimed by the same rename-and-verify step as a stale lock.
            const stealLock = `${lock}.steal`;
            const stealToken = randomUUID();
            let stealing = false;
            try { mkdirSync(stealLock); stealing = true; } catch (mkdirError) {
              if (mkdirError?.code === "EEXIST") await reclaim(stealLock, beforeStealLockRename);
            }
            if (stealing) {
              try {
                writeFileSync(path.join(stealLock, "owner"), stealToken);
                await afterStealLock?.(lock);
                await reclaim(lock, beforeStealRename);
              } finally { removeIfOwned(stealLock, stealToken); }
            }
          }
          await backoff();
        }
      }
    }
    return await fn();
  } finally {
    for (const { lock, token } of held.reverse()) removeIfOwned(lock, token);
  }
}

/** Record that a fix sequence is active for a baseline head; a `commit_only` emit writes it ungranted, a `full` emit granted. */
export function writeSequenceMarker({ tmpRoot, baselineHead, fullGranted = false, branch, execution }) {
  const file = sequenceMarkerPath(tmpRoot, baselineHead);
  mkdirSync(path.dirname(file), { recursive: true });
  // Write to a sibling tmp file and rename, so a crash never leaves a truncated marker at the marker path.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ baselineHead, fullGranted, ...(typeof branch === "string" && branch ? { branch } : {}), ...(execution ? { execution } : {}) })}\n`);
  renameSync(tmp, file);
  return file;
}

/** Remove the marker of a sequence that ended without a fix commit: nothing was committed, so nothing stays guarded. */
export function clearSequenceMarker(tmpRoot, baselineHead) {
  rmSync(sequenceMarkerPath(tmpRoot, baselineHead), { force: true });
}

/** A full lowercase sha, or any other safe marker file name (never a path). Uncloseable: a non-string, an empty name, a name over 128 characters, a name with a character outside `[A-Za-z0-9._-]`, a name that starts with `-` (the CLI parser rejects `--head -x`), `.` and `..`, and a case or whitespace variant of a full sha (it opens the real marker on a case-insensitive filesystem, so it is no non-hex name). One predicate for close-sequence and the push refusal's close command. */
export const isSafeMarkerName = (name) => typeof name === "string" && (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(name)
  || (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(name.trim().toLowerCase()) && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/u.test(name) && name !== "." && name !== ".."));

/**
 * The recovery pointer the refusal reason carries (ADR 0218): the sanctioned no-commit close of the sequence. A `commit_only` fixer that handed back with no commit closes with the authenticated
 * `gate close-sequence` command, which removes the marker. A fix commit keeps the marker and takes the full-phase push.
 * A marker that names no branch (unreadable or malformed) cannot be authenticated by that close, which requires the matching branch marker, so its hint names no close command and no deletion and points to the PRE-PUSH-DELTA-PUSH-AUTHORITY rule, which owns that recovery.
 */
const noCommitHint = (baselineHead, markerPath, branch) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baselineHead) ? ` The sequence marker is ${markerPath}. The marker names a baseline head that is not a full lowercase hex SHA, so no no-commit close command is rendered; the PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery.` : !branch ? ` The sequence marker is ${markerPath}. The marker is unreadable or names no branch, so the no-commit close cannot authenticate it; the PRE-PUSH-DELTA-PUSH-AUTHORITY rule owns its recovery.` : ` The sequence marker is ${markerPath}. To close a commit_only sequence whose fixer made no commit, a live sequence refuses gate close-sequence (sequence_live), so a fix commit takes the full-phase push (the delta review is retired, so run emit --phase full) and an abandoned sequence closes with the gate close-sequence command named below (baseline ${baselineHead}).`;

/** Adds the close-sequence recovery for a closable sequence (HEAD_MOVED, BOUNDED_OUT, FIXER_NEVER_PULLED, or MARKER_UNREADABLE once the dispatch grace has passed); a live sequence stays uncloseable. */
export const recoveryHint = (baselineHead, markerPath, branch) => noCommitHint(baselineHead, markerPath, branch) + (markerPath ? ` To close an abandoned sequence instead, run dev-loops-run cli/index.mjs gate close-sequence --head ${isSafeMarkerName(baselineHead) && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baselineHead) ? baselineHead : "<baseline sha>"} --repo <owner/name> --pr <number>; it refuses a live sequence.` : "");

/** Approximates git check-ref-format for a branch name; an invalid name reads as no branch (fail closed). */
export const isValidBranchName = (b) =>
  typeof b === "string" && b !== "" && b !== "@" && b !== "HEAD" &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(b) &&
  !b.includes("..") && !b.includes("@{") && !b.includes("//") &&
  !/^[/.-]|[/.]$|\.lock(\/|$)|(^|\/)\./.test(b);

const EXECUTION_IDENTITY = /^f[0-9]+-[0-9a-f]{8}$/u;
const isNonEmptyString = (v) => typeof v === "string" && v !== "";

/** The marker's fixer execution only when well formed (identity of the emitter's shape, non-empty refs); else undefined, so it proves nothing and names no path. */
export const validExecution = (e) => e && typeof e === "object" && typeof e.executionIdentity === "string" && EXECUTION_IDENTITY.test(e.executionIdentity) && isNonEmptyString(e.workOrderRef) && isNonEmptyString(e.outputRef) ? e : undefined;

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
 * A marker that names no branch cannot be ended by a remote ref: it stays active until `gate close-sequence` closes it as MARKER_UNREADABLE (fail closed).
 * When `repo` (the owner/name the push targets: the GitHub push URL's slug, else the checkout's origin slug) is given, a marker that passes the branch rule is skipped before the ancestry test only when its execution work order ref names a valid other owner/name
 * and `baselinePresent(baseline)` reports the baseline absent from this checkout. A marker whose repo equals the push target repo, a marker that names no valid repo, a marker whose baseline is present
 * (a fork or renamed repo), and a push with no `repo` keep the rules above (fail closed). When `baselinePresent` throws on a git failure, a `fullGranted` marker is skipped and any other marker is active (the refusal names it).
 * With several active markers a non-granted one wins, so a stale
 * granted marker cannot admit a commit_only fixer push.
 * @param {{ tmpRoot: string, head: string, remoteRef?: string, repo?: string, baselinePresent?: (baseline: string) => boolean, listBaselines: () => string[], isAncestor: (a: string, b: string) => boolean, remoteAdvanced: (baseline: string, branch: string) => boolean }} input
 */
export function findActiveSequence({ tmpRoot, head, remoteRef, repo, baselinePresent = () => true, listBaselines, isAncestor, remoteAdvanced }) {
  const active = [];
  for (const baseline of listBaselines()) {
    const marker = readSequenceMarker(tmpRoot, baseline);
    if (!marker) continue;
    let markerRepo = /^fixer:([^#:]+)#[0-9]+:/u.exec(marker.execution?.workOrderRef ?? "")?.[1];
    try { if (markerRepo !== undefined) parseRepoSlugParts(markerRepo); } catch { markerRepo = undefined; } // A malformed segment names no repo (fail closed).
    if (marker.branch !== undefined && remoteRef !== undefined && remoteRef !== `refs/heads/${marker.branch}`) continue;
    if (repo && markerRepo && !repoSlugEquals(markerRepo, repo)) {
      let absent;
      try {
        absent = !baselinePresent(baseline);
      } catch {
        // The probe failed (any git failure other than a missing object). A granted marker never refuses, so skip it; any other marker refuses and the refusal reason names it (fail closed).
        if (!marker.fullGranted) active.push(marker);
        continue;
      }
      if (absent) continue;
    }
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

