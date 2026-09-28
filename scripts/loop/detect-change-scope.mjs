#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { DIFF_ISOLATION_FLAGS, gitEnvWithoutDirOverrides } from "../github/write-gate-context.mjs";
import { isScopeCountExcluded } from "@dev-loops/core/config";

const USAGE = `Usage: detect-change-scope.mjs [--base <ref>] [--head <ref>]
Detect change scope from git diff for light-mode eligibility.
filesChanged/linesChanged skip SCOPE_COUNT_EXCLUDE_GLOBS paths (changes/*.md,
.claude/{skills,agents,commands}/**); see ADR 0108.
Options:
  --base <ref>   Override base ref (default: HEAD~1)
  --head <ref>   Override head ref; ignored unless --base is also set
  --help, -h     Show this help

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;

function parseCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      base: { type: "string" },
      head: { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const opts = { base: null, head: null };
  for (const token of tokens) {
    if (token.kind === "option") {
      if (token.name === "help") {
        if (token.value !== undefined) {
          throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
        }
        process.stdout.write(USAGE);
        process.exit(0);
      }
      if (token.name === "base") {
        opts.base = token.value ?? null;
        continue;
      }
      if (token.name === "head") {
        opts.head = token.value ?? null;
        continue;
      }
      if (matchJqOutputToken(token, opts)) continue;
    }
  }
  return opts;
}
// Parses `git diff --numstat -z`, skipping SCOPE_COUNT_EXCLUDE_GLOBS paths. A
// rename record is `a\td\t\0old\0new\0` and is skipped only when both paths are
// excluded (fail closed). Binary `-\t-` counts as one file with zero lines.
// rawFilesChanged/rawLinesChanged count every path; diff-class tier matching
// reads them so the exclusion stays scoped to the light-mode cap.
export function parseGitNumstat(output) {
  const tokens = output.split("\0");
  let filesChanged = 0;
  let linesChanged = 0;
  let rawFilesChanged = 0;
  let rawLinesChanged = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!match) continue;
    const paths = match[3] === "" ? [tokens[++i], tokens[++i]] : [match[3]];
    const lines = (Number(match[1]) || 0) + (Number(match[2]) || 0);
    rawFilesChanged += 1;
    rawLinesChanged += lines;
    if (paths.every(isScopeCountExcluded)) continue;
    filesChanged += 1;
    linesChanged += lines;
  }
  return { filesChanged, linesChanged, rawFilesChanged, rawLinesChanged };
}
// Isolated from ambient GIT_DIR/GIT_WORK_TREE (gitEnvWithoutDirOverrides) and
// diff-config drift (DIFF_ISOLATION_FLAGS), matching detectMergeBaseChangedFiles:
// an inherited GIT_DIR/GIT_WORK_TREE would otherwise resolve this diff against a
// DIFFERENT repo than `cwd`, letting a poisoned env under-report scope and
// fail-OPEN the light-mode size cap this function feeds.
function detectScope({ base, head, cwd } = {}) {
  let diffArgs = [...DIFF_ISOLATION_FLAGS, "diff", "--no-ext-diff", "--numstat", "-z"];
  if (base && head) {
    diffArgs.push(`${base}..${head}`);
  } else if (base) {
    diffArgs.push(base);
  } else {
    diffArgs.push("HEAD~1..HEAD");
  }
  let output;
  try {
    output = execFileSync("git", diffArgs, { encoding: "utf8", maxBuffer: 1_000_000, cwd: cwd || undefined, env: gitEnvWithoutDirOverrides() });
  } catch (err) {
    return { ok: false, filesChanged: 0, linesChanged: 0, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, ...parseGitNumstat(output) };
}
function isEligibleForLightMode(scope, threshold) {
  return scope.filesChanged <= threshold.maxFiles && scope.linesChanged <= threshold.maxLines;
}
/**
 * Detect change scope for the merge-base diff between `base` and `head` (the
 * three-dot `base...head` diff git resolves against merge-base(base, head)).
 *
 * Fails CLOSED: a missing base/head, or any git failure, returns `{ ok: false }`
 * so callers that gate on scope (e.g. the light-mode pre-merge acceptance) reject
 * rather than silently treating an unmeasurable diff as under threshold. Reuses
 * the same `parseGitNumstat` scope resolution as `detectScope`.
 *
 * Isolated from ambient `GIT_DIR`/`GIT_WORK_TREE` and diff-config drift the
 * same way `detectMergeBaseChangedFiles` is (see its doc comment) — this feeds
 * the merge-gate hard size cap, so a poisoned env under-reporting scope here
 * would fail-OPEN that cap exactly like an unisolated changed-file read would.
 */
function detectMergeBaseScope({ base, head, cwd } = {}) {
  if (!base || !head) {
    return { ok: false, filesChanged: 0, linesChanged: 0, error: "base and head are required for merge-base scope detection" };
  }
  let output;
  try {
    output = execFileSync(
      "git",
      [...DIFF_ISOLATION_FLAGS, "diff", "--no-ext-diff", "--numstat", "-z", `${base}...${head}`],
      { encoding: "utf8", maxBuffer: 1_000_000, cwd: cwd || undefined, env: gitEnvWithoutDirOverrides() },
    );
  } catch (err) {
    return { ok: false, filesChanged: 0, linesChanged: 0, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, ...parseGitNumstat(output) };
}
/**
 * List changed files for the SAME merge-base (three-dot `base...head`) diff
 * {@link detectMergeBaseScope} measures — the companion fact the
 * GATE-EXEC-PROPORTIONALITY risk-path floor needs at merge-gate re-verify
 * time (detect-checkpoint-evidence.mjs). Fails CLOSED: `{ ok: false, files: null }`
 * on a missing base/head or any git failure, never a silently-empty list.
 *
 * Isolated from ambient `GIT_DIR`/`GIT_WORK_TREE` (`gitEnvWithoutDirOverrides`)
 * and diff-config drift (`DIFF_ISOLATION_FLAGS`), matching the worktree-bound
 * reads in write-gate-context.mjs: an inherited `GIT_DIR`/`GIT_WORK_TREE`
 * would otherwise resolve this diff against a DIFFERENT repo than `cwd`, so a
 * poisoned env could return a clean path list and fail-OPEN the risk-path
 * floor this function feeds.
 */
function detectMergeBaseChangedFiles({ base, head, cwd } = {}) {
  if (!base || !head) {
    return { ok: false, files: null, error: "base and head are required for merge-base changed-files detection" };
  }
  let output;
  try {
    output = execFileSync(
      "git",
      [...DIFF_ISOLATION_FLAGS, "diff", "--no-ext-diff", "--name-only", `${base}...${head}`],
      { encoding: "utf8", maxBuffer: 10_000_000, cwd: cwd || undefined, env: gitEnvWithoutDirOverrides() },
    );
  } catch (err) {
    return { ok: false, files: null, error: err instanceof Error ? err.message : String(err) };
  }
  const files = output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return { ok: true, files };
}
async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
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
  // This tool always exits 0 on a parsed run (scope.ok:false only reflects a git
  // diff failure inside the payload, never the process outcome) — force ok:true
  // as emitResult's default so --jq/--silent compose without changing that.
  process.exitCode = emitResult(
    { ...scope, eligibleForLightMode: eligible, threshold },
    { jq: opts.jq, silent: opts.silent, ok: true },
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
export { detectScope, detectMergeBaseScope, detectMergeBaseChangedFiles, isEligibleForLightMode };
