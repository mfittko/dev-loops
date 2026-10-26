import { spawnSync } from "node:child_process";

/** Strip one leading `refs/remotes/origin/`, `refs/heads/` or `origin/`; any other value is returned unchanged. */
export function normalizeBaseBranch(base) {
  return typeof base === "string" ? base.replace(/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/u, "") : base;
}

/** True for a plain branch name; false for HEAD and revision expressions. A hex-only value is a valid name; callers probe the remote to tell a SHA from a branch. `/` is allowed only on request. */
export function isBranchName(base, { allowSlash = false } = {}) {
  return typeof base === "string" && base !== "" && base !== "HEAD"
    && base !== "@"
    &&!(allowSlash ? /[\s\\~^:?*\[\]{}]/u : /[\s/\\~^:?*\[\]{}]/u).test(base)
    && !base.startsWith("-") && !base.includes("..");
}

/** Prefer the remote counterpart only for a bare branch, never a revision expression. */
export function anchorBaseRef(base, { repoRoot = process.cwd(), env = process.env } = {}) {
  if (!isBranchName(base)) return base;
  const gitEnv = { ...env };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  delete gitEnv.GIT_COMMON_DIR;
  const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`], {
    cwd: repoRoot, env: gitEnv, encoding: "utf8",
  });
  if (probe.error) throw probe.error;
  if (probe.status === 0) return `origin/${base}`;
  if (probe.status === 1) return base;
  throw new Error(`cannot anchor diff base ${base}: ${probe.stderr.trim()}`);
}
