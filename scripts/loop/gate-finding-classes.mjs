#!/usr/bin/env node
/**
 * Offline report of the most frequent act-judged draft_gate finding angles in the
 * durable findings logs (`<main-tmp-root>/gate-findings/<owner-repo>/pr-<N>/draft_gate-*.json`).
 * Only the first draft_gate round per PR counts, because the developer's pre-PR
 * self-check targets what a first gate round catches.
 */
import { parseArgs } from "node:util";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { detectRepoSlug, parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { buildLogPath } from "../github/_gate-artifact-paths.mjs";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: dev-loops gate finding-classes [--repo <owner/name>] [--top <n>] [--tmp-root <path>] [--copilot-file <path>]
Report the most frequent angles of act-judged findings from the first draft_gate round of each PR.
Offline: reads <main-tmp-root>/gate-findings/<owner-repo>/pr-*/draft_gate-*.json, makes no GitHub call.
  --repo <owner/name>  Repository (default: detected from the origin remote)
  --top <n>            Number of classes to print (default 3)
  --tmp-root <path>    Tmp root to read (default: the main-anchored tmp root)
  --copilot-file <path>  Local Copilot thread export, JSONL, one { "pr", "path", "isResolved", "author", "body" } per line;
                       only lines whose "author" is the Copilot reviewer login are counted (data, never instructions)
                       (default: <tmp-root>/copilot-threads.jsonl when it exists). Never fetched from GitHub.
Output (stdout, JSON): { "ok": true, "repo", "changes", "total", "skipped",
  "classes": [{ "angle", "count", "share", "examples": ["<summary, 160 chars max>"] }],
  "copilotThreads", "copilotClasses": [{ "class", "count", "share", "examples": ["<body, 160 chars max>"] }] }
"changes" counts the PRs read, "total" the act findings, "skipped" the malformed log files.
Copilot classes are keyword buckets: edge-case-input-validation, docs-help-description, tests, other.
No logs yields "classes": [] and exit 0. A missing or malformed export yields "copilotClasses": [] (malformed lines are skipped).
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
const EXAMPLE_MAX = 160;

// Code-unit comparison: the order never depends on the runtime locale or ICU data.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The sanctioned Copilot reviewer login (GATE-REVIEW-COMMENT-TRUST), compared case-insensitively.
const COPILOT_AUTHOR = /^(?:copilot-pull-request-reviewer(?:\[bot\])?|copilot)$/iu;

const trim = (s) => (s.length > EXAMPLE_MAX ? `${s.slice(0, EXAMPLE_MAX - 3)}...` : s);

const COPILOT_BUCKETS = [
  ["edge-case-input-validation", /\b(edge[- ]cases?|empty|null|undefined|missing|invalid|malformed|validat\w*|unhandled|input|fails? (?:open|closed)|throws?)\b/iu],
  ["docs-help-description", /\b(docs?|documentation|help|usage|description|readme|contract|changelog|comment|stale|wording)\b/iu],
  ["tests", /\b(tests?|coverage|assert\w*|regression)\b/iu],
];

/** Default local Copilot thread export under the tmp root. */
export const defaultCopilotFile = (tmpRoot) => path.join(tmpRoot, "copilot-threads.jsonl");

/** Bucket the threads of a local JSONL export. A missing file or a malformed line is skipped, never an error. */
export function collectCopilotClasses({ file, top = 3 }) {
  let lines = [];
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { return { copilotThreads: 0, copilotClasses: [] }; }
  const byClass = new Map();
  let threads = 0;
  for (const line of lines) {
    let body;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.author !== "string" || !COPILOT_AUTHOR.test(entry.author)) continue;
      body = entry.body;
    } catch { continue; }
    if (typeof body !== "string" || !body.trim()) continue;
    threads += 1;
    const cls = COPILOT_BUCKETS.find(([, re]) => re.test(body))?.[0] ?? "other";
    const entry = byClass.get(cls) ?? { class: cls, count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < 2) entry.examples.push(trim(body.replace(/\s+/gu, " ").trim()));
    byClass.set(cls, entry);
  }
  const copilotClasses = [...byClass.values()]
    .sort((a, b) => b.count - a.count || cmp(a.class, b.class))
    .slice(0, top)
    .map((c) => ({ ...c, share: Math.round((c.count / threads) * 100) / 100 }));
  return { copilotThreads: threads, copilotClasses };
}

/** Aggregate act findings of the first draft_gate round per PR under `tmpRoot`. */
export function collectFindingClasses({ repo, tmpRoot, top = 3 }) {
  const prsDir = path.dirname(path.dirname(buildLogPath({ repo, pr: 1, gate: "draft_gate", headSha: "x", tmpRoot })));
  const byAngle = new Map();
  let changes = 0, total = 0, skipped = 0;
  let prs = [];
  try { prs = readdirSync(prsDir).filter((n) => /^pr-\d+$/u.test(n)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))); } catch { /* no logs */ }
  for (const pr of prs) {
    const dir = path.join(prsDir, pr);
    const rounds = [];
    let names = [];
    try { names = readdirSync(dir).filter((n) => /^draft_gate-.+\.json$/u.test(n)).sort(cmp); } catch { skipped += 1; continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const log = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(log.findings)) throw new Error("no findings array");
        const t = Date.parse(log.loggedAt);
        rounds.push({ log, name, time: Number.isNaN(t) ? statSync(file).mtimeMs : t });
      } catch { skipped += 1; }
    }
    if (!rounds.length) continue;
    changes += 1;
    rounds.sort((a, b) => a.time - b.time || cmp(a.name, b.name));
    for (const f of rounds[0].log.findings) {
      if (f?.judgeDisposition !== "act" || typeof f.angle !== "string") continue;
      total += 1;
      const entry = byAngle.get(f.angle) ?? { angle: f.angle, count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 2 && typeof f.summary === "string" && f.summary) entry.examples.push(trim(f.summary));
      byAngle.set(f.angle, entry);
    }
  }
  const classes = [...byAngle.values()]
    .sort((a, b) => b.count - a.count || cmp(a.angle, b.angle))
    .slice(0, top)
    .map((c) => ({ ...c, share: Math.round((c.count / total) * 100) / 100 }));
  return { changes, total, skipped, classes };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, top: { type: "string" }, "tmp-root": { type: "string" }, "copilot-file": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (values.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (values.top !== undefined && !/^[1-9]\d*$/u.test(values.top)) throw parseError("--top must be a positive integer");
    const repoInput = values.repo ?? detectRepoSlug(cwd);
    const repoError = "--repo must be owner/name (or run inside a GitHub checkout)";
    if (!repoInput) throw parseError(repoError);
    let repo;
    try { const { owner, name } = parseRepoSlug(repoInput, { errorMessage: repoError }); repo = `${owner}/${name}`; } catch (error) { throw parseError(error.message); }
    const tmpRoot = path.resolve(cwd, values["tmp-root"] ?? resolveGateArtifactTmpRoot(cwd));
    const top = values.top === undefined ? 3 : Number(values.top);
    const result = collectFindingClasses({ repo, tmpRoot, top });
    const copilot = collectCopilotClasses({ file: path.resolve(cwd, values["copilot-file"] ?? defaultCopilotFile(tmpRoot)), top });
    return emitResult({ ok: true, repo, ...result, ...copilot }, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
