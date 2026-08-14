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
} from '@dev-loops/core/loop/bash-command-classify';
import { parseMainWorktreePath } from '@dev-loops/core/loop/worktree-guard';
import {
  buildMainCheckoutFastForwardCommand,
  buildWorktreeCleanupCommand,
  WORKTREE_CLEANUP_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
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
    return { repoRoot: null, repoSlug: null };
  }

  const repoRoot = trimToNull(rootResult.stdout);
  if (!repoRoot) {
    return { repoRoot: null, repoSlug: null };
  }

  const remoteResult = await exec('git config --get remote.origin.url', {
    cwd: repoRoot,
    timeout: REPO_RESOLUTION_TIMEOUT_MS,
  });
  if (remoteResult.code !== 0) {
    return { repoRoot, repoSlug: null };
  }

  return {
    repoRoot,
    repoSlug: normalizeGitHubRepoSlug(remoteResult.stdout ?? ''),
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
  if (!repoContext?.repoRoot || repoContext.repoSlug !== TARGET_REPO_SLUG) {
    return false;
  }

  markPendingUpdate(state, command, repoContext);
  return true;
}


/**
 * Best-effort main-checkout fast-forward (#1596).
 *
 * Resolves the main (primary) checkout via `git worktree list` (first entry) from
 * `pendingRoot`, then runs `fetch origin main && merge --ff-only origin/main` there.
 * `--ff-only` refuses a diverged main without rewriting history, so a diverged
 * checkout fails the merge step and the caller treats it as warn-and-continue.
 * Never throws — every failure path emits a warning notification instead.
 */
async function fastForwardMainCheckout(
  runCommand: (args: RunCommandArgs) => Promise<RunCommandResult>,
  pendingRoot: string,
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

  notify(
    ctx,
    `Post-merge main-checkout fast-forward running: ${buildMainCheckoutFastForwardCommand(mainCheckout)}`,
    'info',
  );

  try {
    const result = await runCommand({
      command: buildMainCheckoutFastForwardCommand(mainCheckout),
      cwd: mainCheckout,
      timeout: MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
    });
    if (result.code === 0 && !result.killed) {
      notify(
        ctx,
        'Post-merge main-checkout fast-forward completed: local main advanced to origin/main',
        'info',
      );
    } else {
      notify(
        ctx,
        `Post-merge main-checkout fast-forward skipped (warning only): ${buildFailureSummary(result)}`,
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
  };

  function reset(): void {
    state.pendingPostMergeUpdate = false;
    state.updateInFlight = false;
    state.pendingRepoRoot = null;
    state.pendingPrNumber = null;
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
        // Check if the command explicitly targets a different repo via -R/--repo
        const explicitRepo = extractRepoFlagFromGhPrReady(event.command);
        if (explicitRepo && explicitRepo.toLowerCase() !== TARGET_REPO_SLUG.toLowerCase()) {
          // Explicitly targeting a different repo — pass through
          return undefined;
        }

        const repoContext = await resolveRepoContextSafe(resolveRepoContext, event.cwd);
        if (!repoContext?.repoRoot || repoContext.repoSlug !== TARGET_REPO_SLUG) {
          // Not our target repo — pass through to default handling
          return undefined;
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
      if (!repoContext?.repoRoot || repoContext.repoSlug !== TARGET_REPO_SLUG) {
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
      if (!state.pendingPostMergeUpdate || state.updateInFlight) {
        return;
      }

      // Capture before reset() clears it — the main-checkout fast-forward runs after the
      // pi-update step and needs a repo root to resolve the main checkout from.
      const pendingRoot = state.pendingRepoRoot ?? ctx.cwd;

      state.updateInFlight = true;
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
      } finally {
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
        reset();
      }
    },
  };
}
