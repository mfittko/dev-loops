// Shared two-dot changed-files delta seam, extracted from
// resolve-angle-carry-forward.mjs's own captureDeltaChangedFiles so
// spec-context.mjs's `changed-paths` mode (issue 2008 / ADR 0061 AC5) reuses
// the SAME git invocation and isolation flags rather than re-deriving them.
import { spawn } from "node:child_process";
import { gitEnvWithoutDirOverrides, hasRenameEntry, normalizeBaseRef, parseChangedFiles } from "../github/write-gate-context.mjs";

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
 * @returns {Promise<{ changedFiles: string[], hasRename: boolean }>}
 */
export function runGitCommand(args, { repoRoot, env = gitEnvWithoutDirOverrides(), spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("git", args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      if (spawnError) return reject(spawnError);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function captureChangedFilesBetween({ base, head = "HEAD", repoRoot, runGit = runGitCommand }) {
  // Same ref-shape guard as write-gate-context.mjs's own normalizeBaseRef path
  // (reused, not re-derived): reject a leading "-" (flag-injection shape) and
  // ".." (ambiguous with this function's own "<base>..<head>" construction)
  // before either ref reaches `git diff`, so a malformed ref fails closed here
  // rather than being silently misinterpreted by git.
  const normalizedBase = normalizeBaseRef(base);
  const normalizedHead = normalizeBaseRef(head);
  if (!normalizedBase || !normalizedHead) {
    throw new Error("captureChangedFilesBetween requires plausible git refs for base/head (no leading '-', no '..')");
  }
  const range = `${normalizedBase}..${normalizedHead}`;
  const result = await runGit([...GIT_ISOLATION, "diff", "--no-ext-diff", "--name-status", range], { repoRoot });
  if (result.code !== 0) throw new Error(`git diff ${range} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return { changedFiles: parseChangedFiles(result.stdout), hasRename: hasRenameEntry(result.stdout) };
}
