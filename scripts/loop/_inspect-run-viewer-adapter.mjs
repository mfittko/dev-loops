import { parseRepoSlugParts } from "@dev-loops/core/github/repo-slug";
import { inspectRun } from "./inspect-run.mjs";
import { runChild } from "../_cli-primitives.mjs";
const ASSIGNED_PR_LIST_CACHE_TTL_MS = 15_000;
const DEFAULT_UPDATED_WITHIN_DAYS = 7;
const DEFAULT_RESULT_LIMIT = 25;
const MAX_RESULT_LIMIT = 100;
const DEFAULT_PR_STATE = "open";
const DEFAULT_INBOX_MODE = "assignee";
const DEFAULT_INBOX_SIGNAL = "waiting";
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
export function createInspectionViewerAdapter({ inspectRunImpl = inspectRun, runGhJsonImpl = null, nowImpl = () => Date.now() } = {}) {
  const runGhJson = async (args, { env = process.env, ghCommand = "gh" } = {}) => {
    if (typeof runGhJsonImpl === "function") {
      return runGhJsonImpl(args, { env, ghCommand });
    }
    const result = await runChild(ghCommand, args, env);
    if (result.code !== 0) {
      throw new Error(`Command failed: ${ghCommand} ${args.join(" ")}\n${result.stderr.trim() || "(no stderr output)"}`);
    }
    return parseGhJsonOutput(result.stdout);
  };
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
  return {
    async loadSnapshot(target, options = {}) {
      const normalizedTarget = normalizeInspectionTarget(target);
      return inspectRunImpl({ ...options, ...normalizedTarget });
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
      const [payload, changesRequestedPayload, failingChecksPayload, pendingChecksPayload, approvedPayload] = await Promise.all([
        runGhJson(baseQueryArgs, { env, ghCommand }),
        runGhJson(queryArgsFor({ review: "changes_requested" }), { env, ghCommand }),
        runGhJson(queryArgsFor({ checks: "failure" }), { env, ghCommand }),
        runGhJson(queryArgsFor({ checks: "pending" }), { env, ghCommand }),
        runGhJson(queryArgsFor({ review: "approved" }), { env, ghCommand }),
      ]);
      if (!Array.isArray(payload)) {
        return [];
      }
      const attentionKeys = new Set([
        ...createEntryKeySet(changesRequestedPayload, toRepoSlug),
        ...createEntryKeySet(failingChecksPayload, toRepoSlug),
      ]);
      const pendingKeys = createEntryKeySet(pendingChecksPayload, toRepoSlug);
      const readyKeys = createEntryKeySet(approvedPayload, toRepoSlug);
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
