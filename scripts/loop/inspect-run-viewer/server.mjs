import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

import {
  DEFAULT_INBOX_MODE,
  DEFAULT_INBOX_PAGE,
  DEFAULT_INBOX_PAGE_SIZE,
  DEFAULT_INBOX_PR_STATE,
  DEFAULT_INBOX_UPDATED_WITHIN_DAYS,
  INBOX_MODE_FILTER_VALUES,
  INBOX_STATE_FILTER_VALUES,
  MAX_INBOX_RESULT_LIMIT,
  MERMAID_BROWSER_ASSET_ROUTE,
} from "./constants.mjs";
import { normalizeCliRepoOption } from "./cli.mjs";
import {
  deriveInboxSignalFromSnapshot,
  loadMermaidBrowserScript,
  normalizeInboxSignal,
  renderInspectRunViewerHtml,
  renderTargetKey,
} from "./rendering.mjs";
import {
  createInspectionViewerAdapter,
  normalizeInspectionTarget,
} from "../_inspect-run-viewer-adapter.mjs";
import { dedupeRepoSlugOptions, repoSlugEquals } from "@dev-loops/core/github/repo-slug";
import { buildDevLoopHandoffEnvelope } from "@dev-loops/core/loop/handoff-envelope";
import { loadDevLoopConfig } from "@dev-loops/core/config";

const execFile = promisify(execFileCallback);

function makeAdapterOptions(options) {
  const adapterOptions = {};
  if (options.steeringStateFile !== undefined) {
    adapterOptions.steeringStateFile = options.steeringStateFile;
  }
  if (options.reviewerLogin !== undefined) {
    adapterOptions.reviewerLogin = options.reviewerLogin;
  }
  if (options.copilotInputPath !== undefined) {
    adapterOptions.copilotInputPath = options.copilotInputPath;
  }
  if (options.reviewerInputPath !== undefined) {
    adapterOptions.reviewerInputPath = options.reviewerInputPath;
  }
  return adapterOptions;
}

function setNoStore(response) {
  response.setHeader("cache-control", "no-store");
}

function writeText(response, statusCode, body, headers = {}) {
  setNoStore(response);
  response.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(body);
}

function writeJson(response, statusCode, payload) {
  setNoStore(response);
  writeText(
    response,
    statusCode,
    `${JSON.stringify(payload, null, 2)}\n`,
    { "content-type": "application/json; charset=utf-8" },
  );
}

function writeHtml(response, html) {
  setNoStore(response);
  writeText(response, 200, html, { "content-type": "text/html; charset=utf-8" });
}

function jsonErrorPayload(target, error) {
  return {
    ok: false,
    target,
    error: {
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function requireSnapshotForJson(snapshot) {
  if (snapshot === null || snapshot === undefined) {
    throw new Error("inspection snapshot unavailable");
  }

  return snapshot;
}


async function runResolverForTarget(target, { repoRoot = process.cwd() } = {}) {
  if (typeof target.repo !== "string" || target.repo.trim().length === 0) {
    throw new Error("Cannot resolve handoff envelope: target repo is required");
  }
  const args = ["scripts/loop/resolve-dev-loop-startup.mjs", "--pr", String(target.pr)];
  const env = { ...process.env, PI_SUBAGENT_RUN_ID: "viewer-operator-tool" };
  const { stdout, stderr } = await execFile("node", args, { cwd: repoRoot, timeout: 30000, env });
  try {
    return JSON.parse(stdout);
  } catch (_err) {
    const preview = (stdout || stderr || "").trim().slice(0, 300);
    throw new Error("Invalid resolver JSON output: " + preview);
  }
}

function parseUpdatedWithinDaysFromUrl(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return DEFAULT_INBOX_UPDATED_WITHIN_DAYS;
  }
  const trimmed = rawValue.trim().toLowerCase();
  if (trimmed === "all") {
    return null;
  }
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    return Number(trimmed);
  }
  const error = new Error("updated must be a positive integer or 'all'");
  error.code = "MALFORMED_TARGET";
  throw error;
}

function parseInboxPageFromUrl(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return DEFAULT_INBOX_PAGE;
  }
  const trimmed = rawValue.trim().toLowerCase();
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    return Number(trimmed);
  }
  const error = new Error("page must be a positive integer");
  error.code = "MALFORMED_TARGET";
  throw error;
}

function parseInboxStateFromUrl(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return DEFAULT_INBOX_PR_STATE;
  }
  const trimmed = rawValue.trim().toLowerCase();
  if (INBOX_STATE_FILTER_VALUES.has(trimmed)) {
    return trimmed;
  }
  const error = new Error(`state must be one of: ${Array.from(INBOX_STATE_FILTER_VALUES).join(", ")}`);
  error.code = "MALFORMED_TARGET";
  throw error;
}

function parseInboxModeFromUrl(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return DEFAULT_INBOX_MODE;
  }
  const trimmed = rawValue.trim().toLowerCase();
  if (INBOX_MODE_FILTER_VALUES.has(trimmed)) {
    return trimmed;
  }
  const error = new Error(`mode must be one of: ${Array.from(INBOX_MODE_FILTER_VALUES).join(", ")}`);
  error.code = "MALFORMED_TARGET";
  throw error;
}

function normalizeRepoQueryParam(rawValue) {
  try {
    return normalizeCliRepoOption(rawValue);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.code = "MALFORMED_TARGET";
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeRequestedViewFromUrl(rawUrl, fixedRepo = null, fallbackTarget = null) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return {
      scopeFilter: fixedRepo,
      target: fallbackTarget,
      updatedWithinDays: DEFAULT_INBOX_UPDATED_WITHIN_DAYS,
      state: DEFAULT_INBOX_PR_STATE,
      mode: DEFAULT_INBOX_MODE,
      page: DEFAULT_INBOX_PAGE,
      pageExplicit: false,
    };
  }

  const url = new URL(rawUrl, "http://localhost");
  const requestedScope = url.searchParams.get("scope");
  const normalizedScope = requestedScope === null || requestedScope.trim().length === 0
    ? null
    : normalizeRepoQueryParam(requestedScope);
  const selectedRepo = url.searchParams.get("repo");
  const normalizedSelectedRepo = selectedRepo === null || selectedRepo.trim().length === 0
    ? null
    : normalizeRepoQueryParam(selectedRepo);

  if (fixedRepo !== null && normalizedScope !== null && !repoSlugEquals(normalizedScope, fixedRepo)) {
    const error = new Error("scope query param must match the repo-scoped viewer");
    error.code = "MALFORMED_TARGET";
    throw error;
  }
  if (fixedRepo !== null && normalizedSelectedRepo !== null && !repoSlugEquals(normalizedSelectedRepo, fixedRepo)) {
    const error = new Error("repo query param must match the repo-scoped viewer");
    error.code = "MALFORMED_TARGET";
    throw error;
  }

  const effectiveScope = fixedRepo ?? normalizedScope;
  const effectiveSelectedRepo = fixedRepo ?? normalizedSelectedRepo;
  const pr = url.searchParams.get("pr");
  if (pr !== null && effectiveSelectedRepo === null) {
    const error = new Error("repo is required when selecting a PR without --repo");
    error.code = "MALFORMED_TARGET";
    throw error;
  }

  return {
    scopeFilter: effectiveScope,
    target: pr === null ? fallbackTarget : normalizeInspectionTarget({ repo: effectiveSelectedRepo, pr }),
    updatedWithinDays: parseUpdatedWithinDaysFromUrl(url.searchParams.get("updated")),
    state: parseInboxStateFromUrl(url.searchParams.get("state")),
    mode: parseInboxModeFromUrl(url.searchParams.get("mode")),
    page: parseInboxPageFromUrl(url.searchParams.get("page")),
    pageExplicit: url.searchParams.has("page"),
  };
}

function dedupeInboxEntries(entries) {
  const seen = new Map();
  const deduped = [];
  for (const entry of entries) {
    const key = renderTargetKey(entry.target);
    const existing = seen.get(key);
    if (existing) {
      if ((existing.title === null || existing.title === undefined) && entry.title) {
        existing.title = entry.title;
      }
      if ((existing.updatedAt === null || existing.updatedAt === undefined) && entry.updatedAt) {
        existing.updatedAt = entry.updatedAt;
      }
      if ((existing.signal === null || existing.signal === undefined || existing.signal === "unknown") && entry.signal) {
        existing.signal = normalizeInboxSignal(entry.signal);
      }
      continue;
    }
    const normalizedEntry = {
      target: entry.target,
      title: entry.title ?? null,
      updatedAt: entry.updatedAt ?? null,
      signal: normalizeInboxSignal(entry.signal),
    };
    seen.set(key, normalizedEntry);
    deduped.push(normalizedEntry);
  }
  return deduped;
}

function collectScopeOptions(entries, { selectedTarget = null, scopeFilter = null } = {}) {
  const repos = [];
  if (typeof scopeFilter === "string") {
    repos.push(scopeFilter);
  }
  if (selectedTarget?.repo) {
    repos.push(selectedTarget.repo);
  }
  for (const entry of entries) {
    if (entry?.target?.repo) {
      repos.push(entry.target.repo);
    }
  }
  return dedupeRepoSlugOptions(repos).sort((left, right) => left.localeCompare(right));
}

export function formatInspectRunViewerUrl(host, port) {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${formattedHost}:${port}`).toString().replace(/\/$/, "");
}

function isLsofNoListenerResult(error) {
  if (!error || error.code !== 1) {
    return false;
  }

  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr.length === 0;
}

export async function listListeningPidsForPort(port, { execFileImpl = execFile } = {}) {
  try {
    const { stdout } = await execFileImpl("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    if (isLsofNoListenerResult(error)) {
      return [];
    }
    throw error;
  }
}

export async function restartExistingPortListener(
  port,
  {
    listListeningPidsImpl = listListeningPidsForPort,
    killProcessImpl = (pid, signal) => process.kill(pid, signal),
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 1500,
    pollIntervalMs = 50,
  } = {},
) {
  const pids = (await listListeningPidsImpl(port)).filter((pid) => pid !== process.pid);
  if (pids.length === 0) {
    return [];
  }

  for (const pid of pids) {
    try {
      killProcessImpl(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingListeners = (await listListeningPidsImpl(port)).filter((pid) => pid !== process.pid);
    if (remainingListeners.length === 0) {
      return pids;
    }
    await sleepImpl(pollIntervalMs);
  }

  throw new Error(`--restart could not stop existing listener on port ${port}`);
}

export function createInspectRunViewerServer(options, deps = {}) {
  const adapter = deps.adapter ?? createInspectionViewerAdapter();
  const loadMermaidBrowserScriptImpl = deps.loadMermaidBrowserScriptImpl ?? loadMermaidBrowserScript;
  const logErrorImpl = deps.logErrorImpl ?? (() => {});
  const fixedRepo = options.repo === undefined ? null : normalizeCliRepoOption(options.repo);
  const fallbackTarget = options.pr === undefined || options.pr === null || fixedRepo === null
    ? null
    : normalizeInspectionTarget({ repo: fixedRepo, pr: options.pr });
  const adapterOptions = makeAdapterOptions(options);
  const supportsAssignedInbox = options.copilotInputPath === undefined && options.reviewerInputPath === undefined;
  const jsonErrorTarget = fallbackTarget ?? { repo: fixedRepo, pr: null };
  const cachedInboxSignals = new Map();
  const CACHED_INBOX_SIGNALS_MAX = 200;
  function setCachedInboxSignal(key, value) {
    if (cachedInboxSignals.size >= CACHED_INBOX_SIGNALS_MAX) {
      cachedInboxSignals.delete(cachedInboxSignals.keys().next().value);
    }
    cachedInboxSignals.set(key, value);
  }

  return createServer(async (request, response) => {
    try {
      const requestPath = request.url ? new URL(request.url, "http://localhost").pathname : "/";
      const method = request.method ?? "GET";

      if (requestPath === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (requestPath !== "/" && requestPath !== "/snapshot.json" && requestPath !== "/handoff-envelope.json" && requestPath !== MERMAID_BROWSER_ASSET_ROUTE) {
        writeText(response, 404, "Not Found", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }

      if (method !== "GET") {
        writeText(response, 405, "Method Not Allowed", {
          allow: "GET",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }

      if (requestPath === MERMAID_BROWSER_ASSET_ROUTE) {
        try {
          const mermaidBrowserScript = await loadMermaidBrowserScriptImpl();
          writeText(response, 200, mermaidBrowserScript, {
            "content-type": "application/javascript; charset=utf-8",
          });
        } catch (error) {
          logErrorImpl(error);
          writeText(response, 500, "Mermaid browser asset unavailable", {
            "content-type": "text/plain; charset=utf-8",
          });
        }
        return;
      }

      let requestedView;
      try {
        requestedView = normalizeRequestedViewFromUrl(request.url, fixedRepo, fallbackTarget);
      } catch (error) {
        if (requestPath === "/snapshot.json" && error?.code === "MALFORMED_TARGET") {
          writeJson(response, 400, jsonErrorPayload(jsonErrorTarget, error));
          return;
        }
        throw error;
      }

      const listAssignedPullRequests = typeof adapter.listAssignedPullRequests === "function"
        ? adapter.listAssignedPullRequests.bind(adapter)
        : async () => [];
      const normalizeAssignedEntries = (rawEntries) => (Array.isArray(rawEntries)
        ? rawEntries.flatMap((entry) => {
          try {
            if (entry && typeof entry === "object" && entry.target) {
              return [{
                target: normalizeInspectionTarget(entry.target),
                title: entry.title ?? null,
                updatedAt: entry.updatedAt ?? null,
                signal: normalizeInboxSignal(entry.signal),
              }];
            }
            return [{ target: normalizeInspectionTarget(entry), title: null, updatedAt: null, signal: "unknown" }];
          } catch {
            return [];
          }
        })
        : []);

      let assignedEntries = [];
      let scopeSourceEntries = [];
      if (supportsAssignedInbox) {
        try {
          if (fixedRepo !== null) {
            const rawAssignedEntries = await listAssignedPullRequests({
              ...adapterOptions,
              repo: fixedRepo,
              updatedWithinDays: requestedView.updatedWithinDays,
              limit: MAX_INBOX_RESULT_LIMIT,
              state: requestedView.state,
              mode: requestedView.mode,
            });
            assignedEntries = normalizeAssignedEntries(rawAssignedEntries);
            scopeSourceEntries = assignedEntries;
          } else {
            const loadAssignedEntries = (repo) => listAssignedPullRequests({
              ...adapterOptions,
              repo,
              updatedWithinDays: requestedView.updatedWithinDays,
              limit: MAX_INBOX_RESULT_LIMIT,
              state: requestedView.state,
              mode: requestedView.mode,
            });
            if (requestedView.scopeFilter === null) {
              const rawAssignedEntries = await loadAssignedEntries(undefined);
              assignedEntries = normalizeAssignedEntries(rawAssignedEntries);
              scopeSourceEntries = assignedEntries;
            } else {
              const [rawScopeEntries, rawAssignedEntries] = await Promise.all([
                loadAssignedEntries(undefined),
                loadAssignedEntries(requestedView.scopeFilter),
              ]);
              scopeSourceEntries = normalizeAssignedEntries(rawScopeEntries);
              assignedEntries = normalizeAssignedEntries(rawAssignedEntries);
            }
          }
        } catch (error) {
          logErrorImpl(error);
          assignedEntries = [];
          scopeSourceEntries = [];
        }
      }

      const requestedPage = requestedView.page ?? DEFAULT_INBOX_PAGE;
      const selectedTargetMatches = requestedView.target !== null
        && assignedEntries.some((entry) => renderTargetKey(entry.target) === renderTargetKey(requestedView.target));
      const effectiveSelectedTarget = supportsAssignedInbox && requestedView.target !== null
        ? (assignedEntries.length === 0 || selectedTargetMatches ? requestedView.target : null)
        : requestedView.target;
      const selectedIndex = effectiveSelectedTarget === null
        ? -1
        : assignedEntries.findIndex((entry) => renderTargetKey(entry.target) === renderTargetKey(effectiveSelectedTarget));
      const totalPages = Math.max(1, Math.ceil(assignedEntries.length / DEFAULT_INBOX_PAGE_SIZE));
      const explicitRequestedPage = requestedView.pageExplicit === true;
      const effectivePage = !explicitRequestedPage && selectedIndex >= 0
        ? (Math.floor(selectedIndex / DEFAULT_INBOX_PAGE_SIZE) + 1)
        : Math.min(Math.max(requestedPage, DEFAULT_INBOX_PAGE), totalPages);
      const pageStart = (effectivePage - 1) * DEFAULT_INBOX_PAGE_SIZE;
      const pagedEntries = assignedEntries.slice(pageStart, pageStart + DEFAULT_INBOX_PAGE_SIZE);
      const requestTarget = requestedView.target ?? effectiveSelectedTarget ?? pagedEntries[0]?.target ?? null;

      if (requestPath === "/handoff-envelope.json") {
        if (requestTarget === null) {
          writeJson(response, 400, jsonErrorPayload(jsonErrorTarget, new Error("handoff-envelope.json requires ?pr=<number> when no PR is currently selected")));
          return;
        }
        try {
          const resolverResult = await runResolverForTarget(requestTarget, { repoRoot: process.cwd() });
          if (!resolverResult || resolverResult.bundleKind !== "resolved") {
            writeJson(response, 400, { ok: false, target: requestTarget, error: { message: "Resolver did not return a resolved bundle; handoff envelope unavailable." } });
            return;
          }
          const { config: devLoopConfig, errors: configErrors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
          if (configErrors && configErrors.length > 0) {
            writeJson(response, 500, { ok: false, target: requestTarget, error: { message: "Dev-loop config has validation errors; handoff envelope unavailable." } });
            return;
          }
          let gateState = {};
          try {
            const snapshot = await adapter.loadSnapshot(requestTarget, adapterOptions);
            if (snapshot) {
              gateState = {
                currentHeadSha: snapshot.currentHeadSha || null,
                ciStatus: snapshot.ciStatus || null,
                unresolvedThreadCount: typeof snapshot.unresolvedThreadCount === "number" ? snapshot.unresolvedThreadCount : 0,
                copilotRoundCount: typeof snapshot.copilotRoundCount === "number" ? snapshot.copilotRoundCount : 0,
              };
            }
          } catch {
            // Snapshot unavailable — gateState stays empty
          }
          const envelope = buildDevLoopHandoffEnvelope(resolverResult, devLoopConfig, gateState);
          writeJson(response, 200, envelope);
        } catch (error) {
          writeJson(response, 500, jsonErrorPayload(requestTarget, error));
        }
        return;
      }

      if (requestPath === "/snapshot.json") {
        if (requestTarget === null) {
          writeJson(response, 400, jsonErrorPayload(jsonErrorTarget, new Error("snapshot.json requires ?pr=<number> when no PR is currently selected")));
          return;
        }
        try {
          const snapshot = requireSnapshotForJson(await adapter.loadSnapshot(requestTarget, adapterOptions));
          setCachedInboxSignal(renderTargetKey(requestTarget), deriveInboxSignalFromSnapshot(snapshot));
          writeJson(response, 200, snapshot);
        } catch (error) {
          writeJson(response, 500, jsonErrorPayload(requestTarget, error));
        }
        return;
      }

      const inboxEntries = dedupeInboxEntries(pagedEntries);

      let snapshot = null;
      let handoffEnvelope = null;
      let error = null;
      if (requestTarget !== null) {
        try {
          snapshot = await adapter.loadSnapshot(requestTarget, adapterOptions);
          if (snapshot !== null && snapshot !== undefined) {
            setCachedInboxSignal(renderTargetKey(requestTarget), deriveInboxSignalFromSnapshot(snapshot));
          }
        } catch (caught) {
          error = caught instanceof Error ? caught : new Error(String(caught));
        }
        try {
          if (typeof adapter.loadHandoffEnvelope === "function") {
            handoffEnvelope = await adapter.loadHandoffEnvelope(requestTarget, snapshot, adapterOptions);
          } else {
            const resolverResult = await runResolverForTarget(requestTarget, { repoRoot: process.cwd() });
            if (resolverResult && resolverResult.bundleKind === "resolved") {
              const { config: devLoopConfig, errors: configErrors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
              if (!configErrors || configErrors.length === 0) {
                const gateState = snapshot ? {
                  currentHeadSha: snapshot.currentHeadSha || null,
                  ciStatus: snapshot.ciStatus || null,
                  unresolvedThreadCount: typeof snapshot.unresolvedThreadCount === "number" ? snapshot.unresolvedThreadCount : 0,
                  copilotRoundCount: typeof snapshot.copilotRoundCount === "number" ? snapshot.copilotRoundCount : 0,
                } : {};
                handoffEnvelope = buildDevLoopHandoffEnvelope(
                  resolverResult,
                  devLoopConfig,
                  gateState,
                  { repoSlug: requestTarget.repo },
                );
              }
            }
          }
        } catch (caught) {
          logErrorImpl(Object.assign(new Error("handoff envelope resolution failed"), { cause: caught }));
          handoffEnvelope = null;
        }
      }

      const inboxItems = inboxEntries.map((inboxEntry) => {
        const inboxTarget = inboxEntry.target;
        const inboxTargetKey = renderTargetKey(inboxTarget);
        const selected = requestTarget !== null && inboxTargetKey === renderTargetKey(requestTarget);
        return {
          target: inboxTarget,
          title: inboxEntry.title ?? `PR #${inboxTarget.pr}`,
          updatedAt: inboxEntry.updatedAt ?? null,
          signal: normalizeInboxSignal(cachedInboxSignals.get(inboxTargetKey), normalizeInboxSignal(inboxEntry.signal)),
          snapshot: selected ? (snapshot ?? null) : null,
        };
      });

      const html = renderInspectRunViewerHtml({
        repo: requestedView.scopeFilter,
        target: requestTarget,
        snapshot: snapshot ?? null,
        handoffEnvelope,
        error,
        inboxItems,
        selectedTitle: requestTarget === null
          ? null
          : assignedEntries.find((entry) => renderTargetKey(entry.target) === renderTargetKey(requestTarget))?.title ?? null,
        scopeOptions: collectScopeOptions(scopeSourceEntries, { selectedTarget: requestTarget, scopeFilter: requestedView.scopeFilter }),
        inboxUpdatedWithinDays: requestedView.updatedWithinDays,
        inboxState: requestedView.state,
        inboxMode: requestedView.mode,
        inboxPage: effectivePage,
        inboxTotalPages: totalPages,
      });
      writeHtml(response, html);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const malformedRequest = /invalid url|uri malformed/i.test(message) || caught?.code === "MALFORMED_TARGET";
      writeText(
        response,
        malformedRequest ? 400 : 500,
        malformedRequest ? "Bad Request" : "Internal Server Error",
        { "content-type": "text/plain; charset=utf-8" },
      );
    }
  });
}
