#!/usr/bin/env node
/**
 * match-copilot-threads-to-gate-findings
 *
 * Reads a JSONL export of Copilot review threads and the local gate-finding
 * round files, marks each thread matched or Copilot-only, classifies the
 * Copilot-only ones by keyword, and names the draft_gate angles that should
 * have caught each class. Reads local files only; makes no GitHub call.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";

const USAGE = `Usage: match-copilot-threads-to-gate-findings.mjs --threads <jsonl> --repo <owner/name> [--findings-root <dir>] [--repo-root <dir>]

Required:
  --threads <jsonl>       JSONL export; one thread per line with pr, path, isResolved, body, mergedAt
  --repo <owner/name>     Selects the default findings dir tmp/gate-findings/<owner-repo>/ (not needed with --findings-root)

Optional:
  --findings-root <dir>   Directory holding pr-<N>/*.json round files
  --repo-root <dir>       Base for the default findings dir (default: cwd)
  --help, -h              Show this help

Matching is by file only: a thread is matched when a finding of the same PR lists
the thread path in files[]. The export has no line, so line is never compared.

Output (stdout, JSON):
  { "threads": [{ pr, path, matched, matchedAngles, class, shouldHaveCaughtAngles }],
    "summary": { total, copilotOnly, byClass, byAngle } }
`;

const parseError = buildParseError(USAGE);

// Draft_gate angle names from packages/core/src/config/extension-defaults.yaml.
export const CLASS_ANGLES = {
  "input-validation-edge-case": ["input-validation", "correctness", "coverage"],
  "docs-help-description": ["docs", "contract-surface", "pr-description"],
  tests: ["coverage"],
  other: ["correctness", "holistic"],
};

// shortcut: first matching class wins on plain keywords, upgrade when the classes need weighting.
const CLASS_PATTERNS = [
  ["input-validation-edge-case", /\b(null|empty|missing|undefined|malformed|wrapped|split|resume[sd]?|stale|blank|whitespace|invalid)\b/i],
  ["docs-help-description", /\b(docs?|documentation|help|usage|description|readme|comment|wording|typo)\b/i],
  ["tests", /\b(tests?|assert\w*|fixtures?|coverage|spec)\b/i],
];

export function classifyThreadBody(body) {
  const text = String(body ?? "");
  for (const [name, pattern] of CLASS_PATTERNS) if (pattern.test(text)) return name;
  return "other";
}

export function parseArgsList(argv) {
  const options = { help: false, threads: null, repo: null, findingsRoot: null, repoRoot: process.cwd() };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      threads: { type: "string" },
      repo: { type: "string" },
      "findings-root": { type: "string" },
      "repo-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "threads") { options.threads = requireTokenValue(token, parseError); continue; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError); continue; }
    if (token.name === "findings-root") { options.findingsRoot = requireTokenValue(token, parseError); continue; }
    if (token.name === "repo-root") { options.repoRoot = requireTokenValue(token, parseError); continue; }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.threads) throw parseError("--threads <jsonl> is required");
  if (!options.findingsRoot) {
    if (!options.repo || !/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
      throw parseError("--repo <owner/name> is required when --findings-root is not given");
    }
    options.findingsRoot = path.join(options.repoRoot, "tmp", "gate-findings", options.repo.replace("/", "-"));
  }
  return options;
}

export async function readThreads(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw parseError(`Cannot read --threads file ${file}: ${error.message}`);
  }
  return raw.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    let thread;
    try {
      thread = JSON.parse(line);
    } catch {
      throw parseError(`Malformed JSONL at ${file}:${index + 1}`);
    }
    if (!thread || typeof thread !== "object" || !Number.isInteger(thread.pr) || typeof thread.path !== "string") {
      throw parseError(`Thread at ${file}:${index + 1} needs an integer pr and a string path`);
    }
    return [thread];
  });
}

/** Map of pr -> Map(path -> Set(angle)) from every object-shaped round file under <root>/pr-<N>/. */
export async function readFindingIndex(root) {
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw parseError(`Cannot read --findings-root ${root}: ${error.message}`);
  }
  const index = new Map();
  for (const dir of dirs) {
    const match = /^pr-(\d+)$/.exec(dir.name);
    if (!dir.isDirectory() || !match) continue;
    const byPath = new Map();
    for (const name of await readdir(path.join(root, dir.name))) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(root, dir.name, name);
      let round;
      try {
        round = JSON.parse(await readFile(file, "utf8"));
      } catch {
        throw parseError(`Malformed round file ${file}`);
      }
      if (!round || typeof round !== "object" || Array.isArray(round)) continue;
      for (const finding of Array.isArray(round.findings) ? round.findings : []) {
        for (const filePath of Array.isArray(finding?.files) ? finding.files : []) {
          if (!byPath.has(filePath)) byPath.set(filePath, new Set());
          if (typeof finding.angle === "string") byPath.get(filePath).add(finding.angle);
        }
      }
    }
    index.set(Number(match[1]), byPath);
  }
  return index;
}

export function matchThreads(threads, index) {
  const results = threads.map((thread) => {
    const angles = index.get(thread.pr)?.get(thread.path);
    const matched = angles !== undefined;
    const klass = classifyThreadBody(thread.body);
    return {
      pr: thread.pr,
      path: thread.path,
      matched,
      matchedAngles: matched ? [...angles].sort() : [],
      class: klass,
      shouldHaveCaughtAngles: matched ? [] : CLASS_ANGLES[klass],
    };
  });
  const summary = { total: results.length, copilotOnly: 0, byClass: {}, byAngle: {} };
  for (const r of results) {
    if (r.matched) continue;
    summary.copilotOnly += 1;
    summary.byClass[r.class] = (summary.byClass[r.class] ?? 0) + 1;
    for (const angle of r.shouldHaveCaughtAngles) summary.byAngle[angle] = (summary.byAngle[angle] ?? 0) + 1;
  }
  return { threads: results, summary };
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgsList(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const threads = await readThreads(options.threads);
  const index = await readFindingIndex(options.findingsRoot);
  const result = matchThreads(threads, index);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
