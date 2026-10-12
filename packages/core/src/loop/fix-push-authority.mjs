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
const PUSH_RE = /(?:^|[;&|(`]|\$\(|\b(?:ba|z)?sh\s+-c\s+['"])\s*(?:\w+=\S*\s+)*(?:(?:env|command|exec|time|sudo|xargs)\s+)*git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push(?=[\s'"`;&|)]|$)/u;

export const sequenceMarkerPath = (tmpRoot, baselineHead) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence`);

/** Record that a fix sequence is active for a baseline head; never downgrades a granted marker. */
export function writeSequenceMarker({ tmpRoot, baselineHead, fullGranted = false }) {
  const file = sequenceMarkerPath(tmpRoot, baselineHead);
  if (!fullGranted && readSequenceMarker(tmpRoot, baselineHead)?.fullGranted === true) return file;
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
 * worktree head is its baseline, or descends from it and is not yet on any remote ref; a push by
 * the full-phase fixer or a moved head ends it.
 * @param {{ tmpRoot: string, head: string, listBaselines: () => string[], isAncestor: (a: string, b: string) => boolean, onRemote: (head: string) => boolean }} input
 */
export function findActiveSequence({ tmpRoot, head, listBaselines, isAncestor, onRemote }) {
  for (const baseline of listBaselines()) {
    const marker = readSequenceMarker(tmpRoot, baseline);
    if (marker && (baseline === head || (isAncestor(baseline, head) && !onRemote(head)))) return marker;
  }
  return null;
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
