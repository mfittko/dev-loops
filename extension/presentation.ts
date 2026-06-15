import type { DevLoopCheck, DevLoopCheckId } from './checks.ts';
import { describeReadiness, DEV_LOOP_CHECK_IDS, summarizeChecks, renderCheckLines } from '../lib/dev-loops-core.mjs';

export type DevLoopsAction = 'doctor' | 'help' | 'status' | 'hide';
export type InspectAction = 'open' | 'resume' | 'status' | 'stop' | 'restart';

const SETUP_GUIDANCE: Record<(typeof DEV_LOOP_CHECK_IDS)[number], string> = {
  'gh-installed': 'Install GitHub CLI to enable remote GitHub/Copilot workflows.',
  'gh-auth': 'Run `gh auth login` so remote GitHub/Copilot workflows can use your GitHub session.',
  'subagent-command': 'Install or enable subagent support so the `subagent` command is available.',
  'git-repo': 'Open Pi inside a git repository checkout before using the shared loops.',
};

function readinessLabel(ready: boolean): string {
  return ready ? 'ready' : 'needs setup';
}

function checkMap(checks: DevLoopCheck[]): Map<DevLoopCheckId, DevLoopCheck> {
  return new Map(checks.map((check) => [check.id, check]));
}

export function orderedSetupSteps(checks: DevLoopCheck[]): string[] {
  const byId = checkMap(checks);
  const uniqueSteps = [...new Set(DEV_LOOP_CHECK_IDS.filter((id) => byId.get(id)?.ok === false).map((id) => SETUP_GUIDANCE[id]))];
  const steps = uniqueSteps.map((step, index) => `${index + 1}. ${step}`);

  if (steps.length > 0) {
    return steps;
  }

  return [
    '1. Use `/skill:dev-loop` to start or continue a dev loop — the single public entry; routing handles the rest.',
    '2. Run `/dev-loops status` whenever you want a concise readiness snapshot.',
    '3. Use `pi install git:github.com/mfittko/dev-loops` to install the package, or `pi update git:github.com/mfittko/dev-loops` to refresh it.',
  ];
}

export function buildHelpLines(): string[] {
  return [
    'dev-loops help',
    'Workflow entry:',
    '- /skill:dev-loop — single public entrypoint; routing handles the rest',
    'Commands:',
    '- /dev-loops status',
    '- /dev-loops doctor',
    '- /dev-loops hide',
    '- /dev-loops inspect open [--repo <owner/name>]',
    '- /dev-loops inspect resume [--repo <owner/name>]',
    '- /dev-loops inspect status [--repo <owner/name>]',
    '- /dev-loops inspect stop [--repo <owner/name>]',
    '- /dev-loops inspect restart [--repo <owner/name>]',
    'Use `pi install git:github.com/mfittko/dev-loops` to install skills and agents; packaged agents sync into `~/.agents/` on session start.',
  ];
}

export function buildWidgetLines(action: Extract<DevLoopsAction, 'doctor' | 'status'>, checks: DevLoopCheck[]): string[] {
  const summary = summarizeChecks(checks);
  const readiness = describeReadiness(checks);
  const lines = [
    `dev-loops ${action}: ${summary.ok}/${summary.total} checks passed`,
    `Local loop readiness: ${readinessLabel(readiness.localReady)}`,
    `Remote GitHub/Copilot readiness: ${readinessLabel(readiness.remoteReady)}`,
  ];

  if (action === 'status') {
    return [
      ...lines,
      'Suggested next steps:',
      ...orderedSetupSteps(checks),
    ];
  }

  return [
    ...lines,
    ...renderCheckLines(checks),
    'Skills load via `pi install git:github.com/mfittko/dev-loops`; packaged agents sync into `~/.agents/` on session start.',
  ];
}

export function buildInspectLines(action: InspectAction, result: { state: string; url?: string | null; detail?: string | null; warning?: string | null; repo?: string | null }): string[] {
  const lines = [
    `inspect ${action}`,
    `State: ${result.state}`,
  ];
  if (result.repo) {
    lines.push(`Repo: ${result.repo}`);
  }
  if (result.url) {
    lines.push(`URL: ${result.url}`);
  }
  if (result.detail) {
    lines.push(`Detail: ${result.detail}`);
  }
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  return lines;
}

export function buildNotificationMessage(action: Extract<DevLoopsAction, 'doctor' | 'status'>, checks: DevLoopCheck[]): string {
  const summary = summarizeChecks(checks);
  return `dev-loops ${action}: ${summary.ok}/${summary.total} checks passed`;
}

export function buildInspectNotification(action: InspectAction, state: string): string {
  return `inspect ${action}: ${state}`;
}
