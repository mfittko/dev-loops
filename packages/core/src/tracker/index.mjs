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
 * `config?.tracker?.provider` selects a built-in provider (default
 * `"github"`); an unknown provider fails closed rather than silently falling
 * back to GitHub. External providers are a post-1.0 consumer concern:
 * `config?.tracker?.plugin` is reserved for that (a module specifier a
 * consumer's own resolver loads and passes here as `deps.providers`) — not
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
      `resolveTrackerAdapter: unknown tracker provider "${provider}" (known: ${Object.keys(providers).join(", ")}). ` +
      `External providers are registered by passing { providers } to resolveTrackerAdapter, not via config alone.`,
    );
  }
  return factory({ ...(env !== undefined ? { env } : {}), ...(ghCommand !== undefined ? { ghCommand } : {}) });
}
