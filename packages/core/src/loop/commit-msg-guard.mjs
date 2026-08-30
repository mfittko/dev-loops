import fs from "node:fs";
import path from "node:path";

/**
 * Enforces the commit-message contract AT COMMIT TIME (issue #1869): the
 * attribution trailers, the no-bare-#N rule, and the conventional-commit
 * subject form were previously prose-only — nothing checked them, so a
 * non-compliant commit landed silently. Installed alongside the
 * default-branch guard (see default-branch-guard.mjs), through the same
 * ensure-worktree provisioning path, so it rides into every worktree too.
 *
 * The rendered hook is a single self-contained Node script (ESM: this repo's
 * root package.json is `"type": "module"`, and Node resolves an
 * extensionless direct-run script's module type by walking up for the
 * nearest package.json — verified empirically, not merely assumed). Keeping
 * the ENTIRE check inline in the rendered script (rather than requiring a
 * sibling file back into the checkout) means the installed hook keeps
 * working even if the checkout that installed it is later removed or moved
 * — the same self-containment default-branch-guard's hooks rely on.
 */
export const COMMIT_MSG_GUARD_MARKER = "dev-loops:commit-msg-guard";
export const COMMIT_MSG_WAIVER_MARKER = `${COMMIT_MSG_GUARD_MARKER}:allow`;

// Ownership check mirrors default-branch-guard's: the marker must be its own
// line (a `//` comment, since the rendered hook is JS), not merely mentioned,
// so a foreign hook that references us in prose is still left untouched.
const GUARD_MARKER_LINE = new RegExp(`^// ${COMMIT_MSG_GUARD_MARKER}$`, "mu");

/**
 * Renders the commit-msg hook as a standalone, runnable Node script. The
 * validation logic below is the ONLY copy of it — there is no separate JS
 * implementation this must stay in sync with, exactly like renderGuardHook's
 * shell body has none either. Tests exercise it by actually running it (see
 * commit-msg-guard.test.mjs), the same way default-branch-guard.test.mjs
 * drives real git rather than asserting on rendered text.
 *
 * String.raw, not a plain template literal: the generated script is full of
 * regex backslash escapes (\s, \d, \b, \.) that a normal template literal
 * would silently strip (an unrecognized string escape drops its backslash),
 * corrupting every regex in the installed hook. String.raw keeps every
 * backslash literal while still substituting the ${...} marker constants.
 * The generated script deliberately uses NO template literals of its own
 * (string concatenation instead) — a literal backtick would otherwise close
 * THIS OUTER template early.
 */
export function renderCommitMsgGuardHook() {
  return String.raw`#!/usr/bin/env node
// ${COMMIT_MSG_GUARD_MARKER}
// Enforces the commit-message contract (issue #1869): attribution trailers,
// no bare non-issue #<digits>, and a conventional-commit subject. A
// per-commit waiver line (${COMMIT_MSG_WAIVER_MARKER}) skips every check
// below for a deliberate exception.
import { readFileSync } from "node:fs";

// git invokes commit-msg with ONLY the message-file path (unlike
// prepare-commit-msg, which also gets a source/sha) — no signal distinguishes
// an ordinary commit from a merge/squash at this hook. A default, unedited
// merge message ("Merge branch '...'", "Merge pull request #...", "Merge tag
// '...'"), a default git-revert message (Revert "..."), or a
// git commit --fixup/--squash autosquash subject (fixup! ... / squash! ...)
// is git/tooling-generated, not operator-authored prose, so each is exempt by
// its own recognizable shape rather than forced through a conventional-commit
// subject and trailers it was never meant to carry.
const [, , msgPath] = process.argv;
const message = readFileSync(msgPath, "utf8");
const subjectLine = message.split("\n", 1)[0] || "";
if (
  /^Merge (branch|tag|remote-tracking branch|pull request) /u.test(subjectLine) ||
  /^Revert "/u.test(subjectLine) ||
  /^(fixup|squash)! /u.test(subjectLine)
) process.exit(0);

if (/^${COMMIT_MSG_GUARD_MARKER}:allow\b/mu.test(message)) process.exit(0);

const errors = [];

// Trailers are required only for an AGENT-authored commit: Claude Code sets
// CLAUDECODE=1 in every shell it spawns (the same harness-detection signal
// packages/core/src/loop/run-context.mjs's isClaudeHarness checks) — a plain
// human commit (CLAUDECODE unset) is never "Claude", so requiring a Claude
// co-author trailer on it would misattribute the commit, not enforce honesty.
if (process.env.CLAUDECODE === "1") {
  if (!/^Co-Authored-By:\s*Claude\s+.+\s+<noreply@anthropic\.com>\s*$/imu.test(message)) {
    errors.push("missing required trailer: Co-Authored-By: Claude <model> <noreply@anthropic.com>");
  }
  if (!/^Claude-Session:\s*\S+/imu.test(message)) {
    errors.push("missing required trailer: Claude-Session: <url>");
  }
}

// A genuine "Closes #N" / "Fixes #N" / "Refs #N" reference (optionally a
// comma/and-joined list, and optionally the trailer colon form "Closes: #N")
// is allowed and stripped first; any #<digits> left over is a bare non-issue
// enumeration, which GitHub auto-links to an unrelated issue/PR when
// rendered.
const withoutAllowedRefs = message.replace(
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?):?\s+#\d+(?:\s*(?:,|and)\s*#\d+)*/giu,
  "",
);
if (/#\d+/u.test(withoutAllowedRefs)) {
  errors.push('bare #<digits> reference found; use "Closes #N" / "Fixes #N" / "Refs #N" for a genuine issue reference, or reword a non-issue enumeration (e.g. "defect N")');
}

if (!/^(feat|fix|chore|docs|test|refactor|revert|perf|style|ci|build)\([^()\n]+\): .+\S/u.test(subjectLine)) {
  errors.push("subject must be conventional-commit form \"type(scope): summary\" (type one of feat/fix/chore/docs/test/refactor/revert/perf/style/ci/build)");
}

if (errors.length > 0) {
  console.error("dev-loops: WORKTREE-COMMIT-MSG-GUARD refuses this commit — contract violation(s):");
  for (const error of errors) console.error("  - " + error);
  console.error("  Waiver: add a \"${COMMIT_MSG_WAIVER_MARKER}\" line to the commit message for a deliberate exception.");
  process.exit(1);
}
process.exit(0);
`;
}

/**
 * Install the commit-msg guard into a repository's hook directory. Mirrors
 * default-branch-guard's install-refusal checks (a caller with an unsafe
 * `core.hooksPath`, a non-absolute/non-git `gitDir`, or a linked worktree's
 * OWN gitdir must never report success for a hook that can never fire) and
 * its atomic write + foreign-hook preservation — duplicated rather than
 * shared, since it is one hook, not a family; see default-branch-guard.mjs
 * for the family version if a third hook installer ever needs the same
 * shape factored out.
 *
 * @param {{ gitDir: string, hooksPathOverride?: string|null }} target
 */
export function installCommitMsgGuard({ gitDir, hooksPathOverride = null }) {
  const refuse = (reason) => ({ ok: false, installed: false, refreshed: false, skipped: true, reason });

  if (typeof hooksPathOverride === "string") {
    const configured = hooksPathOverride.trim();
    return configured.length > 0
      ? refuse(`core.hooksPath is set to ${JSON.stringify(configured)} — install the guard there, or unset it`)
      : refuse("core.hooksPath is set to an empty string — git runs no hooks at all");
  }
  if (typeof gitDir !== "string" || !path.isAbsolute(gitDir)) {
    return refuse(`gitDir must be an absolute path; got ${JSON.stringify(gitDir)}`);
  }
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    return refuse(`gitDir ${JSON.stringify(gitDir)} does not look like a git directory (no HEAD file)`);
  }
  if (fs.existsSync(path.join(gitDir, "commondir"))) {
    return refuse(`gitDir ${JSON.stringify(gitDir)} is a linked worktree's own git directory, not the common one — hooks installed there never run`);
  }

  const hooksDir = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "commit-msg");

  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null;
  const ours = existing === null || GUARD_MARKER_LINE.test(existing);
  if (!ours) {
    return { ok: true, installed: false, refreshed: false, skipped: true, reason: "a pre-existing hook is present and was left untouched" };
  }

  // Same atomic tmp-write + rename as default-branch-guard: the hooks dir is
  // shared across worktrees, so a direct writeFileSync would be visible
  // mid-write to a concurrent install or a real commit racing this one.
  const tmpPath = path.join(hooksDir, `.commit-msg.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, renderCommitMsgGuardHook(), { mode: 0o755 });
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, hookPath);

  return { ok: true, installed: existing === null, refreshed: existing !== null, skipped: false };
}
