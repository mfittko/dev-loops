// Shared two-dot changed-files delta seam, extracted from
// resolve-angle-carry-forward.mjs's own captureDeltaChangedFiles so
// spec-context.mjs's `changed-paths` mode (issue 2008 / ADR 0061 AC5) reuses
// the SAME git invocation and isolation flags rather than re-deriving them.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { gitEnvWithoutDirOverrides, hasRenameEntry, normalizeBaseRef, parseChangedFiles } from "../github/write-gate-context.mjs";

// git-diff isolation flags: pin the name-status output bytes/rename detection
// so the changed-file SET is reproducible regardless of ambient gitconfig.
const GIT_ISOLATION = [
  "-c", "color.ui=false",
  "-c", "core.pager=cat",
  "-c", "diff.renames=true",
  "-c", "core.autocrlf=false",
  "-c", "core.quotePath=false",
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
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    child.stdout?.on("data", (chunk) => { stdout += stdoutDecoder.write(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += stderrDecoder.write(chunk); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
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

/**
 * Main-relative INCREMENTAL changed-files delta for carry-forward.
 *
 * The carry-forward decision must reuse the surface reviewers already see. That
 * surface is the PR's OWN change against main — write-gate-context.mjs builds it
 * as `origin/main...HEAD`. The carry-forward touched-surface delta must match:
 * the files changed since the prior reviewed head (`base..head`, two-dot) MINUS
 * files whose head content is already on `mainRef` (already-merged main commits
 * a base-move replays). Equivalently `(base..head) ∩ (mainRef..head)`: a file is
 * kept only when it was BOTH changed since the prior head AND its head blob
 * differs from `mainRef` (genuinely PR-own). `mainRef..head` (two-dot) is exactly
 * "files whose head blob differs from mainRef", so intersecting drops every file
 * that a base-move only integrated from main.
 *
 * This deliberately keeps the delta INCREMENTAL, not the absolute
 * `merge-base(mainRef,head)...head` PR diff: an angle untouched since the prior
 * reviewed head stays carried even when the PR touched it in an earlier round.
 *
 * Result semantics:
 * - An integrate-only base-move (every incremental file already on main)
 *   contributes an EMPTY `changedFiles` with `reduced: true` — the caller reads
 *   that (with `deltaComplete`) as "nothing PR-own changed, carry forward".
 * - `hasRename` reflects only renames that SURVIVE the exclusion (a PR-own
 *   rename), so a rename replayed from an already-merged main commit does not
 *   force RENAME_ONLY angles to re-run.
 * - When `mainRef` does not resolve (e.g. origin/main not fetched), the reduction
 *   cannot run: the function FALLS BACK to the plain two-dot `base..head` delta
 *   and returns `reduced: false` so the caller keeps the fail-closed empty-delta
 *   posture (no wrongful carry without the main-relative proof).
 *
 * @param {object} input
 * @param {string} input.base — prior reviewed head (head A)
 * @param {string} [input.mainRef] — the already-reviewed baseline ref, default "origin/main"
 * @param {string} [input.head] — default "HEAD"
 * @param {string} input.repoRoot
 * @returns {Promise<{ changedFiles: string[], hasRename: boolean, reduced: boolean }>}
 */
export async function captureMainRelativeChangedFilesSince({ base, mainRef = "origin/main", head = "HEAD", repoRoot, runGit = runGitCommand }) {
  const normalizedBase = normalizeBaseRef(base);
  const normalizedHead = normalizeBaseRef(head);
  const normalizedMain = normalizeBaseRef(mainRef);
  if (!normalizedBase || !normalizedHead || !normalizedMain) {
    throw new Error("captureMainRelativeChangedFilesSince requires plausible git refs (no leading '-', no '..')");
  }
  // Incremental delta since the prior reviewed head (two-dot base..head).
  const incRange = `${normalizedBase}..${normalizedHead}`;
  const incResult = await runGit([...GIT_ISOLATION, "diff", "--no-ext-diff", "--name-status", incRange], { repoRoot });
  if (incResult.code !== 0) throw new Error(`git diff ${incRange} failed: ${incResult.stderr.trim() || `exit ${incResult.code}`}`);

  // The main-relative exclusion needs mainRef to resolve. If it does not, fall
  // back to the plain two-dot delta (reduced: false) — never fail the whole
  // decision just because origin/main is absent.
  const mainResolves = await runGit(["rev-parse", "--verify", "--quiet", `${normalizedMain}^{commit}`], { repoRoot });
  if (mainResolves.code !== 0) {
    return { changedFiles: parseChangedFiles(incResult.stdout), hasRename: hasRenameEntry(incResult.stdout), reduced: false };
  }

  // Files whose head blob differs from mainRef (two-dot mainRef..head): the
  // PR-own surface. A file already on main at head is byte-identical to main and
  // never appears here, so intersecting removes it.
  const mainRange = `${normalizedMain}..${normalizedHead}`;
  const mainResult = await runGit([...GIT_ISOLATION, "diff", "--no-ext-diff", "--name-status", mainRange], { repoRoot });
  if (mainResult.code !== 0) throw new Error(`git diff ${mainRange} failed: ${mainResult.stderr.trim() || `exit ${mainResult.code}`}`);
  const prOwn = new Set(parseChangedFiles(mainResult.stdout));

  // Keep only incremental entries whose destination path is genuinely PR-own.
  // Parse the name-status per line here (rather than via parseChangedFiles) so a
  // surviving rename entry's R-status is tracked for hasRename.
  const changedFiles = [];
  let hasRename = false;
  for (const line of incResult.stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.trim().length === 0) continue;
    const cols = trimmed.split("\t");
    if (cols.length < 2) continue;
    const status = cols[0].trim();
    const isRenameOrCopy = /^[RC]\d*$/i.test(status);
    let dest;
    let src = "";
    if (isRenameOrCopy) {
      if (cols.length < 3) continue;
      src = (cols[1] ?? "").trim();
      dest = cols[cols.length - 1];
    } else {
      dest = cols[1];
    }
    const file = (dest ?? "").trim();
    if (file.length === 0) continue;
    // A file is PR-own when its head path differs from mainRef (present in
    // prOwn). For a rename, EITHER endpoint surviving the main-relative
    // comparison proves the rename is genuinely PR-own, not replayed from an
    // already-merged main commit: the destination differs from main, OR the
    // source's deletion is PR-own. When a PR-own rename lands on a destination
    // path that already exists byte-identical on main, `git diff mainRef..HEAD`
    // reports only the deleted source path (the destination is unchanged vs
    // main), so keying the exclusion on the destination alone would drop the
    // rename, leave `hasRename` false, and wrongly carry the RENAME_ONLY angles
    // — a fail-open. Checking the source too keeps that rename (issue #2292).
    // Adding source membership can only RETAIN renames, never over-exclude: a
    // rename replayed from main has neither endpoint in prOwn and stays dropped.
    const prOwnEntry = prOwn.has(file) || (isRenameOrCopy && src.length > 0 && prOwn.has(src));
    if (!prOwnEntry) continue; // already on main at head — exclude
    changedFiles.push(file);
    if (isRenameOrCopy) hasRename = true;
  }
  return { changedFiles, hasRename, reduced: true };
}
