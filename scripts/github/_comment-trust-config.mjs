// ADR 0290: load the comment-trust config from `.devloops` on the local origin/<default branch> ref only (no fetch), then set it
// process-wide for the shared trust predicate. Never read from the worktree or a PR head.
import { TrustConfig } from "@dev-loops/core/config";
import { setCommentTrustConfig } from "@dev-loops/core/github/comment-trust";
import { readDefaultBranchConfig } from "../loop/standing-authorization.mjs";

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
 * @returns {{ githubActionsBot?: boolean, reviewers?: string[] }} the applied config
 */
export function loadCommentTrustConfig(options = {}) {
  const base = readDefaultBranchConfig({ ...options, fetchOrigin: () => {} }); // no network and no ref-lock race: a stale local ref is the operator's to refresh
  if (!base.ok && !base.noConfigFile) throw new CommentTrustConfigError(base.state, base.detail);
  const raw = base.ok ? base.parsed?.trust : undefined;
  const parsed = raw === undefined ? { success: true, data: {} } : TrustConfig.safeParse(raw);
  if (!parsed.success) throw new CommentTrustConfigError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "trust"}: ${issue.message}`).join("; "));
  setCommentTrustConfig(parsed.data);
  return parsed.data;
}

/** For an entry script's direct-run block: a refused load prints one `{ ok: false, error, state }` JSON line on stderr and exits 2 (the entry scripts' own exit 1 stays theirs), before any trust read. */
export function loadCommentTrustConfigOrExit(options) {
  try {
    return loadCommentTrustConfig(options);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, state: error.state })}\n`);
    process.exit(2);
  }
}
