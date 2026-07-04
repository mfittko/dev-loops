#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireTokenValue, runCommand } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const DEFAULT_MAX_LINES = 1000;
const DEFAULT_DUPLICATE_WINDOW_LINES = 4;
const DEFAULT_BRANCH_THRESHOLD = 25;
const DEFAULT_THIN_WRAPPER_MAX_LINES = 40;
const USAGE = `Usage:
  run-refinement-audit.mjs --paths <comma-separated paths> [--root <path>] [--max-lines <n>] [--duplicate-window-lines <n>] [--branch-threshold <n>] [--thin-wrapper-max-lines <n>] [--output <path>]
  run-refinement-audit.mjs --paths-file <file> [--root <path>] [--max-lines <n>] [--duplicate-window-lines <n>] [--branch-threshold <n>] [--thin-wrapper-max-lines <n>] [--output <path>]
Run a bounded refinement audit for explicit repo paths only. The helper never falls back to a whole-repo scan.
Required:
  exactly one of:
    --paths <comma-separated paths>
    --paths-file <file>
Optional:
  --root <path>                  Repo root (defaults to git rev-parse --show-toplevel)
  --max-lines <n>               Oversized-file threshold (default: ${DEFAULT_MAX_LINES})
  --duplicate-window-lines <n>  Duplicate-block window size (default: ${DEFAULT_DUPLICATE_WINDOW_LINES})
  --branch-threshold <n>        Branching-hotspot threshold (default: ${DEFAULT_BRANCH_THRESHOLD})
  --thin-wrapper-max-lines <n>  Thin-wrapper line threshold (default: ${DEFAULT_THIN_WRAPPER_MAX_LINES})
  --output <path>               Write the same success JSON emitted on stdout
Success output (stdout, JSON):
  {
    "ok": true,
    "repoRoot": "/repo",
    "paths": ["AGENTS.md", "agents/refiner.agent.md"],
    "auditedFiles": [...],
    "findings": [...],
    "highestValueFollowUpCandidates": [...],
    "scopeBoundary": { "mode": "bounded_paths_only", "fullRepoScan": false }
  }
Failure behavior (stderr, JSON, exit 1):
  - malformed arguments, blank paths, invalid thresholds, and zero auditable files fail closed
  - findings are not a process failure; findings still return exit 0

${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
const BRANCH_TOKEN_PATTERN = /\b(?:if|else|switch|case|for|while|catch|finally|break|continue)\b|&&|\|\||\?(?![?.])/gu;
const PRIORITY_ORDER = new Map([
  ["high", 0],
  ["medium", 1],
  ["low", 2],
]);
export function parseRefinementAuditCliArgs(argv) {
  const options = {
    help: false,
    paths: undefined,
    pathsFile: undefined,
    root: undefined,
    maxLines: DEFAULT_MAX_LINES,
    duplicateWindowLines: DEFAULT_DUPLICATE_WINDOW_LINES,
    branchThreshold: DEFAULT_BRANCH_THRESHOLD,
    thinWrapperMaxLines: DEFAULT_THIN_WRAPPER_MAX_LINES,
    output: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      paths: { type: "string" },
      "paths-file": { type: "string" },
      root: { type: "string" },
      "max-lines": { type: "string" },
      "duplicate-window-lines": { type: "string" },
      "branch-threshold": { type: "string" },
      "thin-wrapper-max-lines": { type: "string" },
      output: { type: "string" },
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
    if (token.name === "paths") {
      options.paths = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "paths-file") {
      options.pathsFile = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "root") {
      options.root = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "max-lines") {
      options.maxLines = parsePositiveInteger(requireTokenValue(token, parseError), "--max-lines", parseError);
      continue;
    }
    if (token.name === "duplicate-window-lines") {
      options.duplicateWindowLines = parsePositiveInteger(
        requireTokenValue(token, parseError),
        "--duplicate-window-lines",
        parseError,
      );
      continue;
    }
    if (token.name === "branch-threshold") {
      options.branchThreshold = parsePositiveInteger(
        requireTokenValue(token, parseError),
        "--branch-threshold",
        parseError,
      );
      continue;
    }
    if (token.name === "thin-wrapper-max-lines") {
      options.thinWrapperMaxLines = parsePositiveInteger(
        requireTokenValue(token, parseError),
        "--thin-wrapper-max-lines",
        parseError,
      );
      continue;
    }
    if (token.name === "output") {
      options.output = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.paths !== undefined && options.pathsFile !== undefined) {
    throw parseError("Specify exactly one of --paths or --paths-file");
  }
  if (options.paths === undefined && options.pathsFile === undefined) {
    throw parseError("run-refinement-audit requires exactly one of --paths or --paths-file");
  }
  return options;
}
function toPosixPath(value) {
  return value.split(path.sep).join("/");
}
function countLines(text) {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}
function countBranchTokens(text) {
  const matches = text.match(BRANCH_TOKEN_PATTERN);
  return Array.isArray(matches) ? matches.length : 0;
}
function splitConfiguredPaths(raw) {
  return raw.split(",").map((entry) => entry.trim());
}
function assertNoBlankPaths(entries) {
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw parseError("Audit paths must be non-empty; blank paths are not allowed");
  }
  return entries;
}
async function loadConfiguredPaths(options, cwd) {
  if (options.paths !== undefined) {
    return assertNoBlankPaths(splitConfiguredPaths(options.paths));
  }
  const filePath = path.resolve(cwd, options.pathsFile);
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error && typeof error.message === "string"
      ? error.message
      : String(error);
    throw parseError(`Unreadable --paths-file input: ${detail}`);
  }
  const entries = raw.split(/\r?\n/u);
  if (entries.at(-1) === "") {
    entries.pop();
  }
  return assertNoBlankPaths(entries.map((entry) => entry.trim()));
}
async function resolveRepoRoot(options, { cwd, env, gitCommand }) {
  if (typeof options.root === "string") {
    return path.resolve(cwd, options.root);
  }
  const { stdout } = await runCommand(gitCommand, ["rev-parse", "--show-toplevel"], { cwd, env });
  const repoRoot = stdout.trim();
  if (repoRoot.length === 0) {
    throw new Error("Unable to resolve repo root");
  }
  return repoRoot;
}
function normalizeRequestedPath(requestedPath, repoRoot) {
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(repoRoot, requestedPath);
  const relativePath = path.relative(repoRoot, resolvedPath);
  if (relativePath.length === 0) {
    throw parseError("Repo root is not a valid bounded audit path; name a specific file or subdirectory");
  }
  if (relativePath.startsWith(`..${path.sep}`) || relativePath === ".." || path.isAbsolute(relativePath)) {
    throw parseError(`Path is outside the repo root: ${requestedPath}`);
  }
  return toPosixPath(relativePath);
}
async function expandTrackedFiles(requestedPaths, { repoRoot, env, gitCommand }) {
  const normalizedRequestedPaths = [];
  const seenRequestedPaths = new Set();
  const expandedTrackedFiles = [];
  const seenTrackedFiles = new Set();
  for (const requestedPath of requestedPaths) {
    const normalizedPath = normalizeRequestedPath(requestedPath, repoRoot);
    if (!seenRequestedPaths.has(normalizedPath)) {
      seenRequestedPaths.add(normalizedPath);
      normalizedRequestedPaths.push(normalizedPath);
    }
    const { stdout } = await runCommand(gitCommand, ["ls-files", "--", normalizedPath], { cwd: repoRoot, env });
    const trackedFiles = stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const trackedFile of trackedFiles) {
      const normalizedTrackedFile = toPosixPath(trackedFile);
      if (!seenTrackedFiles.has(normalizedTrackedFile)) {
        seenTrackedFiles.add(normalizedTrackedFile);
        expandedTrackedFiles.push(normalizedTrackedFile);
      }
    }
  }
  return {
    normalizedRequestedPaths,
    expandedTrackedFiles,
  };
}
function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}
function normalizeDuplicateLine(line) {
  return line.replace(/\s+/gu, " ").trim();
}
function shouldConsiderDuplicateWindow(lines) {
  const normalizedLines = lines.map(normalizeDuplicateLine);
  const joined = normalizedLines.join("\n").trim();
  const linesWithWordChars = normalizedLines.filter((line) => /[A-Za-z0-9]/u.test(line));
  return joined.length >= 20 && linesWithWordChars.length >= 2;
}
function collectDuplicateBlockCounts(auditableRecords, duplicateWindowLines) {
  const occurrences = new Map();
  for (const record of auditableRecords) {
    const lines = record.text.split(/\r?\n/u);
    if (lines.length < duplicateWindowLines) {
      continue;
    }
    for (let startIndex = 0; startIndex <= lines.length - duplicateWindowLines; startIndex += 1) {
      const window = lines.slice(startIndex, startIndex + duplicateWindowLines);
      if (!shouldConsiderDuplicateWindow(window)) {
        continue;
      }
      const normalizedBlock = window.map(normalizeDuplicateLine).join("\n");
      const values = occurrences.get(normalizedBlock) ?? [];
      values.push({ path: record.path, startLine: startIndex + 1 });
      occurrences.set(normalizedBlock, values);
    }
  }
  const duplicateCountsByPath = new Map();
  for (const values of occurrences.values()) {
    if (values.length < 2) {
      continue;
    }
    for (const value of values) {
      duplicateCountsByPath.set(value.path, (duplicateCountsByPath.get(value.path) ?? 0) + 1);
    }
  }
  return duplicateCountsByPath;
}
function isCommentLine(line) {
  return line.startsWith("#")
    || line.startsWith("//")
    || line.startsWith("/*")
    || line === "*"
    || line.startsWith("* ")
    || line.startsWith("*	")
    || line.startsWith("*/");
}
function isWrapperLikeLine(line) {
  return [
    /^import\s.+\sfrom\s+["'][^"']+["'];?$/u,
    /^export\s+\*\s+from\s+["'][^"']+["'];?$/u,
    /^export\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["'][^"']+["'];?$/u,
    /^export\s+(?:type\s+)?\{[^}]+\}\s+from\s+["'][^"']+["'];?$/u,
    /^export\s+(?:type\s+)?\{[^}]+\};?$/u,
    /^export\s+default\s+[A-Za-z_$][\w$]*;?$/u,
  ].some((pattern) => pattern.test(line));
}
function detectThinWrapperCandidate(text, { lineCount, branchTokenCount, thinWrapperMaxLines }) {
  if (lineCount === 0 || lineCount > thinWrapperMaxLines || branchTokenCount > 0) {
    return false;
  }
  const meaningfulLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isCommentLine(line));
  if (meaningfulLines.length === 0) {
    return false;
  }
  return meaningfulLines.every(isWrapperLikeLine);
}
function compareFindings(left, right) {
  const priorityDelta = (PRIORITY_ORDER.get(left.priority) ?? 99) - (PRIORITY_ORDER.get(right.priority) ?? 99);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const pathDelta = left.path.localeCompare(right.path);
  if (pathDelta !== 0) {
    return pathDelta;
  }
  return left.id.localeCompare(right.id);
}
function summarizeFollowUpReason(finding) {
  switch (finding.id) {
    case "oversized_file":
      return "Trim or split only if the current refinement scope explicitly chooses to; keep the audit as planning input, not rewrite authorization.";
    case "duplicate_block_candidate":
      return "Check whether duplication should become current-scope cleanup, a risk/watchpoint, or an explicit defer; do not broaden silently.";
    case "branching_hotspot":
      return "Review whether branching complexity should affect AC/DoD or become a watchpoint for the current bounded slice.";
    case "thin_wrapper_candidate":
      return "Consider delete/merge/trim framing before preserving glue-only wrapper layers; defer if out of scope.";
    default:
      return finding.summary;
  }
}
function buildFindings(auditableRecords, duplicateCountsByPath, thresholds) {
  const findings = [];
  for (const record of auditableRecords) {
    if (record.lineCount > thresholds.maxLines) {
      findings.push({
        id: "oversized_file",
        priority: "high",
        path: record.path,
        summary: "File exceeds the bounded audit line threshold.",
        evidence: { lineCount: record.lineCount, threshold: thresholds.maxLines },
      });
    }
    const duplicateBlockMatches = duplicateCountsByPath.get(record.path) ?? 0;
    if (duplicateBlockMatches > 0) {
      findings.push({
        id: "duplicate_block_candidate",
        priority: "medium",
        path: record.path,
        summary: "Normalized repeated text blocks appear more than once within the bounded audit scope.",
        evidence: {
          duplicateBlockMatches,
          duplicateWindowLines: thresholds.duplicateWindowLines,
        },
      });
    }
    if (record.branchTokenCount > thresholds.branchThreshold) {
      findings.push({
        id: "branching_hotspot",
        priority: "medium",
        path: record.path,
        summary: "Control-flow token count exceeds the bounded branching threshold.",
        evidence: { branchTokenCount: record.branchTokenCount, threshold: thresholds.branchThreshold },
      });
    }
    if (record.thinWrapperCandidate) {
      findings.push({
        id: "thin_wrapper_candidate",
        priority: "low",
        path: record.path,
        summary: "Small file looks dominated by re-exports or passthrough-only wrapper glue.",
        evidence: { lineCount: record.lineCount, threshold: thresholds.thinWrapperMaxLines },
      });
    }
  }
  return findings.sort(compareFindings);
}
function buildHighestValueFollowUpCandidates(findings) {
  const candidates = [];
  const seenPaths = new Set();
  for (const finding of findings) {
    if (seenPaths.has(finding.path)) {
      continue;
    }
    seenPaths.add(finding.path);
    candidates.push({
      path: finding.path,
      reason: summarizeFollowUpReason(finding),
    });
  }
  return candidates;
}
async function auditTrackedFiles(trackedFiles, options, { repoRoot }) {
  const auditableRecords = [];
  const skippedRecords = [];
  for (const trackedFile of trackedFiles) {
    const absolutePath = path.join(repoRoot, trackedFile);
    try {
      const buffer = await readFile(absolutePath);
      if (isBinaryBuffer(buffer)) {
        skippedRecords.push({
          path: trackedFile,
          lineCount: null,
          branchTokenCount: null,
          duplicateBlockMatches: 0,
          thinWrapperCandidate: false,
          skipped: true,
          skipReason: "binary_file",
        });
        continue;
      }
      const text = buffer.toString("utf8");
      const lineCount = countLines(text);
      const branchTokenCount = countBranchTokens(text);
      const thinWrapperCandidate = detectThinWrapperCandidate(text, {
        lineCount,
        branchTokenCount,
        thinWrapperMaxLines: options.thinWrapperMaxLines,
      });
      auditableRecords.push({
        path: trackedFile,
        text,
        lineCount,
        branchTokenCount,
        thinWrapperCandidate,
      });
    } catch (error) {
      skippedRecords.push({
        path: trackedFile,
        lineCount: null,
        branchTokenCount: null,
        duplicateBlockMatches: 0,
        thinWrapperCandidate: false,
        skipped: true,
        skipReason: "unreadable_file",
        skipDetail: error instanceof Error ? error.code ?? error.message : String(error),
      });
    }
  }
  if (auditableRecords.length === 0) {
    throw parseError("Zero auditable files remain after expansion; provide tracked text files in the bounded scope");
  }
  const duplicateCountsByPath = collectDuplicateBlockCounts(auditableRecords, options.duplicateWindowLines);
  const findings = buildFindings(auditableRecords, duplicateCountsByPath, {
    maxLines: options.maxLines,
    duplicateWindowLines: options.duplicateWindowLines,
    branchThreshold: options.branchThreshold,
    thinWrapperMaxLines: options.thinWrapperMaxLines,
  });
  const followUpCandidates = buildHighestValueFollowUpCandidates(findings);
  const auditedFileByPath = new Map();
  for (const record of auditableRecords) {
    auditedFileByPath.set(record.path, {
      path: record.path,
      lineCount: record.lineCount,
      branchTokenCount: record.branchTokenCount,
      duplicateBlockMatches: duplicateCountsByPath.get(record.path) ?? 0,
      thinWrapperCandidate: record.thinWrapperCandidate,
      skipped: false,
    });
  }
  for (const record of skippedRecords) {
    auditedFileByPath.set(record.path, record);
  }
  const auditedFiles = trackedFiles.map((trackedFile) => auditedFileByPath.get(trackedFile));
  return {
    auditedFiles,
    findings,
    highestValueFollowUpCandidates: followUpCandidates,
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    cwd = process.cwd(),
    env = process.env,
    gitCommand = "git",
  } = {},
) {
  const options = parseRefinementAuditCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const repoRoot = await resolveRepoRoot(options, { cwd, env, gitCommand });
  const configuredPaths = await loadConfiguredPaths(options, cwd);
  const { normalizedRequestedPaths, expandedTrackedFiles } = await expandTrackedFiles(configuredPaths, {
    repoRoot,
    env,
    gitCommand,
  });
  if (expandedTrackedFiles.length === 0) {
    throw parseError("Zero auditable files remain after expansion; provide tracked files in the bounded scope");
  }
  const auditResult = await auditTrackedFiles(expandedTrackedFiles, options, { repoRoot });
  const payload = {
    ok: true,
    repoRoot,
    paths: normalizedRequestedPaths,
    auditedFiles: auditResult.auditedFiles,
    findings: auditResult.findings,
    highestValueFollowUpCandidates: auditResult.highestValueFollowUpCandidates,
    scopeBoundary: {
      mode: "bounded_paths_only",
      fullRepoScan: false,
    },
  };
  if (typeof options.output === "string") {
    const outputPath = path.resolve(cwd, options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
  }
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout, stderr });
  return payload;
}
if (isDirectCliRun(import.meta.url)) {
  runCli()
    .catch((error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    });
}
