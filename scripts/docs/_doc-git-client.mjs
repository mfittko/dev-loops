import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Injectable git client shared by the two base-ref-dependent documentation
 * validators (validate-changelog-completeness.mjs, validate-decision-records.mjs)
 * so their base-ref resolution and git operations cannot drift. The callers'
 * differences stay explicit at the call site: each passes its own diffNameOnly
 * options (delimiter / directory) and only the changelog validator calls
 * logSubjects.
 */
export function createGitClient(root, exec = promisify(execFile)) {
  const run = (args) => exec("git", args, { cwd: root });
  return {
    async symbolicRef(ref) {
      const { stdout } = await run(["symbolic-ref", ref]);
      return stdout.trim();
    },
    async mergeBase(a, b) {
      const { stdout } = await run(["merge-base", a, b]);
      return stdout.trim();
    },
    /**
     * Changed file paths between `a` and `b`.
     * `--no-renames` always: a `git mv` must surface as a delete+add pair (so
     * the decision-record deletion guard fires) instead of collapsing to just
     * the destination path.
     * `nulDelimited` uses `-z` + NUL split so a C-quoted path containing a
     * newline cannot smuggle a suffix line past the caller as a separate "file"
     * (the changelog classifyFile seam); otherwise names are newline-split.
     * `dir` scopes the diff to a subtree (the decision-records path).
     */
    async diffNameOnly(a, b, { dir = null, nulDelimited = false } = {}) {
      const args = ["diff", "--no-renames", "--name-only"];
      if (nulDelimited) args.push("-z");
      args.push(a, b);
      if (dir) args.push("--", dir);
      const { stdout } = await run(args);
      return nulDelimited
        ? stdout.split("\0").filter(Boolean)
        : stdout.split(/\r?\n/).filter(Boolean);
    },
    async logSubjects(a, b) {
      const { stdout } = await run(["log", "--format=%s", `${a}..${b}`]);
      return stdout.split(/\r?\n/).filter(Boolean);
    },
    async show(spec) {
      const { stdout } = await run(["show", spec]);
      return stdout;
    },
    async pathExistsIn(rev, rel) {
      // `git ls-tree <rev> -- <path>` prints the path iff it exists in <rev> and
      // exits 0 either way, so empty output is a clean-positive "absent from
      // base" (a newly added record) while a real git failure still throws and
      // fails closed — unlike `cat-file -e`, whose exit 128 conflates a missing
      // path with a corrupt object / invalid rev.
      const { stdout } = await run(["ls-tree", "-z", rev, "--", rel]);
      return stdout.length > 0;
    },
  };
}

/**
 * Resolve the merge-base comparison point against the default branch. Candidate
 * order (so the two validators cannot drift): origin/HEAD's default branch,
 * then GITHUB_BASE_REF (CI fetches it into origin/<base>, so a non-main/master
 * default branch still resolves), then origin/main, then origin/master.
 * Returns null when none resolve — the legitimate shallow-checkout / no-origin
 * degrade path.
 */
export async function resolveBaseRef(git, env = process.env) {
  let defaultBranch = null;
  try {
    defaultBranch = (await git.symbolicRef("refs/remotes/origin/HEAD")).replace(/^refs\/remotes\/origin\//, "");
  } catch {
    defaultBranch = null;
  }
  if (defaultBranch) return git.mergeBase(`origin/${defaultBranch}`, "HEAD");
  const candidates = [
    ...(env.GITHUB_BASE_REF ? [`origin/${env.GITHUB_BASE_REF}`] : []),
    ...["main", "master"].map((b) => `origin/${b}`),
  ];
  for (const branch of candidates) {
    try {
      const base = await git.mergeBase(branch, "HEAD");
      if (base) return base;
    } catch {
      // try next candidate
    }
  }
  return null;
}
