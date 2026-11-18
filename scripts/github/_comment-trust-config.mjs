// ADR 0290: load the comment-trust config from `.devloops` on the local origin/<default branch> ref only (no fetch), then set it
// process-wide for the shared trust predicate. Never read from the worktree or a PR head.
import { TrustConfig } from "@dev-loops/core/config";
import { setCommentTrustConfig } from "@dev-loops/core/github/comment-trust";
import { readDefaultBranchConfig } from "../loop/standing-authorization.mjs";

/** Exit code of a refused load. 0, 1 and 2 are the entry scripts' own, and 3 is free in every loading script: callers still key on the stderr `state` field. */
export const TRUST_CONFIG_REFUSED_EXIT = 3;

export class CommentTrustConfigError extends Error {
  constructor(state, detail) {
    super(`comment trust config: ${state}: ${detail}`);
    this.name = "CommentTrustConfigError";
    this.state = state;
  }
}

/**
 * Call once per entry script before its first trust read. No `.devloops` or no `trust` key applies the
 * built-in defaults; any other failure throws, because defaults would undo a `githubActionsBot: false` opt-out.
 * Every refusal names its remedy. The load reads a possibly stale local ref (ADR 0290), so `git fetch origin` is the operator's.
 * @returns {{ githubActionsBot?: boolean, reviewers?: string[] }} the applied config
 */
export function loadCommentTrustConfig(options = {}) {
  const base = readDefaultBranchConfig({ ...options, fetchOrigin: () => {} }); // no network and no ref-lock race: a stale local ref is the operator's to refresh
  if (!base.ok && !base.noConfigFile) {
    if (base.state === "default_branch_unresolved") throw new CommentTrustConfigError(base.state, `${base.detail}; run: git remote set-head origin --auto`);
    if (base.refAbsent) throw new CommentTrustConfigError(base.state, `refusing to run: the local origin/${base.defaultBranch} ref is absent, so the trust config cannot be read; run: git fetch origin`);
    throw new CommentTrustConfigError(base.state, `${base.detail}; fix .devloops on origin/${base.defaultBranch}, then run: git fetch origin`);
  }
  const raw = base.ok ? base.parsed?.trust : undefined;
  const parsed = raw === undefined ? { success: true, data: {} } : TrustConfig.safeParse(raw);
  if (!parsed.success) throw new CommentTrustConfigError("invalid", `${parsed.error.issues.map((issue) => `${issue.path.join(".") || "trust"}: ${issue.message}`).join("; ")}; fix the trust block of .devloops on origin/${base.defaultBranch}, then run: git fetch origin`);
  setCommentTrustConfig(parsed.data);
  return parsed.data;
}

/**
 * For an entry script's direct-run block. A refused load prints one `{ ok: false, error, state }` JSON line on stderr and exits
 * 3 (`TRUST_CONFIG_REFUSED_EXIT`), before any trust read. Exit 1 and 2 stay each entry script's own documented codes; callers key on `state`.
 * A `--help` or `-h` run makes no trust read, so the load is skipped.
 */
export function loadCommentTrustConfigOrExit(options, argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) return undefined;
  try {
    return loadCommentTrustConfig(options);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, state: error.state })}\n`);
    process.exit(TRUST_CONFIG_REFUSED_EXIT);
  }
}
