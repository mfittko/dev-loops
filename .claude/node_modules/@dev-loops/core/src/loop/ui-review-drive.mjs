/**
 * Drive orchestrator for the ui_review route (Stage 2).
 *
 * Authenticates as the change's target role via a project-provided dev-login
 * recipe, then walks the changed UI flows against the arbitrary running-app URL
 * handed off by Stage 1 — rendering each page, exercising its declared
 * interactions, and capturing an ordered set of step screenshots. While it
 * drives, response/requestfailed/pageerror listeners and a server-log tail run
 * so a swallowed error response (a 500 the UI hides) is still recorded.
 *
 * This module is PURE orchestration: all browser/page IO, the auth recipe, the
 * interstitial dismissal, the per-step capture, the event collection, and the
 * server-log tail are injected seams. The thin CLI/harness wires real Playwright
 * (WebKit). The decision logic that lives here is: which flows to drive
 * (a bounded changed-flow heuristic over an explicit allowlist), cap
 * enforcement (max screenshots, screens skipped, no-retry) with explicit logs,
 * and failure classification (collating error responses, request failures,
 * page errors, and server-log exceptions into one structured list).
 *
 * Fail closed: a can't-authenticate condition STOPS with a stated reason and
 * drives nothing. The structured captured-failures list feeds the next stage.
 *
 * Out of scope (later stages): exception -> source-line mapping, review
 * posting, visual-regression/pixel-diffing, cross-browser matrix.
 */

import { trimmedOrNull } from "./normalize.mjs";

const MUST_FIX = "must-fix";

/** Request header the drive advertises its drive-session id on, so a cooperating
 * app can tag the dev-DB rows a create/edit/upload persists during the walk.
 * Stage-5 teardown deletes exactly those tagged rows from an emitted manifest. */
export const DRIVE_SESSION_HEADER = "X-UI-Review-Drive-Session";

/** Step actions that can persist dev-DB state (a create/edit/reorder/upload/
 * toggle). `goto` is navigation and `fill` only types into a field before a
 * submit, so neither is recorded as a row-creating mutation in the manifest. */
const MUTATING_ACTIONS = new Set(["click", "select", "upload", "dispatch"]);

/** The one owner of the error-response threshold: an error response is anything
 * outside 2xx/3xx. 3xx redirects are normal navigation (login/canonical), not
 * errors, so they are not flagged. Shared by the CLI listener's pre-filter (for
 * buffer bounding) and the classifier, so the policy has a single source. */
export function isErrorResponseStatus(status) {
  return typeof status === "number" && (status < 200 || status >= 400);
}

/** The one owner of the request-abort carve-out: a request the browser itself
 * aborted carries no defect signal. Navigating away cancels in-flight asset
 * requests, so these appear on every multi-step flow. Matched per engine:
 * WebKit reports "cancelled", Chromium "net::ERR_ABORTED", Firefox
 * "NS_BINDING_ABORTED". Matching is case-insensitive and substring-based because
 * engines wrap the token in longer text. A genuine DNS/connection/TLS failure
 * carries a different token and is still classified must-fix. */
export function isAbortedRequestFailure(failure) {
  if (typeof failure !== "string") return false;
  const f = failure.toLowerCase();
  return f.includes("cancelled") || f.includes("canceled") || f.includes("err_aborted") || f.includes("ns_binding_aborted");
}

/** Bound the stack text carried onto a page-error failure so a runaway stack
 * (or a synthetic error with a huge stack) can't bloat the feed envelope. Keeps
 * the head — the top frames, where the throwing file:line sits. Exported so the
 * per-state console.json shaping clamps to the SAME bound as the mechanical feed. */
export const PAGE_ERROR_STACK_MAX_CHARS = 4000;

/** Lines of context to preserve on each side of a matching server-log line, so
 * the traceback frames that carry file:line (often on adjacent, non-matching
 * lines) survive into the Stage 3 feed. */
const SERVER_LOG_CONTEXT_LINES = 4;
/** Char cap on the preserved server-log context window per failure entry. */
const SERVER_LOG_CONTEXT_MAX_CHARS = 2000;

/** Bounded caps. A project cannot raise these past the ceilings — the walker is
 * a diagnostic pass over the changed flows, never an unbounded crawl. */
export const DEFAULT_DRIVE_CAPS = Object.freeze({
  maxScreenshots: 40,
  maxFlows: 12,
  maxStepsPerFlow: 20,
  // No-retry is a fixed policy, not a tunable: a flaky step is a finding, not
  // something to paper over by re-running. Logged explicitly on every run.
  retries: 0,
});

/** Merge project caps onto the defaults, clamping each to its ceiling so a
 * recipe can only tighten a cap, never loosen it past the diagnostic budget. */
export function resolveCaps(caps = {}) {
  const clamp = (v, ceiling) =>
    Number.isInteger(v) && v >= 0 ? Math.min(v, ceiling) : ceiling;
  return {
    maxScreenshots: clamp(caps.maxScreenshots, DEFAULT_DRIVE_CAPS.maxScreenshots),
    maxFlows: clamp(caps.maxFlows, DEFAULT_DRIVE_CAPS.maxFlows),
    maxStepsPerFlow: clamp(caps.maxStepsPerFlow, DEFAULT_DRIVE_CAPS.maxStepsPerFlow),
    retries: 0,
  };
}

/**
 * Changed-flow discovery: pick which allowlisted flows to drive.
 *
 * This is a DOCUMENTED HEURISTIC over an EXPLICIT allowlist, never an unbounded
 * crawl. Each flow declares `pathPatterns` (plain substrings matched against the
 * PR's changed file paths). A flow is in scope when any changed path contains
 * any of its patterns. A flow with no `pathPatterns` is always in scope (the
 * project opted it into every run). When `changedPaths` is empty/absent the diff
 * is unknown, so every allowlisted flow is driven — the safe over-approximation.
 * The selection is then capped at `caps.maxFlows`; the overflow is skipped and
 * logged, never silently dropped.
 *
 * @returns {{ selected: object[], skipped: {name:string, reason:string}[] }}
 */
export function selectFlows({ flows = [], changedPaths = [], caps = DEFAULT_DRIVE_CAPS } = {}) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const haveDiff = paths.length > 0;
  const matched = [];
  const skipped = [];
  for (const flow of flows) {
    const patterns = Array.isArray(flow.pathPatterns) ? flow.pathPatterns : [];
    let inScope;
    if (!haveDiff || patterns.length === 0) {
      inScope = true; // unknown diff, or an always-on flow
    } else {
      inScope = patterns.some((p) => paths.some((cp) => cp.includes(p)));
    }
    if (inScope) matched.push(flow);
    else skipped.push({ name: flow.name, reason: "no changed path matched its pathPatterns" });
  }
  const selected = matched.slice(0, caps.maxFlows);
  for (const flow of matched.slice(caps.maxFlows)) {
    skipped.push({ name: flow.name, reason: `maxFlows cap (${caps.maxFlows}) reached` });
  }
  return { selected, skipped };
}

/**
 * Classify raw captured events + the server-log tail into one structured failure
 * list. Pure. This is where a swallowed error response surfaces twice — once
 * from the response listener and once from the server-log tail — so a 500 the UI
 * hid is still recorded.
 *
 * @param {object} input
 * @param {{url?:string,status:number}[]} [input.responses] - from page.on('response')
 * @param {{url?:string,failure?:string}[]} [input.requestFailures] - from page.on('requestfailed')
 * @param {{message?:string,stack?:string|null}[]} [input.pageErrors] - from page.on('pageerror'); `stack` (file:line) feeds Stage 3
 * @param {string} [input.serverLogTail] - tail text of the project server log
 * @param {string} [input.serverLogExceptionPattern] - regex (source) flagging a log exception line
 * @returns {{kind:string, severity:string, message:string, [k:string]:unknown}[]}
 */
export function classifyFailures({
  responses = [],
  requestFailures = [],
  pageErrors = [],
  serverLogTail = "",
  serverLogExceptionPattern,
} = {}) {
  const failures = [];

  for (const r of responses) {
    // A swallowed 500 lands here even when the page rendered a success state,
    // because the listener sees the wire. The error-response threshold has one
    // owner: isErrorResponseStatus.
    if (isErrorResponseStatus(r.status)) {
      failures.push({
        kind: "error-response",
        severity: MUST_FIX,
        status: r.status,
        url: r.url ?? null,
        message: `error response ${r.status}${r.url ? ` at ${r.url}` : ""}`,
      });
    }
  }

  for (const f of requestFailures) {
    // A request the BROWSER aborted is not evidence of a defect: navigating away
    // cancels every asset request still in flight, so a flow with more than one
    // `goto` manufactures one of these per unfinished image/font on the page it
    // left. Measured on sofatutor 2026-08-05: a clean two-goto admin2 walk
    // produced 13, all "cancelled", all classified must-fix — and since
    // `ok: failures.length === 0`, they failed an otherwise passing drive and
    // would have been posted as findings against the PR. This is the request-abort
    // counterpart of the 3xx carve-out in isErrorResponseStatus: a real
    // server/network fault still arrives with its own failure text and is kept.
    if (isAbortedRequestFailure(f.failure)) continue;
    failures.push({
      kind: "request-failed",
      severity: MUST_FIX,
      url: f.url ?? null,
      message: `request failed${f.url ? ` at ${f.url}` : ""}${f.failure ? `: ${f.failure}` : ""}`,
    });
  }

  for (const e of pageErrors) {
    // Carry the bounded stack so Stage 3's exception -> source-line mapping has
    // the file:line signal; null when the listener captured no stack.
    const stack = typeof e.stack === "string" && e.stack.length > 0 ? e.stack.slice(0, PAGE_ERROR_STACK_MAX_CHARS) : null;
    failures.push({
      kind: "page-error",
      severity: MUST_FIX,
      message: `uncaught page error: ${e.message ?? "(no message)"}`,
      stack,
    });
  }

  if (serverLogTail && serverLogExceptionPattern) {
    // Config validates the pattern only on the CLI path; a direct caller can
    // pass an invalid regex. Guard the compile so a bad pattern degrades to a
    // surfaced note instead of throwing and breaking the whole drive envelope.
    let re;
    try {
      re = new RegExp(serverLogExceptionPattern, "iu");
    } catch (err) {
      failures.push({
        kind: "server-log-pattern-invalid",
        severity: "note",
        message: `server-log exception pattern is not a valid regex; skipped server-log classification: ${err?.message ?? String(err)}`,
      });
    }
    if (re) {
      const lines = serverLogTail.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (trimmed.length > 0 && re.test(trimmed)) {
          // Preserve the contiguous frames around the match: the file:line the
          // traceback carries usually sits on adjacent, non-matching lines that
          // the per-line match alone would drop. Bounded on both axes.
          const from = Math.max(0, i - SERVER_LOG_CONTEXT_LINES);
          const to = Math.min(lines.length, i + SERVER_LOG_CONTEXT_LINES + 1);
          const context = lines.slice(from, to).join("\n").slice(0, SERVER_LOG_CONTEXT_MAX_CHARS);
          failures.push({
            kind: "server-log-exception",
            severity: MUST_FIX,
            message: `server log exception: ${trimmed.slice(0, 500)}`,
            context,
          });
        }
      }
    }
  }

  return failures;
}

/**
 * Run the auth + drive sequence over the changed flows.
 *
 * @param {object} input
 * @param {string} input.appUrl - The arbitrary running-app URL from Stage 1.
 * @param {object} input.login - Resolved dev-login recipe (loginUrl + selectors).
 * @param {string|null} [input.driveSession] - Unique id advertised to the app on
 *   DRIVE_SESSION_HEADER; stamps the emitted row manifest so Stage-5 teardown can
 *   drop exactly the rows a mutating step created. Null => no manifest is emitted.
 * @param {object[]} [input.flows] - Allowlisted changed-flow definitions.
 * @param {object[]} [input.interstitials] - Config-declared dismiss selectors.
 * @param {string[]} [input.changedPaths] - Changed file paths (drives selection).
 * @param {string} [input.serverLogExceptionPattern] - regex source for log-tail classification.
 * @param {object} [input.caps] - Project cap overrides (clamped to the ceilings).
 * @param {object} seams - Injected IO.
 * @param {(a:{appUrl:string,login:object})=>Promise<{ok:boolean,detail:string}>} seams.authenticate
 * @param {(a:{interstitials:object[]})=>Promise<{dismissed:string[]}>} [seams.dismissInterstitials]
 * @param {(a:{appUrl:string,flow:object,step:object,index:number})=>Promise<{screenshotPath?:string,statePath?:string,ok?:boolean,detail?:string}>} seams.runStep
 * @param {()=>{responses?:object[],requestFailures?:object[],pageErrors?:object[]}} seams.getCapturedEvents
 * @param {()=>Promise<string>} [seams.readServerLogTail]
 * @param {(msg:string)=>void} [seams.log]
 * @returns {Promise<object>} Result envelope (steps, captures, failures, caps, logs).
 */
export async function driveUiReview(
  { appUrl, login, flows = [], interstitials = [], changedPaths = [], serverLogExceptionPattern, caps = {}, driveSession = null },
  {
    authenticate,
    dismissInterstitials = async () => ({ dismissed: [] }),
    runStep,
    getCapturedEvents,
    readServerLogTail = async () => "",
    log = () => {},
  } = {},
) {
  const logs = [];
  const record = (msg) => {
    logs.push(msg);
    log(msg);
  };
  const resolvedCaps = resolveCaps(caps);
  // No-retry is a fixed policy — log it every run so the bound is never implicit.
  record(`caps: maxScreenshots=${resolvedCaps.maxScreenshots}, maxFlows=${resolvedCaps.maxFlows}, maxStepsPerFlow=${resolvedCaps.maxStepsPerFlow}, retries=${resolvedCaps.retries} (no-retry)`);

  const session = trimmedOrNull(driveSession);
  const base = () => ({ appUrl: appUrl ?? null, logs, driveSession: session });

  // 1. Authenticate as the target role. Fail closed: no session -> STOP, drive
  //    nothing (a review that never reached the app is worthless, not empty).
  const auth = await authenticate({ appUrl, login });
  if (!auth.ok) {
    const stopReason = `cannot authenticate: ${auth.detail ?? "dev-login recipe did not yield a session"}`;
    record(`STOP: ${stopReason}`);
    return {
      ok: false,
      stopped: true,
      stopReason,
      steps: [],
      captures: [],
      failures: [{ kind: "auth-failed", severity: MUST_FIX, message: stopReason }],
      caps: resolvedCaps,
      rowManifest: [],
      ...base(),
    };
  }
  record(`authenticated: ${auth.detail ?? "session established"}`);

  // 2. Dismiss known interstitials ONCE per browser context (config-declared).
  const dismiss = await dismissInterstitials({ interstitials });
  if (dismiss.dismissed?.length) record(`interstitials dismissed: ${dismiss.dismissed.join(", ")}`);

  // 3. Select the changed flows (bounded heuristic over the explicit allowlist).
  const { selected, skipped } = selectFlows({ flows, changedPaths, caps: resolvedCaps });
  for (const s of skipped) record(`flow skipped: ${s.name} (${s.reason})`);
  record(`driving ${selected.length} flow(s)`);

  // 4. Walk each flow's steps, capturing every step, until the screenshot cap.
  //    No retry: a step that throws is recorded as a step failure and the walk
  //    moves on — deterministic, bounded, never re-run.
  const steps = [];
  const captures = [];
  // Row manifest: one session-tagged record per mutating step driven, so Stage-5
  // teardown can drop exactly the dev-DB rows this walk created. Only built when a
  // session is present (no session => nothing to tag => no manifest to drop).
  const rowManifest = [];
  let screenshots = 0;
  let screensSkipped = 0;
  for (const flow of selected) {
    const declaredSteps = Array.isArray(flow.steps) ? flow.steps : [];
    const flowSteps = declaredSteps.slice(0, resolvedCaps.maxStepsPerFlow);
    if (declaredSteps.length > flowSteps.length) {
      record(`steps skipped: ${flow.name} truncated to ${flowSteps.length} step(s) at the maxStepsPerFlow cap (${resolvedCaps.maxStepsPerFlow})`);
    }
    for (let i = 0; i < flowSteps.length; i += 1) {
      const step = flowSteps[i];
      if (screenshots >= resolvedCaps.maxScreenshots) {
        screensSkipped += 1;
        continue;
      }
      let outcome;
      try {
        outcome = await runStep({ appUrl, flow, step, index: screenshots });
      } catch (err) {
        outcome = { ok: false, detail: (err?.message ?? String(err)).slice(0, 500) };
      }
      const ok = outcome?.ok !== false;
      screenshots += 1;
      const entry = {
        flow: flow.name,
        step: step.name ?? step.action ?? `step-${i}`,
        order: screenshots,
        ok,
        screenshotPath: outcome?.screenshotPath ?? null,
        statePath: outcome?.statePath ?? null,
        detail: outcome?.detail ?? null,
      };
      steps.push(entry);
      if (entry.screenshotPath) captures.push({ flow: flow.name, step: entry.step, screenshotPath: entry.screenshotPath, statePath: entry.statePath });
      if (session && MUTATING_ACTIONS.has(step.action)) {
        rowManifest.push({ session, flow: flow.name, step: entry.step, action: step.action });
      }
      if (!ok) record(`step failed (no retry): ${flow.name} / ${entry.step}: ${entry.detail ?? "unknown"}`);
    }
  }
  if (screensSkipped > 0) record(`screens skipped: ${screensSkipped} step(s) past the maxScreenshots cap (${resolvedCaps.maxScreenshots})`);

  // 5. Collate the out-of-band captures: listener events + the server-log tail.
  const events = getCapturedEvents() ?? {};
  const serverLogTail = await readServerLogTail();
  const failures = classifyFailures({
    responses: events.responses ?? [],
    requestFailures: events.requestFailures ?? [],
    pageErrors: events.pageErrors ?? [],
    serverLogTail,
    serverLogExceptionPattern,
  });
  // A step that threw is a drive failure too — surface it in the structured list.
  for (const s of steps) {
    if (!s.ok) failures.push({ kind: "step-failure", severity: MUST_FIX, message: `step failed: ${s.flow} / ${s.step}${s.detail ? `: ${s.detail}` : ""}` });
  }
  record(`captured ${failures.length} failure(s) across ${steps.length} step(s)`);

  return {
    ok: failures.length === 0,
    stopped: false,
    stopReason: null,
    steps,
    captures,
    failures,
    caps: resolvedCaps,
    screensSkipped,
    rowManifest,
    ...base(),
  };
}
