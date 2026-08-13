import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseRepoSlugParts } from "@dev-loops/core/github/repo-slug";
import { resolveRunId } from "@dev-loops/core/loop/run-context";
import {
  loadStateFile as loadSharedStateFile,
  saveStateFile as saveSharedStateFile,
  withStateFileLock as withSharedStateFileLock,
} from "./_steering-state-file.mjs";
import { detectStaleRunner } from "./_stale-runner-detection.mjs";
export const RUNNER_COORDINATION_SCHEMA_VERSION = 2;
export const RUNNER_COORDINATION_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const RUNNER_COORDINATION_HISTORY_LIMIT = 50; // cap audit trail; heartbeats append per-round, keep the most recent 50 events
export const RUNNER_OWNERSHIP_ERROR = Object.freeze({
  ACTIVE_RUN_EXISTS: "active_run_exists",
  OWNERSHIP_LOST: "ownership_lost",
  OWNERSHIP_MISSING: "ownership_missing",
  RUN_ID_REQUIRED: "run_id_required",
  EXIT_SIGNAL_RECORDED: "exit_signal_recorded",
});
function normalizeRepoSlug(repo) {
  const { owner, name } = parseRepoSlugParts(repo, {
    errorMessage: `Invalid repo slug for coordination target path: ${JSON.stringify(repo)}`,
    lowercase: true,
  });
  return `${owner}/${name}`;
}
function normalizePr(pr) {
  const number = typeof pr === "number" ? pr : Number(pr);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid pull request number for runner coordination: ${JSON.stringify(pr)}`);
  }
  return number;
}
function normalizeRunId(runId) {
  return typeof runId === "string" && runId.trim().length > 0
    ? runId.trim()
    : null;
}
function normalizeSignalReason(reason) {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}
async function loadRunnerStateFile(filePath) {
  try {
    return await loadSharedStateFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read runner coordination state file '${filePath}': ${message}`);
  }
}
async function saveRunnerStateFile(filePath, state) {
  try {
    const capped = Array.isArray(state.history) && state.history.length > RUNNER_COORDINATION_HISTORY_LIMIT
      ? { ...state, history: state.history.slice(-RUNNER_COORDINATION_HISTORY_LIMIT) }
      : state;
    return await saveSharedStateFile(filePath, capped);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write runner coordination state file '${filePath}': ${message}`);
  }
}
async function withRunnerStateFileLock(filePath, callback) {
  try {
    return await withSharedStateFileLock(filePath, callback);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to acquire runner coordination state lock for '${filePath}': ${message}`);
  }
}
const coordinationRootCache = new Map();
/**
 * Resolve the single stable coordination root for a checkout, independent of CWD.
 *
 * `git rev-parse --git-common-dir` yields the shared git dir that is identical for
 * a repo and all its linked worktrees, so its parent is the one main-checkout root
 * that a worktree runner and a repo-root detector both anchor to — eliminating the
 * split-copy false-stale stall where each read a different `.pi/runner-coordination`
 * file. Falls back to the canonicalized (realpath'd) `cwd` when git is
 * unavailable or the dir is not a checkout, so symlinked and realpath'd
 * spellings of the same non-git dir still converge on one coordination path.
 *
 * `cwd` is realpath'd once at entry: git returns a relative `--git-common-dir` from
 * a main checkout but an already-realpath'd absolute one from a linked worktree, so
 * resolving against a symlinked cwd (e.g. macOS /tmp -> /private/tmp) would make the
 * two sides compute different roots for the same physical repo. Canonicalizing first
 * makes both sides converge, and doubles as the cache key so symlink-variant cwd
 * spellings share one cache entry. Cached per canonical cwd for the process.
 */
function resolveRepoCoordinationRoot(cwd) {
  let canonicalCwd = cwd;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch (err) {
    // realpathSync on an existing checkout dir virtually never fails;
    // warn (don't throw) so the rare transient failure — which can desync the
    // coordination path across worktrees — is diagnosable instead of silent.
    console.warn(
      `[runner-coordination] realpathSync(${cwd}) failed; using raw cwd, coordination path may diverge across worktrees: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (coordinationRootCache.has(canonicalCwd)) return coordinationRootCache.get(canonicalCwd);
  let root = canonicalCwd;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: canonicalCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commonDir) {
      root = path.dirname(path.resolve(canonicalCwd, commonDir));
    }
  } catch {
    // not a git checkout / git unavailable — anchor at the canonical (realpath'd) cwd
  }
  coordinationRootCache.set(canonicalCwd, root);
  return root;
}
export function defaultRunnerCoordinationFilePathForTarget({ repo, pr }, cwd = process.cwd()) {
  const { owner, name } = parseRepoSlugParts(repo, {
    errorMessage: `Invalid repo slug for coordination target path: ${JSON.stringify(repo)}`,
    lowercase: true,
  });
  const normalizedPr = normalizePr(pr);
  const root = resolveRepoCoordinationRoot(cwd);
  return path.join(root, ".pi", "runner-coordination", owner, name, `pr-${normalizedPr}.json`);
}
export function createRunnerCoordinationState({ repo, pr, runId = null, now = new Date().toISOString() }) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const normalizedRunId = normalizeRunId(runId);
  return {
    schemaVersion: RUNNER_COORDINATION_SCHEMA_VERSION,
    target: {
      repo: normalizedRepo,
      pr: normalizedPr,
    },
    activeRun: normalizedRunId === null
      ? null
      : {
        runId: normalizedRunId,
        claimedAt: now,
        updatedAt: now,
      },
    previousRun: null,
    history: normalizedRunId === null
      ? []
      : [{ type: "claim", runId: normalizedRunId, at: now }],
    exitSignals: [],
  };
}
function normalizeExitSignals(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const runId = normalizeRunId(entry.runId);
    if (runId === null) continue;
    out.push({
      runId,
      at: typeof entry.at === "string" ? entry.at : null,
      reason: normalizeSignalReason(entry.reason),
    });
  }
  return out;
}
export function normalizeRunnerCoordinationState(raw, { repo, pr } = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Runner coordination state must be a non-null object");
  }
  if (!RUNNER_COORDINATION_SUPPORTED_SCHEMA_VERSIONS.includes(raw.schemaVersion)) {
    throw new Error(
      `Unsupported runner coordination schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected one of ${JSON.stringify(RUNNER_COORDINATION_SUPPORTED_SCHEMA_VERSIONS)}`,
    );
  }
  const target = raw.target;
  if (!target || typeof target !== "object") {
    throw new Error("Runner coordination state target is missing");
  }
  const normalizedRepo = normalizeRepoSlug(target.repo);
  const normalizedPr = normalizePr(target.pr);
  if (repo !== undefined && normalizeRepoSlug(repo) !== normalizedRepo) {
    throw new Error(
      `Runner coordination target repo ${JSON.stringify(normalizedRepo)} does not match expected ${JSON.stringify(normalizeRepoSlug(repo))}`,
    );
  }
  if (pr !== undefined && normalizePr(pr) !== normalizedPr) {
    throw new Error(
      `Runner coordination target pr ${JSON.stringify(normalizedPr)} does not match expected ${JSON.stringify(normalizePr(pr))}`,
    );
  }
  const activeRun = raw.activeRun && typeof raw.activeRun === "object"
    ? {
      runId: normalizeRunId(raw.activeRun.runId),
      claimedAt: typeof raw.activeRun.claimedAt === "string" ? raw.activeRun.claimedAt : null,
      updatedAt: typeof raw.activeRun.updatedAt === "string" ? raw.activeRun.updatedAt : null,
    }
    : null;
  const previousRun = raw.previousRun && typeof raw.previousRun === "object"
    ? {
      runId: normalizeRunId(raw.previousRun.runId),
      replacedAt: typeof raw.previousRun.replacedAt === "string" ? raw.previousRun.replacedAt : null,
      replacedByRunId: normalizeRunId(raw.previousRun.replacedByRunId),
    }
    : null;
  return {
    schemaVersion: RUNNER_COORDINATION_SCHEMA_VERSION,
    target: {
      repo: normalizedRepo,
      pr: normalizedPr,
    },
    activeRun: activeRun?.runId
      ? {
        runId: activeRun.runId,
        claimedAt: activeRun.claimedAt,
        updatedAt: activeRun.updatedAt,
      }
      : null,
    previousRun: previousRun?.runId
      ? {
        runId: previousRun.runId,
        replacedAt: previousRun.replacedAt,
        replacedByRunId: previousRun.replacedByRunId,
      }
      : null,
    history: Array.isArray(raw.history) ? raw.history : [],
    exitSignals: normalizeExitSignals(raw.exitSignals),
  };
}
function buildConflict({ error, repo, pr, runId, activeRun, filePath, message, exitSignals = null }) {
  const payload = {
    ok: false,
    error,
    repo,
    pr,
    runId,
    activeRun,
    filePath,
    message,
  };
  if (exitSignals !== null) {
    payload.exitSignals = exitSignals;
  }
  return payload;
}
export async function loadRunnerCoordinationState({ repo, pr, cwd = process.cwd(), filePath = null } = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const resolvedPath = filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd);
  const raw = await loadRunnerStateFile(resolvedPath);
  if (raw === null) {
    return { filePath: resolvedPath, state: null };
  }
  return {
    filePath: resolvedPath,
    state: normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr }),
  };
}
export async function claimRunnerOwnership({
  repo,
  pr,
  runId,
  cwd = process.cwd(),
  filePath = null,
  mode = "claim",
  now = new Date().toISOString(),
} = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId === null) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: null,
      activeRun: null,
      filePath: filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd),
      message: "Runner coordination claim requires a non-empty run id.",
    });
  }
  const resolvedPath = filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd);
  return withRunnerStateFileLock(resolvedPath, async () => {
    const raw = await loadRunnerStateFile(resolvedPath);
    const state = raw === null
      ? createRunnerCoordinationState({ repo: normalizedRepo, pr: normalizedPr })
      : normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr });
    const activeRun = state.activeRun;
    if (activeRun === null) {
      const nextState = {
        ...state,
        activeRun: {
          runId: normalizedRunId,
          claimedAt: now,
          updatedAt: now,
        },
        history: [...state.history, { type: "claim", runId: normalizedRunId, at: now }],
      };
      await saveRunnerStateFile(resolvedPath, nextState);
      return {
        ok: true,
        status: "claimed_new",
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: nextState.activeRun,
        previousRun: nextState.previousRun,
        exitSignals: nextState.exitSignals,
        filePath: resolvedPath,
      };
    }
    if (activeRun.runId === normalizedRunId) {
      const nextState = {
        ...state,
        activeRun: {
          ...activeRun,
          claimedAt: activeRun.claimedAt ?? now,
          updatedAt: now,
        },
        history: [...state.history, { type: "refresh", runId: normalizedRunId, at: now }],
      };
      await saveRunnerStateFile(resolvedPath, nextState);
      return {
        ok: true,
        status: "refreshed",
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: nextState.activeRun,
        previousRun: nextState.previousRun,
        exitSignals: nextState.exitSignals,
        filePath: resolvedPath,
      };
    }
    if (mode !== "takeover") {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.ACTIVE_RUN_EXISTS,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun,
        filePath: resolvedPath,
        exitSignals: state.exitSignals,
        message: `PR ${normalizedRepo}#${normalizedPr} is already owned by run ${activeRun.runId}. Claim failed closed.`,
      });
    }
    const nextState = {
      ...state,
      activeRun: {
        runId: normalizedRunId,
        claimedAt: now,
        updatedAt: now,
      },
      previousRun: {
        runId: activeRun.runId,
        replacedAt: now,
        replacedByRunId: normalizedRunId,
      },
      history: [...state.history, {
        type: "takeover",
        runId: normalizedRunId,
        previousRunId: activeRun.runId,
        at: now,
      }],
    };
    await saveRunnerStateFile(resolvedPath, nextState);
    return {
      ok: true,
      status: "taken_over",
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: nextState.activeRun,
      previousRun: nextState.previousRun,
      exitSignals: nextState.exitSignals,
      filePath: resolvedPath,
    };
  });
}
/**
 * Verify the caller still owns the PR's runner claim.
 *
 * A successful owner-confirmed assert (the active owner's runId matches the
 * caller's) refreshes `activeRun.updatedAt` — it acts as a heartbeat. Every
 * other outcome (no record, no active run, ownership lost, missing run id)
 * is a pure lock-free read with no write. Long-running loops must assert (or
 * claim) at least once within the stale-max-age window
 * (`STALE_RUNNER_DEFAULT_MAX_AGE_MS`, 30 minutes by default, overridable via
 * `DEVLOOPS_STALE_RUNNER_MAX_AGE_MS`; see `_stale-runner-detection.mjs`) to
 * avoid being seen as stale during a long multi-round gate cycle.
 */
export async function assertRunnerOwnership({
  repo,
  pr,
  runId,
  cwd = process.cwd(),
  filePath = null,
  requireExisting = false,
  now = new Date().toISOString(),
} = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const normalizedRunId = normalizeRunId(runId);
  const resolvedPath = filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd);
  if (normalizedRunId === null) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: null,
      activeRun: null,
      filePath: resolvedPath,
      message: "Runner coordination ownership check requires a non-empty run id.",
    });
  }
  const raw = await loadRunnerStateFile(resolvedPath);
  if (raw === null) {
    if (!requireExisting) {
      return {
        ok: true,
        status: "no_owner_record",
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: null,
        exitSignals: [],
        filePath: resolvedPath,
      };
    }
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_MISSING,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      filePath: resolvedPath,
      message: `PR ${normalizedRepo}#${normalizedPr} has no runner ownership record for async run ${normalizedRunId}.`,
    });
  }
  const state = normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr });
  if (state.activeRun === null) {
    if (!requireExisting) {
      return {
        ok: true,
        status: "no_owner_record",
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: null,
        previousRun: state.previousRun,
        exitSignals: state.exitSignals,
        filePath: resolvedPath,
      };
    }
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_MISSING,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      filePath: resolvedPath,
      message: `PR ${normalizedRepo}#${normalizedPr} has no active runner ownership record for async run ${normalizedRunId}.`,
    });
  }
  if (state.activeRun.runId === normalizedRunId) {
    return withRunnerStateFileLock(resolvedPath, async () => {
      const lockedRaw = await loadRunnerStateFile(resolvedPath);
      const lockedState = lockedRaw === null
        ? null
        : normalizeRunnerCoordinationState(lockedRaw, { repo: normalizedRepo, pr: normalizedPr });
      if (lockedState?.activeRun?.runId !== normalizedRunId) {
        // Ownership changed hands between the lockless read above and acquiring
        // the lock (a concurrent takeover) — don't write; report the new owner.
        return buildConflict({
          error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST,
          repo: normalizedRepo,
          pr: normalizedPr,
          runId: normalizedRunId,
          activeRun: lockedState?.activeRun ?? null,
          filePath: resolvedPath,
          exitSignals: lockedState?.exitSignals ?? [],
          message: lockedState?.activeRun?.runId
            ? `PR ${normalizedRepo}#${normalizedPr} is now owned by run ${lockedState.activeRun.runId}; run ${normalizedRunId} must stop.`
            : `PR ${normalizedRepo}#${normalizedPr} no longer has an active runner ownership record; run ${normalizedRunId} must stop.`,
        });
      }
      const nextState = {
        ...lockedState,
        activeRun: {
          ...lockedState.activeRun,
          updatedAt: now,
        },
        history: [...lockedState.history, { type: "heartbeat", runId: normalizedRunId, at: now }],
      };
      await saveRunnerStateFile(resolvedPath, nextState);
      return {
        ok: true,
        status: "owner_confirmed",
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: nextState.activeRun,
        previousRun: nextState.previousRun,
        exitSignals: nextState.exitSignals,
        filePath: resolvedPath,
      };
    });
  }
  return buildConflict({
    error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST,
    repo: normalizedRepo,
    pr: normalizedPr,
    runId: normalizedRunId,
    activeRun: state.activeRun,
    filePath: resolvedPath,
    exitSignals: state.exitSignals,
    message: state.activeRun?.runId
      ? `PR ${normalizedRepo}#${normalizedPr} is now owned by run ${state.activeRun.runId}; run ${normalizedRunId} must stop.`
      : `PR ${normalizedRepo}#${normalizedPr} no longer has an active runner ownership record; run ${normalizedRunId} must stop.`,
  });
}
export async function releaseRunnerOwnership({
  repo,
  pr,
  runId,
  cwd = process.cwd(),
  filePath = null,
  now = new Date().toISOString(),
} = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId === null) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: null,
      activeRun: null,
      filePath: filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd),
      message: "Runner coordination release requires a non-empty run id.",
    });
  }
  const resolvedPath = filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd);
  return withRunnerStateFileLock(resolvedPath, async () => {
    const raw = await loadRunnerStateFile(resolvedPath);
    if (raw === null) {
      return {
        ok: true,
        status: "release_noop",
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: null,
        exitSignals: [],
        filePath: resolvedPath,
      };
    }
    const state = normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr });
    if (state.activeRun?.runId !== normalizedRunId) {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: state.activeRun,
        filePath: resolvedPath,
        exitSignals: state.exitSignals,
        message: state.activeRun?.runId
          ? `Cannot release PR ${normalizedRepo}#${normalizedPr}: active owner is ${state.activeRun.runId}, not ${normalizedRunId}.`
          : `Cannot release PR ${normalizedRepo}#${normalizedPr}: no active owner record remains for ${normalizedRunId}.`,
      });
    }
    const nextState = {
      ...state,
      activeRun: null,
      previousRun: {
        runId: normalizedRunId,
        replacedAt: now,
        replacedByRunId: null,
      },
      history: [...state.history, { type: "release", runId: normalizedRunId, at: now }],
    };
    await saveRunnerStateFile(resolvedPath, nextState);
    return {
      ok: true,
      status: "released",
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      previousRun: nextState.previousRun,
      exitSignals: nextState.exitSignals,
      filePath: resolvedPath,
    };
  });
}
export async function recordExitSignalForRunner({
  repo,
  pr,
  runId,
  reason = null,
  cwd = process.cwd(),
  filePath = null,
  now = new Date().toISOString(),
  requireActiveOwner = true,
} = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId === null) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: null,
      activeRun: null,
      filePath: filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd),
      message: "Recording an exit signal requires a non-empty run id.",
    });
  }
  const resolvedPath = filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd);
  return withRunnerStateFileLock(resolvedPath, async () => {
    const raw = await loadRunnerStateFile(resolvedPath);
    if (raw === null) {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_MISSING,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: null,
        filePath: resolvedPath,
        message: `Cannot record exit signal: PR ${normalizedRepo}#${normalizedPr} has no runner coordination record.`,
      });
    }
    const state = normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr });
    if (requireActiveOwner && (state.activeRun === null || state.activeRun.runId !== normalizedRunId)) {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: state.activeRun,
        filePath: resolvedPath,
        exitSignals: state.exitSignals,
        message: state.activeRun?.runId
          ? `Cannot record exit signal: PR ${normalizedRepo}#${normalizedPr} is owned by ${state.activeRun.runId}, not ${normalizedRunId}.`
          : `Cannot record exit signal: PR ${normalizedRepo}#${normalizedPr} no longer has an active owner.`,
      });
    }
    const nextSignal = {
      runId: normalizedRunId,
      at: now,
      reason: normalizeSignalReason(reason),
    };
    const nextState = {
      ...state,
      exitSignals: [...(state.exitSignals || []), nextSignal],
    };
    await saveRunnerStateFile(resolvedPath, nextState);
    return {
      ok: true,
      status: "exit_signal_recorded",
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: state.activeRun,
      previousRun: state.previousRun,
      exitSignals: nextState.exitSignals,
      filePath: resolvedPath,
    };
  });
}
export async function ensureAsyncRunnerOwnership({
  repo,
  pr,
  env = process.env,
  cwd = process.cwd(),
  claimIfMissing = true,
  requireExisting = false,
  supersedeStale = false,
} = {}) {
  const runId = normalizeRunId(resolveRunId(env));
  if (runId === null) {
    return {
      ok: true,
      status: "skipped_no_async_run_id",
      repo: normalizeRepoSlug(repo),
      pr: normalizePr(pr),
      runId: null,
      activeRun: null,
      exitSignals: [],
      filePath: defaultRunnerCoordinationFilePathForTarget({ repo, pr }, cwd),
    };
  }
  const asserted = await assertRunnerOwnership({ repo, pr, runId, cwd, requireExisting });
  if (asserted.ok && asserted.status !== "no_owner_record") {
    return asserted;
  }
  if (!claimIfMissing) {
    return asserted;
  }
  if (asserted.ok && asserted.status === "no_owner_record") {
    return claimRunnerOwnership({ repo, pr, runId, cwd, mode: "claim" });
  }
  if (asserted.error !== RUNNER_OWNERSHIP_ERROR.OWNERSHIP_MISSING) {
    // A competing run holds the claim. With supersedeStale (handoff), a
    // confirmed-dead owner — its run has a recorded exit signal, or its claim
    // has gone stale past the max-age window — is taken over so the next
    // legitimately-dispatched run proceeds instead of standing down on a
    // leaked lock (#1706). A genuinely live owner stays fail-closed: the
    // one-runner-per-PR invariant for active work is preserved.
    if (supersedeStale) {
      const stale = await detectStaleRunner({ repo, pr, cwd });
      if (!stale.ok && stale.status !== "no_owner_record") {
        return claimRunnerOwnership({ repo, pr, runId, cwd, mode: "takeover" });
      }
    }
    return asserted;
  }
  return claimRunnerOwnership({ repo, pr, runId, cwd, mode: "claim" });
}
/**
 * Env-aware, best-effort release for the run-completion/stop path (issue #1109).
 *
 * Mirrors {@link ensureAsyncRunnerOwnership}: a no-op when no async run id is
 * present, so it is harness-agnostic — Claude Code with no DEVLOOPS_RUN_ID yields
 * `skipped_no_async_run_id` and never touches the coordination file.
 *
 * Non-fatal by contract: a release conflict (the claim is owned by another run,
 * or no record remains) is swallowed into an `ok:true` result so a failed release
 * can never block a stop/checkpoint. Fail-closed competitor semantics are
 * preserved — {@link releaseRunnerOwnership} only clears a claim THIS run owns, so
 * a genuinely active competing run's claim is left intact.
 *
 * Resolves to one of `skipped_no_async_run_id` (no run id present),
 * `release_skipped` (release conflict swallowed), `release_error` (release threw),
 * or the passthrough `releaseRunnerOwnership` result — `released` when this run's
 * claim was cleared, or `release_noop` when the target has no coordination record.
 */
export async function releaseAsyncRunnerOwnership({
  repo,
  pr,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const filePath = defaultRunnerCoordinationFilePathForTarget({ repo, pr }, cwd);
  const runId = normalizeRunId(resolveRunId(env));
  if (runId === null) {
    return {
      ok: true,
      status: "skipped_no_async_run_id",
      repo: normalizeRepoSlug(repo),
      pr: normalizePr(pr),
      runId: null,
      activeRun: null,
      exitSignals: [],
      filePath,
    };
  }
  try {
    const released = await releaseRunnerOwnership({ repo, pr, runId, cwd });
    if (released.ok) {
      return released;
    }
    return {
      ok: true,
      status: "release_skipped",
      repo: released.repo ?? normalizeRepoSlug(repo),
      pr: released.pr ?? normalizePr(pr),
      runId,
      activeRun: released.activeRun ?? null,
      exitSignals: released.exitSignals ?? [],
      skippedReason: released.error,
      message: released.message,
      filePath: released.filePath ?? filePath,
    };
  } catch (error) {
    return {
      ok: true,
      status: "release_error",
      repo: normalizeRepoSlug(repo),
      pr: normalizePr(pr),
      runId,
      activeRun: null,
      exitSignals: [],
      skippedReason: "release_threw",
      message: error instanceof Error ? error.message : String(error),
      filePath,
    };
  }
}

/**
 * Deterministic release-on-process-exit (#1706): best-effort clear of every
 * runner-coordination claim owned by a run across all PRs under a coordination
 * root.
 *
 * The headless dev-loop driver owns the spawned run's process boundary — when
 * the spawned run terminates (completed, killed, timed out, or crashed) this
 * scans the coordination root and releases each PR claim that THIS run still
 * owns, so a dead run never leaves a leaky claim that blocks the next
 * legitimately-dispatched run. Fail-closed competitor semantics are preserved:
 * only claims owned by {@link runId} are cleared; a genuinely live competing
 * run's claim is left intact.
 *
 * Coordination files live at `.pi/runner-coordination/<owner>/<name>/pr-<n>.json`.
 * Best-effort/non-fatal by contract (mirrors {@link releaseAsyncRunnerOwnership}):
 * an unreadable/parsing/lock failure is swallowed and reported, never thrown.
 */
export async function releaseRunClaimsOnExit({
  runId,
  root = process.cwd(),
  readDir = fs.promises.readdir,
  readFile = fs.promises.readFile,
  releaseFn = releaseRunnerOwnership,
} = {}) {
  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId === null) {
    return { ok: true, status: "skipped_no_async_run_id", released: [], failed: [] };
  }
  const coordinationRoot = path.join(root, ".pi", "runner-coordination");
  let entries;
  try {
    entries = await readDir(coordinationRoot, { recursive: true });
  } catch {
    return { ok: true, status: "no_coordination_dir", released: [], failed: [], root };
  }
  const released = [];
  const failed = [];
  const prFiles = (Array.isArray(entries) ? entries : [])
    .filter((entry) => typeof entry === "string" && /pr-\d+\.json$/.test(path.basename(entry)))
    .map((entry) => path.join(coordinationRoot, entry));
  for (const filePath of prFiles) {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      failed.push({ filePath, prNumber: null, reason: "read_failed" });
      continue;
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      failed.push({ filePath, prNumber: null, reason: "parse_failed" });
      continue;
    }
    if (state?.activeRun?.runId !== normalizedRunId) {
      continue;
    }
    const relToRoot = path.relative(root, filePath);
    const prMatch = path.basename(filePath).match(/^pr-(\d+)\.json$/);
    const prNumber = prMatch ? Number(prMatch[1]) : null;
    const parts = relToRoot.split(path.sep);
    const repo = parts.length >= 4 && parts[0] === ".pi" && parts[1] === "runner-coordination"
      ? `${parts[2]}/${parts[3]}`
      : null;
    if (repo === null || prNumber === null) {
      failed.push({ filePath, prNumber, reason: "bad_path" });
      continue;
    }
    try {
      const result = await releaseFn({ repo, pr: prNumber, runId: normalizedRunId, cwd: root, filePath });
      released.push({ filePath, prNumber, status: result?.status ?? "released" });
    } catch {
      failed.push({ filePath, prNumber, reason: "release_failed" });
    }
  }
  return { ok: true, status: "released", released, failed, root };
}
