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
import { renderHandoffEnvelopeSection } from "./handoff-envelope-renderer.mjs";
import { renderLoopIterationMetrics } from "./status.mjs";
import { escapeHtml } from "./shared.mjs";
import {
  deriveInboxSignalFromSnapshot,
  loadMermaidBrowserScript,
  normalizeInboxSignal,
  renderInspectRunViewerHtml,
  renderTargetKey,
} from "./rendering.mjs";
import {
  createInspectionViewerAdapter,
  describeRetryAfter,
  isRateLimitError,
  normalizeInspectionTarget,
  readRateLimitResetMs,
} from "../_inspect-run-viewer-adapter.mjs";
import { dedupeRepoSlugOptions, repoSlugEquals } from "@dev-loops/core/github/repo-slug";
import { buildDevLoopHandoffEnvelope } from "@dev-loops/core/loop/handoff-envelope";
import { runContextEnv } from "@dev-loops/core/loop/run-context";
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


async function runResolverForTarget(target, { repoRoot = process.cwd(), timeoutMs = 30000 } = {}) {
  if (typeof target.repo !== "string" || target.repo.trim().length === 0) {
    throw new Error("Cannot resolve handoff envelope: target repo is required");
  }
  // `--no-reconcile`: the viewer is read-only, and the resolver's post-emit board
  // self-heal is a write path whose gh fan-out dominated this call's wall time.
  const args = ["scripts/loop/resolve-dev-loop-startup.mjs", "--pr", String(target.pr), "--no-reconcile"];
  // Read-only envelope preview: never claims and must render PRs the operator
  // does not own, so the ownership gate is bypassed like every inspection path.
  const env = { ...process.env, ...runContextEnv("viewer-operator-tool"), DEVLOOPS_OWNERSHIP_BYPASS: "1" };
  const { stdout, stderr } = await execFile("node", args, { cwd: repoRoot, timeout: timeoutMs, env });
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
  // Seams for the three subprocess-spawning paths. Without them a unit test that
  // walks the rate-limit branch really runs `gh api -i graphql` (one GraphQL
  // point per run, unbounded wall time), and nothing can assert that the page
  // render does NOT spawn the resolver.
  const runResolverForTargetImpl = deps.runResolverForTargetImpl ?? runResolverForTarget;
  const loadDevLoopConfigImpl = deps.loadDevLoopConfigImpl ?? loadDevLoopConfig;
  const readRateLimitResetMsImpl = deps.readRateLimitResetMsImpl ?? readRateLimitResetMs;
  const fixedRepo = options.repo === undefined ? null : normalizeCliRepoOption(options.repo);
  const fallbackTarget = options.pr === undefined || options.pr === null || fixedRepo === null
    ? null
    : normalizeInspectionTarget({ repo: fixedRepo, pr: options.pr });
  const adapterOptions = makeAdapterOptions(options);
  const supportsAssignedInbox = options.copilotInputPath === undefined && options.reviewerInputPath === undefined;
  const jsonErrorTarget = fallbackTarget ?? { repo: fixedRepo, pr: null };
  const cachedInboxSignals = new Map();
  const CACHED_INBOX_SIGNALS_MAX = 200;
  // The handoff envelope needs a full resolver spawn (tens of seconds), so the
  // page render never waits on it: it renders whatever is already cached, and
  // the resolve happens only when the operator opens the handoff tab and the
  // client fetches `/handoff-envelope.html`. `/handoff-envelope.json` still
  // resolves synchronously for callers that want the envelope itself.
  const handoffEnvelopeCache = new Map();
  const HANDOFF_ENVELOPE_CACHE_TTL_MS = 5 * 60 * 1000;
  const RATE_LIMIT_PROBE_TTL_MS = 60 * 1000;
  let rateLimitResetProbe = null;
  function setCachedInboxSignal(key, value) {
    if (cachedInboxSignals.size >= CACHED_INBOX_SIGNALS_MAX) {
      cachedInboxSignals.delete(cachedInboxSignals.keys().next().value);
    }
    cachedInboxSignals.set(key, value);
  }

  function gateStateFromSnapshot(snapshot) {
    return snapshot
      ? {
        currentHeadSha: snapshot.currentHeadSha || null,
        ciStatus: snapshot.ciStatus || null,
        unresolvedThreadCount: typeof snapshot.unresolvedThreadCount === "number" ? snapshot.unresolvedThreadCount : 0,
        copilotRoundCount: typeof snapshot.copilotRoundCount === "number" ? snapshot.copilotRoundCount : 0,
      }
      : {};
  }

  // Returns the ENTRY, not the envelope: a target whose envelope legitimately
  // resolves to null must still count as a hit, or the 5-minute cache never
  // suppresses anything and every handoff-tab open re-spawns the resolver.
  function readCachedHandoffEnvelope(target) {
    const entry = handoffEnvelopeCache.get(renderTargetKey(target));
    if (!entry || (Date.now() - entry.cachedAt) > HANDOFF_ENVELOPE_CACHE_TTL_MS) {
      return null;
    }
    return entry;
  }

  // One source of gate state for every envelope representation: the HTML
  // fragment and `/handoff-envelope.json` must not describe the same target's
  // head SHA and CI status differently.
  async function loadGateState(target) {
    try {
      return gateStateFromSnapshot(await adapter.loadSnapshot(target, { ...adapterOptions, includeLoopIterations: false }));
    } catch {
      return {};
    }
  }

  function writeCachedHandoffEnvelope(target, envelope) {
    handoffEnvelopeCache.set(renderTargetKey(target), { cachedAt: Date.now(), envelope });
  }

  // One in-flight warm per target: repeated renders never stack resolver spawns.
  const handoffEnvelopeWarming = new Map();
  function warmHandoffEnvelope(target, gateState) {
    const key = renderTargetKey(target);
    const inFlight = handoffEnvelopeWarming.get(key);
    if (inFlight) {
      return inFlight;
    }
    const warming = (async () => {
      // The handoff tab shows a status line while this runs, so it gets a
      // generous timeout instead of the request-path one it used to time out
      // against.
      const resolverResult = await runResolverForTargetImpl(target, { repoRoot: process.cwd(), timeoutMs: 120000 });
      if (!resolverResult || resolverResult.bundleKind !== "resolved") {
        return null;
      }
      const { config: devLoopConfig, errors: configErrors } = await loadDevLoopConfigImpl({ repoRoot: process.cwd() });
      if (configErrors && configErrors.length > 0) {
        return null;
      }
      return buildDevLoopHandoffEnvelope(
        resolverResult,
        devLoopConfig,
        gateState,
        { repoSlug: target.repo },
      );
    })()
      .then((envelope) => {
        writeCachedHandoffEnvelope(target, envelope);
        return envelope;
      })
      .catch((error) => {
        logErrorImpl(Object.assign(new Error("handoff envelope resolution failed"), { cause: error }));
        return null;
      })
      .finally(() => {
        handoffEnvelopeWarming.delete(key);
      });
    handoffEnvelopeWarming.set(key, warming);
    return warming;
  }

  async function resolveHandoffEnvelopeForFragment(target) {
    const cached = readCachedHandoffEnvelope(target);
    if (cached) {
      return cached.envelope;
    }
    // Gate state comes from the same snapshot `/handoff-envelope.json` uses, so
    // the two representations of one target cannot disagree on head SHA / CI.
    const gateState = await loadGateState(target);
    if (typeof adapter.loadHandoffEnvelope === "function") {
      return adapter.loadHandoffEnvelope(target, gateState, adapterOptions);
    }
    return warmHandoffEnvelope(target, gateState);
  }

  const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
  async function respondWithFragment(requestPath, target, response) {
    const roundMetrics = requestPath === "/round-metrics.html";
    if (target === null) {
      writeText(
        response,
        400,
        roundMetrics
          ? "<p>Select a PR first.</p>"
          : "<section class=\"viewer-card\"><h3>Agent handoff</h3><p>Select a PR first.</p></section>",
        HTML_HEADERS,
      );
      return;
    }
    try {
      // Feature-detected like every other optional adapter method here: an
      // injected adapter without this one (every pre-existing one) must render
      // the route's own empty state, not a raw `... is not a function` string.
      const loadLoopIterations = typeof adapter.loadLoopIterations === "function"
        ? adapter.loadLoopIterations.bind(adapter)
        : async () => null;
      const body = roundMetrics
        ? renderLoopIterationMetrics(await loadLoopIterations(target, adapterOptions) ?? null)
        : renderHandoffEnvelopeSection(await resolveHandoffEnvelopeForFragment(target));
      writeText(response, 200, body, HTML_HEADERS);
    } catch (error) {
      logErrorImpl(error);
      const message = escapeHtml(error instanceof Error ? error.message : String(error));
      writeText(
        response,
        500,
        roundMetrics
          ? `<p>Round metrics unavailable: ${message}</p>`
          : `<section class="viewer-card"><h3>Agent handoff</h3><p>${message}</p></section>`,
        HTML_HEADERS,
      );
    }
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

      // Liveness only: answered from memory, never touches `gh`. The managed
      // launcher polls this instead of rendering the dashboard to prove the
      // port is up.
      if (requestPath === "/healthz") {
        writeText(response, 200, "ok\n", { "content-type": "text/plain; charset=utf-8" });
        return;
      }

      if (requestPath !== "/" && requestPath !== "/snapshot.json" && requestPath !== "/handoff-envelope.json" && requestPath !== "/handoff-envelope.html" && requestPath !== "/round-metrics.html" && requestPath !== MERMAID_BROWSER_ASSET_ROUTE) {
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

      // `?refresh=1` forces a live re-fetch of the SELECTED target on the page
      // render only. The inbox listing and every other cached target are
      // untouched, and the JSON routes stay behind the cache so a polling client
      // or a bookmarked `?refresh=1` URL cannot re-run the fan-out per request.
      const selectedTargetOptions = requestPath === "/"
        && typeof request.url === "string"
        && new URL(request.url, "http://localhost").searchParams.get("refresh") === "1"
        ? { ...adapterOptions, refresh: true }
        : adapterOptions;

      // Both fragment routes are parameterized by their OWN `?repo=&pr=` and
      // render data for THAT pr, so they resolve their target from the request
      // alone: no inbox fallback, and a missing or unparseable target is a 400
      // rather than a 200 carrying a different PR's data. Answering here, before
      // the inbox query, also keeps a fragment fetch off `gh search` entirely.
      if (requestPath === "/round-metrics.html" || requestPath === "/handoff-envelope.html") {
        await respondWithFragment(requestPath, requestedView.target, response);
        return;
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
      // A failed inbox query (rate limit, auth, network) used to render exactly
      // like a genuinely empty inbox. Keep it and surface it on the page.
      let inboxError = null;
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
          inboxError = error instanceof Error ? error : new Error(String(error));
          // A rate-limited operator's first question is "when can I retry?".
          // The reset moment does not move, so the probe is cached: a rate-limited
          // viewer must not spend a call per render asking about its own limit.
          if (isRateLimitError(inboxError)) {
            // Cache the PROMISE, not the settled value: assigning only after the
            // await let every concurrent render (two tabs auto-reloading on the
            // same tick) start its own probe, each spending budget the operator
            // has already run out of. Same promise-caching rule as every other
            // cache here.
            if (rateLimitResetProbe === null || Date.now() > rateLimitResetProbe.expiresAt) {
              const promise = readRateLimitResetMsImpl({ ...adapterOptions });
              rateLimitResetProbe = { promise, expiresAt: Date.now() + RATE_LIMIT_PROBE_TTL_MS };
              promise.catch(() => {
                if (rateLimitResetProbe?.promise === promise) {
                  rateLimitResetProbe = null;
                }
              });
            }
            const retryHint = describeRetryAfter(await rateLimitResetProbe.promise);
            if (retryHint !== null) {
              inboxError = new Error(`${inboxError.message} ${retryHint}`);
            }
          }
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
          const resolverResult = await runResolverForTargetImpl(requestTarget, { repoRoot: process.cwd() });
          if (!resolverResult || resolverResult.bundleKind !== "resolved") {
            writeJson(response, 400, { ok: false, target: requestTarget, error: { message: "Resolver did not return a resolved bundle; handoff envelope unavailable." } });
            return;
          }
          const { config: devLoopConfig, errors: configErrors } = await loadDevLoopConfigImpl({ repoRoot: process.cwd() });
          if (configErrors && configErrors.length > 0) {
            writeJson(response, 500, { ok: false, target: requestTarget, error: { message: "Dev-loop config has validation errors; handoff envelope unavailable." } });
            return;
          }
          const envelope = buildDevLoopHandoffEnvelope(resolverResult, devLoopConfig, await loadGateState(requestTarget));
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
          const snapshot = requireSnapshotForJson(await adapter.loadSnapshot(requestTarget, selectedTargetOptions));
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
          // Page render skips the loop-iteration fan-out (6 of ~20 gh calls);
          // the client pulls it from /round-metrics.html after first paint.
          snapshot = await adapter.loadSnapshot(requestTarget, { ...selectedTargetOptions, includeLoopIterations: false });
          if (snapshot !== null && snapshot !== undefined) {
            setCachedInboxSignal(renderTargetKey(requestTarget), deriveInboxSignalFromSnapshot(snapshot));
          }
        } catch (caught) {
          error = caught instanceof Error ? caught : new Error(String(caught));
        }
        if (typeof adapter.loadHandoffEnvelope === "function") {
          // Injected loader: in-process and cheap, so it still resolves inline.
          try {
            handoffEnvelope = await adapter.loadHandoffEnvelope(requestTarget, snapshot, adapterOptions);
          } catch (caught) {
            logErrorImpl(Object.assign(new Error("handoff envelope resolution failed"), { cause: caught }));
            handoffEnvelope = null;
          }
        } else {
          // Resolver-backed envelope: served lazily to the handoff tab via
          // /handoff-envelope.html, so the page render never waits on a spawn.
          handoffEnvelope = readCachedHandoffEnvelope(requestTarget)?.envelope ?? null;
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
        inboxError: inboxError === null ? null : inboxError.message,
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
