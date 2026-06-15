import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { executeDevLoopsCommand } from '../lib/dev-loops-core.mjs';
import { createExtensionCoreRuntime } from './checks.ts';
import { createPostMergeUpdateHook } from './post-merge-update.ts';
import {
  buildHelpLines,
  buildInspectLines,
  buildInspectNotification,
  buildNotificationMessage,
  buildWidgetLines,
  type DevLoopsAction,
  type InspectAction,
} from './presentation.ts';

type ExtensionRuntimeOverrides = NonNullable<Parameters<typeof createExtensionCoreRuntime>[1]> & {
  postMergeUpdateHook?: ReturnType<typeof createPostMergeUpdateHook>;
};

const STATUS_KEY = 'dev-loops';
const WIDGET_KEY = 'dev-loops.setup';
const PACKAGED_AGENTS_ROOT = new URL('../agents/', import.meta.url);

export function syncPackagedAgents({
  sourceRoot = fileURLToPath(PACKAGED_AGENTS_ROOT),
  targetRoot = path.join(os.homedir(), '.agents'),
} = {}) {
  if (!fs.existsSync(sourceRoot)) {
    return;
  }

  fs.mkdirSync(targetRoot, { recursive: true });

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.agent.md')) {
      continue;
    }

    fs.copyFileSync(path.join(sourceRoot, entry.name), path.join(targetRoot, entry.name));
  }
}

export default function (pi: ExtensionAPI, runtimeOverrides: ExtensionRuntimeOverrides = {}) {
  const postMergeUpdateHook = runtimeOverrides.postMergeUpdateHook ?? createPostMergeUpdateHook(pi);

  pi.on('session_start', async (_event, ctx) => {
    postMergeUpdateHook.onSessionStart();
    try {
      syncPackagedAgents();
    } catch {
      // Best-effort agent sync — do not break session start
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on('tool_result', async (event, ctx) => {
    await postMergeUpdateHook.onToolResult(event, ctx);
  });

  pi.on('user_bash', async (event, ctx) => {
    return postMergeUpdateHook.onUserBash(event, ctx);
  });

  pi.on('agent_end', async (event, ctx) => {
    await postMergeUpdateHook.onAgentEnd(event, ctx);
  });

  pi.registerCommand('dev-loops', {
    description: 'Manage dev-loops readiness and inspect-run local UI lifecycle: /dev-loops [help|status|doctor|gates|hide|inspect ...]',
    handler: async (args, ctx) => {
      const result = await executeDevLoopsCommand({
        input: args,
        surface: 'extension',
        runtime: createExtensionCoreRuntime(pi, runtimeOverrides),
      });

      switch (result.kind) {
        case 'hide':
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          ctx.ui.notify('dev-loops widget hidden', 'info');
          return;
        case 'help':
          ctx.ui.setWidget(WIDGET_KEY, buildHelpLines(), { placement: 'belowEditor' });
          ctx.ui.notify('dev-loops help', 'info');
          return;
        case 'checks':
          ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(result.action as Extract<DevLoopsAction, 'doctor' | 'status'>, result.checks), {
            placement: 'belowEditor',
          });
          ctx.ui.notify(buildNotificationMessage(result.action as Extract<DevLoopsAction, 'doctor' | 'status'>, result.checks), 'info');
          return;
        case 'gates':
          ctx.ui.notify('Gate angles printed to console. Run `dev-loops gates` in a terminal to see review prompts.', 'info');
          return;
        case 'inspect_result': {
          const structuredStoppedSuccess = result.state === 'stopped'
            && result.record === null
            && (result.action === 'stop' || result.action === 'status');
          const fallbackStoppedSuccess = result.state === 'stopped'
            && ((result.action === 'stop' && /stopped the managed inspect-run viewer/i.test(result.detail ?? ''))
              || (result.action === 'status' && /no managed inspect-run viewer is recorded/i.test(result.detail ?? '')));
          const informationalStopped = structuredStoppedSuccess || fallbackStoppedSuccess;
          const notificationLevel = informationalStopped || result.state === 'running' ? 'info' : 'error';
          ctx.ui.setWidget(WIDGET_KEY, buildInspectLines(result.action as InspectAction, result), {
            placement: 'belowEditor',
          });
          ctx.ui.notify(buildInspectNotification(result.action as InspectAction, result.state), notificationLevel);
          return;
        }
        case 'malformed':
          ctx.ui.setWidget(WIDGET_KEY, [result.message, ...buildHelpLines()], { placement: 'belowEditor' });
          ctx.ui.notify(`dev-loops ${result.usageAction ?? 'help'}: invalid arguments`, 'error');
          return;
        case 'unsupported': {
          const message = result.message || 'This command is not supported here.';
          ctx.ui.setWidget(WIDGET_KEY, [message, ...buildHelpLines()], { placement: 'belowEditor' });
          ctx.ui.notify(message, 'error');
          return;
        }
        default: {
          const exhaustiveCheck: never = result;
          throw new Error(`Unhandled extension result: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    },
  });
}
