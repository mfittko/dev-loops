/**
 * Neutral, harness-agnostic types for the extension surface.
 *
 * These mirror the JSDoc typedefs in
 * `packages/core/src/harness/extension-adapter.mjs` so the `.ts` extension modules
 * can share a single import-free type vocabulary. No `@earendil-works/pi-*` import
 * lives here — that boundary is owned solely by `./pi-extension-adapter.ts`.
 */

export type HarnessExecResult = {
  code?: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
};

export type HarnessExecOptions = {
  cwd?: string;
  timeout?: number;
};

export type HarnessUi = {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  setWidget(key: string, lines: string[] | undefined, options?: Record<string, unknown>): void;
  setStatus(key: string, text: string | undefined): void;
};

export type HarnessContext = {
  cwd: string;
  hasUI: boolean;
  ui: HarnessUi;
  sendUserMessage?: (message: string, options?: Record<string, unknown>) => unknown;
};

export type HarnessLifecycleEvent = 'session_start' | 'tool_result' | 'user_bash' | 'agent_end';

export type HarnessCommandConfig = {
  description: string;
  handler: (args: string | string[], ctx: HarnessContext) => unknown;
};

export type HarnessLifecycleHandler = (event: unknown, ctx: HarnessContext) => unknown;

export type ExtensionHarnessAdapter = {
  exec(command: string, options?: HarnessExecOptions): Promise<HarnessExecResult>;
  on(event: HarnessLifecycleEvent, handler: HarnessLifecycleHandler): void;
  registerCommand(name: string, config: HarnessCommandConfig): void;
};
