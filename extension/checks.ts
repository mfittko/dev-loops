import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { collectDevLoopChecks as collectSharedDevLoopChecks, DEV_LOOP_CHECK_IDS } from '../lib/dev-loops-core.mjs';
import { createInspectRunViewerLifecycleManager } from '../scripts/loop/inspect-run-viewer/managed-instance.mjs';

export type DevLoopCheckId = (typeof DEV_LOOP_CHECK_IDS)[number];

export type DevLoopCheck = {
  id: DevLoopCheckId;
  label: string;
  ok: boolean;
  detail: string;
};

async function commandExists(pi: ExtensionAPI, command: string): Promise<boolean> {
  try {
    const result = await pi.exec('bash', ['-lc', `command -v ${command} >/dev/null 2>&1`], {
      timeout: 5_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function ghAuthOk(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec('bash', ['-lc', 'gh auth status >/dev/null 2>&1'], {
      timeout: 10_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function insideGitRepo(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec(
      'bash',
      ['-lc', 'git rev-parse --is-inside-work-tree >/dev/null 2>&1'],
      { timeout: 5_000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

async function getRepoRoot(pi: ExtensionAPI): Promise<string> {
  const result = await pi.exec('bash', ['-lc', 'git rev-parse --show-toplevel'], {
    timeout: 10_000,
  });
  if (result.code !== 0) {
    throw new Error('Open Pi inside a git repository before using `/dev-loops inspect`.');
  }
  const repoRoot = `${result.stdout ?? ''}`.trim();
  if (!repoRoot) {
    throw new Error('Could not determine the repository root for `/dev-loops inspect`.');
  }
  return repoRoot;
}

export function createExtensionCoreRuntime(
  pi: ExtensionAPI,
  {
    uiLifecycle = createInspectRunViewerLifecycleManager(),
    getRepoRoot: getRepoRootOverride,
  }: {
    uiLifecycle?: ReturnType<typeof createInspectRunViewerLifecycleManager>;
    getRepoRoot?: () => Promise<string>;
  } = {},
) {
  return {
    surface: 'extension' as const,
    commandExists: (command: string) => commandExists(pi, command),
    ghAuthOk: () => ghAuthOk(pi),
    insideGitRepo: () => insideGitRepo(pi),
    getRepoRoot: () => (getRepoRootOverride ? getRepoRootOverride() : getRepoRoot(pi)),
    uiLifecycle,
    async getSubagentAvailability() {
      const ok = await commandExists(pi, 'subagent');
      return {
        ok,
        availableDetail: '`subagent` command is available.',
        unavailableDetail: 'Install or enable subagent support so `subagent` is available.',
      };
    },
  };
}

export async function collectDevLoopChecks(pi: ExtensionAPI): Promise<DevLoopCheck[]> {
  return collectSharedDevLoopChecks(createExtensionCoreRuntime(pi));
}
