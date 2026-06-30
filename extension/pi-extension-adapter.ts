import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createExtensionHarnessAdapter } from '@dev-loops/core/harness';

// Re-exported so the rest of the extension can name the Pi entry type without importing
// `@earendil-works/pi-*` directly — this module owns that import boundary.
export type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type {
  ExtensionHarnessAdapter,
  HarnessContext,
  HarnessCommandConfig,
  HarnessExecOptions,
  HarnessLifecycleEvent,
  HarnessLifecycleHandler,
} from './harness-types.ts';

/**
 * The single module allowed to import `@earendil-works/pi-*`.
 *
 * Wraps a Pi `ExtensionAPI` into the neutral `ExtensionHarnessAdapter` so the rest of
 * the extension talks only to the neutral seam. Pi's per-invocation `ExtensionContext`
 * is converted to a neutral `HarnessContext` at call time, so UI/cwd flow through
 * unchanged — preserving today's behavior exactly.
 */

export function toHarnessContext(ctx: Partial<ExtensionContext> | undefined): HarnessContext {
  const ui = ctx?.ui;
  const sender = (ctx as { sendUserMessage?: (message: string, options?: Record<string, unknown>) => unknown } | undefined)?.sendUserMessage;
  return {
    cwd: (ctx?.cwd as string) ?? process.cwd(),
    hasUI: Boolean(ctx?.hasUI),
    ui: {
      notify: (message, level = 'info') => ui?.notify?.(message, level),
      setWidget: (key, lines, options) => ui?.setWidget?.(key, lines as never, options as never),
      setStatus: (key, text) => ui?.setStatus?.(key, text as never),
    },
    sendUserMessage: sender ? (message, options) => sender.call(ctx, message, options) : undefined,
  };
}

export function createPiExtensionAdapter(pi: ExtensionAPI): ExtensionHarnessAdapter {
  // Route through the shared factory so the Pi adapter gets the same validation + freeze
  // guarantee as the Claude adapter (symmetric construction across harnesses).
  return createExtensionHarnessAdapter({
    async exec(command: string, options: HarnessExecOptions = {}) {
      return pi.exec('bash', ['-lc', command], {
        cwd: options.cwd,
        timeout: options.timeout,
      });
    },

    on(event: HarnessLifecycleEvent, handler: HarnessLifecycleHandler) {
      pi.on(event as never, (async (piEvent: unknown, piCtx: ExtensionContext) =>
        handler(piEvent, toHarnessContext(piCtx))) as never);
    },

    registerCommand(name: string, config: HarnessCommandConfig) {
      pi.registerCommand(name, {
        description: config.description,
        handler: (async (args: string | string[], piCtx: ExtensionContext) =>
          config.handler(args, toHarnessContext(piCtx))) as never,
      });
    },
  }) as ExtensionHarnessAdapter;
}
