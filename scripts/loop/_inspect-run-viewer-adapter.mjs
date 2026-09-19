import { parseRepoSlugParts } from "@dev-loops/core/github/repo-slug";
import { inspectRun, inspectRunLoopIterations } from "./inspect-run.mjs";
import { ghJson } from "@dev-loops/core/github/gh";
import { runChild } from "@dev-loops/core/cli/primitives";
const ASSIGNED_PR_LIST_CACHE_TTL_MS = 15_000;
// Inbox dot signals (review state, check state) move far more slowly than the
// list, so they outlive the list cache and keep a list refresh at one call.
const SIGNAL_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
// One snapshot costs ~20 `gh` subprocesses (copilot evidence + reviewer evidence
// + the loop-iteration fan-out), and every page render, inbox click and
// snapshot.json fetch asks for it again. Cache per target for the same window as
// the inbox list; the shortest auto-reload period is 60s, so auto-reload never
// serves a cached snapshot. `loadSnapshot(target, { refresh: true })` bypasses
// it for the selected PR only.
const SNAPSHOT_CACHE_TTL_MS = 15_000;
// `gh` child processes register no timeout, so a hung handshake yields a promise
// that never settles. Without a ceiling that entry owns its cache key for the
// process lifetime and every later render for that PR joins the hung promise.
// Far above the TTL so a merely slow fan-out is still shared, not re-run.
const SNAPSHOT_INFLIGHT_CEILING_MS = 120_000;
const DEFAULT_UPDATED_WITHIN_DAYS = 7;
const DEFAULT_RESULT_LIMIT = 25;
const MAX_RESULT_LIMIT = 100;
const DEFAULT_PR_STATE = "open";
const DEFAULT_INBOX_MODE = "assignee";
const DEFAULT_INBOX_SIGNAL = "waiting";
// Anchored to gh's own phrasings ("API rate limit exceeded", "rate limit already
// exceeded", "You have exceeded a secondary rate limit"). A bare `rate limit`
// substring also matches an echoed PR title or proxy body, and classifying those
// as rate limits shows the operator a retry time that will never come true.
export function isRateLimitError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /rate limit[^\n]{0,20}\bexceeded\b|\bexceeded\b[^\n]{0,20}rate limit/i.test(message);
}

// The failing `gh search` call surfaces no headers, and `gh api rate_limit`
// reports a DIFFERENT budget than the one search spends (observed: 5000
// remaining while a live response header said 0). So read the authoritative
// `X-RateLimit-Reset` off a header-only probe of the same resource.
// The failing inbox call is `gh search prs`, which spends the SEARCH budget, and
// search resets on a per-minute cadence while graphql resets hourly. Probing the
// wrong bucket produces a confidently wrong "retry in ~47 min" for a limit that
// clears in seconds — worse guidance than the generic failure it replaced. So the
// probe hits the search resource and REFUSES a reading whose own
// `X-RateLimit-Resource` header does not say `search`.
const RATE_LIMIT_PROBE_RESOURCE = "search";
const RATE_LIMIT_PROBE_TIMEOUT_MS = 5_000;

export async function readRateLimitResetMs({
  env = process.env,
  ghCommand = "gh",
  runChildImpl = runChild,
  timeoutMs = RATE_LIMIT_PROBE_TIMEOUT_MS,
} = {}) {
  try {
    // This is awaited on the `GET /` request path, and `runChild` settles only on
    // close/error — it registers no timer. A stalled TLS handshake to the API
    // would hang the dashboard render until Node's 300s request timeout, with the
    // child still resident. Bound it here; a probe that misses only costs the hint.
    const result = await Promise.race([
      runChildImpl(ghCommand, ["api", "-i", "search/issues?q=repo:github/gitignore+is:issue&per_page=1"], env),
      new Promise((resolve) => { const timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
    ]);
    if (result === null) {
      return null;
    }
    // Newline between the two streams: without it an unterminated stdout merges
    // its last line into stderr's first and the anchored match silently misses.
    const headers = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
    const resource = /^x-ratelimit-resource:\s*(\S+)\s*$/im.exec(headers)?.[1];
    if (resource !== RATE_LIMIT_PROBE_RESOURCE) {
      return null;
    }
    const match = /^x-ratelimit-reset:\s*(\d+)\s*$/im.exec(headers);
    if (match === null) {
      return null;
    }
    const resetSeconds = Number(match[1]);
    return Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : null;
  } catch {
    return null;
  }
}

// A rate-limit window longer than a day is not a rate limit, it is a bad header.
// The cap also keeps `new Date(resetMs).toISOString()` below the RangeError
// threshold: an absurd reset value would otherwise throw from inside the request
// handler and replace the whole dashboard with `Internal Server Error`.
const MAX_RETRY_HINT_MS = 24 * 60 * 60 * 1000;

export function describeRetryAfter(resetMs, nowMs = Date.now()) {
  if (typeof resetMs !== "number" || !Number.isFinite(resetMs) || resetMs <= nowMs) {
    return null;
  }
  if ((resetMs - nowMs) > MAX_RETRY_HINT_MS) {
    return null;
  }
  const minutes = Math.ceil((resetMs - nowMs) / 60_000);
  const clock = new Date(resetMs).toISOString().slice(11, 16);
  return `Retry in ~${minutes} min (resets at ${clock} UTC).`;
}

function malformedTargetError(message) {
  const error = new Error(message);
  error.code = "MALFORMED_TARGET";
  return error;
}
export function parseGhJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${stdout.trim() || "<empty>"}`);
  }
}
function parsePositivePr(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  throw malformedTargetError("target.pr must be a positive integer");
}
function parseUpdatedWithinDays(value) {
  if (value === undefined || value === "") {
    return DEFAULT_UPDATED_WITHIN_DAYS;
  }
  if (value === null || value === "all") {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  throw malformedTargetError("updatedWithinDays must be a positive integer or 'all'");
}
function parseResultLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RESULT_LIMIT;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, MAX_RESULT_LIMIT);
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Math.min(Number(value), MAX_RESULT_LIMIT);
  }
  throw malformedTargetError(`limit must be a positive integer <= ${MAX_RESULT_LIMIT}`);
}
function parsePrState(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_PR_STATE;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "open" || normalized === "closed" || normalized === "all") {
    return normalized;
  }
  throw malformedTargetError("state must be one of: open, closed, all");
}
function parseInboxMode(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_INBOX_MODE;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "assignee" || normalized === "reviewer" || normalized === "involved") {
    return normalized;
  }
  throw malformedTargetError("mode must be one of: assignee, reviewer, involved");
}
function formatUtcDateDaysAgo(daysAgo, nowMs) {
  const date = new Date(nowMs - (daysAgo * 24 * 60 * 60 * 1000));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function buildPrSearchArgs({
  repoSlug,
  mode,
  state,
  updatedWithinDays,
  limit,
  jsonFields,
  review,
  checks,
  nowMs = Date.now(),
} = {}) {
  const ghArgs = [
    "search",
    "prs",
  ];
  if (mode === "assignee") {
    ghArgs.push("--assignee", "@me");
  } else if (mode === "reviewer") {
    ghArgs.push("--review-requested", "@me");
  } else {
    ghArgs.push("--involves", "@me");
  }
  if (typeof repoSlug === "string" && repoSlug.length > 0) {
    ghArgs.push("--repo", repoSlug);
  }
  if (state !== "all") {
    ghArgs.push("--state", state);
  }
  if (typeof review === "string" && review.length > 0) {
    ghArgs.push("--review", review);
  }
  if (typeof checks === "string" && checks.length > 0) {
    ghArgs.push("--checks", checks);
  }
  ghArgs.push(
    "--sort",
    "updated",
    "--order",
    "desc",
  );
  if (updatedWithinDays !== null) {
    ghArgs.push("--updated", `>=${formatUtcDateDaysAgo(updatedWithinDays, nowMs)}`);
  }
  ghArgs.push(
    "--limit",
    String(limit),
    "--json",
    jsonFields.join(","),
  );
  return ghArgs;
}
function renderSearchEntryKey(repo, pr) {
  return `${String(repo).toLowerCase()}#${String(pr)}`;
}
function createEntryKeySet(payload, toRepoSlugImpl) {
  if (!Array.isArray(payload)) {
    return new Set();
  }
  const keys = new Set();
  for (const item of payload) {
    const repo = toRepoSlugImpl(item?.repository);
    if (repo === null) {
      continue;
    }
    try {
      const normalizedTarget = normalizeInspectionTarget({ repo, pr: item?.number });
      keys.add(renderSearchEntryKey(normalizedTarget.repo, normalizedTarget.pr));
    } catch {
      continue;
    }
  }
  return keys;
}
function normalizeSearchState(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "open" || normalized === "closed" || normalized === "merged") {
    return normalized;
  }
  return DEFAULT_PR_STATE;
}
function deriveInboxSignal({ state, isDraft, attentionKeys, pendingKeys, readyKeys, entryKey }) {
  if (state === "closed" || state === "merged") {
    return "closed";
  }
  if (attentionKeys.has(entryKey)) {
    return "attention";
  }
  if (pendingKeys.has(entryKey) || isDraft) {
    return "pending";
  }
  if (readyKeys.has(entryKey)) {
    return "ready";
  }
  return DEFAULT_INBOX_SIGNAL;
}
export function normalizeInspectionTarget(target) {
  if (target === null || typeof target !== "object") {
    throw malformedTargetError("target must be an object with repo and pr");
  }
  const rawRepo = typeof target.repo === "string" ? target.repo.trim() : "";
  if (rawRepo.length === 0) {
    throw malformedTargetError("target.repo is required");
  }
  try {
    parseRepoSlugParts(rawRepo, { errorMessage: "target.repo must match <owner/name>" });
  } catch (error) {
    throw malformedTargetError(error instanceof Error ? error.message : String(error));
  }
  return {
    repo: rawRepo,
    pr: parsePositivePr(target.pr),
  };
}
// Options that change what a snapshot contains; everything else (e.g. `refresh`)
// is transport-level and must not split the cache.
function snapshotCacheKey(target, options) {
  return JSON.stringify([
    target.repo.toLowerCase(),
    target.pr,
    options.steeringStateFile ?? null,
    options.copilotInputPath ?? null,
    options.reviewerInputPath ?? null,
    options.reviewerLogin ?? null,
    options.ghCommand ?? null,
    options.includeLoopIterations !== false,
  ]);
}
export function createInspectionViewerAdapter({
  inspectRunImpl = inspectRun,
  inspectRunLoopIterationsImpl = inspectRunLoopIterations,
  runGhJsonImpl = ghJson,
  nowImpl = () => Date.now(),
  snapshotCacheTtlMs = SNAPSHOT_CACHE_TTL_MS,
  snapshotInflightCeilingMs = SNAPSHOT_INFLIGHT_CEILING_MS,
} = {}) {
  const runGhJson = (args, { env = process.env, ghCommand = "gh" } = {}) => runGhJsonImpl(args, { env, ghCommand });
  const toRepoSlug = (repository) => {
    if (repository === null || typeof repository !== "object") {
      return null;
    }
    if (typeof repository.nameWithOwner === "string" && repository.nameWithOwner.trim().length > 0) {
      return repository.nameWithOwner.trim();
    }
    const ownerLogin = typeof repository.owner?.login === "string" ? repository.owner.login.trim() : "";
    const repoName = typeof repository.name === "string" ? repository.name.trim() : "";
    if (ownerLogin.length === 0 || repoName.length === 0) {
      return null;
    }
    return `${ownerLogin}/${repoName}`;
  };
  const assignedPrListCache = new Map();
  const signalKeyCache = new Map();
  const snapshotCache = new Map();
  // The cached value is the PROMISE, so concurrent callers (page render plus its
  // snapshot.json fetch) share one `gh` fan-out instead of racing. `cachedAt` is
  // stamped when the fetch SETTLES, not when it starts: stamping it up front
  // sweeps a load slower than the TTL while it is still in flight, and a second
  // full fan-out then starts on exactly the loads the cache exists for. An
  // unsettled entry is still swept at the much higher in-flight ceiling, so a
  // `gh` fan-out that never settles cannot own its key forever.
  function memoizeFetch(key, refresh, factory) {
    const nowMs = nowImpl();
    for (const [cachedKey, entry] of snapshotCache.entries()) {
      const maxAgeMs = entry.settled ? snapshotCacheTtlMs : snapshotInflightCeilingMs;
      if ((nowMs - entry.cachedAt) > maxAgeMs) {
        snapshotCache.delete(cachedKey);
      }
    }
    const cached = refresh ? undefined : snapshotCache.get(key);
    if (cached) {
      return cached.promise;
    }
    const promise = (async () => factory())();
    const entry = { cachedAt: nowMs, promise, settled: false };
    snapshotCache.set(key, entry);
    promise.then(
      () => {
        entry.cachedAt = nowImpl();
        entry.settled = true;
      },
      // Never cache a failure: drop the entry so the next request retries live.
      () => {
        if (snapshotCache.get(key) === entry) {
          snapshotCache.delete(key);
        }
      },
    );
    return promise;
  }
  return {
    async loadSnapshot(target, options = {}) {
      const normalizedTarget = normalizeInspectionTarget(target);
      const { refresh = false, ...inspectOptions } = options;
      const load = () => inspectRunImpl({ ...inspectOptions, ...normalizedTarget });
      if (!(snapshotCacheTtlMs > 0)) {
        return load();
      }
      return memoizeFetch(snapshotCacheKey(normalizedTarget, inspectOptions), refresh, load);
    },
    // Round metrics only: what the deferred /round-metrics.html fragment renders.
    // Cached apart from the snapshot so reopening a PR inside the TTL is free.
    async loadLoopIterations(target, options = {}) {
      const normalizedTarget = normalizeInspectionTarget(target);
      const { refresh = false, includeLoopIterations: _unused, ...inspectOptions } = options;
      const load = () => inspectRunLoopIterationsImpl({ ...inspectOptions, ...normalizedTarget });
      if (!(snapshotCacheTtlMs > 0)) {
        return load();
      }
      return memoizeFetch(`loopIterations:${snapshotCacheKey(normalizedTarget, inspectOptions)}`, refresh, load);
    },
    async listAssignedPullRequests(options = {}) {
      const {
        repo,
        limit = DEFAULT_RESULT_LIMIT,
        updatedWithinDays = DEFAULT_UPDATED_WITHIN_DAYS,
        state = DEFAULT_PR_STATE,
        mode = DEFAULT_INBOX_MODE,
        env = process.env,
        ghCommand = "gh",
      } = options;
      const repoSlug = typeof repo === "string" ? repo.trim() : "";
      if (repoSlug.length > 0) {
        try {
          parseRepoSlugParts(repoSlug, { errorMessage: "repo must match <owner/name>" });
        } catch (error) {
          throw malformedTargetError(error instanceof Error ? error.message : String(error));
        }
      }
      const normalizedLimit = parseResultLimit(limit);
      const normalizedUpdatedWithinDays = parseUpdatedWithinDays(updatedWithinDays);
      const normalizedState = parsePrState(state);
      const normalizedMode = parseInboxMode(mode);
      const nowMs = nowImpl();
      for (const [key, entry] of assignedPrListCache.entries()) {
        if ((nowMs - entry.cachedAt) > ASSIGNED_PR_LIST_CACHE_TTL_MS) {
          assignedPrListCache.delete(key);
        }
      }
      // Same sweep for the signal cache: its key space is the full filter
      // permutation, so a long-lived viewer browsing many repo scopes would
      // otherwise accumulate entries for the process lifetime.
      for (const [key, entry] of signalKeyCache.entries()) {
        if ((nowMs - entry.cachedAt) > SIGNAL_KEY_CACHE_TTL_MS) {
          signalKeyCache.delete(key);
        }
      }
      const cacheKey = `${ghCommand}::${repoSlug.length > 0 ? repoSlug.toLowerCase() : "all-repos"}::${normalizedMode}::${normalizedState}::${normalizedLimit}::${normalizedUpdatedWithinDays ?? "all"}`;
      const cached = assignedPrListCache.get(cacheKey);
      if (cached && (nowMs - cached.cachedAt) <= ASSIGNED_PR_LIST_CACHE_TTL_MS) {
        return cached.payload.map((entry) => ({
          target: { ...entry.target },
          title: entry.title,
          updatedAt: entry.updatedAt,
          signal: entry.signal ?? DEFAULT_INBOX_SIGNAL,
        }));
      }
      const baseQueryArgs = buildPrSearchArgs({
        repoSlug,
        mode: normalizedMode,
        state: normalizedState,
        updatedWithinDays: normalizedUpdatedWithinDays === null ? null : normalizedUpdatedWithinDays,
        limit: normalizedLimit,
        jsonFields: ["number", "title", "repository", "updatedAt", "state", "isDraft"],
        nowMs,
      });
      const queryArgsFor = (overrides = {}) => buildPrSearchArgs({
        repoSlug,
        mode: normalizedMode,
        state: normalizedState,
        updatedWithinDays: normalizedUpdatedWithinDays === null ? null : normalizedUpdatedWithinDays,
        limit: normalizedLimit,
        jsonFields: ["number", "repository"],
        nowMs,
        ...overrides,
      });
      // The 4 signal queries only tint the inbox dots and change far more slowly
      // than the list itself, so they get their own long TTL: a list refresh
      // costs 1 search call, not 5. Every `gh search` spends GraphQL points.
      // The cached value is the in-flight PROMISE, so a page render overlapping
      // an auto-reload tick joins the same 4 searches instead of firing 8.
      const listPromise = runGhJson(baseQueryArgs, { env, ghCommand });
      const signalCached = signalKeyCache.get(cacheKey);
      let signalsPromise;
      if (signalCached) {
        signalsPromise = signalCached.promise;
      } else {
        signalsPromise = Promise.all([
          runGhJson(queryArgsFor({ review: "changes_requested" }), { env, ghCommand }),
          runGhJson(queryArgsFor({ checks: "failure" }), { env, ghCommand }),
          runGhJson(queryArgsFor({ checks: "pending" }), { env, ghCommand }),
          runGhJson(queryArgsFor({ review: "approved" }), { env, ghCommand }),
        ]).then(([changesRequested, failingChecks, pendingChecks, approved]) => ({
          attention: new Set([
            ...createEntryKeySet(changesRequested, toRepoSlug),
            ...createEntryKeySet(failingChecks, toRepoSlug),
          ]),
          pending: createEntryKeySet(pendingChecks, toRepoSlug),
          ready: createEntryKeySet(approved, toRepoSlug),
        }));
        const signalEntry = { cachedAt: nowMs, promise: signalsPromise };
        signalKeyCache.set(cacheKey, signalEntry);
        // Stamped when the fan-out SETTLES, the same rule memoizeFetch uses:
        // stamping only at start expires a load slower than the TTL against the
        // moment it began, so the entry it produced is already half spent.
        signalsPromise.then(() => {
          signalEntry.cachedAt = nowImpl();
        }, () => {});
        signalsPromise.catch(() => {
          if (signalKeyCache.get(cacheKey) === signalEntry) {
            signalKeyCache.delete(cacheKey);
          }
        });
      }
      const [payload, signalSets] = await Promise.all([listPromise, signalsPromise]);
      if (!Array.isArray(payload)) {
        return [];
      }
      const attentionKeys = signalSets.attention;
      const pendingKeys = signalSets.pending;
      const readyKeys = signalSets.ready;
      const normalized = [];
      for (const item of payload) {
        const itemRepo = toRepoSlug(item?.repository);
        if (itemRepo === null) {
          continue;
        }
        try {
          const target = normalizeInspectionTarget({ repo: itemRepo, pr: item?.number });
          const entryKey = renderSearchEntryKey(target.repo, target.pr);
          normalized.push({
            target,
            title: typeof item?.title === "string" && item.title.trim().length > 0
              ? item.title.trim()
              : null,
            updatedAt: typeof item?.updatedAt === "string" && item.updatedAt.trim().length > 0
              ? item.updatedAt.trim()
              : null,
            signal: deriveInboxSignal({
              state: normalizeSearchState(item?.state),
              isDraft: item?.isDraft === true,
              attentionKeys,
              pendingKeys,
              readyKeys,
              entryKey,
            }),
          });
        } catch {
          continue;
        }
      }
      assignedPrListCache.set(cacheKey, {
        cachedAt: nowMs,
        payload: normalized.map((entry) => ({
          target: { ...entry.target },
          title: entry.title,
          updatedAt: entry.updatedAt,
          signal: entry.signal ?? DEFAULT_INBOX_SIGNAL,
        })),
      });
      return normalized;
    },
  };
}
