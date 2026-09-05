#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const COMMON_EXACT_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "playwright.config.mjs",
  "scripts/loop/rendered-artifact-ci-changes.mjs",
  "scripts/loop/ui-review-capture.mjs",
  "test/playwright/harness/deck-fit-harness.mjs",
  "test/playwright/harness/webkit-smoke-harness.mjs",
]);
const COMMON_PREFIXES = Object.freeze([".github/actions/playwright-webkit/"]);
const USAGE = "Usage: rendered-artifact-ci-changes.mjs <changed-files-path>";
const HELP = `${USAGE}
Classify changed files for the presentation and article Playwright CI jobs.

${JQ_OUTPUT_USAGE}`;
const parseError = buildParseError(USAGE);

function normalizePath(filePath) {
  return String(filePath ?? "").trim().replace(/^\.\/+/u, "");
}

function isCommon(path) {
  return COMMON_EXACT_PATHS.includes(path) || COMMON_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isSingleHtml(path, directory) {
  if (!path.startsWith(`${directory}/`) || !path.endsWith(".html")) return false;
  return !path.slice(directory.length + 1).includes("/");
}

export function classifyRenderedArtifactCiChanges(changedPaths = []) {
  const paths = [...new Set(changedPaths.map(normalizePath).filter(Boolean))].sort();
  const presentationPaths = paths.filter((path) => isCommon(path) || isSingleHtml(path, "docs/presentations") || /^test\/playwright\/[^/]*-deck\.spec\.mjs$/u.test(path));
  const articlePaths = paths.filter((path) => isCommon(path) || isSingleHtml(path, "docs/articles") || /^test\/playwright\/[^/]*-article\.spec\.mjs$/u.test(path));
  return {
    presentations: presentationPaths.length > 0,
    articles: articlePaths.length > 0,
    presentationPaths,
    articlePaths,
  };
}

export async function runCli(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
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
  if (positionals.length !== 1) throw parseError("expected exactly one changed-files path");
  const rawPaths = await readFile(positionals[0], "utf8");
  const result = classifyRenderedArtifactCiChanges(rawPaths.split(/\r?\n/u));
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `presentations=${result.presentations}\narticles=${result.articles}\n`, "utf8");
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
