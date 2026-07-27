#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { parseArgs } from "node:util";
export const INSPECT_RUN_VIEWER_RELEVANT_EXACT_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "playwright.config.mjs",
  "scripts/loop/_inspect-run-viewer-adapter.mjs",
  "scripts/loop/inspect-run-viewer.mjs",
  "scripts/loop/inspect-run-viewer-ci-changes.mjs",
  // The viewer smoke's artifact writing lives here; the harness below is now a
  // re-export shim over it, so listing only the shim would miss real changes.
  "scripts/loop/ui-review-capture.mjs",
  "test/playwright/harness/webkit-smoke-harness.mjs",
  "test/playwright/inspect-run-viewer.spec.mjs",
]);
export const INSPECT_RUN_VIEWER_RELEVANT_PREFIXES = Object.freeze([
  "scripts/loop/inspect-run-viewer/",
  "test/playwright/fixtures/",
]);
const USAGE = "Usage: inspect-run-viewer-ci-changes.mjs <changed-files-path>";
const HELP = `Usage: inspect-run-viewer-ci-changes.mjs <changed-files-path>
Classify changed files to determine if inspect-run-viewer tests should run.
Reads a newline-delimited file list and checks against known relevant paths.
Options:
  --help, -h    Show this help

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;
const parseError = buildParseError(USAGE);
export function normalizeInspectRunViewerPath(filePath) {
  return String(filePath ?? "")
    .trim()
    .replace(/^\.\/+/u, "");
}
function isInspectRunViewerRelevantNormalizedPath(normalizedPath) {
  return normalizedPath.length > 0 && (
    INSPECT_RUN_VIEWER_RELEVANT_EXACT_PATHS.includes(normalizedPath)
    || INSPECT_RUN_VIEWER_RELEVANT_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))
  );
}
export function isInspectRunViewerRelevantPath(filePath) {
  return isInspectRunViewerRelevantNormalizedPath(normalizeInspectRunViewerPath(filePath));
}
export function classifyInspectRunViewerCiChanges(changedPaths = []) {
  const relevantPaths = [...new Set(changedPaths
    .map((entry) => normalizeInspectRunViewerPath(entry))
    .filter((entry) => isInspectRunViewerRelevantNormalizedPath(entry)))].sort();
  return {
    shouldRun: relevantPaths.length > 0,
    relevantPaths,
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
  });
  if (values.help) {
    stdout.write(HELP);
    return;
  }
  if (positionals.length !== 1) {
    throw parseError("inspect-run-viewer-ci-changes requires exactly one changed-files path argument");
  }
  const rawPaths = await readFile(positionals[0], "utf8");
  const result = classifyInspectRunViewerCiChanges(rawPaths.split(/\r?\n/u));
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `inspect_run_viewer=${result.shouldRun}\n`, "utf8");
  }
  process.exitCode = emitResult({ ok: true, ...result }, { jq: values.jq, silent: values.silent, stdout, stderr });
  return result;
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
