import { EXECUTION_IDENTITY_RE } from '@dev-loops/core/loop/work-order-digest';

/**
 * Pi enforcement of the read-only role boundary (#2509). Pi maps `search` and `bash` to
 * unrestricted `bash`, and its `tool_call` event carries no agent identity. The dispatch
 * sets the role marker `DEVLOOPS_AGENT_TYPE` in the child environment; the `tool_call`
 * handler reads it here. The Pi surface must not import the Claude hook seam, so the
 * sanctioned pull line is rebuilt from the shared identity regex; a test pins parity with
 * the Claude gate's `parseSanctionedPullLine`.
 */
const PULL_VALUE = '[A-Za-z0-9][\\w.:/#-]*';
const SANCTIONED_PULL_RE = new RegExp(
  `^dev-loops-run scripts/github/pull-work-order\\.mjs (?:${EXECUTION_IDENTITY_RE.source.slice(1, -1)}|--ref ${PULL_VALUE} --digest ${PULL_VALUE} --execution ${PULL_VALUE})$`,
);
const parseSanctionedPullLine = (command: string) => SANCTIONED_PULL_RE.test(command.trim());
const stripPluginNamespace = (agentType: string) => agentType.slice(agentType.lastIndexOf(':') + 1);
export const PI_AGENT_TYPE_ENV = 'DEVLOOPS_AGENT_TYPE';

/** Roles whose Pi `bash` is restricted. The judge pulls only; the reviewer also reads and searches. */
const READ_SEARCH_ROLES = new Set(['review']);
export const PI_BASH_RESTRICTED_ROLES = Object.freeze(['judge', 'review']);

// Read and search programs. Test and build runners (bun, npm, node, vitest, make) are absent.
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'stat', 'file', 'diff']);
const READ_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'status', 'ls-files', 'grep', 'blame', 'rev-parse', 'cat-file']);
// Shell-inert commands only: no chaining, redirection, substitution or newlines.
const SHELL_ACTIVE_RE = /[;&|<>`$\n\r(){}\\]/;

function isReadSearchCommand(command: string): boolean {
  if (SHELL_ACTIVE_RE.test(command)) return false;
  const [program, sub] = command.trim().split(/\s+/);
  if (program === 'git') return READ_GIT_SUBCOMMANDS.has(sub);
  return READ_PROGRAMS.has(program);
}

export type PiToolCallDecision = { block: false } | { block: true; reason: string };

/** Read the calling role from the dispatch marker. Returns null for the unmarked main agent. */
export function resolvePiAgentType(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[PI_AGENT_TYPE_ENV];
  return raw === undefined ? null : stripPluginNamespace(raw.trim());
}

/**
 * Decide a Pi `tool_call`. A restricted role runs only the sanctioned pull line (plus
 * read and search commands for the reviewer). A set but blank marker fails closed: it is
 * treated as a restricted role that may pull only.
 */
export function decidePiToolCall({ toolName, input, agentType }: {
  toolName?: string;
  input?: { command?: unknown };
  agentType: string | null;
}): PiToolCallDecision {
  if (agentType === null || toolName !== 'bash') return { block: false };
  if (agentType !== '' && !PI_BASH_RESTRICTED_ROLES.includes(agentType)) return { block: false };
  const command = typeof input?.command === 'string' ? input.command : '';
  if (parseSanctionedPullLine(command)) return { block: false };
  if (READ_SEARCH_ROLES.has(agentType) && isReadSearchCommand(command)) return { block: false };
  return {
    block: true,
    reason:
      `Read-only role boundary (#2509): role "${agentType || '(blank marker)'}" may run only its dispatched ` +
      '`dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>` line' +
      (READ_SEARCH_ROLES.has(agentType) ? ' and shell-inert read or search commands' : '') +
      '. Never run shell, test or build commands.',
  };
}
