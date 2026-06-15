#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { base: null, head: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write(`Usage: detect-change-scope.mjs [--base <ref>] [--head <ref>]
Detect change scope from git diff for light-mode eligibility.
Options:
  --base <ref>   Override base ref (default: HEAD~1)
  --head <ref>   Override head ref; ignored unless --base is also set
  --help, -h     Show this help
Exit codes:
  0   Success
  1   Error
`);
      process.exit(0);
    }
    if (args[i] === "--base" && i + 1 < args.length) opts.base = args[++i];
    else if (args[i] === "--head" && i + 1 < args.length) opts.head = args[++i];
  }
  return opts;
}
export function parseGitDiffStat(output) {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return { filesChanged: 0, linesChanged: 0 };
  }
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1];
  const isSummary = /\d+\s+files?\s+changed/.test(lastLine) || /\d+\s+insertion/.test(lastLine) || /\d+\s+deletion/.test(lastLine);
  const fileCount = isSummary ? lines.length - 1 : lines.length;
  let insertions = 0;
  let deletions = 0;
  if (isSummary) {
    const insMatch = lastLine.match(/(\d+)\s+insertion/);
    const delMatch = lastLine.match(/(\d+)\s+deletion/);
    if (insMatch) insertions = parseInt(insMatch[1], 10);
    if (delMatch) deletions = parseInt(delMatch[1], 10);
  }
  return { filesChanged: fileCount, linesChanged: insertions + deletions };
}
function detectScope({ base, head } = {}) {
  let diffArgs = ["diff", "--stat"];
  if (base && head) {
    diffArgs.push(`${base}..${head}`);
  } else if (base) {
    diffArgs.push(base);
  } else {
    diffArgs.push("HEAD~1..HEAD");
  }
  let output;
  try {
    output = execFileSync("git", diffArgs, { encoding: "utf8", maxBuffer: 1_000_000 });
  } catch (err) {
    return { ok: false, filesChanged: 0, linesChanged: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = parseGitDiffStat(output);
  return { ok: true, ...parsed };
}
function isEligibleForLightMode(scope, threshold) {
  return scope.filesChanged <= threshold.maxFiles && scope.linesChanged <= threshold.maxLines;
}
async function main() {
  const opts = parseArgs();
  const scope = detectScope(opts);
  let threshold = { maxFiles: 3, maxLines: 200 };
  let eligible = false;
  try {
    const { loadDevLoopConfig, resolveLightMode } = await import(
      "@dev-loops/core/config"
    );
    const { config, errors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
    if (Array.isArray(errors) && errors.length > 0) {
    } else {
      const lightMode = resolveLightMode(config);
      if (lightMode && scope.ok !== false) {
        threshold = { maxFiles: lightMode.maxFiles, maxLines: lightMode.maxLines };
        eligible = isEligibleForLightMode(scope, threshold);
      }
    }
  } catch {
  }
  process.stdout.write(
    JSON.stringify({
      ...scope,
      eligibleForLightMode: eligible,
      threshold,
    }) + "\n"
  );
}
const isDirectRun =
  process.argv[1] && process.argv[1].includes("detect-change-scope.mjs");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
export { detectScope, isEligibleForLightMode };
