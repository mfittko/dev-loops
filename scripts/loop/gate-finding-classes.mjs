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
import { detectRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { buildLogPath } from "../github/_gate-artifact-paths.mjs";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: dev-loops gate finding-classes [--repo <owner/name>] [--top <n>] [--tmp-root <path>]
Report the most frequent angles of act-judged findings from the first draft_gate round of each PR.
Offline: reads <main-tmp-root>/gate-findings/<owner-repo>/pr-*/draft_gate-*.json, makes no GitHub call.
  --repo <owner/name>  Repository (default: detected from the origin remote)
  --top <n>            Number of classes to print (default 3)
  --tmp-root <path>    Tmp root to read (default: the main-anchored tmp root)
Output (stdout, JSON): { "ok": true, "repo", "changes", "total", "skipped",
  "classes": [{ "angle", "count", "share", "examples": ["<summary, 160 chars max>"] }] }
"changes" counts the PRs read, "total" the act findings, "skipped" the malformed log files.
No logs yields "classes": [] and exit 0.
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
const EXAMPLE_MAX = 160;

const trim = (s) => (s.length > EXAMPLE_MAX ? `${s.slice(0, EXAMPLE_MAX - 3)}...` : s);

/** Aggregate act findings of the first draft_gate round per PR under `tmpRoot`. */
export function collectFindingClasses({ repo, tmpRoot, top = 3 }) {
  const prsDir = path.dirname(path.dirname(buildLogPath({ repo, pr: 1, gate: "draft_gate", headSha: "x", tmpRoot })));
  const byAngle = new Map();
  let changes = 0, total = 0, skipped = 0;
  let prs = [];
  try { prs = readdirSync(prsDir).filter((n) => /^pr-\d+$/u.test(n)); } catch { /* no logs */ }
  for (const pr of prs) {
    const dir = path.join(prsDir, pr);
    const rounds = [];
    for (const name of readdirSync(dir).filter((n) => /^draft_gate-.+\.json$/u.test(n))) {
      const file = path.join(dir, name);
      try {
        const log = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(log.findings)) throw new Error("no findings array");
        const t = Date.parse(log.loggedAt);
        rounds.push({ log, time: Number.isNaN(t) ? statSync(file).mtimeMs : t });
      } catch { skipped += 1; }
    }
    if (!rounds.length) continue;
    changes += 1;
    rounds.sort((a, b) => a.time - b.time);
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
    .sort((a, b) => b.count - a.count || a.angle.localeCompare(b.angle))
    .slice(0, top)
    .map((c) => ({ ...c, share: Math.round((c.count / total) * 100) / 100 }));
  return { changes, total, skipped, classes };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, top: { type: "string" }, "tmp-root": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (values.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (values.top !== undefined && !/^[1-9]\d*$/u.test(values.top)) throw parseError("--top must be a positive integer");
    const repo = values.repo ?? detectRepoSlug(cwd);
    if (!repo || !/^[^/\s]+\/[^/\s]+$/u.test(repo)) throw parseError("--repo must be owner/name (or run inside a GitHub checkout)");
    const tmpRoot = path.resolve(cwd, values["tmp-root"] ?? resolveGateArtifactTmpRoot(cwd));
    const result = collectFindingClasses({ repo, tmpRoot, top: values.top === undefined ? 3 : Number(values.top) });
    return emitResult({ ok: true, repo, ...result }, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
