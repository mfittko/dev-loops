#!/usr/bin/env node
/**
 * spec-lint (GRILL-SPEC-LINT)
 *
 * Offline lint of an issue body against the rule registry and the decision
 * records. It reads only local files and makes no GitHub call. Semantic
 * contradiction between an AC row and a rule or ADR stays with the grill and
 * the spec-authority judge.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import {
  FORWARD_RULE_REFERENCES,
  NON_RULE_TOKENS,
  RULE_ID_SHAPE_RE,
  normalizeRuleEntry,
} from "../docs/validate-rule-ownership.mjs";
import { firstMeaningfulLine, isAcceptedOrSuperseded, splitStatus } from "../docs/validate-decision-records.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: dev-loops loop spec-lint --body-file <path> [--repo-root <path>]

Lint an issue body against skills/docs/required-rules.json and docs/decisions.

  --body-file <path>   File that holds the issue body (required)
  --repo-root <path>   Repository root to lint against (default: cwd)

Output (stdout, JSON):
  { "ok": true, "findings": [{ "kind", "id", "detail" }],
    "checks": { "rules": { "status": "ran" } | { "status": "skipped", "reason" },
                "adrs":  { "status": "ran" } | { "status": "skipped", "reason" } } }

Finding kinds: unknown_rule_id, unknown_adr, adr_not_accepted, adr_superseded, adr_amended.

${JQ_OUTPUT_USAGE}

Exit codes: 0 lint completed (with or without findings); 1 usage error;
2 malformed required-rules.json, another runtime error, or an invalid --jq filter.`;

const RECORD_FILE_RE = /^(\d{4})-[a-z0-9-]+\.md$/;
const BODY_ADR_RE = /\bADR\s+(\d{4})\b|docs\/decisions\/(\d{4})-[\w-]*\.md/g;
// ponytail: ADR numbers below 1000 carry a leading zero, so dates and issue numbers never match.
const STATUS_ADR_RE = /\b(0\d{3})\b/g;

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function stripFencedCode(body) {
  let inFence = false;
  return body.split(/\r?\n/).filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return false; }
    return !inFence;
  }).join("\n");
}

async function loadKnownRuleIds(repoRoot) {
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
  const entries = [...(parsed?.requiredRules ?? []), ...(parsed?.optOutRules ?? [])].map(normalizeRuleEntry);
  if (!Array.isArray(parsed?.requiredRules) || entries.some((entry) => entry.invalid)) {
    throw Object.assign(new Error(`Malformed registry in ${file}: requiredRules must be an array of rule entries`), { exitCode: 2 });
  }
  return { ids: new Set(entries.map((entry) => entry.id)) };
}

export function lintRuleIds(body, knownIds) {
  const seen = new Set();
  const findings = [];
  for (const [token] of stripFencedCode(body).matchAll(RULE_ID_SHAPE_RE)) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (knownIds.has(token) || NON_RULE_TOKENS.has(token) || FORWARD_RULE_REFERENCES.has(token) || /^ADR-\d+$/.test(token)) continue;
    findings.push({ kind: "unknown_rule_id", id: token, detail: { reason: "not in requiredRules or optOutRules of skills/docs/required-rules.json" } });
  }
  return findings;
}

function statusSentences(statusText) {
  const flat = statusText
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\([^()]*\bamended\b[^()]*\)/gi, " ")
    .replace(/\s+/g, " ");
  return flat.split(/(?<=[.!?])\s+/);
}

// The clause that names the targets ends at the first colon or semicolon, or at "does not amend".
function clauseAfter(sentence, index) {
  return sentence.slice(index).split(/[:;]|\bdoes not amend\b/i)[0];
}

function adrNumbersIn(text) {
  return [...text.matchAll(STATUS_ADR_RE)].map((match) => match[1]);
}

/**
 * Index docs/decisions/*.md by four-digit number. Amendment edges come from
 * Status sections only: "M amends N" in M, or "Amended by M" in N.
 */
export async function indexDecisionRecords(decisionsDir) {
  const records = new Map();
  for (const name of (await readdir(decisionsDir)).sort()) {
    const match = RECORD_FILE_RE.exec(name);
    if (!match || match[1] === "0000") continue;
    const { status } = splitStatus(await readFile(path.join(decisionsDir, name), "utf8"));
    const root = firstMeaningfulLine(status);
    const state = /^Proposed\b/.test(root) ? "proposed" : /^Superseded by\b/.test(root) ? "superseded" : isAcceptedOrSuperseded(status) ? "accepted" : "unknown";
    const supersededBy = state === "superseded" ? adrNumbersIn(statusSentences(root).join(" "))[0] ?? null : null;
    records.set(match[1], { id: match[1], file: name, state, statusLine: root, supersededBy, amends: new Set(), amendedBy: new Set(), status });
  }
  const addEdge = (amender, target) => {
    if (amender === target || !records.has(amender) || !records.has(target)) return;
    records.get(amender).amends.add(target);
    records.get(target).amendedBy.add(amender);
  };
  for (const record of records.values()) {
    for (const sentence of statusSentences(record.status)) {
      if (/\bamends no\b/i.test(sentence)) continue;
      const amends = /\b(?:partially\s+)?amends\b/i.exec(sentence);
      if (amends) {
        for (const target of adrNumbersIn(clauseAfter(sentence, amends.index))) addEdge(record.id, target);
      }
      const amendedBy = /\bamended by\b/i.exec(sentence);
      if (amendedBy) {
        for (const amender of adrNumbersIn(clauseAfter(sentence, amendedBy.index))) addEdge(amender, record.id);
      }
    }
    delete record.status;
  }
  return records;
}

export function lintAdrCitations(body, records) {
  const cited = new Set([...body.matchAll(BODY_ADR_RE)].map((match) => match[1] ?? match[2]));
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
    const amenders = [...record.amendedBy]
      .filter((amender) => amender > id && records.get(amender).state === "accepted")
      .sort()
      .map((amender) => ({ id: amender, file: records.get(amender).file, amenderCited: cited.has(amender) }));
    if (amenders.length > 0) findings.push({ kind: "adr_amended", id, detail: { amenders } });
  }
  return findings;
}

export async function lintSpec({ body, repoRoot }) {
  const findings = [];
  const checks = {};
  const rules = await loadKnownRuleIds(repoRoot);
  if (rules.skipped) {
    checks.rules = { status: "skipped", reason: rules.skipped };
  } else {
    findings.push(...lintRuleIds(body, rules.ids));
    checks.rules = { status: "ran" };
  }
  const decisionsDir = path.join(repoRoot, "docs", "decisions");
  let records;
  try {
    records = await indexDecisionRecords(decisionsDir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    checks.adrs = { status: "skipped", reason: `no decision records directory at ${decisionsDir}` };
  }
  if (records) {
    findings.push(...lintAdrCitations(body, records));
    checks.adrs = { status: "ran" };
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
