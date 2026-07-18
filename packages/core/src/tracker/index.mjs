export { createTrackerAdapter, isTrackerAdapter, hasBoardCapability, REQUIRED_METHODS, BOARD_METHODS } from "./adapter.mjs";
export { createGithubTrackerAdapter } from "./github-adapter.mjs";
export { createNoopTrackerAdapter } from "./noop-adapter.mjs";

import { createGithubTrackerAdapter } from "./github-adapter.mjs";

/** Built-in provider registry — GitHub is the only baked-in provider in v1
 * (issue #1408); an external provider registers here post-1.0 (or a consumer
 * passes its own adapter directly, bypassing this registry entirely). */
const BUILTIN_PROVIDERS = Object.freeze({
  github: createGithubTrackerAdapter,
});

/**
 * Resolve the tracker adapter for the given effective dev-loop config.
 *
 * Config-driven with NO global/singleton state (#1408 design constraint): a
 * future multi-tracker or per-capability layer just calls this again with a
 * different scoped config, and it stays additive — this function never reads
 * outside its `config` argument.
 *
 * `config?.tracker?.provider` selects a provider FROM THE REGISTERED
 * `providers` map (default `"github"`, the only one registered out of the
 * box) — the registry is extensible, not built-in-only: a consumer passes
 * `{ providers: { ...builtins, jira: createJiraAdapter } }` to register an
 * external provider (post-1.0 consumer concern). An unknown provider (not in
 * whatever `providers` was actually passed) fails closed rather than
 * silently falling back to GitHub. `config?.tracker?.plugin` is reserved for
 * a consumer's own module-loading resolver in front of this — not
 * implemented in this pass (non-goal, #1408).
 *
 * @param {import("../config/config.mjs").DevLoopConfig|null|undefined} config
 * @param {{ env?: NodeJS.ProcessEnv, ghCommand?: string, providers?: Record<string, Function> }} [deps]
 * @returns {import("./adapter.mjs").TrackerAdapter}
 */
export function resolveTrackerAdapter(config, { env, ghCommand, providers = BUILTIN_PROVIDERS } = {}) {
  const provider = config?.tracker?.provider?.trim() || "github";
  const factory = providers[provider];
  if (typeof factory !== "function") {
    throw new Error(
      `Unknown tracker.provider "${provider}" — no adapter is registered for it. ` +
      `Registered: ${Object.keys(providers).join(", ")} ("github" is the built-in default; ` +
      `any others listed here were registered by the caller). ` +
      `An external provider is a post-1.0 consumer concern: register it by passing ` +
      `{ providers: { ...builtins, "${provider}": createYourAdapter } } to resolveTrackerAdapter ` +
      `(setting tracker.provider in .devloops alone does not register one).`,
    );
  }
  return factory({ ...(env !== undefined ? { env } : {}), ...(ghCommand !== undefined ? { ghCommand } : {}) });
}
