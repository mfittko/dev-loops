#!/usr/bin/env node
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: detect-internal-only-pr.mjs --repo <owner/name> --pr <number> [--config <path>]
Detect whether a PR only touches internal tooling files (scripts, docs, tests, config)
and should suppress external Copilot review.

Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --config <path>       Path to .devloops (default: auto-detect, tries .devloops then .pi/dev-loop/settings.*)
  --label-check         Also check for explicit "internal_only" label on the PR
Output (stdout, JSON):
  { "ok": true, "internalOnly": true|false, "files": ["path1", "path2", ...],
    "reason": "...", "repo": "...", "pr": N }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

// Shipped default patterns used as fallback when no config is found.
const SHIPPED_DEFAULT_PATTERNS = [
  "^scripts/",
  "^docs/",
  "^skills/docs/",
  "^\\.pi/",
  "^\\.github/",
  "^test/",
];

function findRepoRoot(cwd = process.cwd()) {
  let dir = cwd;
  while (true) {
    try {
      const s = statSync(path.join(dir, ".git"));
      if (s.isDirectory() || s.isFile()) return dir;
    } catch {
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load internal path patterns from config, with precedence:
 *   1. --config flag (explicit path)
 *   2. Auto-detect from repo root (.devloops first, then .pi/dev-loop/settings.* or overrides.*)
 *   3. Shipped defaults
 *
 * Returns a flat array of regex pattern strings.
 * Falls back to shipped defaults when parsed patterns are empty or invalid.
 */
function loadInternalPathPatterns(configPath) {
  // --config flag takes priority
  if (configPath) {
    const patterns = tryLoadFromFile(configPath);
    if (patterns && patterns.length > 0) return patterns;
    return [...SHIPPED_DEFAULT_PATTERNS];
  }

  // Auto-detect from repo root
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const candidates = [
      // .devloops at repo root (primary)
      path.join(repoRoot, ".devloops"),
      path.join(repoRoot, ".devloops.yaml"),
      path.join(repoRoot, ".devloops.yml"),
      path.join(repoRoot, ".devloops.json"),
      // Legacy .pi/dev-loop/settings.* or overrides.* (deprecated)
      path.join(repoRoot, ".pi", "dev-loop", "settings.yaml"),
      path.join(repoRoot, ".pi", "dev-loop", "settings.yml"),
      path.join(repoRoot, ".pi", "dev-loop", "settings.json"),
      path.join(repoRoot, ".pi", "dev-loop", "overrides.yaml"),
      path.join(repoRoot, ".pi", "dev-loop", "overrides.yml"),
      path.join(repoRoot, ".pi", "dev-loop", "overrides.json"),
    ];
    for (const candidate of candidates) {
      const patterns = tryLoadFromFile(candidate);
      if (patterns && patterns.length > 0) return patterns;
    }
  }

  // Fall back to shipped defaults
  return [...SHIPPED_DEFAULT_PATTERNS];
}

function tryLoadFromFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = filePath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    const patterns = parsed?.internalPathPatterns;
    if (Array.isArray(patterns)) {
      const trimmed = patterns.filter(p => typeof p === "string" && p.trim()).map(p => p.trim());
      return trimmed.length > 0 ? trimmed : null;
    }
  } catch {
  }
  return null;
}

function buildPatternMatchers(patterns) {
  return patterns.map(p => {
    try {
      return new RegExp(p);
    } catch {
      return null;
    }
  }).filter(r => r !== null);
}

export function parseCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    config: undefined,
    labelCheck: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      config: { type: "string" },
      "label-check": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "config") {
      options.config = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "label-check") {
      options.labelCheck = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-internal-only-pr requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

async function fetchPrFiles({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "files", "--jq", ".files[].path"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const paths = result.stdout.trim().split("\n").filter(Boolean);
  return paths;
}

async function fetchPrLabels({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "labels", "--jq", ".labels[].name"],
    env,
  );
  if (result.code !== 0) {
    return []; // Best-effort: label check failure is not fatal
  }
  const labels = result.stdout.trim().split("\n").filter(Boolean);
  return labels;
}

/**
 * Detect whether a PR is internal-only using a configurable whitelist.
 *
 * Single-whitelist logic:
 * - If ALL changed files match at least one internal pattern → internalOnly=true
 * - If ANY changed file doesn't match any pattern → internalOnly=false
 * - No blacklist needed — a non-matching file is consumer-facing by definition.
 */
export async function detectInternalOnly(options, { env = process.env, ghCommand = "gh" } = {}) {
  const patterns = loadInternalPathPatterns(options.config);
  const matchers = buildPatternMatchers(patterns);
  const files = await fetchPrFiles(options, { env, ghCommand });

  if (files.length === 0) {
    return {
      ok: true,
      internalOnly: false,
      files: [],
      reason: "No files changed; cannot determine internal-only status",
      repo: options.repo,
      pr: options.pr,
    };
  }

  // Single whitelist: any non-matching file → NOT internal-only
  const nonMatching = files.filter(f => !matchers.some(r => r.test(f)));
  if (nonMatching.length > 0) {
    return {
      ok: true,
      internalOnly: false,
      files,
      reason: `Consumer-facing file(s) changed: ${nonMatching.join(", ")}`,
      repo: options.repo,
      pr: options.pr,
    };
  }

  // Check for explicit internal_only label if requested (confirmation only)
  if (options.labelCheck) {
    const labels = await fetchPrLabels(options, { env, ghCommand });
    if (labels.includes("internal_only")) {
      // Label confirms — path check already passed
    }
  }

  return {
    ok: true,
    internalOnly: true,
    files,
    reason: `All ${files.length} changed file(s) are internal tooling only (scripts/docs/tests/config)`,
    repo: options.repo,
    pr: options.pr,
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await detectInternalOnly(options, { env, ghCommand });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}

export { findRepoRoot, loadInternalPathPatterns, buildPatternMatchers, tryLoadFromFile, SHIPPED_DEFAULT_PATTERNS };
