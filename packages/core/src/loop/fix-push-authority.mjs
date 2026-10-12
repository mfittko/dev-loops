/**
 * fix-push-authority.mjs: during a gate fix sequence only the full-phase fixer pushes the fix
 * branch (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-PUSH-AUTHORITY).
 *
 * A sequence marker `<tmp-root>/gate-delta/<baseline>.sequence` is written when the `commit_only`
 * fixer work order is emitted (or the delta input is built) and flipped to `fullGranted` when the
 * `full` work order is emitted. The hook reads it. Pure of git: the caller supplies the facts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// A `git push` at command position (after `;`, `&&`, `|`, `(`, `$(`, a backtick or `sh -c "`),
// past env assignments, a launcher word and git's global options (`-C x`, `-c x=y`, `--no-pager`, ...).
const PUSH_RE = /(?:^|[;&|(`]|\$\(|\b(?:ba|z)?sh\s+-c\s+['"])\s*(?:\w+=\S*\s+)*(?:(?:env|command|exec|time|sudo|xargs)\s+)*git((?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*)\s+push(?=[\s'"`;&|)]|$)/u;

/**
 * The directory a `git ... push` runs in, as the last `-C <dir>` of its global options (last wins).
 * Returns undefined for no `-C` and null when the directory is not a plain literal (unresolvable).
 */
export function pushTargetDir(command) {
  const options = typeof command === "string" ? PUSH_RE.exec(command)?.[1] : undefined;
  const dirs = [...(options ?? "").matchAll(/\s-C\s+(\S+)/gu)];
  if (dirs.length === 0) return undefined;
  const dir = dirs[dirs.length - 1][1].replace(/^(['"])(.*)\1$/u, "$2");
  return /[$`~*?'"\\]/u.test(dir) ? null : dir;
}

export const sequenceMarkerPath = (tmpRoot, baselineHead) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence`);

/**
 * Record that a fix sequence is active for a baseline head. A non-granted write keeps a granted
 * marker (the delta check re-runs inside the full phase) unless `reset` starts a new commit_only round.
 */
export function writeSequenceMarker({ tmpRoot, baselineHead, fullGranted = false, reset = false }) {
  const file = sequenceMarkerPath(tmpRoot, baselineHead);
  if (!fullGranted && !reset && readSequenceMarker(tmpRoot, baselineHead)?.fullGranted === true) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ baselineHead, fullGranted })}\n`);
  return file;
}

/** The marker for a baseline head, or null when none exists. A malformed marker reads as active, not granted (fail closed). */
export function readSequenceMarker(tmpRoot, baselineHead) {
  let text;
  try {
    text = readFileSync(sequenceMarkerPath(tmpRoot, baselineHead), "utf8");
  } catch {
    return null;
  }
  try {
    const marker = JSON.parse(text);
    if (marker?.baselineHead === baselineHead) return { baselineHead, fullGranted: marker.fullGranted === true };
  } catch {
    // Falls through to the fail-closed reading.
  }
  return { baselineHead, fullGranted: false };
}

/**
 * The marker of the sequence that is active at `head`, or null. A sequence is active while the
 * worktree head is its baseline, or descends from it, and no remote ref has advanced past the
 * baseline (a push ended it). With several active markers a non-granted one wins, so a stale
 * granted marker cannot admit a commit_only fixer push.
 * @param {{ tmpRoot: string, head: string, listBaselines: () => string[], isAncestor: (a: string, b: string) => boolean, remoteAdvanced: (baseline: string) => boolean }} input
 */
export function findActiveSequence({ tmpRoot, head, listBaselines, isAncestor, remoteAdvanced }) {
  const active = [];
  for (const baseline of listBaselines()) {
    const marker = readSequenceMarker(tmpRoot, baseline);
    if (marker && (baseline === head || isAncestor(baseline, head)) && !remoteAdvanced(baseline)) active.push(marker);
  }
  return active.find((m) => !m.fullGranted) ?? active[0] ?? null;
}

/** @returns {{ decision: "allow"|"deny", reason?: string }} */
export function decideFixPushAuthority({ command, agentType, sequenceActive, fullGranted = false }) {
  if (typeof command !== "string" || !PUSH_RE.test(command) || sequenceActive !== true) return { decision: "allow" };
  // The main agent (no subagent type) is the operator; only subagents are bound by the sequence.
  if (typeof agentType !== "string" || agentType.length === 0) return { decision: "allow" };
  // The fixer pushes only in the full phase; the commit_only fixer hands the commit back unpushed.
  if (agentType.split(":").pop() === "fixer" && fullGranted === true) return { decision: "allow" };
  return {
    decision: "deny",
    reason: "PRE-PUSH-DELTA-PUSH-AUTHORITY: a gate fix sequence is active; only the full-phase fixer pushes the fix branch, after the full work order is emitted. Hand the committed candidate back unpushed.",
  };
}
