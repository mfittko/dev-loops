import { collectDevLoopChecks as collectSharedDevLoopChecks, DEV_LOOP_CHECK_IDS } from '../lib/dev-loops-core.mjs';
import { createInspectRunViewerLifecycleManager } from '../scripts/loop/inspect-run-viewer/managed-instance.mjs';
import type { ExtensionHarnessAdapter } from './harness-types.ts';

export type DevLoopCheckId = (typeof DEV_LOOP_CHECK_IDS)[number];

export type DevLoopCheck = {
  id: DevLoopCheckId;
  label: string;
  ok: boolean;
  detail: string;
};

async function commandExists(adapter: ExtensionHarnessAdapter, command: string): Promise<boolean> {
  try {
    const result = await adapter.exec(`command -v ${command} >/dev/null 2>&1`, { timeout: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function ghAuthOk(adapter: ExtensionHarnessAdapter): Promise<boolean> {
  try {
    const result = await adapter.exec('gh auth status >/dev/null 2>&1', { timeout: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function insideGitRepo(adapter: ExtensionHarnessAdapter): Promise<boolean> {
  try {
    const result = await adapter.exec('git rev-parse --is-inside-work-tree >/dev/null 2>&1', { timeout: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function getRepoRoot(adapter: ExtensionHarnessAdapter): Promise<string> {
  const result = await adapter.exec('git rev-parse --show-toplevel', { timeout: 10_000 });
  if (result.code !== 0) {
    throw new Error('Open this session inside a git repository before using `/dev-loops inspect`.');
  }
  const repoRoot = `${result.stdout ?? ''}`.trim();
  if (!repoRoot) {
    throw new Error('Could not determine the repository root for `/dev-loops inspect`.');
  }
  return repoRoot;
}

export function createExtensionCoreRuntime(
  adapter: ExtensionHarnessAdapter,
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
    commandExists: (command: string) => commandExists(adapter, command),
    ghAuthOk: () => ghAuthOk(adapter),
    insideGitRepo: () => insideGitRepo(adapter),
    getRepoRoot: () => (getRepoRootOverride ? getRepoRootOverride() : getRepoRoot(adapter)),
    uiLifecycle,
    async getSubagentAvailability() {
      const ok = await commandExists(adapter, 'subagent');
      return {
        ok,
        availableDetail: '`subagent` command is available.',
        unavailableDetail: 'Install or enable subagent support so `subagent` is available.',
      };
    },
  };
}

export async function collectDevLoopChecks(adapter: ExtensionHarnessAdapter): Promise<DevLoopCheck[]> {
  return collectSharedDevLoopChecks(createExtensionCoreRuntime(adapter));
}
