import { EXECUTION_IDENTITY_RE } from '@dev-loops/core/loop/work-order-digest';
import { NATIVE_PI_PARENT_SESSION_MARKER, isNativePiAsyncContext } from '@dev-loops/core/loop/run-context';

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
const CD_PREFIX_RE = /^cd (?:"[\w./-]+"|[\w./-]+) && /;
const GIT_C_RE = /^git -C (?:"[\w./-]+"|[\w./-]+) /;
// Flags that make an allowed program execute another program or write a file. Git accepts unique prefixes, so match prefixes.
const EXEC_FLAG_RE = /^(?:-[^-\s]*O|--op|--out|--ext|--tex)/;
const RG_PRE_RE = /^--pre(?:-glob)?(?:=|$)/;
const FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/;

type Word = { value: string; quoted: boolean };

// A word is fully unquoted, fully single-quoted or fully double-quoted. Returns null for anything else.
// An unquoted `|` alone is the pipe token. Double quotes may not hold `$`, a backtick, `\` or `!`.
function tokenize(command: string): Word[] | null {
  const words: Word[] = [];
  let i = 0;
  while (i < command.length) {
    if (/[ \t]/.test(command[i])) {
      i += 1;
      continue;
    }
    const quote = command[i] === "'" || command[i] === '"' ? command[i] : null;
    let value: string;
    if (quote) {
      const end = command.indexOf(quote, i + 1);
      if (end === -1) return null;
      value = command.slice(i + 1, end);
      if (/[\n\r]/.test(value) || (quote === '"' && /[$`\\!]/.test(value))) return null;
      i = end + 1;
      if (i < command.length && !/[ \t]/.test(command[i])) return null;
    } else {
      let end = i;
      while (end < command.length && !/[ \t]/.test(command[end])) end += 1;
      value = command.slice(i, end);
      if (value !== '|' && SHELL_ACTIVE_RE.test(value)) return null;
      i = end;
    }
    words.push({ value, quoted: quote !== null });
  }
  return words;
}

const CUT_RE = /^-c\d+-\d+$/;

function isReadSearchCommand(rawCommand: string): boolean {
  // Strip the mandated `cd <path> && ` and `git -C <path> ` forms first; their paths allow safe characters only.
  const command = rawCommand.trim().replace(CD_PREFIX_RE, '').replace(GIT_C_RE, 'git ');
  if (/[\n\r]/.test(command)) return false;
  if (REVIEWER_SCRIPT_RE.test(command) && !SHELL_ACTIVE_RE.test(command)) return true;
  const words = tokenize(command);
  if (!words) return false;
  const pipe = words.findIndex((w) => !w.quoted && w.value === '|');
  let readWords = words;
  if (pipe !== -1) {
    // One bounded pipe, to `cut -c<N>-<M>` only.
    const rest = words.slice(pipe + 1);
    if (rest.length !== 2 || rest.some((w) => w.quoted || w.value === '|')) return false;
    if (rest[0].value !== 'cut' || !CUT_RE.test(rest[1].value)) return false;
    readWords = words.slice(0, pipe);
  }
  if (readWords.length === 0 || readWords.some((w) => w.quoted && w.value.startsWith('-'))) return false;
  let tokens = readWords;
  const program = tokens[0];
  if (program.quoted) return false;
  if (program.value === 'git') {
    tokens = tokens.slice(1);
    if (!tokens[0] || tokens[0].quoted || !READ_GIT_SUBCOMMANDS.has(tokens[0].value)) return false;
  } else if (!READ_PROGRAMS.has(program.value)) {
    return false;
  }
  const args = tokens.slice(1).map((w) => w.value);
  if (args.some((t) => EXEC_FLAG_RE.test(t))) return false;
  if (program.value === 'rg' && args.some((t) => RG_PRE_RE.test(t) || /^--host/.test(t))) return false;
  if (program.value === 'file' && args.some((t) => /^-[^-\s]*C/.test(t) || /^--comp/.test(t))) return false;
  if (program.value === 'find' && args.some((t) => FIND_EXEC_RE.test(t))) return false;
  return true;
}
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
 * read and search commands for the reviewer). An unresolved role ('' from a blank tag, an
 * unknown dev-loops: name, conflicting tags or an untagged native async child session) fails
 * closed: it is treated as a restricted role that may pull only.
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
  if (agentType === 'judge' && JUDGE_DECISION_CHECK_RE.test(command.trim()) && !command.includes('..')) return { block: false };
  if (READ_SEARCH_ROLES.has(agentType) && isReadSearchCommand(command)) return { block: false };
  return {
    block: true,
    reason:
      `Read-only role boundary (#2509): role "${agentType || '(unresolved role: fail closed)'}" may run only its dispatched ` +
      '`dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>` line' +
      (READ_SEARCH_ROLES.has(agentType) ? ' and shell-inert read or search commands' : '') +
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
