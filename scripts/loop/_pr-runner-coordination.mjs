import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseRepoSlugParts } from "@dev-loops/core/github/repo-slug";
import { resolveRunId, resolveRuntimeHarness } from "@dev-loops/core/loop/run-context";
import { WATCH_KINDS } from "@dev-loops/core/loop/watcher-exclusivity";
import {
  loadStateFile as loadSharedStateFile,
  saveStateFile as saveSharedStateFile,
  withStateFileLock as withSharedStateFileLock,
} from "./_steering-state-file.mjs";
import { detectStaleRunner, resolveStaleRunnerMaxAgeMs, STALE_RUNNER_ERROR } from "./_stale-runner-detection.mjs";
export const RUNNER_COORDINATION_SCHEMA_VERSION = 2;
export const RUNNER_COORDINATION_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const RUNNER_COORDINATION_HISTORY_LIMIT = 50; // cap audit trail; heartbeats append per-round, keep the most recent 50 events
export const RUNNER_OWNERSHIP_ERROR = Object.freeze({
  ACTIVE_RUN_EXISTS: "active_run_exists",
  OWNERSHIP_LOST: "ownership_lost",
  OWNERSHIP_MISSING: "ownership_missing",
  RUN_ID_REQUIRED: "run_id_required",
  EXIT_SIGNAL_RECORDED: "exit_signal_recorded",
  WATCH_HEAD_REQUIRED: "watch_head_required",
  WATCH_KIND_INVALID: "watch_kind_invalid",
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
function normalizeClaimGeneration(claim) {
  return {
    claimedAt: typeof claim?.claimedAt === "string" ? claim.claimedAt : null,
    updatedAt: typeof claim?.updatedAt === "string" ? claim.updatedAt : null,
  };
}
/**
 * Whether a supplied takeover expectation can name a claim generation: a plain
 * object carrying `claimedAt` and `updatedAt`, each a string or null. Any other
 * object-typed value (a `Date`, a `Map`, an array), an absent member or a
 * non-string member would normalize to the all-null generation and surface as a
 * lost-race `active_run_exists` for input the caller never sent.
 */
function isClaimGeneration(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return [value.claimedAt, value.updatedAt].every(
    (member) => member === null || typeof member === "string",
  );
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
  let cursor = canonicalCwd;
  while (true) {
    const marker = path.join(cursor, ".git");
    try {
      const stat = fs.statSync(marker);
      if (stat.isDirectory()) {
        root = cursor;
        break;
      }
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(marker, "utf8"));
        if (match) {
          const gitDir = path.resolve(cursor, match[1]);
          const worktreesDir = path.dirname(gitDir);
          root = path.basename(worktreesDir) === "worktrees"
            ? path.dirname(path.dirname(worktreesDir))
            : cursor;
        }
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
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
/**
 * Normalize the optional per-run watch claim recorded on `activeRun.watch` by
 * {@link recordWatchClaim}: the (head, wait-kind) boundary this run is the sole
 * sanctioned owner of. Additive/optional — a lease written before this field
 * existed (or with a malformed watch) normalizes to `null`. Every field must be
 * present and valid or the whole claim is dropped (fail-closed: a partial claim
 * never masquerades as ownership evidence).
 */
function normalizeWatch(raw) {
  if (!raw || typeof raw !== "object") return null;
  const head = typeof raw.head === "string" && raw.head.trim().length > 0 ? raw.head.trim() : null;
  const waitKind = WATCH_KINDS.includes(raw.waitKind) ? raw.waitKind : null;
  const rawUpdatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim().length > 0 ? raw.updatedAt.trim() : null;
  // resolveWatchOwnership requires a Date.parse-able owner.updatedAt (see
  // validateOwner in watcher-exclusivity.mjs); an unparseable timestamp here
  // fails closed like every other partial/malformed watch field.
  const updatedAt = rawUpdatedAt !== null && !Number.isNaN(Date.parse(rawUpdatedAt)) ? rawUpdatedAt : null;
  if (head === null || waitKind === null || updatedAt === null) return null;
  return { head, waitKind, updatedAt };
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
      watch: normalizeWatch(raw.activeRun.watch),
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
        ...(activeRun.watch ? { watch: activeRun.watch } : {}),
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
  expectPreviousRunId = null,
  expectPreviousClaim = null,
} = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const normalizedRunId = normalizeRunId(runId);
  // Normalized once, like every other run-id input: an absent, null or padded
  // expectation behaves like the rest of this module rather than refusing raw.
  const expectedPreviousRunId = normalizeRunId(expectPreviousRunId);
  // The claim generation the recovery-authorizing read observed, compared
  // literally under the lock: a member the record normalizes to `null` (an
  // absent or non-string timestamp) stays `null` here too, so it can never
  // silently match a different generation.
  const expectedPreviousClaim = expectPreviousClaim === null || expectPreviousClaim === undefined
    ? null
    : normalizeClaimGeneration(expectPreviousClaim);
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
  // A supplied expectation is caller input in either mode, so a malformed one
  // refuses here: before the lock, with no state write, and with a message that
  // names the OPTION rather than the mode so a claim and a takeover call read the
  // same. Only an absent, null or undefined expectation is inactive.
  //
  // A run id that collapses to null would silently disable the takeover race
  // guards below.
  if (expectPreviousRunId !== null && expectPreviousRunId !== undefined && expectedPreviousRunId === null) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      filePath: filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd),
      message: "Runner coordination requires a non-empty expectPreviousRunId when one is supplied.",
    });
  }
  // A supplied value that cannot describe a claim generation refuses here: coercing
  // a non-generation (a string, an array, a `Date`) or a non-string member to an
  // all-null generation would surface as a lost-race `active_run_exists` for input
  // the caller never sent, so it refuses as malformed instead.
  if (expectPreviousClaim !== null && expectPreviousClaim !== undefined && !isClaimGeneration(expectPreviousClaim)) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      filePath: filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd),
      message: "Runner coordination requires an expectPreviousClaim object carrying claimedAt and updatedAt when one is supplied.",
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
        // Prior evidence cannot belong to a new claim, even when wall-clock timestamps overlap.
        exitSignals: state.exitSignals.filter((entry) => entry.runId !== normalizedRunId),
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
    // A recovery is authorized by evidence read before this lock. Refuse when the
    // owner changed in between, so a takeover never displaces a run whose death
    // was not the one observed.
    if (expectedPreviousRunId !== null && activeRun.runId !== expectedPreviousRunId) {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.ACTIVE_RUN_EXISTS,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun,
        filePath: resolvedPath,
        exitSignals: state.exitSignals,
        message: `PR ${normalizedRepo}#${normalizedPr} is owned by ${activeRun.runId}, not the displaced run ${expectedPreviousRunId}. Takeover failed closed.`,
      });
    }
    // The same run id is not the same claim: a heartbeat keeps the run id and
    // bumps only `updatedAt`, and a same-run release plus re-claim retires that
    // claim's exit signals while keeping the id. Refuse when the generation the
    // detector judged dead is no longer the locked one, so the takeover can never
    // displace a live owner the detection read did not observe.
    if (expectedPreviousClaim !== null
      && (activeRun.claimedAt !== expectedPreviousClaim.claimedAt || activeRun.updatedAt !== expectedPreviousClaim.updatedAt)) {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.ACTIVE_RUN_EXISTS,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun,
        filePath: resolvedPath,
        exitSignals: state.exitSignals,
        message: `PR ${normalizedRepo}#${normalizedPr} is owned by a claim of run ${activeRun.runId} that changed after the stale read (claimed ${JSON.stringify(activeRun.claimedAt)}, updated ${JSON.stringify(activeRun.updatedAt)}). Takeover failed closed.`,
      });
    }
    const nextState = {
      ...state,
      exitSignals: state.exitSignals.filter((entry) => entry.runId !== normalizedRunId),
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
/**
 * Record this run's claimed (head, wait-kind) watch boundary onto the active
 * runner-coordination lease, so the boundary has exactly one sanctioned
 * external-wait owner (watcher-exclusivity live enforcement, issue 2157).
 *
 * Fails closed exactly like the write path of {@link assertRunnerOwnership}: the
 * claim is only written when THIS run is the current active owner. No record,
 * no active run, or an active run owned by another run all return an
 * `ownership_*` conflict and write nothing — a run that does not own the PR
 * lease can never register itself as the boundary's watch owner.
 *
 * On success `activeRun.watch = { head, waitKind, updatedAt }` and
 * `activeRun.updatedAt` is refreshed (the write doubles as a heartbeat). The
 * returned `watch` is the exact evidence a caller feeds to
 * `resolveWatchOwnership` as `evidence.owner` (with runId + `<repo>#<pr>` target)
 * before starting the single sanctioned watcher.
 */
export async function recordWatchClaim({
  repo,
  pr,
  runId,
  head,
  waitKind,
  cwd = process.cwd(),
  filePath = null,
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
      message: "Recording a watch claim requires a non-empty run id.",
    });
  }
  const normalizedHead = typeof head === "string" ? head.trim() : "";
  if (normalizedHead.length === 0) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.WATCH_HEAD_REQUIRED,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      filePath: resolvedPath,
      message: "Recording a watch claim requires a non-empty head.",
    });
  }
  if (!WATCH_KINDS.includes(waitKind)) {
    return buildConflict({
      error: RUNNER_OWNERSHIP_ERROR.WATCH_KIND_INVALID,
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: null,
      filePath: resolvedPath,
      message: `Watch claim waitKind must be one of ${WATCH_KINDS.join(", ")}, got ${JSON.stringify(waitKind)}.`,
    });
  }
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
        message: `Cannot record watch claim: PR ${normalizedRepo}#${normalizedPr} has no runner coordination record.`,
      });
    }
    const state = normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr });
    if (state.activeRun === null || state.activeRun.runId !== normalizedRunId) {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST,
        repo: normalizedRepo,
        pr: normalizedPr,
        runId: normalizedRunId,
        activeRun: state.activeRun,
        filePath: resolvedPath,
        exitSignals: state.exitSignals,
        message: state.activeRun?.runId
          ? `Cannot record watch claim: PR ${normalizedRepo}#${normalizedPr} is owned by ${state.activeRun.runId}, not ${normalizedRunId}.`
          : `Cannot record watch claim: PR ${normalizedRepo}#${normalizedPr} has no active owner.`,
      });
    }
    const watch = { head: normalizedHead, waitKind, updatedAt: now };
    const nextState = {
      ...state,
      activeRun: {
        ...state.activeRun,
        updatedAt: now,
        watch,
      },
      history: [...state.history, { type: "watch_claim", runId: normalizedRunId, head: normalizedHead, waitKind, at: now }],
    };
    await saveRunnerStateFile(resolvedPath, nextState);
    return {
      ok: true,
      status: "watch_claim_recorded",
      repo: normalizedRepo,
      pr: normalizedPr,
      runId: normalizedRunId,
      activeRun: nextState.activeRun,
      watch,
      previousRun: nextState.previousRun,
      exitSignals: nextState.exitSignals,
      filePath: resolvedPath,
    };
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
export async function handoffRunnerOwnership({
  repo, pr, runId, env = process.env, cwd = process.cwd(), filePath = null,
  now = new Date().toISOString(),
} = {}) {
  const normalizedRepo = normalizeRepoSlug(repo);
  const normalizedPr = normalizePr(pr);
  const verifiedRunId = normalizeRunId(resolveRunId(env));
  const requestedRunId = normalizeRunId(runId);
  const resolvedPath = filePath ?? defaultRunnerCoordinationFilePathForTarget({ repo: normalizedRepo, pr: normalizedPr }, cwd);
  const target = { repo: normalizedRepo, pr: normalizedPr, runId: verifiedRunId, filePath: resolvedPath };
  if (verifiedRunId === null) {
    return buildConflict({ ...target, error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED, activeRun: null,
      message: "Runner coordination handoff requires a verified runtime run id." });
  }
  if (requestedRunId !== null && requestedRunId !== verifiedRunId) {
    return buildConflict({ ...target, error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST, activeRun: null,
      message: "Requested handoff run id does not match the verified runtime identity." });
  }
  return withRunnerStateFileLock(resolvedPath, async () => {
    const raw = await loadRunnerStateFile(resolvedPath);
    const state = raw === null ? null : normalizeRunnerCoordinationState(raw, { repo: normalizedRepo, pr: normalizedPr });
    if (!state?.activeRun) {
      return { ok: true, status: "handoff_noop", ...target, activeRun: null,
        previousRun: state?.previousRun ?? null, exitSignals: state?.exitSignals ?? [] };
    }
    if (state.activeRun.runId !== verifiedRunId) {
      return buildConflict({ ...target, error: RUNNER_OWNERSHIP_ERROR.OWNERSHIP_LOST,
        activeRun: state.activeRun, exitSignals: state.exitSignals,
        message: `Cannot hand off PR ${normalizedRepo}#${normalizedPr}: active owner is ${state.activeRun.runId}, not ${verifiedRunId}.` });
    }
    // Preserve unrelated raw authority and schema fields; normalize only to validate ownership.
    const nextState = {
      ...raw,
      activeRun: null,
      previousRun: { runId: verifiedRunId, replacedAt: now, replacedByRunId: null },
      exitSignals: [...state.exitSignals, { runId: verifiedRunId, at: now, reason: "handoff" }],
      history: [...state.history, { type: "handoff", runId: verifiedRunId, at: now }],
    };
    await saveRunnerStateFile(resolvedPath, nextState);
    return { ok: true, status: "handoff_recorded", ...target, activeRun: null,
      previousRun: nextState.previousRun, exitSignals: nextState.exitSignals };
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
/**
 * Map a stale-runner detector verdict onto the typed recovery evidence it
 * authorizes.
 *
 * The detector returns exactly two recoverable verdicts; anything else maps to
 * `null`, so a takeover can never report a successful recovery it cannot name.
 * A claim whose `claimedAt`/`updatedAt` do not parse arrives as the ordinary
 * `stale_runner` verdict carrying `staleRunner.corruptedTimestamp`, and no clock
 * comparison produced it: corruption maps to `null` rather than to a max-age
 * recovery the evidence never supported.
 */
function resolveRecoveryEvidence(stale) {
  if (stale?.error === STALE_RUNNER_ERROR.EXIT_SIGNAL_RECORDED) return "exit_signal";
  if (stale?.error === STALE_RUNNER_ERROR.STALE_RUNNER && stale.staleRunner?.corruptedTimestamp !== true) {
    return "stale_max_age";
  }
  return null;
}
export async function ensureAsyncRunnerOwnership({
  repo,
  pr,
  env = process.env,
  cwd = process.cwd(),
  claimIfMissing = true,
  requireExisting = false,
  supersedeStale = false,
  // The detection read this handoff authorizes a takeover with; tests inject a
  // verdict to exercise the production wiring without a live stale claim.
  detectStale = detectStaleRunner,
} = {}) {
  const runId = normalizeRunId(resolveRunId(env));
  if (runId === null) {
    if ((claimIfMissing || requireExisting) && resolveRuntimeHarness(env) === "codex") {
      return buildConflict({
        error: RUNNER_OWNERSHIP_ERROR.RUN_ID_REQUIRED,
        repo: normalizeRepoSlug(repo),
        pr: normalizePr(pr),
        runId: null,
        activeRun: null,
        filePath: null,
        message: "Native Codex async context could not be verified for runner ownership.",
      });
    }
    return {
      ok: true,
      status: "skipped_no_async_run_id",
      repo: normalizeRepoSlug(repo),
      pr: normalizePr(pr),
      runId: null,
      activeRun: null,
      exitSignals: [],
      filePath: null,
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
    // leaked lock. A genuinely live owner stays fail-closed: the
    // one-runner-per-PR invariant for active work is preserved.
    if (supersedeStale) {
      const stale = await detectStale({
        repo,
        pr,
        cwd,
        maxAgeMs: resolveStaleRunnerMaxAgeMs({}, { ...process.env, ...env }),
      });
      const evidence = resolveRecoveryEvidence(stale);
      // A verdict this recovery cannot name is not evidence to take over on:
      // fail closed on the original conflict instead of an untyped takeover.
      if (!stale.ok && evidence !== null) {
        const takenOver = await claimRunnerOwnership({
          repo,
          pr,
          runId,
          cwd,
          mode: "takeover",
          expectPreviousRunId: stale.activeRun?.runId ?? null,
          expectPreviousClaim: {
            claimedAt: stale.activeRun?.claimedAt ?? null,
            updatedAt: stale.activeRun?.updatedAt ?? null,
          },
        });
        if (!takenOver.ok || takenOver.status !== "taken_over") {
          return takenOver;
        }
        return {
          ...takenOver,
          recovery: {
            evidence,
            displacedRunId: takenOver.previousRun.runId,
            maxAgeMs: stale.maxAgeMs,
          },
        };
      }
    }
    return asserted;
  }
  return claimRunnerOwnership({ repo, pr, runId, cwd, mode: "claim" });
}
/**
 * Env-aware, best-effort release for the run-completion/stop path.
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
      filePath: null,
    };
  }
  const filePath = defaultRunnerCoordinationFilePathForTarget({ repo, pr }, cwd);
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
 * Deterministic release-on-process-exit: best-effort clear of every
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
 */
/**
 * True for the "directory just isn't there" readdir errors that mean a normal
 * nothing-to-sweep exit (no coordination claims were ever written). Any other
 * readdir failure is a real scan problem and must not be treated as an absent
 * coordination dir.
 */
function isMissingDirError(error) {
  const code = error?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Coordination files live at `.pi/runner-coordination/<owner>/<name>/pr-<n>.json`.
 * Best-effort/non-fatal by contract (mirrors {@link releaseAsyncRunnerOwnership}):
 * an unreadable/parsing/lock failure is swallowed and reported, never thrown.
 */
export async function releaseRunClaimsOnExit({
  runId,
  root = process.cwd(),
  resolveCoordinationRoot = resolveRepoCoordinationRoot,
  readDir = fs.promises.readdir,
  readFile = fs.promises.readFile,
  releaseFn = releaseRunnerOwnership,
} = {}) {
  const normalizedRunId = normalizeRunId(runId);
  if (normalizedRunId === null) {
    return { ok: true, status: "skipped_no_async_run_id", released: [], failed: [] };
  }
  // Anchor at the same git-common-dir root the claims are stored under: in a
  // linked worktree the coordination dir lives in the MAIN repo's .pi (git
  // common dir), not under the worktree cwd, so a naive
  // path.join(root, ".pi", ...) would scan the wrong location and miss the
  // run's own claims. resolveRepoCoordinationRoot handles the common-dir
  // anchoring and falls back to the canonicalized cwd for non-git dirs.
  const repoBase = resolveCoordinationRoot(root);
  const coordinationRoot = path.join(repoBase, ".pi", "runner-coordination");
  let entries;
  try {
    entries = await readDir(coordinationRoot, { recursive: true });
  } catch (error) {
    // A missing coordination root (ENOENT/ENOTDIR) is the normal
    // nothing-to-sweep case; ANY other readdir failure (permissions, IO,
    // unsupported options) must not masquerade as that or the sweep looks
    // successful while doing nothing. Surface it as a distinct scan_failed
    // status so the caller can log a non-fatal warning. Non-fatal by contract:
    // never rethrow.
    if (isMissingDirError(error)) {
      return { ok: true, status: "no_coordination_dir", released: [], failed: [], root };
    }
    return {
      ok: true,
      status: "scan_failed",
      released: [],
      failed: [],
      root,
      error: error instanceof Error ? error.message : String(error),
    };
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
    const relToRoot = path.relative(repoBase, filePath);
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
