#!/usr/bin/env node
/**
 * Bounded wrapper: capture ONE screen's screenshot from a Playwright navigation
 * descriptor, for the loop-grill visual-resources step.
 *
 * A navigation descriptor names how to reach a screen ("go to /settings, click
 * Edit Profile") as an ordered list of steps. This wrapper authenticates via the
 * project's dev-login recipe (when declared), walks the steps against the
 * running-app URL, and captures the final screen — reusing the ui_review drive
 * harness (authenticate, dismissInterstitials, makeRunStep -> captureNamedUiState)
 * rather than a parallel browser impl. It is a THIN adapter: the grill invokes it
 * so no raw browser code runs inline in the skill.
 *
 * Fail-closed: an unavailable runner (browser launch throws), a failed login, or a
 * step that throws returns { ok: false } with a stated reason, so the grill flags
 * the visual gap `unresolved` rather than fabricating a description of the screen.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { rm } from "node:fs/promises";
import { webkit } from "@playwright/test";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveUiReviewDriveRecipe } from "@dev-loops/core/config";
import { authenticate, dismissInterstitials, makeRunStep } from "./ui-review-drive.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  visual-grill-capture.mjs --repo-root <p> --app-url <url> --output-dir <p> --descriptor <json|@file>
Walk a Playwright navigation descriptor headless (WebKit) and capture the final
screen as loop-grill visual context. Authenticates via the .devloops uiReview.login
recipe when one is declared; walks steps unauthenticated otherwise.
Required:
  --repo-root <p>      Absolute path to the worktree carrying the .devloops recipe.
  --app-url <url>      The running-app base URL.
  --output-dir <p>     Directory for the captured screenshot + state.json artifacts.
  --descriptor <v>     Navigation descriptor as inline JSON, or @<path> to read it
                       from a file. Shape: { "name": string, "steps": [ { "action":
                       "goto"|"click"|"fill"|..., "path"?, "selector"?, "value"? } ] }.
Optional:
  -h, --help           Show this help.
Output (stdout, JSON):
  { "ok": bool, "screenshotPath": string|null, "statePath": string|null, "stopReason": string|null }

${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);

// A descriptor is semi-trusted plan/issue-authored input; cap the walk so an
// oversized descriptor can't drive an unbounded browser session.
export const MAX_DESCRIPTOR_STEPS = 50;

// Only DOM-interaction actions that reach a screen are allowed. `upload`
// (setInputFiles) makes the browser READ a local file and send it to the app —
// arbitrary local-file exfiltration on a semi-trusted descriptor — so it is
// rejected along with any unknown/missing action.
export const SAFE_STEP_ACTIONS = new Set(["goto", "click", "fill", "select", "dispatch"]);

// Only http/https navigation is allowed. A goto `path` that is absolute overrides
// the app base, so validate the RESOLVED URL, not the raw path: this rejects
// file:/data:/javascript:/about: (which could screenshot local file contents into
// the artifact) and any cross-origin override of the running app.
const ALLOWED_NAV_SCHEMES = new Set(["http:", "https:"]);

export function validateNavigation({ appUrl, steps }) {
  let base;
  try {
    base = new URL(appUrl);
  } catch {
    return { ok: false, reason: `app-url is not a valid URL: ${appUrl}` };
  }
  if (!ALLOWED_NAV_SCHEMES.has(base.protocol)) {
    return { ok: false, reason: `app-url scheme "${base.protocol}" is not allowed (http/https only)` };
  }
  for (const step of steps) {
    if (step?.action !== "goto") continue;
    let target;
    try {
      target = new URL(step.path ?? "/", appUrl); // same resolution makeRunStep uses
    } catch {
      return { ok: false, reason: `goto path is not a resolvable URL: ${String(step.path)}` };
    }
    if (!ALLOWED_NAV_SCHEMES.has(target.protocol)) {
      return { ok: false, reason: `goto scheme "${target.protocol}" is not allowed (http/https only): ${target.toString()}` };
    }
    if (target.origin !== base.origin) {
      return { ok: false, reason: `goto target overrides the app base origin (${base.origin} → ${target.origin}): ${target.toString()}` };
    }
  }
  return { ok: true };
}

export function parseVisualGrillCliArgs(argv) {
  const options = { help: false, repoRoot: undefined, appUrl: undefined, outputDir: undefined, descriptor: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "repo-root": { type: "string" },
      "app-url": { type: "string" },
      "output-dir": { type: "string" },
      descriptor: { type: "string" },
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
    if (token.name === "descriptor") {
      options.descriptor = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.help) return options;
  if (!options.repoRoot) throw parseError("Missing required --repo-root");
  if (!options.appUrl) throw parseError("Missing required --app-url");
  if (!options.outputDir) throw parseError("Missing required --output-dir");
  if (!options.descriptor) throw parseError("Missing required --descriptor");
  return options;
}

/**
 * Parse the navigation descriptor from an inline JSON string or an `@<path>`
 * reference. Fail closed: malformed JSON, a missing `name`, or an empty `steps`
 * array throws — a descriptor that cannot be walked must never silently capture
 * a wrong (or blank) screen.
 */
export function parseDescriptor(raw, { readFileSync } = {}) {
  let text = raw;
  if (typeof raw === "string" && raw.startsWith("@")) {
    if (!readFileSync) throw new Error("descriptor @<path> requires a file reader");
    text = readFileSync(raw.slice(1), "utf8");
  }
  let descriptor;
  try {
    descriptor = JSON.parse(text);
  } catch (err) {
    throw new Error(`descriptor is not valid JSON: ${(err?.message ?? String(err)).split("\n")[0]}`);
  }
  if (!descriptor || typeof descriptor.name !== "string" || descriptor.name.trim().length === 0) {
    throw new Error("descriptor must carry a non-empty string `name`");
  }
  if (!Array.isArray(descriptor.steps) || descriptor.steps.length === 0) {
    throw new Error("descriptor must carry a non-empty `steps` array");
  }
  if (descriptor.steps.length > MAX_DESCRIPTOR_STEPS) {
    throw new Error(`descriptor exceeds the ${MAX_DESCRIPTOR_STEPS}-step cap (${descriptor.steps.length} steps)`);
  }
  for (const step of descriptor.steps) {
    if (!SAFE_STEP_ACTIONS.has(step?.action)) {
      throw new Error(`unsupported step action "${String(step?.action)}" (allowed: ${[...SAFE_STEP_ACTIONS].join(", ")})`);
    }
  }
  return descriptor;
}

/**
 * Authenticate (when a recipe is declared), walk the descriptor's steps, and
 * return the final captured screen. The browser launch/config load are injectable
 * seams so the wiring is exercised without a real browser. Any thrown error (login
 * failure, unreachable step, screenshot write) degrades to { ok: false } with a
 * stated reason — the grill's fail-closed contract.
 */
// Remove a step's on-disk capture bundle (the whole named-state dir the screenshot
// lives in). Fail-safe: a missing dir is fine — the goal is only that no off-origin
// bundle persists.
async function removeCaptureArtifact(capture) {
  const anchor = capture?.screenshotPath ?? capture?.statePath;
  if (!anchor) return;
  // Best-effort cleanup: a teardown error (EACCES/EPERM) must not escape and turn a
  // fail-closed path into a rejection — the caller is always owed a structured result.
  try {
    await rm(path.dirname(anchor), { recursive: true, force: true });
  } catch {
    // ponytail: swallow — leaving a bundle is less bad than breaking the fail-closed contract.
  }
}

export async function captureDescriptorScreen(
  { repoRoot, appUrl, outputDir, descriptor },
  { loadConfig = loadDevLoopConfig, launchBrowser = () => webkit.launch({ headless: true }) } = {},
) {
  let browser;
  // The most recent capture bundle written to disk; hoisted so the failure catch
  // can prune a half-walked intermediate too.
  let last = null;
  try {
    // Validate navigation BEFORE launching a browser, so a file:// / cross-origin
    // goto is rejected without ever opening a page.
    const nav = validateNavigation({ appUrl, steps: descriptor.steps });
    if (!nav.ok) {
      return { ok: false, screenshotPath: null, statePath: null, stopReason: nav.reason };
    }
    const { config } = await loadConfig({ repoRoot });
    const recipe = resolveUiReviewDriveRecipe(config);
    browser = await launchBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    if (recipe) {
      const auth = await authenticate({ page, login: recipe.login });
      if (!auth.ok) {
        return { ok: false, screenshotPath: null, statePath: null, stopReason: `authentication failed: ${auth.detail}` };
      }
      await dismissInterstitials({ page, interstitials: recipe.interstitials });
    }
    const appOrigin = new URL(appUrl).origin;
    const runStep = makeRunStep({ page, outputDir });
    const flow = { name: descriptor.name };
    for (let index = 0; index < descriptor.steps.length; index += 1) {
      const prior = last;
      last = await runStep({ appUrl, flow, step: descriptor.steps[index], index });
      // Only the FINAL screen is loop-grill context; delete the superseded prior
      // bundle so a sensitive intermediate state (e.g. a screen after a credential
      // `fill`) never lingers on disk.
      await removeCaptureArtifact(prior);
      // Runtime confinement: a server-side redirect or a click-navigation can leave
      // the app origin after the pre-launch check. If it did, fail closed — never
      // return a screenshot of an off-origin page. Delete this step's bundle first.
      const currentUrl = page.url();
      if (new URL(currentUrl).origin !== appOrigin) {
        await removeCaptureArtifact(last);
        last = null;
        return { ok: false, screenshotPath: null, statePath: null, stopReason: `navigation left the app origin: ${currentUrl}` };
      }
    }
    return { ok: true, screenshotPath: last.screenshotPath, statePath: last.statePath, stopReason: null };
  } catch (err) {
    // Runner unavailable (launch threw) or a step failed => fail closed with a
    // reason, so the grill flags the visual gap unresolved. Prune any intermediate
    // bundle already written so nothing sensitive is left behind.
    await removeCaptureArtifact(last);
    return { ok: false, screenshotPath: null, statePath: null, stopReason: (err?.message ?? String(err)).split("\n")[0].slice(0, 300) };
  } finally {
    // Best-effort teardown: a close() error must not mask the returned envelope.
    try {
      await browser?.close();
    } catch {
      // ponytail: swallow — the structured result already went out; a dangling browser
      // is a lesser evil than rejecting a fail-closed path.
    }
  }
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseVisualGrillCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const { readFileSync } = await import("node:fs");
  let descriptor;
  try {
    descriptor = parseDescriptor(options.descriptor, { readFileSync });
  } catch (err) {
    const result = { ok: false, screenshotPath: null, statePath: null, stopReason: (err?.message ?? String(err)).split("\n")[0] };
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
    return;
  }
  const result = await captureDescriptorScreen({
    repoRoot: options.repoRoot,
    appUrl: options.appUrl,
    outputDir: options.outputDir,
    descriptor,
  });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
