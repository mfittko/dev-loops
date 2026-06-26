// GENERATED from packages/core/src/loop/run-context.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Neutral run-id / async-context contract.
 *
 * The dev-loop async path keys off the harness-neutral `DEVLOOPS_RUN_ID` env var to
 * identify an inspectable per-subagent run (runner ownership, async-start enforcement,
 * human-comment gating), and provides a mint-and-propagate path for harnesses (e.g. Claude
 * Code) that inject no native per-subagent run id. The harness sets `DEVLOOPS_RUN_ID` when
 * dispatching an async subagent.
 *
 * This module is pure except for the explicit file/IO helpers (writeRunContext/readRunContext),
 * which take an injectable `fs` and `root` for testability.
 */

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";

/**
 * Env var names that carry the async-context run id, in resolution precedence order.
 * The neutral `DEVLOOPS_RUN_ID` is the sole marker.
 */
export const RUN_ID_MARKERS = Object.freeze(["DEVLOOPS_RUN_ID"]);

/** Neutral env var name used when minting/propagating a run id. */
export const NEUTRAL_RUN_ID_VAR = "DEVLOOPS_RUN_ID";

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
 * Resolve the active run id from the environment.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} The trimmed run id, or null when none is set.
 */
export function resolveRunId(env = process.env) {
  for (const marker of RUN_ID_MARKERS) {
    const value = env?.[marker];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
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
