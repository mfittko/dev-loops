#!/usr/bin/env node
/**
 * CLI/harness wrapper for the ui_review drive orchestrator (Stage 2).
 *
 * Launches one headless WebKit context, authenticates as the change's target
 * role via the project's dev-login recipe, dismisses config-declared
 * interstitials once, then walks the changed flows against the arbitrary
 * running-app URL from Stage 1 — capturing a step screenshot + state.json + snapshot.json + axe.json + console.json per
 * step. Response/requestfailed/pageerror listeners plus a server-log tail run
 * throughout so a swallowed error response is still recorded. The per-step
 * capture SLICES the listener buffer (the events since the previous step) into
 * that step's console.json for per-state attribution, WITHOUT clearing the
 * buffer — so the same classified events still reach the drive's walk-level
 * failure gate. The mechanical `ok`/`failures` gate stays authoritative: a
 * captured step-scoped error deterministically fails the drive closed, and keeps
 * its source-line anchoring, independent of the review mode or the LLM.
 *
 * This is a thin adapter: it wires the real IO seams (WebKit browser/page, the
 * page-event listeners, captureNamedUiState, the login form driving, the
 * server-log tail) into the pure core orchestrator
 * (packages/core/src/loop/ui-review-drive.mjs). The decision logic (flow
 * selection, cap enforcement, failure classification) lives in core.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveUiReviewDriveRecipe } from "@dev-loops/core/config";
import { driveUiReview, isErrorResponseStatus, PAGE_ERROR_STACK_MAX_CHARS, DRIVE_SESSION_HEADER } from "@dev-loops/core/loop/ui-review-drive";
import { captureNamedUiState, launchWebkit } from "./ui-review-capture.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  ui-review-drive.mjs --repo-root <p> --app-url <url> --output-dir <p> [--changed-path <p> ...]
Authenticate as the target role and drive the changed UI flows headless (WebKit),
capturing step screenshots + error-response/pageerror/server-log failures (Stage 2 of the ui_review route).
Required:
  --repo-root <p>      Absolute path to the (provisioned) worktree carrying the .devloops recipe.
  --app-url <url>      The running-app URL handed off by Stage 1.
  --output-dir <p>     Directory for the ordered step screenshots + state.json + snapshot.json + axe.json + console.json artifacts.
Optional:
  --changed-path <p>   A changed file path (repeatable); drives the changed-flow selection heuristic.
  -h, --help           Show this help.
Output (stdout, JSON):
  { "ok": bool, "stopped": bool, "stopReason": string|null,
    "steps": [...], "captures": [...], "failures": [...], "caps": {...},
    "appUrl": string|null, "driveSession": string|null, "rowManifest": [...], "logs": [...] }
  driveSession is advertised to the app on the ${DRIVE_SESSION_HEADER} header and stamps
  each rowManifest record (a mutating step), so Stage-5 teardown can drop exactly those rows.
  On the walk (non-stopped) path the envelope also carries "screensSkipped": number
  (steps dropped past the maxScreenshots cap).

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

export function parseUiReviewDriveCliArgs(argv) {
  const options = { help: false, repoRoot: undefined, appUrl: undefined, outputDir: undefined, changedPaths: [] };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      "app-url": { type: "string" },
      "output-dir": { type: "string" },
      "changed-path": { type: "string", multiple: true },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo-root") {
      options.repoRoot = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "app-url") {
      options.appUrl = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "output-dir") {
      options.outputDir = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "changed-path") {
      options.changedPaths.push(requireTokenValue(token, parseError, { flagPattern: /^-/u }));
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  if (!options.appUrl) throw parseError("Missing required --app-url");
  if (!options.outputDir) throw parseError("Missing required --output-dir");
  return options;
}

/**
 * Register the response/requestfailed/pageerror listeners on a page (or any
 * object exposing the same `on(event, cb)` emitter interface, so this is unit
 * testable without a browser). Only error responses (per isErrorResponseStatus,
 * the shared threshold owner) are retained so the buffer stays bounded; the pure
 * classifier decides severity from the collected set.
 *
 * `sliceCapturedEvents()` returns the events appended since the previous slice
 * and advances an internal cursor — it does NOT clear the buffer. The per-step
 * capture slices its window into that state's console.json (per-state
 * attribution), while `getCapturedEvents()` still hands the walk-level classifier
 * the WHOLE buffer at walk end. So attribution and the mechanical fail-closed
 * gate are two views of the same classified events, not a hand-off: a
 * step-scoped error lands in its state's console.json AND still drives the drive's
 * `ok`/`failures` gate (keeping its source-line anchoring). The final human-facing
 * report dedups so the same error is not posted twice.
 *
 * @returns {{ getCapturedEvents: () => {responses:object[],requestFailures:object[],pageErrors:object[]}, sliceCapturedEvents: () => {responses:object[],requestFailures:object[],pageErrors:object[]} }}
 */
export function attachPageListeners(page) {
  const responses = [];
  const requestFailures = [];
  const pageErrors = [];
  page.on("response", (res) => {
    const status = typeof res.status === "function" ? res.status() : res.status;
    if (isErrorResponseStatus(status)) {
      const url = typeof res.url === "function" ? res.url() : res.url;
      responses.push({ url, status });
    }
  });
  page.on("requestfailed", (req) => {
    const url = typeof req.url === "function" ? req.url() : req.url;
    const failure = typeof req.failure === "function" ? req.failure()?.errorText : req.failure;
    requestFailures.push({ url, failure: failure ?? null });
  });
  page.on("pageerror", (err) => {
    // Carry err.stack (the file:line signal Stage 3's exception -> source-line
    // mapping needs); the classifier bounds it before it lands on the feed.
    pageErrors.push({ message: err?.message ?? String(err), stack: err?.stack ?? null });
  });
  // Per-state attribution cursor: return the window appended since the previous
  // slice and advance, WITHOUT clearing — so the walk-level classifier still sees
  // every event and the mechanical fail-closed gate stays authoritative.
  const cursor = { responses: 0, requestFailures: 0, pageErrors: 0 };
  const sliceCapturedEvents = () => {
    const slice = {
      responses: responses.slice(cursor.responses),
      requestFailures: requestFailures.slice(cursor.requestFailures),
      pageErrors: pageErrors.slice(cursor.pageErrors),
    };
    cursor.responses = responses.length;
    cursor.requestFailures = requestFailures.length;
    cursor.pageErrors = pageErrors.length;
    return slice;
  };
  return { getCapturedEvents: () => ({ responses, requestFailures, pageErrors }), sliceCapturedEvents };
}

/** Shape a per-state slice of listener events into the console.json
 * review-input payload: JS `pageerror`s become `consoleErrors`, error responses
 * and failed requests become `failedRequests`. Returns null when the slice is
 * empty, so an errorless state emits a deterministic JSON null (mirroring the
 * snapshot/axe best-effort policy) rather than an empty envelope. */
export function toPerStateConsolePayload(events = {}) {
  const consoleErrors = (events.pageErrors ?? []).map((e) => ({
    message: e.message ?? null,
    // Clamp to the SAME bound the mechanical feed uses (classifyFailures) so a
    // runaway stack can't bloat console.json and the two views stay consistent.
    stack: typeof e.stack === "string" && e.stack.length > 0 ? e.stack.slice(0, PAGE_ERROR_STACK_MAX_CHARS) : null,
  }));
  const failedRequests = [
    ...(events.responses ?? []).map((r) => ({ kind: "error-response", url: r.url ?? null, status: r.status })),
    ...(events.requestFailures ?? []).map((f) => ({ kind: "request-failed", url: f.url ?? null, failure: f.failure ?? null })),
  ];
  if (consoleErrors.length === 0 && failedRequests.length === 0) return null;
  return { consoleErrors, failedRequests };
}

/** Cap the bytes a single tail read pulls into memory, so a huge log growth
 * (a runaway error loop dumping megabytes) can't OOM the drive. On overflow we
 * keep the LAST maxBytes of the delta (the newest lines, where a just-logged 500
 * lives) and log the truncation — a bounded cap, never a silent one. */
const SERVER_LOG_TAIL_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Open a server-log tail bound to the log's size at drive start. `read()` returns
 * only the bytes appended since — the tail of one drive run, so a 500 logged
 * during the walk is captured without dragging in unrelated history.
 *
 * ponytail: tracks a byte offset, not the inode. If the project rotates the log
 * mid-run the offset goes stale; upgrade to an inode/rename watch if that
 * matters. Absent log path => a no-op read (empty tail).
 *
 * @param {string|null} logPath
 * @param {{maxBytes?:number, log?:(msg:string)=>void}} [opts] - `maxBytes` caps a
 *   single read; `log` receives a truncation note when the delta exceeds it.
 *   Defaults to `console.warn` so a truncation is surfaced by default (honoring
 *   the "logged, never silent" contract); pass `log: () => {}` to opt into silence.
 */
export function openServerLogTail(logPath, { maxBytes = SERVER_LOG_TAIL_MAX_BYTES, log = console.warn } = {}) {
  if (!logPath) return { read: async () => "" };
  let startOffset = 0;
  try {
    startOffset = statSync(logPath).size;
  } catch {
    startOffset = 0; // not created yet; read from the beginning once it exists
  }
  return {
    read: async () => {
      let handle;
      try {
        handle = await open(logPath, "r");
        const { size } = await handle.stat();
        if (size <= startOffset) return "";
        const delta = size - startOffset;
        // Keep the newest maxBytes of the delta on overflow; read from the tail.
        const length = Math.min(delta, maxBytes);
        const readFrom = size - length;
        if (delta > maxBytes) {
          log(`server-log tail truncated: kept the last ${length} of ${delta} appended byte(s) at the ${maxBytes}-byte cap`);
        }
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, readFrom);
        return buf.toString("utf8");
      } catch (err) {
        // Degrade to an empty tail, but never silently: a present-but-unreadable
        // log (permissions, mid-run rotation) is a real signal, not "no errors".
        log(`server-log tail unreadable at ${logPath}; treated as empty: ${(err?.message ?? String(err)).split("\n")[0]}`);
        return "";
      } finally {
        await handle?.close();
      }
    },
  };
}

/** Drive the dev-login recipe in the browser and confirm the session by waiting
 * for `successSelector`. Fail closed: any timeout/throw => {ok:false} with a
 * stated reason, so the core STOPS rather than driving an unauthenticated app. */
export async function authenticate({ page, login, interstitials = [], timeoutMs = 15000 }) {
  try {
    await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
    // A config-declared interstitial (cookie consent) can overlay the login
    // form and swallow the submit click — dismiss on the login page too, not
    // only after auth (dismissal stays best-effort and idempotent).
    await dismissInterstitials({ page, interstitials });
    if (login.usernameSelector && login.usernameValue != null) {
      await page.fill(login.usernameSelector, login.usernameValue);
    }
    if (login.passwordSelector && login.passwordValue != null) {
      await page.fill(login.passwordSelector, login.passwordValue);
    }
    await page.click(login.submitSelector);
    await page.waitForSelector(login.successSelector, { timeout: timeoutMs, state: "visible" });
    return { ok: true, detail: `session confirmed via ${login.successSelector}` };
  } catch (err) {
    return { ok: false, detail: (err?.message ?? String(err)).split("\n")[0].slice(0, 300) };
  }
}

/** Dismiss config-declared interstitials once, best-effort: an interstitial that
 * never appears or is not clickable is skipped silently so one stubborn overlay
 * can't abort the walk. */
export async function dismissInterstitials({ page, interstitials, timeoutMs = 2000 }) {
  const dismissed = [];
  for (const it of interstitials ?? []) {
    try {
      const el = page.locator(it.selector).first();
      await el.waitFor({ timeout: timeoutMs, state: "visible" });
      await el.click();
      dismissed.push(it.selector);
    } catch {
      // Not shown this run (or not clickable) — dismissal is best-effort.
    }
  }
  return { dismissed };
}

/** Map one declared step to its Playwright page call, then capture the state.
 * Exported so the per-state attribution + consolePath threading has a regression
 * test against the REAL production wiring (not a substitute fake runStep). */
export function makeRunStep({ page, outputDir, sliceCapturedEvents }) {
  // The Playwright page keeps its size across steps, so a declared viewport stays
  // in effect for later undeclared steps too. Carry it forward so the slug always
  // names the viewport the page is ACTUALLY at — never a stale `default`. Before
  // any explicit resize the page is at the context default, which slugs as `default`.
  let effectiveViewport;
  return async ({ appUrl, flow, step, index }) => {
    const sel = step.selector;
    // Apply a declared viewport BEFORE the action so the render (and its capture)
    // reflects it — otherwise a mobile-slugged directory would hold desktop pixels.
    if (step.viewport) {
      await page.setViewportSize(step.viewport);
      effectiveViewport = step.viewport;
    }
    switch (step.action) {
      case "goto":
        await page.goto(new URL(step.path ?? "/", appUrl).toString(), { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await page.click(sel);
        break;
      case "fill":
        await page.fill(sel, step.value ?? "");
        break;
      case "select":
        await page.selectOption(sel, step.value ?? "");
        break;
      case "upload":
        await page.setInputFiles(sel, step.value ?? "");
        break;
      case "dispatch":
        await page.dispatchEvent(sel, step.event ?? "click");
        break;
      default:
        throw new Error(`unknown step action: ${step.action}`);
    }
    const stateName = step.name ?? `${flow.name} ${step.action} ${index + 1}`;
    // Slice the walk-level listener window for THIS state IMMEDIATELY after the step
    // action — BEFORE capturing artifacts — so the attribution cursor advances even if
    // captureNamedUiState later throws (screenshot/file-write failure). Otherwise the
    // next step's console.json would misattribute this step's events. Slicing never
    // clears the buffer, so getCapturedEvents still feeds the whole set to the
    // mechanical fail-closed gate.
    const consolePayload = sliceCapturedEvents ? toPerStateConsolePayload(sliceCapturedEvents()) : undefined;
    const paths = await captureNamedUiState({
      page,
      sliceId: flow.name,
      stateName,
      viewport: effectiveViewport,
      interactionState: step.interactionState,
      fullPage: false,
      outputDir,
      // Hand the already-sliced window to this state's console.json (same attribution
      // as before when capture succeeds); the cursor already advanced above.
      captureConsole: sliceCapturedEvents ? () => consolePayload : undefined,
      metadata: { fixture: null, route: step.path ?? null, reviewHint: `Drive step "${stateName}" for the "${flow.name}" flow.` },
    });
    return { ok: true, screenshotPath: paths.screenshotPath, statePath: paths.statePath, snapshotPath: paths.snapshotPath, axePath: paths.axePath, consolePath: paths.consolePath };
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, launchBrowser = launchWebkit } = {}) {
  const options = parseUiReviewDriveCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }

  const { config } = await loadDevLoopConfig({ repoRoot: options.repoRoot });
  const recipe = resolveUiReviewDriveRecipe(config);
  if (!recipe) {
    // Fail closed: no dev-login recipe => cannot authenticate => drive nothing.
    const result = {
      ok: false,
      stopped: true,
      stopReason: "no drive recipe: the branch declares no uiReview.login recipe (cannot authenticate)",
      steps: [],
      captures: [],
      failures: [{ kind: "drive-recipe-missing", severity: "must-fix", message: "declare uiReview.login (loginUrl + submitSelector + successSelector) in .devloops" }],
      caps: {},
      appUrl: options.appUrl ?? null,
      // Keep the envelope shape stable across every return path: no drive ran, so
      // there is no session and nothing to tag.
      driveSession: null,
      rowManifest: [],
      logs: [],
    };
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
    return;
  }

  const serverLogPath = recipe.serverLogPath ? path.resolve(options.repoRoot, recipe.serverLogPath) : null;
  const logTail = openServerLogTail(serverLogPath, { log: (msg) => stderr.write(`[ui-review-drive] ${msg}\n`) });

  // One id per drive run: advertised to the app on every request via the session
  // header so a cooperating app can tag the dev-DB rows a mutating step persists,
  // and stamped onto the emitted row manifest so teardown drops exactly those.
  const driveSession = randomUUID();

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    // An unavailable runner (Playwright or the WebKit binary absent) is a
    // setup gap, not a crash: keep the documented stdout envelope so the stage
    // stays threadable, same as the missing-recipe path above.
    const result = {
      ok: false,
      stopped: true,
      stopReason: err?.message ?? String(err),
      steps: [],
      captures: [],
      failures: [{ kind: "drive-runner-unavailable", severity: "must-fix", message: err?.message ?? String(err) }],
      caps: {},
      appUrl: options.appUrl ?? null,
      driveSession: null,
      rowManifest: [],
      logs: [],
    };
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
    return;
  }
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { [DRIVE_SESSION_HEADER]: driveSession } });
    const page = await context.newPage();
    const { getCapturedEvents, sliceCapturedEvents } = attachPageListeners(page);
    const result = await driveUiReview(
      {
        appUrl: options.appUrl,
        login: recipe.login,
        flows: recipe.flows,
        interstitials: recipe.interstitials,
        changedPaths: options.changedPaths,
        serverLogExceptionPattern: recipe.serverLogExceptionPattern,
        caps: recipe.caps,
        driveSession,
      },
      {
        authenticate: () => authenticate({ page, login: recipe.login, interstitials: recipe.interstitials }),
        dismissInterstitials: ({ interstitials }) => dismissInterstitials({ page, interstitials }),
        runStep: makeRunStep({ page, outputDir: options.outputDir, sliceCapturedEvents }),
        getCapturedEvents,
        readServerLogTail: () => logTail.read(),
        log: (msg) => stderr.write(`[ui-review-drive] ${msg}\n`),
      },
    );
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
  } finally {
    await browser.close();
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
