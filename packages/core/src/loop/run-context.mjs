/**
 * Neutral run-id / async-context contract.
 *
 * The dev-loop async path keys off the harness-neutral `DEVLOOPS_RUN_ID` env var to
 * identify an inspectable per-subagent run (runner ownership, async-start enforcement,
 * human-comment gating), and provides a mint-and-propagate path for harnesses (e.g. Claude
 * Code) that inject no native per-subagent run id. For those harnesses dev-loops itself mints
 * and sets `DEVLOOPS_RUN_ID` when dispatching an async subagent.
 *
 * Other harnesses may already inject their own run-id var: pi-subagents <= 0.64 injected
 * `PI_SUBAGENT_RUN_ID` (not `DEVLOOPS_RUN_ID`) into each async subagent's child env, so that
 * name is honored as a recognized legacy run-id alias (precedence after the neutral primary).
 * It is an externally-injected Pi-runtime contract var, not a dev-loops-owned var — dev-loops
 * still mints/propagates only the neutral `DEVLOOPS_RUN_ID`.
 *
 * pi-subagents 0.65 moved children to native in-process Pi `AgentSession`s and dropped the
 * `PI_`-prefixed subprocess-env block entirely, so that legacy alias is no longer injected.
 * The native async runner instead marks a child with `PI_SUBAGENT_CHILD=1` plus a non-empty
 * `PI_SUBAGENT_PARENT_SESSION` (see `NATIVE_PI_ASYNC_MARKERS`). Those markers carry no run id,
 * so `resolveRunId` synthesizes a stable one from the parent session rather than returning
 * null and degrading every run-id consumer (runner ownership, checkpoint verdicts).
 *
 * This module is pure except for the explicit file/IO helpers (writeRunContext/readRunContext),
 * which take an injectable `fs` and `root` for testability.
 */

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";

/**
 * Env var names that carry the async-context run id, in resolution precedence order.
 * The neutral `DEVLOOPS_RUN_ID` is primary; `PI_SUBAGENT_RUN_ID` is the legacy alias
 * pi-subagents <= 0.64 injected into async-subagent child envs. pi-subagents >= 0.65 no
 * longer injects it — see `NATIVE_PI_ASYNC_MARKERS` for the markers that replaced it.
 * These are run-id *carriers* only; the native markers below carry no id and are deliberately
 * kept out of this list so `resolveRunId` never returns a flag value like `"1"`.
 */
export const RUN_ID_MARKERS = Object.freeze(["DEVLOOPS_RUN_ID", "PI_SUBAGENT_RUN_ID"]);

/** Neutral env var name used when minting/propagating a run id. */
export const NEUTRAL_RUN_ID_VAR = "DEVLOOPS_RUN_ID";

/**
 * Native Pi async-runner markers (pi-subagents >= 0.65), which carry no run id.
 *
 * The child flag plus a non-empty parent session id are the async-start evidence; the runner
 * marker is set on the detached runner env and corroborates, but is never sufficient alone.
 */
export const NATIVE_PI_CHILD_MARKER = "PI_SUBAGENT_CHILD";
export const NATIVE_PI_PARENT_SESSION_MARKER = "PI_SUBAGENT_PARENT_SESSION";
export const NATIVE_PI_RUNNER_MARKER = "PI_ASYNC_NATIVE_RUNNER";

/** Native Pi async-runner markers, in the order the async-start contract documents them. */
export const NATIVE_PI_ASYNC_MARKERS = Object.freeze([
  NATIVE_PI_CHILD_MARKER,
  NATIVE_PI_PARENT_SESSION_MARKER,
  NATIVE_PI_RUNNER_MARKER,
]);

/**
 * Every env marker that evidences a harness-managed async context — the run-id carriers first,
 * then the native Pi markers that carry no run id. Consumers that must build a deliberately
 * async-signal-free env (test helpers) strip this whole set by name.
 */
export const ASYNC_CONTEXT_ENV_MARKERS = Object.freeze([
  ...RUN_ID_MARKERS,
  ...NATIVE_PI_ASYNC_MARKERS,
]);

/** State-file name (under `.pi/`, consistent with existing dev-loop checkpoint files). */
export const RUN_CONTEXT_FILENAME = "dev-loop-run-context.json";

/**
 * Env var Claude Code sets in every tool/subagent shell it spawns.
 * Used as the harness signal — see `isClaudeHarness`.
 */
export const CLAUDE_HARNESS_MARKER = "CLAUDECODE";

/**
 * True when running under the Claude Code harness.
 *
 * Claude Code sets `CLAUDECODE=1` in the environment of every Bash tool and
 * subagent it spawns. This is the harness-detection seam used to relax
 * Pi-specific runtime contracts (e.g. the async-start contract) that do not
 * apply to Claude's execution model.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isClaudeHarness(env = process.env) {
  return env?.[CLAUDE_HARNESS_MARKER] === "1";
}

/**
 * True when the env carries the native Pi async-runner child markers (pi-subagents >= 0.65).
 *
 * Both the child flag and a non-empty parent-session id are required: the child flag is set
 * in-process by the background async runner, and the parent session id is what makes the run
 * inspectable. `NATIVE_PI_RUNNER_MARKER` is deliberately not required — it appears only on the
 * detached runner env, so requiring it would fail closed for other native children.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isNativePiAsyncContext(env = process.env) {
  if (env?.[NATIVE_PI_CHILD_MARKER] !== "1") return false;
  const parentSession = env?.[NATIVE_PI_PARENT_SESSION_MARKER];
  return typeof parentSession === "string" && parentSession.trim().length > 0;
}

/**
 * Synthesize a stable run id for a native Pi async context.
 *
 * Same parent session -> same id, so run-id consumers key on one stable identity for the whole
 * session. The `pi-session-` prefix keeps a synthesized id distinguishable from a real
 * pi-subagents run id and from a dev-loops-minted `devloops-<uuid>`.
 *
 * Known ceiling, deliberately not fixed here: the id is derived from the parent session alone,
 * so concurrent sibling native Pi children of one parent session share ONE run id. Runner
 * coordination treats an equal run id as an authorized refresh rather than a conflict, so the
 * one-runner-per-PR lease degrades from "conflict" to "refresh" between such siblings. This
 * is still strictly stronger than the pre-fix Pi state, where `resolveRunId` returned null and
 * the lease did not engage at all, and the stability is what the async-start contract requires.
 * Discriminating siblings needs a per-child identity the native runner does not currently
 * inject; sourcing the run id from a dev-loops-owned surface instead of a harness env var is
 * the decoupling follow-up tracked separately.
 *
 * @param {string} parentSessionId
 * @returns {string} `pi-session-<parent-session-id>`
 */
export function synthesizePiRunId(parentSessionId) {
  return `pi-session-${parentSessionId.trim()}`;
}

/**
 * Resolve the active run id from the environment.
 *
 * A run-id carrier wins when present. With none present, a native Pi async context synthesizes
 * a stable id from its parent session instead of returning null.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} The trimmed run id, or null when no async context is present.
 */
export function resolveRunId(env = process.env) {
  for (const marker of RUN_ID_MARKERS) {
    const value = env?.[marker];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  if (isNativePiAsyncContext(env)) {
    return synthesizePiRunId(env[NATIVE_PI_PARENT_SESSION_MARKER]);
  }
  return null;
}

/**
 * Mint a fresh neutral run id.
 *
 * @returns {string} `devloops-<uuid>` (e.g. "devloops-3f2c1e84-...-9a0b")
 */
export function mintRunId() {
  return `devloops-${crypto.randomUUID()}`;
}

/**
 * Build the env fragment that propagates a run id to child processes.
 *
 * Sets the neutral var; child Bash scripts observe it via `resolveRunId`. Callers merge
 * this into the child env (e.g. `{ ...process.env, ...runContextEnv(runId) }`).
 *
 * @param {string} runId
 * @returns {{ DEVLOOPS_RUN_ID: string }}
 */
export function runContextEnv(runId) {
  return { [NEUTRAL_RUN_ID_VAR]: runId };
}

/**
 * Absolute path to the run-context state file for a repo root.
 *
 * @param {string} root - Repository root (or any base dir).
 * @returns {string}
 */
export function runContextPath(root) {
  return path.join(root, ".pi", RUN_CONTEXT_FILENAME);
}

/**
 * Persist the run-context state file (for inspection/recovery).
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {string} params.root
 * @param {string} [params.mintedAt] - ISO timestamp; defaults to now. Tests pass a fixed
 *   value for determinism; real runs get a useful inspection/recovery timestamp.
 * @param {typeof import("node:fs")} [params.fs]
 * @returns {string} The path written.
 */
export function writeRunContext({ runId, root, mintedAt, fs = fsDefault }) {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new TypeError("writeRunContext: runId must be a non-empty string");
  }
  const file = runContextPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    runId: runId.trim(),
    mintedAt: mintedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Read the run-context state file, or null when absent/unparseable.
 *
 * @param {object} params
 * @param {string} params.root
 * @param {typeof import("node:fs")} [params.fs]
 * @returns {{ runId: string, mintedAt: string|null }|null}
 */
export function readRunContext({ root, fs = fsDefault }) {
  const file = runContextPath(root);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.runId === "string" && parsed.runId.trim().length > 0) {
      return { runId: parsed.runId.trim(), mintedAt: parsed.mintedAt ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the active run id, or mint one and persist a run-context state file.
 *
 * This is the "mint at startup and propagate" primitive a Claude dev-loop agent (or a
 * headless entry) calls before dispatching child work. When the env already carries a
 * `DEVLOOPS_RUN_ID`, it is reused and no new id is minted.
 *
 * @param {object} [params]
 * @param {Record<string, string|undefined>} [params.env]
 * @param {string} [params.root]
 * @param {string} [params.mintedAt] - ISO timestamp for the state file (determinism).
 * @param {typeof import("node:fs")} [params.fs]
 * @returns {{ runId: string, minted: boolean, statePath: string|null }}
 */
export function ensureRunId({ env = process.env, root, mintedAt, fs = fsDefault } = {}) {
  const existing = resolveRunId(env);
  if (existing) {
    return { runId: existing, minted: false, statePath: null };
  }
  const runId = mintRunId();
  let statePath = null;
  if (typeof root === "string" && root.length > 0) {
    statePath = writeRunContext({ runId, root, mintedAt, fs });
  }
  return { runId, minted: true, statePath };
}
