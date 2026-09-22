import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionHarnessAdapter, HarnessContext, HarnessExecResult } from './harness-types.ts';
import {
  TARGET_REPO_SLUG,
  trimToNull,
  normalizeGitHubRepoSlug,
  isMergeCapableCommand,
  isGhPrReadyCommand,
  extractPrNumberFromGhPrReady,
  extractRepoFlagFromGhPrReady,
  extractPrNumberFromGhPrMergeAnywhere,
  extractRepoFlagFromGhPrMergeAnywhere,
  deriveInManagedRepo,
  explicitRepoProvenForeign,
  isCleanRepoSlug,
  DEVLOOPS_CONFIG_VARIANTS,
} from '@dev-loops/core/loop/bash-command-classify';
import { parseMainWorktreePath } from '@dev-loops/core/loop/worktree-guard';
import {
  buildWorktreeCleanupCommand,
  buildPostMergeActionsCommand,
  WORKTREE_CLEANUP_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
  POST_MERGE_ACTIONS_TIMEOUT_MS,
  syncMainCheckout,
} from '@dev-loops/core/loop/main-checkout-ff';

// The bash-command classifiers now live in `@dev-loops/core/loop/bash-command-classify` so the
// Pi extension and the Claude Code Bash hook share one source of truth. Re-export them here so
// existing importers (and tests) that reference them from this module keep resolving.
export {
  TARGET_REPO_SLUG,
  normalizeGitHubRepoSlug,
  isMergeCapableCommand,
  isGhPrReadyCommand,
  extractPrNumberFromGhPrReady,
  extractRepoFlagFromGhPrReady,
};

// Neutral event shapes the post-merge hook reads. The harness adapter forwards the
// harness-native event object through unchanged; these capture only the fields used here.
type ToolResultLike = { toolName?: string; input?: { command?: unknown } | null; isError?: boolean };
type UserBashLike = { command: string; cwd: string };
type UserBashResultLike = {
  result: {
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
  };
};

export const POST_MERGE_UPDATE_COMMAND = 'pi update git:github.com/mfittko/dev-loops';
export const PRE_PR_READY_GATE_SCRIPT = 'node scripts/loop/pre-pr-ready-gate.mjs';

const MERGE_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const POST_MERGE_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const REPO_RESOLUTION_TIMEOUT_MS = 5_000;
const PR_READY_GATE_TIMEOUT_MS = 30_000;

type RepoContext = {
  repoRoot: string | null;
  repoSlug: string | null;
  inManagedContext: boolean;
};

type RunCommandArgs = {
  command: string;
  cwd?: string;
  timeout?: number;
};

type RunCommandResult = HarnessExecResult;

type PostMergeUpdateHookState = {
  pendingPostMergeUpdate: boolean;
  updateInFlight: boolean;
  pendingRepoRoot: string | null;
  pendingPrNumber: number | null;
  // Set on ANY successful merge-capable command in ANY repo (not slug-gated like
  // pendingPostMergeUpdate, which only tracks the dev-loops self-update flow):
  // postMerge.actions (#1457) is a consumer-repo opt-in feature, so it must run
  // for the repo that merged regardless of its slug.
  pendingPostMergeActionsRoot: string | null;
};

type CreatePostMergeUpdateHookOptions = {
  exec?: ExtensionHarnessAdapter['exec'];
  resolveRepoContext?: (cwd: string) => Promise<RepoContext>;
  runCommand?: (args: RunCommandArgs) => Promise<RunCommandResult>;
};

function buildShellOutput(result: Pick<RunCommandResult, 'stdout' | 'stderr'>): string {
  const stdout = `${result.stdout ?? ''}`.trimEnd();
  const stderr = `${result.stderr ?? ''}`.trimEnd();
  if (stdout && stderr) {
    return `${stdout}\n${stderr}`;
  }
  return stdout || stderr;
}

function buildFailureSummary(result: Pick<RunCommandResult, 'stdout' | 'stderr' | 'code' | 'killed'>): string {
  return trimToNull(result.stderr)
    ?? trimToNull(result.stdout)
    ?? (result.killed
      ? 'command was killed before completing'
      : (typeof result.code === 'number' ? `exit code ${result.code}` : 'exit code unavailable'));
}

function getBashCommandFromToolResult(event: ToolResultLike | null | undefined): string | null {
  if (!event || event.toolName !== 'bash') {
    return null;
  }
  const command = event.input?.command;
  return typeof command === 'string' ? command : null;
}

function notify(ctx: Pick<HarnessContext, 'hasUI' | 'ui'>, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

async function defaultResolveRepoContext(exec: ExtensionHarnessAdapter['exec'], cwd: string): Promise<RepoContext> {
  const rootResult = await exec('git rev-parse --show-toplevel', {
    cwd,
    timeout: REPO_RESOLUTION_TIMEOUT_MS,
  });
  if (rootResult.code !== 0) {
    return { repoRoot: null, repoSlug: null, inManagedContext: false };
  }

  const repoRoot = trimToNull(rootResult.stdout);
  if (!repoRoot) {
    return { repoRoot: null, repoSlug: null, inManagedContext: false };
  }

  const inManagedContext = DEVLOOPS_CONFIG_VARIANTS.some((ext) => fs.existsSync(path.join(repoRoot, `.devloops${ext}`)));

  // A thrown/rejected `exec` here (timeout, spawn failure) must not bubble past this
  // function: `repoRoot`/`inManagedContext` are already known-good, and losing them
  // to a caught-upstream `null` would fail OPEN (resolveRepoContextSafe returns null,
  // callers pass the command through). Fail closed instead: repoSlug null, same as
  // the handled non-zero-exit branch below.
  let remoteResult: RunCommandResult;
  try {
    remoteResult = await exec('git config --get remote.origin.url', {
      cwd: repoRoot,
      timeout: REPO_RESOLUTION_TIMEOUT_MS,
    });
  } catch {
    return { repoRoot, repoSlug: null, inManagedContext };
  }
  if (remoteResult.code !== 0) {
    return { repoRoot, repoSlug: null, inManagedContext };
  }

  return {
    repoRoot,
    repoSlug: normalizeGitHubRepoSlug(remoteResult.stdout ?? ''),
    inManagedContext,
  };
}

async function defaultRunCommand(exec: ExtensionHarnessAdapter['exec'], args: RunCommandArgs): Promise<RunCommandResult> {
  return exec(args.command, {
    cwd: args.cwd,
    timeout: args.timeout,
  });
}

function markPendingUpdate(state: PostMergeUpdateHookState, command: string, repoContext: RepoContext): void {
  if (!repoContext.repoRoot || repoContext.repoSlug !== TARGET_REPO_SLUG) {
    return;
  }

  if (state.pendingPostMergeUpdate) {
    state.pendingRepoRoot ??= repoContext.repoRoot;
    return;
  }

  state.pendingPostMergeUpdate = true;
  state.pendingRepoRoot = repoContext.repoRoot;
}

async function resolveRepoContextSafe(
  resolveRepoContext: (cwd: string) => Promise<RepoContext>,
  cwd: string,
): Promise<RepoContext | null> {
  try {
    return await resolveRepoContext(cwd);
  } catch {
    return null;
  }
}

function markPendingPostMergeActions(state: PostMergeUpdateHookState, repoContext: RepoContext): void {
  if (!repoContext.repoRoot) {
    return;
  }
  state.pendingPostMergeActionsRoot ??= repoContext.repoRoot;
}

async function queueIfEligible(
  state: PostMergeUpdateHookState,
  resolveRepoContext: (cwd: string) => Promise<RepoContext>,
  command: string,
  cwd: string,
): Promise<boolean> {
  if (!isMergeCapableCommand(command)) {
    return false;
  }

  const repoContext = await resolveRepoContextSafe(resolveRepoContext, cwd);
  if (!repoContext?.repoRoot) {
    return false;
  }

  // postMerge.actions (#1457) runs for the repo that merged regardless of slug.
  markPendingPostMergeActions(state, repoContext);

  if (repoContext.repoSlug === TARGET_REPO_SLUG) {
    markPendingUpdate(state, command, repoContext);
  }

  // A resolved repo root means the caller should still capture the PR number (used
  // by both the dev-loops update pipeline and postMerge.actions), even for a repo
  // whose slug doesn't match TARGET_REPO_SLUG.
  return true;
}


/**
 * Best-effort main-checkout fast-forward (#1596).
 *
 * Resolves the main (primary) checkout via `git worktree list` (first entry) from
 * `pendingRoot`, then runs `syncMainCheckout`'s step-wise flow there: fetch,
 * `rev-parse --symbolic-full-name HEAD`, and `merge --ff-only origin/main` only when
 * that ref is `refs/heads/main`. `--ff-only` refuses a diverged main without
 * rewriting history, so a diverged checkout fails the merge step and the caller
 * treats it as warn-and-continue. When `git worktree list` fails, is killed, or its
 * output doesn't parse, `mainCheckout` falls back to `pendingRoot` and the sync
 * still runs there (unchanged from before #2363's `not_on_main` diagnostic). A
 * resolved checkout that is detached or on another branch emits the
 * `main_checkout_not_on_main` diagnostic at error level; the same outcome against
 * an UNRESOLVED (fallback) checkout stays warning-only instead, since `pendingRoot`
 * may be a linked feature worktree rather than the true main checkout. Every other
 * failure path (fetch, unreadable ref, etc.) stays warning-only regardless of
 * resolution.
 */
async function fastForwardMainCheckout(
  runCommand: (args: RunCommandArgs) => Promise<RunCommandResult>,
  pendingRoot: string,
  ctx: Pick<HarnessContext, 'hasUI' | 'ui'>,
): Promise<void> {
  let mainCheckout = pendingRoot;
  let mainCheckoutResolved = false;
  try {
    const wtResult = await runCommand({
      command: 'git worktree list',
      cwd: pendingRoot,
      timeout: MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
    });
    if (wtResult.code === 0 && !wtResult.killed) {
      const resolved = parseMainWorktreePath(wtResult.stdout ?? '');
      if (resolved) {
        mainCheckout = resolved;
        mainCheckoutResolved = true;
      }
    }
  } catch {
    // fall back to pendingRoot
  }

  notify(ctx, `Post-merge main-checkout fast-forward running for ${mainCheckout}`, 'info');

  const run = async (fwCommand: string): Promise<{ ok: boolean; stdout: string; reason: string }> => {
    const result = await runCommand({
      command: fwCommand,
      cwd: mainCheckout,
      timeout: MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
    });
    const ok = result.code === 0 && !result.killed;
    return { ok, stdout: result.stdout ?? '', reason: ok ? '' : buildFailureSummary(result) };
  };

  try {
    const syncResult = await syncMainCheckout(mainCheckout, run);
    if (syncResult.status === 'fast_forwarded') {
      notify(
        ctx,
        'Post-merge main-checkout fast-forward completed: local main advanced to origin/main',
        'info',
      );
    } else if (syncResult.status === 'not_on_main') {
      if (mainCheckoutResolved) {
        const message = syncResult.diagnostic.message;
        if (ctx.hasUI) {
          ctx.ui.notify(message, 'error');
        } else {
          process.stderr.write(message + '\n');
        }
      } else {
        // The checkout could not be resolved via `git worktree list`, so `mainCheckout`
        // is the fallback `pendingRoot` (possibly a linked feature worktree, not the
        // true main checkout). Downgrade to the generic warning instead of the
        // `main_checkout_not_on_main` diagnostic, which would be a false signal here.
        notify(
          ctx,
          `Post-merge main-checkout fast-forward skipped (warning only): ${syncResult.diagnostic.ref}`,
          'warning',
        );
      }
    } else {
      notify(
        ctx,
        `Post-merge main-checkout fast-forward skipped (warning only): ${syncResult.reason}`,
        'warning',
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notify(ctx, `Post-merge main-checkout fast-forward skipped (warning only): ${detail}`, 'warning');
  }
}

/**
 * Best-effort post-merge worktree removal (#1627).
 *
 * Resolves the main checkout the same way fastForwardMainCheckout does, then runs
 * the shared cleanup command built by `buildWorktreeCleanupCommand` (which invokes
 * `cleanup-worktree.mjs --pr <n>` FROM the main checkout — the hook's cwd can be
 * inside the worktree being removed). Non-fatal: every failure is a warning.
 */
async function removeMergedWorktree(
  runCommand: (args: RunCommandArgs) => Promise<RunCommandResult>,
  pendingRoot: string,
  prNumber: number | null,
  ctx: Pick<HarnessContext, 'hasUI' | 'ui'>,
): Promise<void> {
  if (prNumber === null) {
    return;
  }
  let mainCheckout = pendingRoot;
  try {
    const wtResult = await runCommand({
      command: 'git worktree list',
      cwd: pendingRoot,
      timeout: MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
    });
    if (wtResult.code === 0 && !wtResult.killed) {
      const resolved = parseMainWorktreePath(wtResult.stdout ?? '');
      if (resolved) mainCheckout = resolved;
    }
  } catch {
    // fall back to pendingRoot
  }

  const cleanupCommand = buildWorktreeCleanupCommand(mainCheckout, prNumber);
  if (!cleanupCommand) {
    return;
  }
  notify(ctx, `Post-merge worktree cleanup running for PR #${prNumber}`, 'info');
  try {
    const result = await runCommand({
      command: cleanupCommand,
      cwd: mainCheckout,
      timeout: WORKTREE_CLEANUP_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed) {
      notify(
        ctx,
        `Post-merge worktree cleanup skipped (warning only): ${buildFailureSummary(result)}`,
        'warning',
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notify(ctx, `Post-merge worktree cleanup skipped (warning only): ${detail}`, 'warning');
  }
}

/**
 * Run the repo's declared `postMerge.actions` (#1457), for the repo that
 * merged — regardless of its slug (unlike the dev-loops self-update pipeline,
 * this is a consumer opt-in feature). Resolves the main checkout the same way
 * fastForwardMainCheckout/removeMergedWorktree do, then runs the shared
 * existence-guarded runner command. The runner itself stays silent (no
 * stdout) when the repo declares no postMerge.actions, so this only notifies
 * when the runner actually produced output (something ran/skipped/failed) or
 * genuinely errored — never throws out of `onAgentEnd`.
 */
async function runPostMergeActionsForRepo(
  runCommand: (args: RunCommandArgs) => Promise<RunCommandResult>,
  pendingRoot: string,
  prNumber: number | null,
  ctx: Pick<HarnessContext, 'hasUI' | 'ui'>,
): Promise<void> {
  let mainCheckout = pendingRoot;
  try {
    const wtResult = await runCommand({
      command: 'git worktree list',
      cwd: pendingRoot,
      timeout: MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
    });
    if (wtResult.code === 0 && !wtResult.killed) {
      const resolved = parseMainWorktreePath(wtResult.stdout ?? '');
      if (resolved) mainCheckout = resolved;
    }
  } catch {
    // fall back to pendingRoot
  }

  try {
    const result = await runCommand({
      command: buildPostMergeActionsCommand(mainCheckout, prNumber ?? undefined),
      cwd: mainCheckout,
      timeout: POST_MERGE_ACTIONS_TIMEOUT_MS,
    });
    // Only the runner's own stdout (its final JSON result line) drives notification —
    // the wrapped command is `... || true`, so a non-zero exit never surfaces here; a
    // repo with no postMerge.actions produces no stdout at all (stays silent, AC11).
    const output = trimToNull(result.stdout);
    if (output) {
      notify(ctx, `Post-merge actions: ${output}`, 'info');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notify(ctx, `Post-merge actions skipped (warning only): ${detail}`, 'warning');
  }
}

export function createPostMergeUpdateHook(options: CreatePostMergeUpdateHookOptions = {}) {
  const exec = options.exec ?? null;

  const resolveRepoContext = options.resolveRepoContext
    ?? (exec ? ((cwd: string) => defaultResolveRepoContext(exec, cwd)) : null);
  const runCommand = options.runCommand
    ?? (exec ? ((args: RunCommandArgs) => defaultRunCommand(exec, args)) : null);

  if (!resolveRepoContext || !runCommand) {
    throw new Error('createPostMergeUpdateHook requires an `exec` function or explicit resolveRepoContext/runCommand overrides.');
  }

  const state: PostMergeUpdateHookState = {
    pendingPostMergeUpdate: false,
    updateInFlight: false,
    pendingRepoRoot: null,
    pendingPrNumber: null,
    pendingPostMergeActionsRoot: null,
  };

  function reset(): void {
    state.pendingPostMergeUpdate = false;
    state.updateInFlight = false;
    state.pendingRepoRoot = null;
    state.pendingPrNumber = null;
    state.pendingPostMergeActionsRoot = null;
  }

  return {
    getState(): PostMergeUpdateHookState {
      return { ...state };
    },

    onSessionStart(): void {
      reset();
    },

    async onToolResult(rawEvent: unknown, ctx: Pick<HarnessContext, 'cwd'>): Promise<void> {
      // Harness events arrive as `unknown` across the neutral seam; narrow here, at the
      // single place that knows which fields this hook reads.
      const event = rawEvent as ToolResultLike;
      const command = getBashCommandFromToolResult(event);
      if (!command || event.isError) {
        return;
      }
      // `pending`: a merge-capable command whose repo root resolved (any slug) — used
      // by both the dev-loops update pipeline and postMerge.actions (#1457).
      const pending = await queueIfEligible(state, resolveRepoContext, command, ctx.cwd);
      if (pending) {
        const pr = extractPrNumberFromGhPrMergeAnywhere(command);
        if (pr !== null) state.pendingPrNumber = pr;
      }
    },

    async onUserBash(rawEvent: unknown, _ctx?: HarnessContext): Promise<UserBashResultLike | undefined> {
      const event = rawEvent as UserBashLike;
      // The seam forwards events as `unknown`; a malformed/foreign-harness event must pass
      // through untouched rather than crash the handler (downstream calls .trim() on command).
      if (!event || typeof event.command !== 'string') {
        return undefined;
      }
      // Intercept gh pr ready before any other checks
      if (isGhPrReadyCommand(event.command)) {
        const repoContext = await resolveRepoContextSafe(resolveRepoContext, event.cwd);
        if (!repoContext?.repoRoot) {
          return undefined;
        }
        const managedRepoSlug = repoContext.inManagedContext ? repoContext.repoSlug : null;
        const explicitRepo = extractRepoFlagFromGhPrReady(event.command);
        if (explicitRepo && explicitRepoProvenForeign(explicitRepo, managedRepoSlug)) {
          return undefined; // provably foreign target — pass through
        }
        const inManagedRepo = deriveInManagedRepo({
          inManagedContext: repoContext.inManagedContext,
          managedRepoSlug,
          repoSlug: repoContext.repoSlug,
        });
        if (!inManagedRepo) {
          return undefined; // not a managed repo — pass through
        }

        const prNumber = extractPrNumberFromGhPrReady(event.command);
        if (prNumber === null) {
          return {
            result: {
              output: 'gh pr ready blocked: could not determine PR number from command. Include the PR number explicitly.',
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }

        // Defense-in-depth: `repoContext.repoSlug` reaches a `bash -lc` interpolation below.
        // `normalizeGitHubRepoSlug` already guarantees it is either a clean `owner/name` or null,
        // but a non-null value that is NOT a clean slug (e.g. an injected test double, or a future
        // resolver bypassing the normalizer) must fail closed here rather than be interpolated.
        // `null` is left to the existing fail-closed path below (it renders as the literal, inert
        // string "null", not a shell metacharacter).
        if (repoContext.repoSlug && !isCleanRepoSlug(repoContext.repoSlug)) {
          return {
            result: {
              output: 'gh pr ready blocked: resolved repo identity is not a valid owner/name — refusing to run the draft-gate check.',
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }

        // Run draft-gate evidence check
        const gateCommand = `${PRE_PR_READY_GATE_SCRIPT} --repo ${repoContext.repoSlug} --pr ${prNumber}`;
        try {
          const gateResult = await runCommand({
            command: gateCommand,
            cwd: repoContext.repoRoot,
            timeout: PR_READY_GATE_TIMEOUT_MS,
          });

          if (gateResult.code !== 0) {
            const stderr = `${gateResult.stderr ?? ''}`.trim();
            let message = `gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #${prNumber}.`;
            try {
              const parsed = JSON.parse(stderr);
              if (parsed.error) {
                message = `gh pr ready blocked: ${parsed.error}`;
              }
            } catch {
              if (stderr) {
                message = `gh pr ready blocked:\n${stderr}`;
              }
            }
            return {
              result: {
                output: message,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }

          // Gate passed — run the actual gh pr ready command
          const readyResult = await runCommand({
            command: event.command,
            cwd: event.cwd,
            timeout: MERGE_COMMAND_TIMEOUT_MS,
          });

          return {
            result: {
              output: buildShellOutput(readyResult),
              exitCode: readyResult.killed ? undefined : readyResult.code,
              cancelled: Boolean(readyResult.killed),
              truncated: false,
            },
          };
        } catch {
          return {
            result: {
              output: 'gh pr ready blocked: draft-gate evidence check failed (could not run guard script).',
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
      }

      if (!isMergeCapableCommand(event.command)) {
        return undefined;
      }

      const repoContext = await resolveRepoContextSafe(resolveRepoContext, event.cwd);
      if (!repoContext?.repoRoot) {
        return undefined;
      }
      const managedRepoSlug = repoContext.inManagedContext ? repoContext.repoSlug : null;
      const explicitRepo = extractRepoFlagFromGhPrMergeAnywhere(event.command);
      if (explicitRepo && explicitRepoProvenForeign(explicitRepo, managedRepoSlug)) {
        return undefined; // provably foreign target — pass through
      }
      const inManagedRepo = deriveInManagedRepo({
        inManagedContext: repoContext.inManagedContext,
        managedRepoSlug,
        repoSlug: repoContext.repoSlug,
      });
      if (!inManagedRepo) {
        return undefined;
      }

      try {
        const result = await runCommand({
          command: event.command,
          cwd: event.cwd,
          timeout: MERGE_COMMAND_TIMEOUT_MS,
        });

        if (result.code === 0 && !result.killed) {
          markPendingUpdate(state, event.command, repoContext);
          markPendingPostMergeActions(state, repoContext);
          const pr = extractPrNumberFromGhPrMergeAnywhere(event.command);
          if (pr !== null) state.pendingPrNumber = pr;
        }

        return {
          result: {
            output: buildShellOutput(result),
            exitCode: result.killed ? undefined : result.code,
            cancelled: Boolean(result.killed),
            truncated: false,
          },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          result: {
            output: detail,
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        };
      }
    },

    async onAgentEnd(_event: unknown, ctx: Pick<HarnessContext, 'cwd' | 'hasUI' | 'ui'>): Promise<void> {
      const shouldRunUpdate = state.pendingPostMergeUpdate;
      const actionsRoot = state.pendingPostMergeActionsRoot;
      if ((!shouldRunUpdate && !actionsRoot) || state.updateInFlight) {
        return;
      }

      // Capture before reset() clears it — the main-checkout fast-forward runs after the
      // pi-update step and needs a repo root to resolve the main checkout from.
      const pendingRoot = state.pendingRepoRoot ?? ctx.cwd;

      state.updateInFlight = true;

      if (shouldRunUpdate) {
        notify(ctx, `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, 'info');

        try {
          const result = await runCommand({
            command: POST_MERGE_UPDATE_COMMAND,
            cwd: pendingRoot,
            timeout: POST_MERGE_UPDATE_TIMEOUT_MS,
          });

          if (result.code === 0 && !result.killed) {
            notify(ctx, `Post-merge update completed: ${POST_MERGE_UPDATE_COMMAND}`, 'info');
          } else {
            notify(
              ctx,
              `Post-merge update failed (warning only): ${buildFailureSummary(result)}`,
              'warning',
            );
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          notify(ctx, `Post-merge update failed (warning only): ${detail}`, 'warning');
        }
      }

      try {
        if (shouldRunUpdate) {
          // Best-effort main-checkout fast-forward (#1596): the dev-loop merges remotely
          // but never fast-forwarded the main checkout's local main, so read-only gate
          // scripts ran stale code. Never throw out of onAgentEnd; reset() must still run.
          await fastForwardMainCheckout(runCommand, pendingRoot, ctx).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            notify(ctx, `Post-merge main-checkout fast-forward skipped (warning only): ${detail}`, 'warning');
          });
          // Post-merge worktree removal (#1627): remove the merged branch's worktree from
          // the main checkout, non-fatal (never throws out of onAgentEnd).
          await removeMergedWorktree(runCommand, pendingRoot, state.pendingPrNumber, ctx).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            notify(ctx, `Post-merge worktree cleanup skipped (warning only): ${detail}`, 'warning');
          });
        }
        if (actionsRoot) {
          // postMerge.actions (#1457): runs for the repo that merged regardless of
          // slug, independently of the dev-loops-only update/FF/cleanup pipeline above.
          await runPostMergeActionsForRepo(runCommand, actionsRoot, state.pendingPrNumber, ctx).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            notify(ctx, `Post-merge actions skipped (warning only): ${detail}`, 'warning');
          });
        }
      } finally {
        reset();
      }
    },
  };
}
