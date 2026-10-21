/**
 * Neutral run-id / async-context contract.
 *
 * The dev-loop async path keys off the harness-neutral `DEVLOOPS_RUN_ID` env var to
 * identify an inspectable per-subagent run (runner ownership, async-start enforcement,
 * human-comment gating), and provides a mint-and-propagate path only on the dispatch surfaces
 * that can carry an env — e.g. the Claude Code harness, where dev-loops itself mints and sets
 * `DEVLOOPS_RUN_ID` when it spawns the async subagent. The Pi `subagent` tool exposes no env
 * parameter, so dev-loops cannot inject a run id into a Pi child; a Pi native child's id is
 * synthesized from `PI_SESSION_ID` instead (see below).
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
 * so `resolveRunId` synthesizes a stable one from the child's `PI_SESSION_ID` when available,
 * falling back to the parent session when it is absent (same parent session -> same id),
 * rather than returning null and degrading run-id consumers (runner ownership, checkpoint verdicts).
 *
 * Native Codex context uses bounded first-record metadata IO via resolveNativeCodexContext;
 * CODEX_THREAD_ID is only a lookup key. Pi/Claude retain their existing marker precedence.
 */

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";
import os from "node:os";

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

/**
 * Pi's per-child session id. Deliberately NOT an async-context signal: the Pi runtime injects
 * it into every Pi shell's env, the main agent's included, so on its own it proves nothing
 * about being an async child. Inside a native async child it is what distinguishes sibling
 * children of one parent session, so it is the preferred source for the synthesized run id
 * and is kept out of `NATIVE_PI_ASYNC_MARKERS` on purpose.
 */
export const NATIVE_PI_SESSION_MARKER = "PI_SESSION_ID";

/** Native Pi async-runner markers, in the order the async-start contract documents them. */
export const NATIVE_PI_ASYNC_MARKERS = Object.freeze([
  NATIVE_PI_CHILD_MARKER,
  NATIVE_PI_PARENT_SESSION_MARKER,
  NATIVE_PI_RUNNER_MARKER,
]);

/**
 * Context carriers and lookup keys to strip for an isolated environment. CODEX_THREAD_ID
 * alone is not evidence; native Codex metadata must corroborate it.
 */
export const ASYNC_CONTEXT_ENV_MARKERS = Object.freeze([
  ...RUN_ID_MARKERS,
  ...NATIVE_PI_ASYNC_MARKERS,
  "CODEX_THREAD_ID",
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

/** Resolve the active CLI harness without choosing a model for it. */
export function resolveRuntimeHarness(env = process.env) {
  if (isClaudeHarness(env)) return "claude";
  if (typeof env?.CODEX_THREAD_ID === "string" && env.CODEX_THREAD_ID.trim()) return "codex";
  return "pi";
}

/** Current native session header compatibility bridge; never returns instructions or history. */
export function validateNativeCodexMetadata(header, threadId) {
  const payload = header?.payload;
  const spawn = payload?.source?.subagent?.thread_spawn;
  const parent = payload?.parent_thread_id;
  if (typeof threadId !== "string" || !threadId || header?.type !== "session_meta" || payload?.id !== threadId ||
      typeof parent !== "string" || !parent.trim() || parent.trim() === threadId ||
      spawn?.parent_thread_id !== parent || !Number.isSafeInteger(spawn?.depth) || spawn.depth < 1 ||
      !(spawn.agent_role === null || typeof spawn.agent_role === "string") ||
      !(spawn.agent_path === null || typeof spawn.agent_path === "string")) {
    return { status: "rejected", reason: "Unsupported or mismatched native Codex child metadata (id, parent, source or depth)." };
  }
  return { status: "valid", reason: "Verified native Codex thread_spawn child.",
    threadId, runId: `codex-thread-${threadId}`, parentThreadId: parent, depth: spawn.depth,
    agentPath: spawn.agent_path, agentRole: spawn.agent_role };
}

/** UUIDv7 lookup-key shape shared by discovery and the identity reader. */
export const NATIVE_CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Bounded discovery of the single native Codex rollout journal for one thread id.
 *
 * Shared by the header-only identity reader (`resolveNativeCodexContext`) and the
 * terminal-evidence adapter (`codex-execution-evidence`), so both resolve the SAME
 * single journal file. Discovery only lists the date-partitioned directories; it
 * reads no journal bytes. Finite UUIDv7-date discovery, no recursive history scan,
 * no cache and no global scan.
 *
 * @returns {{ status: "found", path: string } | { status: "rejected", reason: string }}
 */
export function findNativeCodexSessionJournal({ threadId, env = process.env, fs = fsDefault } = {}) {
  const reject = (reason) => ({ status: "rejected", reason });
  if (typeof threadId !== "string" || !NATIVE_CODEX_THREAD_ID_PATTERN.test(threadId)) {
    return reject("Native Codex discovery requires a supported UUIDv7 thread id lookup key.");
  }
  const home = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, ".codex") : path.join(os.homedir(), ".codex"));
  const createdAt = Number.parseInt(threadId.slice(0, 13).replaceAll("-", ""), 16);
  const matches = [];
  try {
    // Native filenames use local dates; adjacent UTC dates cover that boundary.
    for (const offset of [-1, 0, 1]) {
      const date = new Date(createdAt + offset * 86400000).toISOString().slice(0, 10);
      const directory = path.join(home, "sessions", ...date.split("-"));
      let dir;
      try { dir = fs.opendirSync(directory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      try {
        let entry;
        let count = 0;
        while ((entry = dir.readSync()) !== null) {
          if (++count > 4096) return reject("Native Codex discovery directory exceeds entry bound.");
          if (entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) {
            if (!entry.isFile()) return reject("Native Codex metadata is not a regular file.");
            matches.push(path.join(directory, entry.name));
            if (matches.length > 1) return reject("Native Codex metadata is ambiguous.");
          }
        }
      } finally { dir.closeSync(); }
    }
  } catch {
    return reject("Native Codex journal discovery is unreadable or malformed.");
  }
  if (matches.length !== 1) return reject("Native Codex session metadata not found.");
  return { status: "found", path: matches[0] };
}

/** Finite UUIDv7-date discovery and first-record-only IO; no recursive history scan or cache. */
export function resolveNativeCodexContext({ env = process.env, fs = fsDefault } = {}) {
  const reject = (reason) => ({ status: "rejected", reason });
  const threadId = env?.CODEX_THREAD_ID;
  if (env?.DEVLOOPS_DETACHED === "1") return reject("Detached execution is not a native Codex async child.");
  if (typeof threadId !== "string" || !NATIVE_CODEX_THREAD_ID_PATTERN.test(threadId)) {
    return reject("Native Codex context requires a supported UUIDv7 CODEX_THREAD_ID lookup key.");
  }
  const discovery = findNativeCodexSessionJournal({ threadId, env, fs });
  if (discovery.status !== "found") return reject(discovery.reason);
  try {
    const fd = fs.openSync(discovery.path, "r");
    try {
      if (!fs.fstatSync(fd).isFile()) return reject("Native Codex metadata is not a regular file.");
      const header = Buffer.alloc(128 * 1024);
      // Read exactly through the first newline, without reading any transcript bytes.
      for (let length = 0; length < header.length; length++) {
        if (fs.readSync(fd, header, length, 1, null) !== 1) return reject("Native Codex metadata header is incomplete.");
        if (header[length] === 10) return validateNativeCodexMetadata(JSON.parse(header.subarray(0, length).toString("utf8")), threadId);
      }
      return reject("Native Codex metadata header exceeds byte bound.");
    } finally { fs.closeSync(fd); }
  } catch {
    return reject("Native Codex metadata is unreadable or malformed.");
  }
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
 * Prefers the child's own session id so two sibling children of one parent session get distinct
 * ids; runner coordination accepts an equal run id as an authorized refresh rather than a
 * conflict, so a shared id would degrade the one-runner-per-PR lease. Falls back to the parent
 * session id when the child session id is absent, which keeps the id stable per parent session
 * (same parent session -> same id) rather than returning null.
 *
 * The `pi-session-` prefix keeps a synthesized id distinguishable from a real pi-subagents run
 * id and from a dev-loops-minted `devloops-<uuid>`.
 *
 * @param {string} sessionId - The child's own session id, else the parent session id.
 * @returns {string} `pi-session-<session-id>`
 */
export function synthesizePiRunId(sessionId) {
  return `pi-session-${sessionId.trim()}`;
}

/**
 * The trimmed per-child Pi session id, or null when absent/blank.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
function resolveNativePiChildSessionId(env) {
  const value = env?.[NATIVE_PI_SESSION_MARKER];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the active run id; native Codex performs bounded metadata IO.
 *
 * Verified native Codex identity takes precedence over inherited carriers and fails closed.
 * Outside Codex, a run-id carrier wins when present. With none present, a native Pi async context synthesizes
 * a stable id: the child's own session id when available, else the parent session id. No
 * async context at all still returns null.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} The trimmed run id, or null when no async context is present.
 */
export function resolveRunId(env = process.env) {
  if (resolveRuntimeHarness(env) === "codex") {
    const native = resolveNativeCodexContext({ env });
    return native.status === "valid" ? native.runId : null;
  }
  for (const marker of RUN_ID_MARKERS) {
    const value = env?.[marker];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  if (isNativePiAsyncContext(env)) {
    const childSessionId = resolveNativePiChildSessionId(env);
    return synthesizePiRunId(childSessionId ?? env[NATIVE_PI_PARENT_SESSION_MARKER]);
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
  if (resolveRuntimeHarness(env) === "codex") throw new Error("Cannot mint a run identity for unverified native Codex context.");
  const runId = mintRunId();
  let statePath = null;
  if (typeof root === "string" && root.length > 0) {
    statePath = writeRunContext({ runId, root, mintedAt, fs });
  }
  return { runId, minted: true, statePath };
}
