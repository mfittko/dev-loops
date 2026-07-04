#!/usr/bin/env node
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  loadDevLoopConfig,
  resolveHumanHandoffConfig,
} from "@dev-loops/core/config";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: resolve-handoff-candidates.mjs --repo <owner/name> --pr <number> [--changed-files <a,b,c>] [--pr-author <login>]
Resolve an ordered, deduped list of human-handoff reviewer/assignee candidates
for a PR, from the sources configured under \`approval.humanHandoff\` (#920).
This is the "offer" side: it surfaces candidates only — it never assigns anyone.

Sources (in priority order):
  assignees          Static configured list (approval.humanHandoff.assignees).
  codeowners         .github/CODEOWNERS / CODEOWNERS / docs/CODEOWNERS matched
                     against the PR's changed paths (last-match-wins per
                     CODEOWNERS semantics). Team handles (@org/team) are
                     included, flagged with isTeam:true.
  recent-committers  git log authors on the PR's changed paths (recent commits),
                     by GitHub login where derivable from the commit email,
                     excluding the PR author and bots.

Which sources run is controlled by approval.humanHandoff.candidatesFrom.
Disabled (default) => no-op: ok:true with an empty candidate list.

Required:
  --repo <owner/name>
  --pr <number>
Optional:
  --changed-files <csv>   Comma-separated changed paths. When omitted, derived
                          from \`gh pr view --json files\`.
  --pr-author <login>     PR author login (excluded from recent-committers).
                          When omitted, derived from \`gh pr view --json author\`.
Output (stdout, JSON):
  { "ok": true, "enabled": bool, "candidates": [{ "login", "source", "isTeam"?, "paths"? }],
    "changedFiles": [...], "sources": [...], "warnings": [...] }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including disabled no-op and fail-soft per-source skips)
  1  Argument error
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

function nextValue(args, i, flag) {
  const value = args[i];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw parseError(`Missing value for ${flag}`);
  }
  return value;
}

const RECENT_COMMITTERS_LIMIT = 50;
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
// Bot author handles to exclude from recent-committers.
const BOT_PATTERN = /\[bot\]$|^(?:dependabot|github-actions|copilot|renovate)$/i;

export function parseResolveCandidatesCliArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }
  const options = { help: false, repo: undefined, pr: undefined, changedFiles: undefined, prAuthor: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--repo") { options.repo = nextValue(args, ++i, "--repo"); continue; }
    if (token === "--pr") { options.pr = parsePrNumber(nextValue(args, ++i, "--pr"), parseError); continue; }
    if (token === "--changed-files") {
      options.changedFiles = nextValue(args, ++i, "--changed-files")
        .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      continue;
    }
    if (token === "--pr-author") { options.prAuthor = nextValue(args, ++i, "--pr-author").trim().replace(/^@/, ""); continue; }
    if (token === "--jq") { options.jq = nextValue(args, ++i, "--jq"); continue; }
    if (token === "--silent" || token === "-s") { options.silent = true; continue; }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Resolving handoff candidates requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// ---------------------------------------------------------------------------
// CODEOWNERS — parse + match
// ---------------------------------------------------------------------------

/**
 * Parse CODEOWNERS content into ordered { pattern, owners } rules.
 * Comments (#...) and blank lines are skipped. Owners keep their leading `@`.
 * @param {string} content
 * @returns {{ pattern: string, owners: string[] }[]}
 */
export function parseCodeowners(content) {
  const rules = [];
  for (const rawLine of String(content).split("\n")) {
    // A `#` starts a comment only at line start (after leading whitespace) or
    // when preceded by whitespace; a mid-token `#` is part of the pattern/owner
    // (gitignore/CODEOWNERS semantics).
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({ pattern, owners: owners.filter((o) => o.length > 0) });
  }
  return rules;
}

/**
 * Match a CODEOWNERS pattern against a repo-relative path (gitignore-ish).
 * Leading `/` anchors to repo root; trailing `/` matches a directory subtree;
 * `*` matches within a path segment, `**` across segments; a bare pattern with
 * no slash matches the path's basename or any segment.
 * @param {string} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
export function codeownersMatch(pattern, filePath) {
  const file = filePath.replace(/^\.?\//, "");
  let pat = pattern;
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  // Bare name (no slash, not anchored): match any path segment subtree.
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);

  const toRegex = (p) => {
    let re = "";
    for (let i = 0; i < p.length; i += 1) {
      const c = p[i];
      if (c === "*") {
        if (p[i + 1] === "*") { re += ".*"; i += 1; }
        else re += "[^/]*";
      } else if ("\\^$.|?+()[]{}".includes(c)) {
        re += `\\${c}`;
      } else {
        re += c;
      }
    }
    return re;
  };

  // Bare-vs-anchored is decided on the NORMALIZED pattern: a trailing-only `/`
  // (e.g. `build/`) normalizes to a bare token with no leading/internal slash,
  // so it matches at any depth like gitignore. Only a leading or internal slash
  // anchors the match.
  if (!anchored && !pat.includes("/")) {
    // Bare token: match a full segment anywhere, plus its subtree.
    const seg = toRegex(pat);
    return new RegExp(`(?:^|/)${seg}(?:/|$)`).test(file);
  }

  const body = toRegex(pat);
  // Anchored (or contains slash): match from root, allow subtree under it.
  const re = new RegExp(`^${body}(?:/|$)`);
  if (re.test(file)) return true;
  // Directory pattern also matches the directory's whole subtree.
  if (dirOnly) return new RegExp(`^${body}/`).test(file);
  return false;
}

/**
 * Resolve CODEOWNERS owners for a set of changed paths. Last-match-wins per
 * CODEOWNERS semantics: the final matching rule for each path wins.
 * @param {{ pattern: string, owners: string[] }[]} rules
 * @param {string[]} changedFiles
 * @returns {Map<string, Set<string>>} owner login (no `@`) -> set of paths
 */
export function ownersForPaths(rules, changedFiles) {
  /** @type {Map<string, Set<string>>} */
  const byOwner = new Map();
  for (const file of changedFiles) {
    let winner = null;
    for (const rule of rules) {
      if (codeownersMatch(rule.pattern, file)) winner = rule;
    }
    if (!winner || winner.owners.length === 0) continue;
    for (const owner of winner.owners) {
      const login = owner.replace(/^@/, "");
      if (login === "") continue;
      if (!byOwner.has(login)) byOwner.set(login, new Set());
      byOwner.get(login).add(file);
    }
  }
  return byOwner;
}

// ---------------------------------------------------------------------------
// Source resolvers (each fail-soft: returns candidates + a warning on error)
// ---------------------------------------------------------------------------

async function resolveCodeownersSource(changedFiles, { repoRoot, readFile }) {
  const warnings = [];
  for (const rel of CODEOWNERS_PATHS) {
    let content;
    try {
      content = await readFile(path.join(repoRoot, rel), "utf8");
    } catch (error) {
      // ENOENT => genuinely absent at this location: try the next path quietly.
      // Any other error (EACCES / IO) is real: surface it rather than silently
      // claiming "no CODEOWNERS file found".
      if (error && error.code === "ENOENT") continue;
      warnings.push(`codeowners: failed to read ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const rules = parseCodeowners(content);
    const byOwner = ownersForPaths(rules, changedFiles);
    return {
      candidates: [...byOwner.entries()].map(([login, paths]) => ({
        login,
        source: "codeowners",
        isTeam: login.includes("/"),
        paths: [...paths],
      })),
      warnings,
    };
  }
  // Fail-soft: no CODEOWNERS file anywhere -> no candidates, no abort. Keep any
  // non-ENOENT read warnings so a permissions/IO failure is not masked.
  return { candidates: [], warnings: [...warnings, "codeowners: no CODEOWNERS file found"] };
}

/**
 * Map a git author email to a GitHub login. `<login>@users.noreply.github.com`
 * (optionally `<id>+<login>@...`) carries the login directly; otherwise fall
 * back to the local-part of the email as a best-effort handle.
 */
export function loginFromCommitEmail(email) {
  const e = String(email).trim().toLowerCase();
  const noreply = e.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  if (noreply) return noreply[1];
  const at = e.indexOf("@");
  return at > 0 ? e.slice(0, at) : null;
}

async function resolveRecentCommittersSource(changedFiles, { repoRoot, prAuthor, run }) {
  if (changedFiles.length === 0) {
    return { candidates: [], warnings: [] };
  }
  let stdout;
  try {
    const result = await run("git", [
      "-C", repoRoot,
      "log", `-n${RECENT_COMMITTERS_LIMIT}`, "--no-merges", "--pretty=format:%ae",
      "--", ...changedFiles,
    ]);
    if (result.code !== 0) {
      return { candidates: [], warnings: [`recent-committers: git log exited ${result.code}`] };
    }
    stdout = result.stdout;
  } catch (error) {
    return { candidates: [], warnings: [`recent-committers: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const author = prAuthor ? prAuthor.toLowerCase() : null;
  const seen = new Set();
  const candidates = [];
  for (const line of stdout.split("\n")) {
    const email = line.trim();
    if (email === "") continue;
    const login = loginFromCommitEmail(email);
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    if (BOT_PATTERN.test(login)) continue;
    if (author && key === author) continue;
    seen.add(key);
    candidates.push({ login, source: "recent-committers" });
  }
  return { candidates, warnings: [] };
}

// ---------------------------------------------------------------------------
// gh lookups for changed files / author (only when not supplied)
// ---------------------------------------------------------------------------

async function fetchPrFacts(repo, pr, { run, ghCommand }) {
  const result = await run(ghCommand, [
    "pr", "view", String(pr), "--repo", repo, "--json", "files,author",
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `gh pr view exited ${result.code}`);
  }
  const payload = JSON.parse(result.stdout);
  const files = Array.isArray(payload?.files)
    ? payload.files.map((f) => (typeof f?.path === "string" ? f.path : "")).filter((p) => p.length > 0)
    : [];
  const author = typeof payload?.author?.login === "string" ? payload.author.login : null;
  return { files, author };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Resolve handoff candidates. Pure-ish: all IO is injected.
 * @param {{ repo: string, pr: number, changedFiles?: string[], prAuthor?: string|null }} input
 * @param {object} deps
 * @returns {Promise<object>}
 */
export async function resolveHandoffCandidates(input, deps = {}) {
  const {
    config,
    repoRoot = process.cwd(),
    ghCommand = "gh",
    run = (cmd, args) => runChild(cmd, args),
    readFile = fsReadFile,
  } = deps;

  const handoff = resolveHumanHandoffConfig(config);
  const warnings = [];

  if (!handoff.enabled) {
    return {
      ok: true,
      enabled: false,
      candidates: [],
      changedFiles: input.changedFiles ?? [],
      sources: [],
      warnings: [],
    };
  }

  let changedFiles = input.changedFiles;
  let prAuthor = input.prAuthor ?? null;
  if (changedFiles === undefined || prAuthor === null) {
    try {
      const facts = await fetchPrFacts(input.repo, input.pr, { run, ghCommand });
      if (changedFiles === undefined) changedFiles = facts.files;
      if (prAuthor === null) prAuthor = facts.author;
    } catch (error) {
      warnings.push(`pr-facts: ${error instanceof Error ? error.message : String(error)}`);
      if (changedFiles === undefined) changedFiles = [];
    }
  }

  const ordered = [];
  // 1. Static assignees — highest priority.
  for (const login of handoff.assignees) {
    ordered.push({ login: login.replace(/^@/, ""), source: "assignees", isTeam: login.includes("/") });
  }

  // 2/3. Other sources, in the CANONICAL priority order
  // (assignees > codeowners > recent-committers), regardless of the order they
  // appear in candidatesFrom. candidatesFrom only selects WHICH sources run,
  // not their relative rank.
  const enabledSources = new Set(handoff.candidatesFrom);
  if (enabledSources.has("codeowners")) {
    const result = await resolveCodeownersSource(changedFiles, { repoRoot, readFile });
    ordered.push(...result.candidates);
    warnings.push(...result.warnings);
  }
  if (enabledSources.has("recent-committers")) {
    const result = await resolveRecentCommittersSource(changedFiles, { repoRoot, prAuthor, run });
    ordered.push(...result.candidates);
    warnings.push(...result.warnings);
  }

  // Dedup by login (case-insensitive), first occurrence wins (preserves the
  // assignees > codeowners > recent-committers priority).
  const seen = new Set();
  const candidates = [];
  for (const c of ordered) {
    const key = c.login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }

  return {
    ok: true,
    enabled: true,
    candidates,
    changedFiles,
    sources: handoff.candidatesFrom,
    warnings,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let options;
  try {
    options = parseResolveCandidatesCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const repoRoot = deps.repoRoot ?? process.cwd();
  const { config } = deps.config !== undefined
    ? { config: deps.config }
    : await loadDevLoopConfig({ repoRoot });
  const result = await resolveHandoffCandidates(
    { repo: options.repo, pr: options.pr, changedFiles: options.changedFiles, prAuthor: options.prAuthor ?? null },
    { ...deps, config, repoRoot },
  );
  return emitResult(result, { jq: options.jq, silent: options.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
