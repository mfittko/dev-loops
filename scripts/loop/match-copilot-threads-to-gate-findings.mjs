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
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { buildLogPath } from "../github/_gate-artifact-paths.mjs";
import { COPILOT_AUTHOR, COPILOT_BUCKETS } from "./gate-finding-classes.mjs";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

// A thread matches a same-file finding when both carry a line and the thread line is within this many lines of it.
export const LINE_WINDOW = 25;

const USAGE = `Usage: match-copilot-threads-to-gate-findings.mjs --threads <jsonl> --repo <owner/name> [--findings-root <dir>] [--repo-root <dir>]

Required:
  --threads <jsonl>       JSONL export; one thread per line; uses pr (integer), path (string), optional line (integer), author and body; only lines whose author is the Copilot reviewer login are read; other fields are ignored
  --repo <owner/name>     Selects the default findings dir <main-checkout>/tmp/gate-findings/<owner-repo>/ (not needed with --findings-root)

Optional:
  --findings-root <dir>   Directory holding pr-<N>/draft_gate-*.json round files
  --repo-root <dir>       Checkout whose main worktree anchors the default findings dir (default: cwd)
  --help, -h              Show this help

Matching is by file and line: a thread is matched when a finding of the same PR lists
the thread path in files[] (or the singular file) and, when both the thread and the finding
carry a line, the thread line is within ${LINE_WINDOW} lines of the finding line. When either side
has no line, the file match alone counts.

Output (stdout, JSON):
  { "threads": [{ pr, path, matched, matchedAngles, class, shouldHaveCaughtAngles }],
    "summary": { total, copilotOnly, byClass, byAngle, skippedRoundFiles } }
Only draft_gate-<sha>.json and draft_gate-<sha>.round-<N>.json round files are read; a malformed one is skipped and counted.

${JQ_OUTPUT_USAGE}
`;

const parseError = buildParseError(USAGE);

// Real draft_gate angle names (packages/core/src/config/extension-defaults.yaml), keyed by the class names of COPILOT_BUCKETS.
export const CLASS_ANGLES = {
  "edge-case-input-validation": ["input-validation", "correctness", "state-concurrency", "determinism"],
  "docs-help-description": ["contract-surface", "pr-description", "link-check"],
  tests: ["coverage"],
  other: ["correctness", "holistic", "state-concurrency", "contract-surface", "determinism", "packaging-runtime", "contradiction-lens"],
};

// The same bucket table as gate-finding-classes.mjs, so the brief and this report give one class per thread.
export function classifyThreadBody(body) {
  const text = String(body ?? "");
  return COPILOT_BUCKETS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

export function parseArgsList(argv) {
  const options = { help: false, threads: null, repo: null, findingsRoot: null, repoRoot: process.cwd(), jqOutput: {} };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      threads: { type: "string" },
      repo: { type: "string" },
      "findings-root": { type: "string" },
      "repo-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
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
    if (matchJqOutputToken(token, options.jqOutput, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.threads) throw parseError("--threads <jsonl> is required");
  if (!options.findingsRoot) {
    if (!options.repo) throw parseError("--repo <owner/name> is required when --findings-root is not given");
    // The main-anchored ledger is the authoritative copy (as in gate-finding-classes.mjs), never a worktree-local tmp/ copy.
    try {
      options.findingsRoot = path.dirname(path.dirname(buildLogPath({ repo: options.repo, pr: 1, gate: "draft_gate", headSha: "x", tmpRoot: resolveGateArtifactTmpRoot(options.repoRoot) })));
    } catch (error) {
      throw parseError(error.message);
    }
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
    if (typeof thread?.author !== "string" || !COPILOT_AUTHOR.test(thread.author)) return [];
    if (!Number.isInteger(thread.pr) || typeof thread.path !== "string") {
      throw parseError(`Thread at ${file}:${index + 1} needs an integer pr and a string path`);
    }
    return [thread];
  });
}

function findingFiles(finding) {
  const files = Array.isArray(finding?.files) ? finding.files : typeof finding?.file === "string" ? [finding.file] : [];
  return files.filter((entry) => typeof entry === "string");
}

/** { index, skipped }: index is pr -> Map(path -> [{ angle, line }]) from every draft_gate-*.json round file under <root>/pr-<N>/; skipped counts unreadable or non-object ones. */
export async function readFindingIndex(root) {
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw parseError(`Cannot read --findings-root ${root}: ${error.message}`);
  }
  const index = new Map();
  let skipped = 0;
  for (const dir of dirs) {
    const match = /^pr-(\d+)$/.exec(dir.name);
    if (!dir.isDirectory() || !match) continue;
    const byPath = new Map();
    for (const name of await readdir(path.join(root, dir.name))) {
      if (!/^draft_gate-[0-9a-f]+(?:\.round-\d+)?\.json$/.test(name)) continue; // the ledger writer's names only: derived .consolidated/.act-list/... files are not rounds
      const file = path.join(root, dir.name, name);
      let round;
      try {
        round = JSON.parse(await readFile(file, "utf8"));
      } catch {
        skipped += 1;
        continue;
      }
      if (!round || typeof round !== "object" || Array.isArray(round)) { skipped += 1; continue; }
      for (const finding of Array.isArray(round.findings) ? round.findings : []) {
        for (const rawPath of findingFiles(finding)) {
          const filePath = rawPath.trim();
          if (!byPath.has(filePath)) byPath.set(filePath, []);
          byPath.get(filePath).push({ angle: typeof finding.angle === "string" ? finding.angle : null, line: Number.isInteger(finding.line) ? finding.line : null });
        }
      }
    }
    index.set(Number(match[1]), byPath);
  }
  return { index, skipped };
}

export function matchThreads(threads, { index, skipped = 0 }) {
  const results = threads.map((thread) => {
    const near = (index.get(thread.pr)?.get(thread.path.trim()) ?? []).filter((f) => !Number.isInteger(thread.line) || f.line === null || Math.abs(thread.line - f.line) <= LINE_WINDOW);
    const matched = near.length > 0;
    const angles = new Set(near.flatMap((f) => (f.angle === null ? [] : [f.angle])));
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
  const summary = { total: results.length, copilotOnly: 0, byClass: {}, byAngle: {}, skippedRoundFiles: skipped };
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
  const result = matchThreads(threads, await readFindingIndex(options.findingsRoot));
  const { jq, silent, fields } = options.jqOutput;
  process.exitCode = emitResult(result, { jq, silent, fields });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
