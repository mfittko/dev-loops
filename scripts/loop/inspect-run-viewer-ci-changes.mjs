#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
export const INSPECT_RUN_VIEWER_RELEVANT_EXACT_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "playwright.config.mjs",
  "scripts/loop/_inspect-run-viewer-adapter.mjs",
  "scripts/loop/inspect-run-viewer.mjs",
  "scripts/loop/inspect-run-viewer-ci-changes.mjs",
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
Exit codes:
  0   Success
  1   Error
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
  { env = process.env, stdout = process.stdout } = {},
) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    stdout.write(HELP);
    return;
  }
  if (argv.length !== 1) {
    throw parseError("inspect-run-viewer-ci-changes requires exactly one changed-files path argument");
  }
  const rawPaths = await readFile(argv[0], "utf8");
  const result = classifyInspectRunViewerCiChanges(rawPaths.split(/\r?\n/u));
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `inspect_run_viewer=${result.shouldRun}\n`, "utf8");
  }
  stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  return result;
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
