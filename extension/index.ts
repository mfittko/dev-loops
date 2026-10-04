import { executeDevLoopsCommand, inspectResultSeverity } from '../lib/dev-loops-core.mjs';
import { fileURLToPath } from 'node:url';
import { createExtensionCoreRuntime } from './checks.ts';
import { createPostMergeUpdateHook } from './post-merge-update.ts';
import { createPiExtensionAdapter, type ExtensionAPI } from './pi-extension-adapter.ts';
import {
  createChildRoleGateRegistrar,
  loadRegisterRequiredChildExtensions,
} from './required-child-extensions.ts';
import {
  buildEntrypointLines,
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
  /** Test seam: override the `pi-subagents` required-child-extension loader. */
  loadRegisterRequiredChildExtensions?: typeof loadRegisterRequiredChildExtensions;
};

const STATUS_KEY = 'dev-loops';
const WIDGET_KEY = 'dev-loops.setup';

// `syncPackagedAgents` remaps the harness-neutral `tools:` frontmatter to Pi
// builtins at session-start sync time (#1583); the pure transform + IO live in
// a dedicated module so they stay testable offline. Import for local use AND
// re-export so tests can reach the same binding the session_start handler calls.
import { syncPackagedAgents } from './sync-packaged-agents.ts';
export { syncPackagedAgents };
import { decidePiToolCall, resolvePiRole } from './readonly-role-gate.ts';

async function dispatchDevLoopIntent(ctx: { sendUserMessage?: (message: string) => unknown }, intent: string) {
  await ctx.sendUserMessage?.(`/skill:dev-loop ${intent}`);
}

export default function (pi: ExtensionAPI, runtimeOverrides: ExtensionRuntimeOverrides = {}) {
  // Wrap the Pi harness at the entry boundary; everything below talks to the neutral seam.
  const adapter = createPiExtensionAdapter(pi);
  const postMergeUpdateHook = runtimeOverrides.postMergeUpdateHook ?? createPostMergeUpdateHook({ exec: adapter.exec });
  // A foreground (`async: false`) child never loads ambient extensions, so the read-only
  // role gate stayed inert in dispatched judge/reviewer children. Register the extension
  // itself as a required child extension so every child loads it; see
  // skills/docs/cross-harness-regression-contract.md "Read-only role enforcement on Pi".
  const childRoleGate = createChildRoleGateRegistrar({
    // This module is the extension entry (`pi.extensions`), so its own URL is the path a
    // child must load to run the same `tool_call` handler.
    extensionPath: fileURLToPath(import.meta.url),
    load: runtimeOverrides.loadRegisterRequiredChildExtensions ?? loadRegisterRequiredChildExtensions,
  });

  adapter.on('session_start', async (_event, ctx) => {
    postMergeUpdateHook.onSessionStart();
    try {
      syncPackagedAgents({ projectRoot: ctx.cwd });
    } catch {
      // Best-effort agent sync — do not break session start
    }
    try {
      await childRoleGate.register(ctx.getSessionId?.());
    } catch {
      // Best-effort child-extension registration — never break session start
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  adapter.on('session_shutdown', () => {
    childRoleGate.disposeAll();
  });

  // Read-only role enforcement on Pi (cross-harness-regression-contract.md): block shell for
  // read-only roles; Pi honours `{ block, reason }` from `tool_call`.
  adapter.on('tool_call', (event, ctx) => {
    const { toolName, input } = event as { toolName?: string; input?: { command?: unknown } };
    return decidePiToolCall({ toolName, input, agentType: resolvePiRole({ systemPrompt: ctx?.getSystemPrompt?.() }) });
  });

  adapter.on('tool_result', async (event, ctx) => {
    await postMergeUpdateHook.onToolResult(event, ctx);
  });

  adapter.on('user_bash', async (event, ctx) => {
    return postMergeUpdateHook.onUserBash(event, ctx);
  });

  adapter.on('agent_end', async (event, ctx) => {
    await postMergeUpdateHook.onAgentEnd(event, ctx);
  });

  adapter.registerCommand('dev-loops', {
    description: 'Run a dev-loop entrypoint or manage readiness: /dev-loops [start <issue>|auto <issue>|continue [issue|pr]|start-spike <question>|info <issue|pr>|status|doctor|gates|hide|inspect ...]',
    handler: async (args, ctx) => {
      const result = await executeDevLoopsCommand({
        input: args,
        surface: 'extension',
        runtime: createExtensionCoreRuntime(adapter, runtimeOverrides),
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
        case 'entrypoint':
          ctx.ui.setWidget(WIDGET_KEY, buildEntrypointLines(result.action, result.intent), { placement: 'belowEditor' });
          await dispatchDevLoopIntent(ctx, result.intent);
          ctx.ui.notify(`dev-loops ${result.action}: ${result.intent}`, 'info');
          return;
        case 'start_spike':
          ctx.ui.setWidget(WIDGET_KEY, buildEntrypointLines('start-spike', result.intent), { placement: 'belowEditor' });
          await dispatchDevLoopIntent(ctx, result.intent);
          ctx.ui.notify(`dev-loops start-spike: ${result.intent}`, 'info');
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
          // Severity is shared with the CLI surface so both classify identically.
          const notificationLevel = inspectResultSeverity(result);
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
