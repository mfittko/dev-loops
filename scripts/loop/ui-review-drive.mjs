#!/usr/bin/env node
/**
 * CLI/harness wrapper for the ui_review drive orchestrator (Stage 2).
 *
 * Launches one headless WebKit context, authenticates as the change's target
 * role via the project's dev-login recipe, dismisses config-declared
 * interstitials once, then walks the changed flows against the arbitrary
 * running-app URL from Stage 1 — capturing a step screenshot + state.json per
 * step. Response/requestfailed/pageerror listeners plus a server-log tail run
 * throughout so a swallowed non-2xx is still recorded.
 *
 * This is a thin adapter: it wires the real IO seams (WebKit browser/page, the
 * page-event listeners, captureNamedUiState, the login form driving, the
 * server-log tail) into the pure core orchestrator
 * (packages/core/src/loop/ui-review-drive.mjs). The decision logic (flow
 * selection, cap enforcement, failure classification) lives in core.
 */
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { webkit } from "@playwright/test";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveUiReviewDriveRecipe } from "@dev-loops/core/config";
import { driveUiReview } from "@dev-loops/core/loop/ui-review-drive";
import { captureNamedUiState } from "../../test/playwright/harness/webkit-smoke-harness.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  ui-review-drive.mjs --repo-root <p> --app-url <url> --output-dir <p> [--changed-path <p> ...]
Authenticate as the target role and drive the changed UI flows headless (WebKit),
capturing step screenshots + non-2xx/pageerror/server-log failures (Stage 2 of the ui_review route).
Required:
  --repo-root <p>      Absolute path to the (provisioned) worktree carrying the .devloops recipe.
  --app-url <url>      The running-app URL handed off by Stage 1.
  --output-dir <p>     Directory for the ordered step screenshots + state.json artifacts.
Optional:
  --changed-path <p>   A changed file path (repeatable); drives the changed-flow selection heuristic.
  -h, --help           Show this help.
Output (stdout, JSON):
  { "ok": bool, "stopped": bool, "stopReason": string|null,
    "steps": [...], "captures": [...], "failures": [...], "caps": {...},
    "appUrl": string|null, "logs": [...] }
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
 * testable without a browser). Only non-2xx responses are retained so the buffer
 * stays bounded; the pure classifier decides severity from the collected set.
 *
 * @returns {{ getCapturedEvents: () => {responses:object[],requestFailures:object[],pageErrors:object[]} }}
 */
export function attachPageListeners(page) {
  const responses = [];
  const requestFailures = [];
  const pageErrors = [];
  page.on("response", (res) => {
    const status = typeof res.status === "function" ? res.status() : res.status;
    if (typeof status === "number" && (status < 200 || status >= 400)) {
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
    pageErrors.push({ message: err?.message ?? String(err) });
  });
  return { getCapturedEvents: () => ({ responses, requestFailures, pageErrors }) };
}

/**
 * Open a server-log tail bound to the log's size at drive start. `read()` returns
 * only the bytes appended since — the tail of one drive run, so a 500 logged
 * during the walk is captured without dragging in unrelated history.
 *
 * ponytail: tracks a byte offset, not the inode. If the project rotates the log
 * mid-run the offset goes stale; upgrade to an inode/rename watch if that
 * matters. Absent log path => a no-op read (empty tail).
 */
export function openServerLogTail(logPath) {
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
        const length = size - startOffset;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, startOffset);
        return buf.toString("utf8");
      } catch {
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
async function authenticate({ page, login, timeoutMs = 15000 }) {
  try {
    await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
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

/** Dismiss config-declared interstitials once. A non-optional interstitial that
 * never appears is not fatal here (the drive stage records it, not this seam);
 * a click failure is swallowed so one stubborn overlay can't abort the walk. */
async function dismissInterstitials({ page, interstitials, timeoutMs = 2000 }) {
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

/** Map one declared step to its Playwright page call, then capture the state. */
function makeRunStep({ page, outputDir }) {
  return async ({ appUrl, flow, step, index }) => {
    const sel = step.selector;
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
    const paths = await captureNamedUiState({
      page,
      sliceId: flow.name,
      stateName,
      fullPage: false,
      outputDir,
      metadata: { fixture: null, route: step.path ?? null, reviewHint: `Drive step "${stateName}" for the "${flow.name}" flow.` },
    });
    return { ok: true, screenshotPath: paths.screenshotPath, statePath: paths.statePath };
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
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
      logs: [],
    };
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
    return;
  }

  const serverLogPath = recipe.serverLogPath ? path.resolve(options.repoRoot, recipe.serverLogPath) : null;
  const logTail = openServerLogTail(serverLogPath);

  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { getCapturedEvents } = attachPageListeners(page);
    const result = await driveUiReview(
      {
        appUrl: options.appUrl,
        login: recipe.login,
        flows: recipe.flows,
        interstitials: recipe.interstitials,
        changedPaths: options.changedPaths,
        serverLogExceptionPattern: recipe.serverLogExceptionPattern,
        caps: recipe.caps,
      },
      {
        authenticate: () => authenticate({ page, login: recipe.login }),
        dismissInterstitials: ({ interstitials }) => dismissInterstitials({ page, interstitials }),
        runStep: makeRunStep({ page, outputDir: options.outputDir }),
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
