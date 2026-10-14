import { classifyValidationCommand, FULL_VALIDATION_REMEDY, isReadSearchCommand, isReviewerContractCommand } from '@dev-loops/core/loop/bash-command-classify';
import { EXECUTION_IDENTITY_RE } from '@dev-loops/core/loop/work-order-digest';
import { NATIVE_PI_PARENT_SESSION_MARKER, isNativePiAsyncContext } from '@dev-loops/core/loop/run-context';
import { fileURLToPath } from 'node:url';

const TRUSTED_CLI_PATH = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));

/**
 * Pi enforcement of the read-only role boundary
 * (skills/docs/cross-harness-regression-contract.md, "Read-only role enforcement on Pi"). Pi's `tool_call`
 * event carries no agent identity, so the handler resolves the role per call from the calling session's own
 * system prompt: pi-subagents writes `<active_agent name="<agent>"/>` into every named child. The Pi surface
 * must not import the Claude hook seam, so the sanctioned pull line is rebuilt from the shared identity
 * regex; a test pins parity with the Claude gate's `parseSanctionedPullLine`.
 */
const PULL_VALUE = '[A-Za-z0-9][\\w.:/#-]*';
const SANCTIONED_PULL_RE = new RegExp(
  `^dev-loops-run scripts/github/pull-work-order\\.mjs (?:${EXECUTION_IDENTITY_RE.source.slice(1, -1)}|--ref ${PULL_VALUE} --digest ${PULL_VALUE} --execution ${PULL_VALUE})$`,
);
const parseSanctionedPullLine = (command: string) => SANCTIONED_PULL_RE.test(command.trim());
const JUDGE_DECISION_CHECK_RE = /^dev-loops-run scripts\/loop\/check-judge-decision\.mjs --file [\w.\/#-]*tmp\/gate-judge\/[\w.\/#-]+\.json$/;
const stripPluginNamespace = (agentType: string) => agentType.slice(agentType.lastIndexOf(':') + 1);
/**
 * The plugin namespace a tag value names: the text before its first `:`, trimmed; '' when the value
 * carries no namespace. Read off the same trimmed value as the bare name so a `dev-loops:`-prefixed
 * name with whitespace around the separator is still recognized as namespaced.
 */
const pluginNamespace = (agentType: string) => {
  const trimmed = agentType.trim();
  const colon = trimmed.indexOf(':');
  return colon === -1 ? '' : trimmed.slice(0, colon).trim();
};

/** Roles whose Pi `bash` is restricted. The judge pulls and runs the check-judge-decision line; the reviewer also reads and searches. */
const READ_SEARCH_ROLES = new Set(['review']);
export const BASH_RESTRICTED_ROLES = Object.freeze(['judge', 'review']);

export type PiToolCallDecision = { block: false } | { block: true; reason: string };

/** Every dev-loops agent role: the `name` frontmatter of `agents/*.agent.md`. */
export const DEV_LOOPS_ROLES = Object.freeze([
  'review', 'judge', 'fixer', 'developer', 'refiner', 'docs', 'quality', 'dev-loop', 'gate-coordinator',
]);
const ACTIVE_AGENT_RE = /<active_agent name="([^"]*)"\/>/g;

/**
 * True when the *calling* session is the untagged native async child the fail-closed row targets.
 *
 * The native async runner sets the child flag in-process, so the flag is shared by every session in
 * the process and cannot by itself separate the child from an untagged main agent running alongside
 * it: reading the bare flag would lock the operator's own session to the pull line. Requiring the
 * canonical native-async pair (child flag plus a non-blank parent session, via
 * `isNativePiAsyncContext`) and a non-blank calling session id that differs from the recorded
 * parent scopes the fail-closed to the child itself — the untagged main agent, whose own session
 * id equals the recorded parent, and a session with no usable id, both stay unrestricted.
 */
function isNativePiAsyncChildSession(
  env: Record<string, string | undefined>,
  sessionId: string | undefined,
): boolean {
  if (!isNativePiAsyncContext(env)) return false;
  const own = (sessionId ?? '').trim();
  const parent = (env[NATIVE_PI_PARENT_SESSION_MARKER] ?? '').trim();
  return own !== '' && own !== parent;
}

/**
 * Resolve the calling role from the session's own system prompt (the pi-subagents `active_agent`
 * tag). Returns null for the unrestricted main agent, a role name, or '' to fail closed.
 *
 * `sessionId` is the calling session's own id (from `ctx.getSessionId()`), used only to scope the
 * untagged native-async-child fail-closed row to the calling session rather than the shared process
 * env; see `isNativePiAsyncChildSession`.
 */
export function resolvePiRole({ systemPrompt, env = process.env, sessionId }: {
  systemPrompt?: string;
  env?: Record<string, string | undefined>;
  sessionId?: string;
}): string | null {
  const raws = [...(systemPrompt ?? '').matchAll(ACTIVE_AGENT_RE)].map((m) => m[1]);
  if (raws.length === 0) return isNativePiAsyncChildSession(env, sessionId) ? '' : null;
  const names = new Set(raws.map((raw) => stripPluginNamespace(raw).trim()));
  if (names.size !== 1) return '';
  const [name] = names;
  if (name === '') return '';
  if (raws.some((raw) => pluginNamespace(raw) === 'dev-loops') && !DEV_LOOPS_ROLES.includes(name)) return '';
  return name;
}
/**
 * Decide a Pi `tool_call`. A restricted role runs only the sanctioned pull line (plus
 * read and search commands for the reviewer; the judge also runs its decision check). An unresolved role ('' from a blank tag, an
 * unknown dev-loops: name, conflicting tags or an untagged native async child session) fails
 * closed: it is treated as a restricted role that may pull only.
 */
export function decidePiToolCall({ toolName, input, agentType }: {
  toolName?: string;
  input?: { command?: unknown };
  agentType: string | null;
}): PiToolCallDecision {
  if (agentType === null || toolName !== 'bash') return { block: false };
  const command = typeof input?.command === 'string' ? input.command : '';
  if (['developer', 'fixer'].includes(agentType) && classifyValidationCommand(command) === 'full-repository') {
    return { block: true, reason: FULL_VALIDATION_REMEDY };
  }
  if (agentType !== '' && !BASH_RESTRICTED_ROLES.includes(agentType)) return { block: false };
  if (parseSanctionedPullLine(command)) return { block: false };
  if (agentType === 'judge' && JUDGE_DECISION_CHECK_RE.test(command.trim()) && !command.includes('..')) return { block: false };
  if (READ_SEARCH_ROLES.has(agentType) && (isReadSearchCommand(command) || isReviewerContractCommand(command, TRUSTED_CLI_PATH))) return { block: false };
  return {
    block: true,
    reason:
      `Read-only role boundary (#2509): role "${agentType || '(unresolved role: fail closed)'}" may run only its dispatched ` +
      '`dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>` line' +
      (agentType === 'judge' ? ' or `dev-loops-run scripts/loop/check-judge-decision.mjs --file tmp/gate-judge/<path>.json`' : '') +
      (READ_SEARCH_ROLES.has(agentType) ?' and shell-inert reads, searches or contract-mandated read-only commands' : '') +
      '. Never run shell, test or build commands.',
  };
}

/**
 * True when a resolved role is read-only: a restricted roster role (`BASH_RESTRICTED_ROLES`) or an
 * unresolved role (`''`, the fail-closed row). The extension uses this to keep its mutation-capable
 * post-merge hooks inert in a read-only child session — the `tool_call` gate already denies such a
 * session any real merge, so the hooks have nothing legitimate to do there.
 */
export function isReadOnlyPiRole(agentType: string | null): boolean {
  return agentType === '' || (agentType !== null && BASH_RESTRICTED_ROLES.includes(agentType));
}
