// Shared two-dot changed-files delta seam, extracted from
// resolve-angle-carry-forward.mjs's own captureDeltaChangedFiles so
// spec-context.mjs's `changed-paths` mode (issue 2008 / ADR 0061 AC5) reuses
// the SAME git invocation and isolation flags rather than re-deriving them.
import { execFileSync } from "node:child_process";
import { gitEnvWithoutDirOverrides, hasRenameEntry, parseChangedFiles } from "../github/write-gate-context.mjs";

// git-diff isolation flags: pin the name-status output bytes/rename detection
// so the changed-file SET is reproducible regardless of ambient gitconfig.
const GIT_ISOLATION = [
  "-c", "color.ui=false",
  "-c", "core.pager=cat",
  "-c", "diff.renames=true",
  "-c", "core.autocrlf=false",
];

/**
 * Two-dot changed-files delta between `base` and `head`: the direct tree diff,
 * NOT three-dot (`base...head`, which diffs merge-base(base,head)..head and can
 * omit a file that differs between the two but happens to equal their
 * merge-base under a non-fast-forward advance).
 * @param {object} input
 * @param {string} input.base
 * @param {string} [input.head] — default "HEAD"
 * @param {string} input.repoRoot
 * @returns {{ changedFiles: string[], hasRename: boolean }}
 */
export function captureChangedFilesBetween({ base, head = "HEAD", repoRoot }) {
  const range = `${base}..${head}`;
  const out = execFileSync("git", [...GIT_ISOLATION, "diff", "--no-ext-diff", "--name-status", range], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // See gitEnvWithoutDirOverrides (write-gate-context.mjs): the caller's own
    // worktree-at-head guard (when it has one) scrubs the SAME way, so the
    // guard and this delta always mean the worktree at `repoRoot`, never a
    // repo an inherited GIT_DIR points at.
    env: gitEnvWithoutDirOverrides(),
  });
  return { changedFiles: parseChangedFiles(out), hasRename: hasRenameEntry(out) };
}
