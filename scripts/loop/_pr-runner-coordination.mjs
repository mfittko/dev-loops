import path from "node:path";
import process from "node:process";
import { parseRepoSlugParts } from "@dev-loops/core/github/repo-slug";
import {
  loadStateFile as loadSharedStateFile,
  saveStateFile as saveSharedStateFile,
  withStateFileLock as withSharedStateFileLock,
} from "./_steering-state-file.mjs";
export const RUNNER_COORDINATION_SCHEMA_VERSION = 2;
export const RUNNER_COORDINATION_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
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
    return await saveSharedStateFile(filePath, state);
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
export function defaultRunnerCoordinationFilePathForTarget({ repo, pr }, cwd = process.cwd()) {
  const { owner, name } = parseRepoSlugParts(repo, {
    errorMessage: `Invalid repo slug for coordination target path: ${JSON.stringify(repo)}`,
    lowercase: true,
  });
  const normalizedPr = normalizePr(pr);
  return path.join(cwd, ".pi", "runner-coordination", owner, name, `pr-${normalizedPr}.json`);
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
export async function assertRunnerOwnership({
  repo,
  pr,
  runId,
  cwd = process.cwd(),
  filePath = null,
  requireExisting = false,
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
    return {
      ok: true,
      status: "owner_confirmed",
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: state.activeRun,
      previousRun: state.previousRun,
      exitSignals: state.exitSignals,
      filePath: resolvedPath,
    };
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
} = {}) {
  const runId = normalizeRunId(env?.PI_SUBAGENT_RUN_ID);
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
    return asserted;
  }
  return claimRunnerOwnership({ repo, pr, runId, cwd, mode: "claim" });
}
