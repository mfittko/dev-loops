// Render CLI invocations in emitted text (work orders, agentRemedy, refusals) for the active
// harness (ADR 0118). Under Claude Code the bare `dev-loops <ns> <sub>` form is
// denied by the auto-mode classifier, while `dev-loops-run ...` matches the `Bash(dev-loops-run:*)`
// allow rule. Pi and Codex text stays byte-identical.
import { rewriteWrapperInvocation } from "../claude/asset-generation.mjs";
import { isClaudeHarness } from "./run-context.mjs";

/**
 * @param {string} text Emitted text that names `dev-loops <ns> <sub>` calls.
 * @param {{env?: Record<string, string|undefined>, root?: string}} [options] `root` is the checkout the agent passes to `--repo-root`.
 * @returns {string}
 */
export function renderCliText(text, { env = process.env, root = "<checkout>" } = {}) {
  return isClaudeHarness(env)
    ? rewriteWrapperInvocation(text, `dev-loops-run --repo-root ${root}`)
    : String(text);
}

/** An `Error` whose message names CLI calls in the active harness's launcher form. */
export const cliError = (message) => new Error(renderCliText(message));
