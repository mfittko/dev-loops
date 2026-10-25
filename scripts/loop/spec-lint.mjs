#!/usr/bin/env node
/**
 * spec-lint (GRILL-SPEC-LINT)
 *
 * Offline lint of an issue body against the rule registry and the decision
 * records. It reads only local files and makes no GitHub call. Semantic
 * contradiction between an AC row and a rule or ADR stays with the grill and
 * the spec-authority judge.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadDevLoopConfigStrict } from "@dev-loops/core/config";
import { extractSection } from "@dev-loops/core/loop/markdown-sections";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { resolveSizeBounds } from "./check-size-budget.mjs";
import {
  FORWARD_RULE_REFERENCES,
  NON_RULE_TOKENS,
  RULE_ID_CITATION_RE,
  RULE_ID_SHAPE_RE,
  normalizeRuleEntry,
} from "../docs/validate-rule-ownership.mjs";
import { firstMeaningfulLine, isAcceptedOrSuperseded, splitStatus } from "../docs/validate-decision-records.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: dev-loops loop spec-lint --body-file <path> [--repo-root <path>]

Lint an issue body against skills/docs/required-rules.json, docs/decisions and the .devloops size bounds.

  --body-file <path>   File that holds the issue body (required)
  --repo-root <path>   Repository root to lint against (default: cwd)

Output (stdout, JSON):
  { "ok": true, "findings": [{ "kind", "id", "detail" }],
    "checks": { "sizeForecast": { "status": "ran" },
                "rules": { "status": "ran" } | { "status": "skipped", "reason" },
                "adrs":  { "status": "ran" } | { "status": "skipped", "reason" } } }

Finding kinds: unknown_rule_id, unknown_adr, adr_not_accepted, adr_superseded, adr_amended,
size_forecast_missing, size_forecast_malformed, size_forecast_split_required (PLAN-SIZE-BAND; one
"- forecast: slice=<id> wloc=<n> files=<path>,<path>" line per slice under "## Size forecast";
a line at or above the resolved default-tier waiverLoc must be split, not disposed;
a list item that starts with the word "forecast" or contains "wloc=" and does not parse is
size_forecast_malformed, also not disposable; non-list lines are never claimed),
simplest_design_missing (DESIGN-SIMPLEST-FIRST; a body with a "## Size forecast" section and no "## Simplest design" section).
ADR citation forms: "ADR NNNN", "ADR-<digits>" and docs/decisions/NNNN-*.md links.

${JQ_OUTPUT_USAGE}

Exit codes: 0 lint completed (with or without findings); 1 usage error;
2 malformed required-rules.json, a .devloops config error, another runtime error, or an invalid --jq filter.`;

const RECORD_FILE_RE = /^(\d{4,})-[a-z0-9-]+\.md$/;
const BODY_ADR_RE = /\bADR[\s-]+(\d{4,})\b|docs\/decisions\/(\d{4,})-[\w-]*\.md/g;
// Status sections also hold dates and issue numbers, so adrNumbersIn keeps only indexed record numbers.
const STATUS_ADR_RE = /\b(\d{4,})\b/g;

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

export function stripFencedCode(body) {
  // A fence closes only on a bare run of its own character at least as long as the opener.
  let fence = null;
  return body.split(/\r?\n/).filter((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) {
      if (marker) fence = marker;
      return !marker;
    }
    if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
    return false;
  }).join("\n");
}

export async function loadKnownRuleIds(repoRoot) {
  const file = path.join(repoRoot, "skills", "docs", "required-rules.json");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return { skipped: `no registry at ${file}` };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error(`Malformed JSON in ${file}`, { cause: error }), { exitCode: 2 });
  }
  const malformed = () => Object.assign(new Error(`Malformed registry in ${file}: requiredRules must be an array of rule entries`), { exitCode: 2 });
  if (!Array.isArray(parsed?.requiredRules) || !Array.isArray(parsed.optOutRules ?? [])) throw malformed();
  const entries = [...parsed.requiredRules, ...(parsed.optOutRules ?? [])].map(normalizeRuleEntry);
  if (entries.some((entry) => entry.invalid)) throw malformed();
  return { ids: new Set(entries.map((entry) => entry.id)) };
}

export function lintRuleIds(body, knownIds) {
  const seen = new Set();
  const findings = [];
  for (const [token] of stripFencedCode(body).matchAll(RULE_ID_CITATION_RE)) {
    if (seen.has(token)) continue;
    seen.add(token);
    // A citation-only form (one-character later segment) counts only when registered; unregistered, it is not rule-shaped (GLM-5, STEP-1).
    if (knownIds.has(token) || ![...token.matchAll(RULE_ID_SHAPE_RE)].some((m) => m[0] === token) || NON_RULE_TOKENS.has(token) || FORWARD_RULE_REFERENCES.has(token) || /^ADR-\d+$/.test(token)) continue;
    findings.push({ kind: "unknown_rule_id", id: token, detail: { reason: "not in requiredRules or optOutRules of skills/docs/required-rules.json" } });
  }
  return findings;
}

function statusSentences(statusText) {
  const flat = statusText
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    // Drop only "(which itself amended ...)" asides; an "(Amended by M)" annotation still creates an edge.
    .replace(/\((?:which|that)\s+(?:itself\s+)?amended\b[^()]*\)/gi, " ")
    .replace(/\s+/g, " ");
  return flat.split(/(?<=[.!?])\s+/);
}

// The clause that names the targets ends at the first colon or semicolon, or at "does not amend".
function clauseAfter(sentence, index) {
  return sentence.slice(index).split(/[:;]|\bdoes not amend\b/i)[0];
}

function adrNumbersIn(text, records) {
  return [...text.matchAll(STATUS_ADR_RE)].map((match) => match[1]).filter((id) => records.has(id));
}

/**
 * Index docs/decisions/*.md by record number (four or more digits). Amendment edges come from
 * Status sections only: "M amends N" in M, or "Amended by M" in N.
 * Returns null when the directory is missing.
 */
export async function indexDecisionRecords(decisionsDir) {
  let names;
  try {
    names = await readdir(decisionsDir);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const records = new Map();
  for (const name of names.sort()) {
    const match = RECORD_FILE_RE.exec(name);
    if (!match || match[1] === "0000") continue;
    const file = path.join(decisionsDir, name);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw Object.assign(new Error(`Cannot read decision record ${file}: ${error.message}`, { cause: error }), { exitCode: 2 });
    }
    const { status } = splitStatus(text);
    const root = firstMeaningfulLine(status);
    const state = /^Proposed\b/.test(root) ? "proposed" : /^Superseded by\b/.test(root) ? "superseded" : isAcceptedOrSuperseded(status) ? "accepted" : "unknown";
    records.set(match[1], { id: match[1], file: name, state, statusLine: root, supersededBy: null, amends: new Set(), amendedBy: new Set(), status });
  }
  const addEdge = (amender, target) => {
    if (amender === target || !records.has(amender) || !records.has(target)) return;
    records.get(amender).amends.add(target);
    records.get(target).amendedBy.add(amender);
  };
  for (const record of records.values()) {
    if (record.state === "superseded") record.supersededBy = adrNumbersIn(statusSentences(record.statusLine).join(" "), records)[0] ?? null;
    for (const sentence of statusSentences(record.status)) {
      if (/\bamends no\b/i.test(sentence)) continue;
      const amends = /\b(?:partially\s+)?amends\b/i.exec(sentence);
      if (amends) {
        let targets = adrNumbersIn(clauseAfter(sentence, amends.index), records);
        // "ADR N (amends its ...)" names the target before the verb.
        if (targets.length === 0 && /^amends\s+(?:its|their)\b/i.test(sentence.slice(amends.index))) targets = adrNumbersIn(sentence.slice(0, amends.index), records);
        for (const target of targets) addEdge(record.id, target);
      }
      const amendedBy = /\bamended by\b/i.exec(sentence);
      if (amendedBy) {
        for (const amender of adrNumbersIn(clauseAfter(sentence, amendedBy.index), records)) addEdge(amender, record.id);
      }
    }
    delete record.status;
  }
  return records;
}

/**
 * The record numbers a body cites, in any of the accepted citation forms. One
 * reader for every consumer: `BODY_ADR_RE` is global/stateful, so it is never
 * shared as a regex.
 */
export function citedAdrNumbers(body) {
  return new Set([...body.matchAll(BODY_ADR_RE)].map((match) => match[1] ?? match[2]));
}

/** Amenders in force: later-numbered than the amended record and accepted. */
export function inForceAmenders(id, record, records) {
  return [...record.amendedBy].filter((amender) => Number(amender) > Number(id) && records.get(amender).state === "accepted");
}

export function lintAdrCitations(body, records) {
  const cited = citedAdrNumbers(body);
  const findings = [];
  for (const id of cited) {
    const record = records.get(id);
    if (!record) {
      findings.push({ kind: "unknown_adr", id, detail: { reason: `no docs/decisions/${id}-*.md record` } });
      continue;
    }
    if (record.state === "proposed") {
      findings.push({ kind: "adr_not_accepted", id, detail: { status: record.statusLine, file: record.file } });
    }
    if (record.state === "superseded") {
      findings.push({ kind: "adr_superseded", id, detail: { supersededBy: record.supersededBy, status: record.statusLine } });
    }
    const amenders = inForceAmenders(id, record, records)
      .sort((a, b) => Number(a) - Number(b))
      .map((amender) => ({ id: amender, file: records.get(amender).file, amenderCited: cited.has(amender) }));
    if (amenders.length > 0) findings.push({ kind: "adr_amended", id, detail: { amenders } });
  }
  return findings;
}

const FORECAST_LINE_RE = /^\s*-\s+forecast:\s+slice=(\S+)\s+wloc=(\d+)\s+files=(\S+)\s*$/;
// One grammar claims a forecast attempt: a LIST ITEM (marker `-`, `*`, `+`, `N.`, `N)`) whose first token (ignoring `*`, `_`, backtick) is the word `forecast`, or that contains `wloc=` (spaces around `=` allowed). Non-list lines are never claimed. A claimed line that misses FORECAST_LINE_RE is reported, never dropped.
const FORECAST_BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:[*_`]*forecast\b|.*wloc\s*=)/iu;

/**
 * PLAN-SIZE-BAND forecast lines under `## Size forecast`: one line per slice,
 * `- forecast: slice=<id> wloc=<n> files=<path>,<path>`. A missing line and a
 * line at or above the resolved waiverLoc are findings, and so is a forecast
 * bullet that fails to parse (size_forecast_malformed); none can be disposed.
 */
export function lintSizeForecast(body, { waiverLoc }) {
  const section = extractSection(stripFencedCode(body), "Size forecast") ?? "";
  const rawLines = section.split(/\r?\n/);
  const lines = rawLines.map((line) => FORECAST_LINE_RE.exec(line)).filter(Boolean);
  const malformed = rawLines
    .filter((line) => FORECAST_BULLET_RE.test(line) && !FORECAST_LINE_RE.test(line))
    .map((line) => ({ kind: "size_forecast_malformed", id: "size-forecast", detail: { line: line.trim() } }));
  const missing = lines.length === 0
    ? [{ kind: "size_forecast_missing", id: "size-forecast", detail: { reason: "no `- forecast: slice=<id> wloc=<n> files=<path>,<path>` line under `## Size forecast`" } }]
    : [];
  if (lines.length === 0 || typeof waiverLoc !== "number") return [...missing, ...malformed];
  return [
    ...malformed,
    ...lines
      .filter(([, , wloc]) => Number(wloc) >= waiverLoc)
      .map(([, slice, wloc]) => ({ kind: "size_forecast_split_required", id: slice, detail: { wloc: Number(wloc), waiverLoc } })),
  ];
}

/** DESIGN-SIMPLEST-FIRST: a grilled body (one with `## Size forecast`) needs a `## Simplest design` section. */
export function lintSimplestDesign(body) {
  const stripped = stripFencedCode(body);
  if (extractSection(stripped, "Size forecast") === null || extractSection(stripped, "Simplest design")?.trim()) return [];
  return [{ kind: "simplest_design_missing", id: "simplest-design", detail: { reason: "no `## Simplest design` section (minimal approach, rejected alternatives, cost comparison)" } }];
}

export async function lintSpec({ body, repoRoot }) {
  const rootStat = await stat(repoRoot).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!rootStat?.isDirectory()) throw Object.assign(new Error(`--repo-root ${repoRoot} is not an existing directory`), { usage: USAGE, exitCode: 1 });
  const findings = [];
  const checks = {};
  const rules = await loadKnownRuleIds(repoRoot);
  if (rules.skipped) {
    checks.rules = { status: "skipped", reason: rules.skipped };
  } else {
    findings.push(...lintRuleIds(body, rules.ids));
    checks.rules = { status: "ran" };
  }
  const { config } = await loadDevLoopConfigStrict({ repoRoot });
  findings.push(...lintSizeForecast(body, resolveSizeBounds(config)));
  checks.sizeForecast = { status: "ran" };
  findings.push(...lintSimplestDesign(body));
  const decisionsDir = path.join(repoRoot, "docs", "decisions");
  const records = await indexDecisionRecords(decisionsDir);
  if (records) {
    findings.push(...lintAdrCitations(body, records));
    checks.adrs = { status: "ran" };
  } else {
    checks.adrs = { status: "skipped", reason: `no decision records directory at ${decisionsDir}` };
  }
  return { ok: true, findings, checks };
}

export function parseSpecLintArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" }, "body-file": { type: "string" }, "repo-root": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
      strict: true,
    }));
  } catch (error) {
    throw Object.assign(new Error(error.message), { usage: USAGE, exitCode: 1 });
  }
  if (values.help) return { help: true };
  if (!values["body-file"]) throw Object.assign(new Error("Missing required --body-file <path>"), { usage: USAGE, exitCode: 1 });
  return { help: false, bodyFile: values["body-file"], repoRoot: values["repo-root"] ?? process.cwd(), jq: values.jq, silent: values.silent, fields: values.fields };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseSpecLintArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const body = await readFile(options.bodyFile, "utf8");
    const result = await lintSpec({ body, repoRoot: path.resolve(options.repoRoot) });
    return emitResult(result, { jq: options.jq, silent: options.silent, fields: options.fields, stdout, stderr });
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: error.exitCode === 1 ? USAGE : undefined })}\n`);
    return error.exitCode ?? 2;
  }
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
