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

const MUST_FIX = "must-fix";

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
 * @param {{message?:string}[]} [input.pageErrors] - from page.on('pageerror')
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
    // An error response is anything outside 2xx/3xx (status <200 or >=400). 3xx
    // redirects are normal navigation (login/canonical), not errors, so they are
    // not flagged. A swallowed 500 lands here even when the page rendered a
    // success state, because the listener sees the wire.
    if (typeof r.status === "number" && (r.status < 200 || r.status >= 400)) {
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
    failures.push({
      kind: "request-failed",
      severity: MUST_FIX,
      url: f.url ?? null,
      message: `request failed${f.url ? ` at ${f.url}` : ""}${f.failure ? `: ${f.failure}` : ""}`,
    });
  }

  for (const e of pageErrors) {
    failures.push({
      kind: "page-error",
      severity: MUST_FIX,
      message: `uncaught page error: ${e.message ?? "(no message)"}`,
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
      for (const line of serverLogTail.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && re.test(trimmed)) {
          failures.push({
            kind: "server-log-exception",
            severity: MUST_FIX,
            message: `server log exception: ${trimmed.slice(0, 500)}`,
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
  { appUrl, login, flows = [], interstitials = [], changedPaths = [], serverLogExceptionPattern, caps = {} },
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

  const base = () => ({ appUrl: appUrl ?? null, logs });

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
    ...base(),
  };
}
