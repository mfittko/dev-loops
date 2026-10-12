/**
 * fix-push-authority.mjs: during a gate fix sequence only the full-phase fixer pushes the fix
 * branch (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-PUSH-AUTHORITY).
 *
 * A sequence marker `<main worktree>/tmp/gate-delta/<baseline>.sequence` is written when the
 * `commit_only` fixer work order is emitted (ungranted) and rewritten with `fullGranted` when the
 * `full` work order is emitted. The hooks read it. Pure of git: the caller supplies the facts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Shell segment starts: a newline, `;`, `&`, `|`, a subshell or brace group, `$(` or a backtick.
const SEGMENT_SPLIT = /&&|\|\||\$\(|[;&|\n\r(){}`]/u;
// Leading shell keywords, a `!`, or `sh -c "` before the command word.
const SEGMENT_LEAD = /^(?:(?:then|do|else|elif|if|while|until|time|!)\s+|\b(?:ba|z)?sh\s+-c\s+['"])+/u;
// Env assignments, then launcher words (`timeout 60`, `nice -n 5`, `env`, ...), then an optional binary path.
const PUSH_SEGMENT_RE = /^\s*(?:\w+=\S*\s+)*(?:(?:env|command|exec|time|sudo|xargs|nohup)\s+|(?:timeout|nice)\s+(?:-\S+\s+)*(?:\d+[smhd]?\s+)?)*(?:\S*\/)?git((?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree)\s+\S+|--[\w-]+(?:=\S+)?))*)\s+push(?=[\s'"`;&|)]|$)/u;

/** The global-option text of the first `git ... push` segment in `command`, or undefined when none. */
function findPush(command) {
  if (typeof command !== "string") return undefined;
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const options = PUSH_SEGMENT_RE.exec(segment.trim().replace(SEGMENT_LEAD, ""))?.[1];
    if (options !== undefined) return options;
  }
  return undefined;
}

export const isGitPush = (command) => findPush(command) !== undefined;

/**
 * The directory a `git ... push` runs in: `cwd` resolved through every `-C <dir>` in order (git
 * applies each relative `-C` to the previous one). Returns null (fail closed) when a directory is
 * not a plain literal or `--git-dir`/`--work-tree` is present.
 */
export function pushTargetDir(command, cwd) {
  const options = findPush(command) ?? "";
  if (/--(?:git-dir|work-tree)/u.test(options)) return null;
  const dirs = [...options.matchAll(/\s-C\s+(\S+)/gu)].map((m) => m[1].replace(/^(['"])(.*)\1$/u, "$2"));
  if (dirs.some((dir) => /[$`~*?'"\\]/u.test(dir))) return null;
  return path.resolve(cwd, ...dirs);
}

export const sequenceMarkerPath = (tmpRoot, baselineHead) => path.join(tmpRoot, "gate-delta", `${baselineHead}.sequence`);

/** Record that a fix sequence is active for a baseline head; a `commit_only` emit writes it ungranted, a `full` emit granted. */
export function writeSequenceMarker({ tmpRoot, baselineHead, fullGranted = false }) {
  const file = sequenceMarkerPath(tmpRoot, baselineHead);
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
 * worktree head is its baseline or descends from it, and no remote ref has advanced past the
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
  if (typeof command !== "string" || !isGitPush(command) || sequenceActive !== true) return { decision: "allow" };
  // The main agent (no subagent type) is the operator; only subagents are bound by the sequence.
  if (typeof agentType !== "string" || agentType.length === 0) return { decision: "allow" };
  // The fixer pushes only in the full phase; the commit_only fixer hands the commit back unpushed.
  if (agentType.split(":").pop() === "fixer" && fullGranted === true) return { decision: "allow" };
  return {
    decision: "deny",
    reason: "PRE-PUSH-DELTA-PUSH-AUTHORITY: a gate fix sequence is active; only the full-phase fixer pushes the fix branch, after the full work order is emitted. Hand the committed candidate back unpushed.",
  };
}
