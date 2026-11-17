// Render CLI invocations in emitted text (work orders, agentRemedy, refusals) for the active
// harness (ADR 0118). Under Claude Code the bare `dev-loops <ns> <sub>` form is
// denied by the auto-mode classifier, while `dev-loops-run ...` matches the `Bash(dev-loops-run:*)`
// allow rule. Pi and Codex text stays byte-identical.
import { rewriteWrapperInvocation } from "../claude/asset-generation.mjs";
import { isClaudeHarness } from "./run-context.mjs";

/**
 * @param {string} text Emitted text that names `dev-loops <ns> <sub>` calls.
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {string}
 */
export function renderCliText(text, { env = process.env } = {}) {
  return isClaudeHarness(env)
    ? rewriteWrapperInvocation(String(text).split("node <dev-loops-package-root>/cli/index.mjs").join("dev-loops-run --repo-root <checkout> cli/index.mjs"), "dev-loops-run --repo-root <checkout>")
    : String(text);
}

/** An `Error` whose message names CLI calls in the active harness's launcher form. */
export const cliError = (message, options) => new Error(renderCliText(message, options));
