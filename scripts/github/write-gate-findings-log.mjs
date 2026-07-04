#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const USAGE = `Usage: write-gate-findings-log.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --verdict <clean|findings_present|blocked> --findings <json> [--tmp-root <path>]
Write a durable <gate>-<headSha>.json log under deterministic tmp/ paths.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>
  --verdict <clean|findings_present|blocked>
  --findings <json>              JSON array of finding objects with severity, disposition, angle, and summary
Optional:
  --tmp-root <path>              Root tmp directory (default: tmp/)

${JQ_OUTPUT_USAGE}
`.trim();
function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}
function normalizeGate(value) {
  const gates = new Set(["draft_gate", "pre_approval_gate"]);
  const normalized = String(value).trim().toLowerCase();
  return gates.has(normalized) ? normalized : null;
}
function normalizeVerdict(value) {
  const verdicts = new Set(["clean", "findings_present", "blocked"]);
  const normalized = String(value).trim().toLowerCase();
  return verdicts.has(normalized) ? normalized : null;
}
function normalizeHeadSha(value) {
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}
const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
const VALID_DISPOSITIONS = new Set(["accepted-for-fix", "deferred", "disputed", "operator_acknowledged"]);
function parseFindingsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--findings must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw parseError("--findings must be a JSON array");
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object") {
      throw parseError(`--findings[${i}] must be an object`);
    }
    if (!f.severity || !VALID_SEVERITIES.has(f.severity)) {
      throw parseError(`--findings[${i}].severity must be one of: must-fix, worth-fixing-now, defer`);
    }
    if (!f.angle || typeof f.angle !== "string" || f.angle.trim().length === 0) {
      throw parseError(`--findings[${i}].angle is required`);
    }
    if (!f.summary || typeof f.summary !== "string" || f.summary.trim().length === 0) {
      throw parseError(`--findings[${i}].summary is required`);
    }
    const entry = {
      severity: f.severity,
      angle: f.angle.trim(),
      summary: f.summary.trim(),
    };
    if ("disposition" in f) {
      if (typeof f.disposition !== "string" || f.disposition.trim().length === 0) {
        throw parseError(`--findings[${i}].disposition must be a non-empty string`);
      }
      const disp = f.disposition.trim();
      if (!VALID_DISPOSITIONS.has(disp)) {
        throw parseError(`--findings[${i}].disposition must be one of: accepted-for-fix, deferred, disputed, operator_acknowledged`);
      }
      entry.disposition = disp;
    }
    if (Array.isArray(f.files)) {
      entry.files = f.files.filter(x => typeof x === "string" && x.trim().length > 0);
    }
    if ("resolvedIn" in f) {
      if (typeof f.resolvedIn !== "string" || f.resolvedIn.trim().length === 0) {
        throw parseError(`--findings[${i}].resolvedIn must be a non-empty string`);
      }
      const sha = f.resolvedIn.trim();
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
        throw parseError(`--findings[${i}].resolvedIn must be a 7-64 char hex SHA`);
      }
      entry.resolvedIn = sha;
    }
    return entry;
  });
}
export function parseWriteGateFindingsLogCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      verdict: { type: "string" },
      findings: { type: "string" },
      "tmp-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    verdict: undefined,
    findings: undefined,
    tmpRoot: "tmp",
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      return { help: true };
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "gate") {
      const gate = normalizeGate(requireTokenValue(token, parseError));
      if (!gate) throw parseError("--gate must be draft_gate or pre_approval_gate");
      options.gate = gate;
      continue;
    }
    if (token.name === "head-sha") {
      const sha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--head-sha must be a 7-64 character hex SHA");
      options.headSha = sha;
      continue;
    }
    if (token.name === "verdict") {
      const verdict = normalizeVerdict(requireTokenValue(token, parseError));
      if (!verdict) throw parseError("--verdict must be clean, findings_present, or blocked");
      options.verdict = verdict;
      continue;
    }
    if (token.name === "findings") {
      options.findings = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "jq") {
      options.jq = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "headSha", "verdict", "findings"]
    .filter(k => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  return options;
}
export function buildLogPath({ repo, pr, gate, headSha, tmpRoot }) {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some(p => p.length === 0)) {
    throw new Error(`--repo must be in owner/name format, got: ${JSON.stringify(repo)}`);
  }
  for (const p of parts) {
    if (p === "." || p === ".." || /[\s\\]/.test(p)) {
      throw new Error(`--repo segment ${JSON.stringify(p)} contains unsafe characters (dots, whitespace, or backslashes)`);
    }
  }
  const repoSlug = parts.join("-");
  return path.join(tmpRoot, "gate-findings", repoSlug, `pr-${pr}`, `${gate}-${headSha}.json`);
}
export async function writeGateFindingsLog(options, { repoRoot = process.cwd() } = {}) {
  const findings = parseFindingsJson(options.findings);
  const logPath = buildLogPath({
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    tmpRoot: options.tmpRoot || "tmp",
  });
  const fullPath = path.resolve(repoRoot, logPath);
  const log = {
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    verdict: options.verdict,
    loggedAt: new Date().toISOString(),
    findings,
  };
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(log, null, 2) + "\n", "utf8");
  return { ok: true, path: logPath, log };
}
async function main() {
  let options;
  try {
    options = parseWriteGateFindingsLogCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await writeGateFindingsLog(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
