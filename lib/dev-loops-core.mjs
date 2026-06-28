export const DEV_LOOP_CHECK_IDS = [
  'gh-installed',
  'gh-auth',
  'subagent-command',
  'git-repo',
];

const LOCAL_READINESS_IDS = ['subagent-command', 'git-repo'];
const REMOTE_READINESS_IDS = ['gh-installed', 'gh-auth', 'subagent-command', 'git-repo'];
const INSPECT_ACTIONS = new Set(['open', 'resume', 'status', 'stop', 'restart']);

// Direct dev-loop entrypoints (#972): thin named wrappers over the public dev-loop contract.
// Each maps `<verb> <issue|pr>` to the canonical public-intent shorthand the `dev-loop` skill
// already accepts — no new routing/strategy logic lives here. `start`/`auto` target an issue,
// `continue` targets a PR; `info` is the read-only state shortcut for an issue or PR.
const ENTRYPOINT_VERBS = {
  start: { target: 'issue', phrase: (n) => `start dev loop on issue ${n}` },
  auto: { target: 'issue', phrase: (n) => `auto dev loop on issue ${n}` },
  continue: { target: 'pr', phrase: (n) => `continue dev loop on PR ${n}` },
  info: { target: 'either', phrase: (n) => `inspect dev loop state on ${n}` },
};

const UNICODE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

function normalizeInput(input) {
  if (Array.isArray(input)) {
    return input
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .flatMap((part) => {
        const normalized = `${part}`.replace(UNICODE_SPACE_RE, ' ');
        return normalized.trim().split(/\s+/).filter(Boolean);
      });
  }

  // Normalize unusual whitespace (NBSP, Unicode spaces) to regular spaces before splitting
  return `${input ?? ''}`
    .replace(UNICODE_SPACE_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeProbe(probe, availableDetail, unavailableDetail) {
  if (typeof probe === 'boolean') {
    return {
      ok: probe,
      detail: probe ? availableDetail : unavailableDetail,
    };
  }

  const ok = probe?.ok === true;
  return {
    ok,
    detail: ok
      ? availableDetail ?? probe?.availableDetail
      : unavailableDetail ?? probe?.unavailableDetail,
  };
}

function invalidCommand(message, usageAction, tokens) {
  return {
    kind: 'malformed',
    message,
    usageAction,
    tokens,
  };
}

function parseInspectCommand(tokens, { surface }) {
  if (surface !== 'extension') {
    return invalidCommand('Unrecognized command: inspect.', undefined, tokens);
  }

  const [, rawAction, ...rawArgs] = tokens;
  const action = rawAction?.toLowerCase();
  if (!INSPECT_ACTIONS.has(action)) {
    return invalidCommand('`/dev-loops inspect` only supports: open, resume, status, stop, restart.', 'inspect', tokens);
  }

  let repo;
  while (rawArgs.length > 0) {
    const token = rawArgs.shift();
    if (token === '--repo') {
      const value = rawArgs.shift();
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        return invalidCommand('`--repo` requires `<owner/name>`.', 'inspect', tokens);
      }
      repo = value;
      continue;
    }
    return invalidCommand(`Unrecognized inspect argument: ${token}.`, 'inspect', tokens);
  }

  return {
    kind: 'inspect_action',
    action,
    repo,
    tokens,
  };
}

function parseEntrypointCommand(action, args, tokens) {
  const spec = ENTRYPOINT_VERBS[action];
  const positional = args.filter((a) => a !== undefined);
  if (positional.length !== 1) {
    const targetHint = spec.target === 'pr' ? '<pr>' : spec.target === 'either' ? '<issue|pr>' : '<issue>';
    return invalidCommand(`\`${action}\` requires exactly one ${targetHint} argument.`, action, tokens);
  }
  const number = String(positional[0]).replace(/^#/, '');
  if (!/^\d+$/.test(number)) {
    return invalidCommand(`\`${action}\` expects a numeric issue/PR, got: ${positional[0]}.`, action, tokens);
  }
  return {
    kind: 'entrypoint',
    action,
    target: spec.target,
    number,
    intent: spec.phrase(number),
    tokens,
  };
}

export function parseDevLoopsCommand(input, { surface = 'extension' } = {}) {
  const tokens = normalizeInput(input);
  const [rawAction, rawScope, ...rest] = tokens;
  const action = rawAction?.toLowerCase();
  const extensionSurface = surface === 'extension';

  if (action === 'inspect') {
    return parseInspectCommand(tokens, { surface });
  }

  if (action && Object.prototype.hasOwnProperty.call(ENTRYPOINT_VERBS, action)) {
    return parseEntrypointCommand(action, [rawScope, ...rest], tokens);
  }

  switch (action) {
    case undefined:
    case '':
    case 'help':
      return extensionSurface || (rest.length === 0 && rawScope === undefined)
        ? { kind: 'action', action: 'help', tokens }
        : invalidCommand('`help` does not accept additional arguments.', 'help', tokens);
    case 'status':
    case 'doctor':
    case 'gates':
      return extensionSurface || (rest.length === 0 && rawScope === undefined)
        ? { kind: 'action', action, tokens }
        : invalidCommand(`\`${action}\` does not accept additional arguments.`, action, tokens);
    case 'hide':
      if (!extensionSurface && (rest.length > 0 || rawScope !== undefined)) {
        return invalidCommand('`hide` does not accept additional arguments.', 'hide', tokens);
      }

      return extensionSurface
        ? { kind: 'action', action: 'hide', tokens }
        : {
            kind: 'unsupported',
            action: 'hide',
            message: '`dev-loops hide` is not supported outside the Pi extension; use `/dev-loops hide` inside Pi instead.',
            tokens,
          };
    default:
      return extensionSurface
        ? { kind: 'action', action: 'help', tokens }
        : invalidCommand(`Unrecognized command: ${rawAction}.`, undefined, tokens);
  }
}

export async function collectDevLoopChecks(runtime) {
  const [ghInstalled, ghAuthenticated, inGitRepo, subagentProbe] = await Promise.all([
    runtime.commandExists('gh'),
    runtime.ghAuthOk(),
    runtime.insideGitRepo(),
    runtime.getSubagentAvailability(),
  ]);

  const subagent = normalizeProbe(
    subagentProbe,
    '`subagent` command is available.',
    'Install or enable subagent support so `subagent` is available.',
  );

  return [
    {
      id: 'gh-installed',
      label: 'GitHub CLI installed',
      ok: ghInstalled,
      detail: ghInstalled ? '`gh` is available.' : 'Install GitHub CLI to use remote GitHub/Copilot loops.',
    },
    {
      id: 'gh-auth',
      label: 'GitHub CLI authenticated',
      ok: ghInstalled && ghAuthenticated,
      detail:
        ghInstalled && ghAuthenticated
          ? '`gh auth status` succeeded.'
          : ghInstalled
            ? 'Run `gh auth login` before using remote GitHub/Copilot loops.'
            : 'GitHub CLI is not installed yet.',
    },
    {
      id: 'subagent-command',
      label: 'Subagent command available',
      ok: subagent.ok,
      detail: subagent.detail,
    },
    {
      id: 'git-repo',
      label: 'Inside a git repository',
      ok: inGitRepo,
      detail: inGitRepo
        ? 'Current working directory is inside a git repo.'
        : 'Local and GitHub loops work best inside a git repository checkout.',
    },
  ];
}

export function summarizeChecks(checks) {
  return {
    ok: checks.filter((check) => check.ok).length,
    total: checks.length,
  };
}

export function renderCheckLines(checks) {
  return checks.flatMap((check) => {
    const marker = check.ok ? '✅' : '⚠️';
    return [`${marker} ${check.label}`, `   ${check.detail}`];
  });
}

function checkMap(checks) {
  return new Map(checks.map((check) => [check.id, check]));
}

export function describeReadiness(checks) {
  const byId = checkMap(checks);
  return {
    localReady: LOCAL_READINESS_IDS.every((id) => byId.get(id)?.ok),
    remoteReady: REMOTE_READINESS_IDS.every((id) => byId.get(id)?.ok),
  };
}

export async function executeDevLoopsCommand({ input, surface = 'extension', runtime, stdout }) {
  const parsed = parseDevLoopsCommand(input, { surface });

  if (parsed.kind === 'inspect_action') {
    if (surface !== 'extension' || typeof runtime?.uiLifecycle?.[parsed.action] !== 'function') {
      return {
        kind: 'unsupported',
        message: 'Inspect lifecycle commands are only available inside the Pi extension.',
        tokens: parsed.tokens,
      };
    }
    let repoRoot = null;
    try {
      repoRoot = await runtime.getRepoRoot();
    } catch (error) {
      return {
        kind: 'inspect_result',
        action: parsed.action,
        repo: parsed.repo ?? null,
        repoRoot: null,
        state: 'stopped',
        url: null,
        detail: error instanceof Error ? error.message : String(error),
        warning: null,
      };
    }
    try {
      const result = await runtime.uiLifecycle[parsed.action]({ repoRoot, repo: parsed.repo });
      return {
        kind: 'inspect_result',
        action: parsed.action,
        repo: parsed.repo ?? null,
        repoRoot,
        ...result,
      };
    } catch (error) {
      return {
        kind: 'inspect_result',
        action: parsed.action,
        repo: parsed.repo ?? null,
        repoRoot,
        state: 'stopped',
        url: null,
        detail: error instanceof Error ? error.message : String(error),
        warning: null,
      };
    }
  }

  if (parsed.kind === 'entrypoint') {
    // Thin wrapper: surface the canonical public intent so the user dispatches it through the
    // `dev-loop` skill (the single public router). No routing/strategy decision is made here.
    return {
      kind: 'entrypoint',
      action: parsed.action,
      target: parsed.target,
      number: parsed.number,
      intent: parsed.intent,
    };
  }

  if (parsed.kind !== 'action') {
    return parsed;
  }

  switch (parsed.action) {
    case 'help':
      return { kind: 'help' };
    case 'hide':
      return { kind: 'hide' };
    case 'status':
    case 'doctor': {
      const checks = await collectDevLoopChecks(runtime);
      return {
        kind: 'checks',
        action: parsed.action,
        checks,
      };
    }
    case 'gates': {
      const { run } = await import('../scripts/loop/print-gates.mjs');
      await run({ repoRoot: runtime.getRepoRoot ? await runtime.getRepoRoot() : process.cwd(), stdout });
      return { kind: 'gates' };
    }
    default:
      throw new Error(`Unhandled action: ${parsed.action}`);
  }
}
