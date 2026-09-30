import { EXECUTION_IDENTITY_RE } from '@dev-loops/core/loop/work-order-digest';

/**
 * Pi enforcement of the read-only role boundary
 * (skills/docs/cross-harness-regression-contract.md, "Read-only role enforcement on Pi"). Pi maps `search` and `bash` to
 * unrestricted `bash`, and its `tool_call` event carries no agent identity. The `tool_call`
 * handler reads the role marker `DEVLOOPS_AGENT_TYPE` when dispatch sets it; Pi dispatch
 * wiring is tracked in #2582 and an absent marker is the unrestricted main agent. The Pi surface must not import the Claude hook seam, so the
 * sanctioned pull line is rebuilt from the shared identity regex; a test pins parity with
 * the Claude gate's `parseSanctionedPullLine`.
 */
const PULL_VALUE = '[A-Za-z0-9][\\w.:/#-]*';
const SANCTIONED_PULL_RE = new RegExp(
  `^dev-loops-run scripts/github/pull-work-order\\.mjs (?:${EXECUTION_IDENTITY_RE.source.slice(1, -1)}|--ref ${PULL_VALUE} --digest ${PULL_VALUE} --execution ${PULL_VALUE})$`,
);
const parseSanctionedPullLine = (command: string) => SANCTIONED_PULL_RE.test(command.trim());
const stripPluginNamespace = (agentType: string) => agentType.slice(agentType.lastIndexOf(':') + 1);
export const AGENT_TYPE_ENV = 'DEVLOOPS_AGENT_TYPE';

/** Roles whose Pi `bash` is restricted. The judge pulls only; the reviewer also reads and searches. */
const READ_SEARCH_ROLES = new Set(['review']);
export const BASH_RESTRICTED_ROLES = Object.freeze(['judge', 'review']);

// Read and search programs. Test and build runners (bun, npm, node, vitest, make) are absent.
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'stat', 'file', 'diff', 'jq', 'find']);
const READ_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'status', 'ls-files', 'grep', 'blame', 'rev-parse', 'cat-file']);
// Shell-inert commands only: no chaining, redirection, substitution or newlines.
// Quotes and glob characters are denied too: the shell would strip or expand them into flags the gate never saw.
const SHELL_ACTIVE_RE = /[;&|<>`$\n\r(){}\\'"*?[\]]/;

// The reviewer contract's mandated sentinel and bound-escape scripts, and its `cd <worktree> && ...` prefix.
const REVIEWER_SCRIPT_RE = /^dev-loops-run scripts\/github\/(?:verify-fresh-review-context|emit-reviewer-blocked)\.mjs(?: .*)?$/;
const CD_PREFIX_RE = /^cd "?[\w./-]+"? && /;
const GIT_C_RE = /^git -C "?[\w./-]+"? /;
// Flags that make an allowed program execute another program or write a file. Git accepts unique prefixes, so match prefixes.
const EXEC_FLAG_RE = /^(?:-[^-\s]*O|--op|--out|--ext|--tex)/;
const RG_PRE_RE = /^--pre(?:-glob)?(?:=|$)/;
const FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/;

function isReadSearchCommand(rawCommand: string): boolean {
  // Strip the mandated `cd <path> && ` and `git -C <path> ` forms before the shell-inert check; their paths allow safe characters only.
  const command = rawCommand.trim().replace(CD_PREFIX_RE, '').replace(GIT_C_RE, 'git ');
  if (SHELL_ACTIVE_RE.test(command)) return false;
  if (REVIEWER_SCRIPT_RE.test(command)) return true;
  let tokens = command.split(/\s+/);
  const program = tokens[0];
  if (program === 'git') {
    tokens = tokens.slice(1);
    if (!READ_GIT_SUBCOMMANDS.has(tokens[0])) return false;
  } else if (!READ_PROGRAMS.has(program)) {
    return false;
  }
  const args = tokens.slice(1);
  if (args.some((t) => EXEC_FLAG_RE.test(t))) return false;
  if (program === 'rg' && args.some((t) => RG_PRE_RE.test(t) || /^--host/.test(t))) return false;
  if (program === 'file' && args.some((t) => /^-[^-\s]*C/.test(t) || /^--comp/.test(t))) return false;
  if (program === 'find' && args.some((t) => FIND_EXEC_RE.test(t))) return false;
  return true;
}

export type PiToolCallDecision = { block: false } | { block: true; reason: string };

/** Read the calling role from the dispatch marker. Returns null for the unmarked main agent. */
export function resolvePiAgentType(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[AGENT_TYPE_ENV];
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
  if (agentType !== '' && !BASH_RESTRICTED_ROLES.includes(agentType)) return { block: false };
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
