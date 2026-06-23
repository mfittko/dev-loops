/**
 * Extension-surface harness adapter interface.
 *
 * Abstracts the *extension surface* that the dev-loops runtime uses today — process
 * execution, session lifecycle events, slash-command registration, and a UI surface —
 * so the extension is no longer bound directly to Pi's `ExtensionAPI`/`ExtensionContext`.
 *
 * This is distinct from the context seam in `./adapter.mjs` (cwd/env/repo-root): that one
 * answers "where/how am I running"; this one answers "how do I talk to the harness".
 *
 * Concrete adapters (Pi, Claude, test) implement this so call sites stay harness-agnostic.
 * Keep it minimal — add a method only when a real call site needs it.
 *
 * @typedef {Object} HarnessExecResult
 * @property {number} [code] - Process exit code (undefined when killed).
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {boolean} [killed] - Whether the process was killed (e.g. timeout).
 *
 * @typedef {Object} HarnessExecOptions
 * @property {string} [cwd]
 * @property {number} [timeout] - Timeout in milliseconds.
 *
 * @typedef {Object} HarnessUi
 * @property {(message: string, level?: 'info'|'warning'|'error') => void} notify
 * @property {(key: string, lines: string[]|undefined, options?: object) => void} setWidget
 * @property {(key: string, text: string|undefined) => void} setStatus
 *
 * @typedef {Object} HarnessContext
 * @property {string} cwd - Working directory for the current invocation.
 * @property {boolean} hasUI - Whether an interactive UI surface is attached.
 * @property {HarnessUi} ui - UI operations for this invocation.
 *
 * @typedef {'session_start'|'tool_result'|'user_bash'|'agent_end'} HarnessLifecycleEvent
 *
 * @typedef {Object} HarnessCommandConfig
 * @property {string} description
 * @property {(args: string|string[], ctx: HarnessContext) => unknown} handler
 *
 * @typedef {Object} ExtensionHarnessAdapter
 * @property {(command: string, options?: HarnessExecOptions) => Promise<HarnessExecResult>} exec
 * @property {(event: HarnessLifecycleEvent, handler: (event: any, ctx: HarnessContext) => unknown) => void} on
 * @property {(name: string, config: HarnessCommandConfig) => void} registerCommand
 */

const REQUIRED_METHODS = ["exec", "on", "registerCommand"];

/**
 * Validate and freeze an extension-surface harness-adapter implementation.
 *
 * @param {Partial<ExtensionHarnessAdapter>} impl
 * @returns {ExtensionHarnessAdapter}
 */
export function createExtensionHarnessAdapter(impl) {
  if (!impl || typeof impl !== "object") {
    throw new TypeError("createExtensionHarnessAdapter: impl must be an object");
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof impl[method] !== "function") {
      throw new TypeError(`createExtensionHarnessAdapter: missing required method "${method}"`);
    }
  }

  return Object.freeze({
    exec: impl.exec,
    on: impl.on,
    registerCommand: impl.registerCommand,
  });
}

/**
 * Type guard for extension-surface adapter values.
 *
 * @param {*} value
 * @returns {value is ExtensionHarnessAdapter}
 */
export function isExtensionHarnessAdapter(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return REQUIRED_METHODS.every((method) => typeof value[method] === "function");
}
