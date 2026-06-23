import type { ExtensionHarnessAdapter, HarnessContext, HarnessExecResult } from './harness-types.ts';

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

export const TARGET_REPO_SLUG = 'mfittko/dev-loops';
export const POST_MERGE_UPDATE_COMMAND = 'pi update git:github.com/mfittko/dev-loops';
export const PRE_PR_READY_GATE_SCRIPT = 'node scripts/loop/pre-pr-ready-gate.mjs';

const MERGE_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const POST_MERGE_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const REPO_RESOLUTION_TIMEOUT_MS = 5_000;
const PR_READY_GATE_TIMEOUT_MS = 30_000;

// Flags known to take a value argument for gh pr ready (not boolean flags)
const FLAGS_THAT_TAKE_VALUE = new Set(["-r", "--repo"]);

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
};

type CreatePostMergeUpdateHookOptions = {
  exec?: ExtensionHarnessAdapter['exec'];
  resolveRepoContext?: (cwd: string) => Promise<RepoContext>;
  runCommand?: (args: RunCommandArgs) => Promise<RunCommandResult>;
};

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = `${value ?? ''}`.trim();
  return trimmed ? trimmed : null;
}

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

function getBashCommandFromToolResult(event: ToolResultLike): string | null {
  if (event.toolName !== 'bash') {
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

export function normalizeGitHubRepoSlug(remoteUrl: string): string | null {
  const normalized = trimToNull(remoteUrl);
  if (!normalized) {
    return null;
  }

  const patterns = [
    /^git@github\.com:([^\s]+?)(?:\.git)?$/i,
    /^https:\/\/github\.com\/([^\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^\s]+?)(?:\.git)?$/i,
    /^git:github\.com\/([^\s]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    return trimToNull(match[1])?.toLowerCase() ?? null;
  }

  return null;
}

function isGhPrMergeCommand(segment: string): boolean {
  if (!/^gh\s+pr\s+merge(?:\s|$)/i.test(segment)) {
    return false;
  }

  const remainder = segment.replace(/^gh\s+pr\s+merge(?:\s|$)/i, '').trim();
  if (!remainder) {
    return true;
  }

  const firstArg = remainder.match(/^(\S+)/)?.[1]?.toLowerCase() ?? '';
  return !['--help', '-h'].includes(firstArg);
}

function isGitMergeCompletionCommand(segment: string): boolean {
  if (!/^git\s+merge(?:\s|$)/i.test(segment)) {
    return false;
  }

  const remainder = segment.replace(/^git\s+merge(?:\s|$)/i, '').trim();
  if (!remainder) {
    return true;
  }

  const firstArg = remainder.match(/^(\S+)/)?.[1]?.toLowerCase() ?? '';
  return !['--abort', '--continue', '--quit', '--help', '-h'].includes(firstArg);
}

export function isMergeCapableCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  return normalized
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .some((segment) => isGhPrMergeCommand(segment) || isGitMergeCompletionCommand(segment));
}

function firstShellSegment(command: string): string {
  return command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0]?.trim() ?? '';
}

export function isGhPrReadyCommand(command: string): boolean {
  const segment = firstShellSegment(command);
  if (!segment || !/^gh\s+pr\s+ready(?:\s|$)/i.test(segment)) {
    return false;
  }

  const remainder = segment.replace(/^gh\s+pr\s+ready(?:\s|$)/i, '').trim();
  if (!remainder) {
    return true;
  }
  // Block interception if --help or -h appears anywhere in the arguments
  const args = remainder.split(/\s+/).map(a => a.toLowerCase());
  return !args.includes('--help') && !args.includes('-h');
}

export function extractPrNumberFromGhPrReady(command: string): number | null {
  const segment = firstShellSegment(command);
  if (!/^gh\s+pr\s+ready(?:\s|$)/i.test(segment)) {
    return null;
  }
  const remainder = segment.replace(/^gh\s+pr\s+ready(?:\s|$)/i, '').trim();
  if (!remainder) {
    return null;
  }
  // Skip flags (--flag or --flag=value)
  const tokens = remainder.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      // Only skip the next token for flags known to take a value argument
      const flagName = token.replace(/=.*$/, '').toLowerCase();
      if (!token.includes('=') && FLAGS_THAT_TAKE_VALUE.has(flagName)) {
        i++; // skip next token (the flag value)
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      const num = Number(token);
      if (num > 0) {
        return num;
      }
    }
    // Non-numeric non-flag token — not a PR number
    return null;
  }
  return null;
}

export function extractRepoFlagFromGhPrReady(command: string): string | null {
  const segment = firstShellSegment(command);
  if (!/^gh\s+pr\s+ready(?:\s|$)/i.test(segment)) {
    return null;
  }
  const remainder = segment.replace(/^gh\s+pr\s+ready(?:\s|$)/i, '').trim();
  if (!remainder) {
    return null;
  }
  const tokens = remainder.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower === '-r' || lower === '--repo') {
      // Next token is the repo slug value
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        return tokens[i + 1];
      }
    }
    // Handle --repo=value and -R=value
    const repoEqMatch = token.match(/^(?:--repo|-R)=(.+)$/i);
    if (repoEqMatch) {
      return repoEqMatch[1];
    }

  }
  return null;
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
  };

  function reset(): void {
    state.pendingPostMergeUpdate = false;
    state.updateInFlight = false;
    state.pendingRepoRoot = null;
  }

  return {
    getState(): PostMergeUpdateHookState {
      return { ...state };
    },

    onSessionStart(): void {
      reset();
    },

    async onToolResult(event: ToolResultLike, ctx: Pick<HarnessContext, 'cwd'>): Promise<void> {
      const command = getBashCommandFromToolResult(event);
      if (!command || event.isError) {
        return;
      }
      await queueIfEligible(state, resolveRepoContext, command, ctx.cwd);
    },

    async onUserBash(event: UserBashLike, _ctx?: HarnessContext): Promise<UserBashResultLike | undefined> {
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

      state.updateInFlight = true;
      notify(ctx, `Post-merge update running: ${POST_MERGE_UPDATE_COMMAND}`, 'info');

      try {
        const result = await runCommand({
          command: POST_MERGE_UPDATE_COMMAND,
          cwd: state.pendingRepoRoot ?? ctx.cwd,
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
        reset();
      }
    },
  };
}
