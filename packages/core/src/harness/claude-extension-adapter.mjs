import { execFile } from "node:child_process";

import { createExtensionHarnessAdapter } from "./extension-adapter.mjs";

/**
 * Create the Claude Code extension-surface adapter.
 *
 * Implements the same `ExtensionHarnessAdapter` interface as the Pi adapter so
 * `executeDevLoopsCommand` and the extension wiring run unchanged under Claude.
 *
 * - `exec` shells out via `bash -lc` (Claude has no native exec API in core).
 * - lifecycle `on(...)` registrations are stored in `listeners` for hook-driven
 *   dispatch (wired in CA4 / #773); they are not auto-fired here.
 * - `registerCommand(...)` registrations are stored in `commands`.
 * - Claude core has no interactive widget/status surface, so the default
 *   `HarnessContext` reports `hasUI: false` and routes `ui` calls to a sink.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - Default cwd for exec and contexts (default: process.cwd()).
 * @param {NodeJS.ProcessEnv} [options.env] - Env for exec (default: process.env).
 * @param {(message: string, level: string) => void} [options.onNotify] - Optional sink for
 *   `ui.notify` (e.g. console). Defaults to a no-op.
 * @returns {import("./extension-adapter.mjs").ExtensionHarnessAdapter & {
 *   listeners: Map<string, Function>,
 *   commands: Map<string, import("./extension-adapter.mjs").HarnessCommandConfig>,
 *   makeContext: (overrides?: {cwd?: string}) => import("./extension-adapter.mjs").HarnessContext,
 * }}
 */
export function createClaudeExtensionAdapter({
  cwd = process.cwd(),
  env = process.env,
  onNotify = () => {},
} = {}) {
  const listeners = new Map();
  const commands = new Map();

  function exec(command, options = {}) {
    return new Promise((resolve) => {
      execFile(
        "bash",
        ["-lc", command],
        {
          cwd: options.cwd ?? cwd,
          env,
          timeout: options.timeout ?? 0,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            // Match the documented HarnessExecResult contract: `code` is undefined when
            // the process was killed (e.g. timeout), mirroring the Pi adapter's shape.
            const killed = Boolean(error.killed);
            resolve({
              code: killed ? undefined : (typeof error.code === "number" ? error.code : 1),
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              killed,
            });
            return;
          }
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "", killed: false });
        },
      );
    });
  }

  function makeContext({ cwd: ctxCwd } = {}) {
    return {
      cwd: ctxCwd ?? cwd,
      hasUI: false,
      ui: {
        notify(message, level = "info") {
          onNotify(message, level);
        },
        setWidget() {},
        setStatus() {},
      },
    };
  }

  const adapter = createExtensionHarnessAdapter({
    exec,
    on(event, handler) {
      listeners.set(event, handler);
    },
    registerCommand(name, config) {
      commands.set(name, config);
    },
  });

  return {
    exec: adapter.exec,
    on: adapter.on,
    registerCommand: adapter.registerCommand,
    listeners,
    commands,
    makeContext,
  };
}
