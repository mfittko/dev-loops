#!/usr/bin/env node
/**
 * consolidate-fanin.mjs — sanctioned fan-in CLI over the pure helpers in
 * @dev-loops/core/loop/gate-fanin (issue #1481). Reads every per-angle
 * findings artifact a gate-review fan-out produced, consolidates them with
 * consolidateFanin()/toFindingsLogShape(), and emits the JSON shapes
 * write-gate-findings-log.mjs (--findings / --findings-file), post-gate-findings.mjs
 * (--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json)
 * accept directly — the orchestrator no longer hand-authors this JSON with inline
 * interpreters.
 *
 * Per-angle findings artifact shape (one *.json file per angle in --findings-dir):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present" | "blocked",
 *     findings: [{ severity, summary, file?, line?, disposition? }]
 *   }
 *
 * An angle reporting verdict "blocked" (or any malformed artifact) is not a
 * recognized consolidateFanin() input verdict; it is correctly folded into an
 * overall "blocked" gate verdict by consolidateFanin()'s own malformed-input
 * handling — no special-casing needed here.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { consolidateFanin, toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";

const USAGE = `Usage: consolidate-fanin.mjs --findings-dir <dir> [--gate <draft_gate|pre_approval_gate>] [--out <path>] [--pr-checklist-matrix <clean|json>]
Consolidate the per-angle *.json findings artifacts a gate-review fan-out wrote into
--findings-dir into the JSON shapes write-gate-findings-log.mjs, post-gate-findings.mjs
(--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json) accept.
Required:
  --findings-dir <dir>          Directory containing one *.json per-angle findings
                                 artifact: { angle, verdict, findings: [{ severity, summary, file?, line?, disposition? }] }
Optional:
  --gate <draft_gate|pre_approval_gate>   Echoed onto the result as "gate" (no validation side effects)
  --out <path>                  Also write the flat findings array to this path as JSON
  --pr-checklist-matrix <clean|json>      When no pr-checklist-matrix angle artifact was found,
                                 upsert one: "clean" for { angle: "pr-checklist-matrix", verdict: "clean", findings: [] },
                                 or a JSON artifact object ({ angle?, verdict, findings }) for a custom one
Output (stdout, JSON):
  { "ok": true, "gate"?: "...", "angles": [{ "angle", "verdict", "findingCount" }],
    "findings": [...], "ledger": [...], "severityCounts": { "must-fix", "worth-fixing-now", "defer" },
    "overallVerdict": "clean"|"findings_present"|"blocked" }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, missing/empty --findings-dir, unparseable artifact, or schema violation
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

const VALID_GATES = new Set(["draft_gate", "pre_approval_gate"]);
const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);

export function parseConsolidateFaninCliArgs(argv) {
  const options = {
    help: false,
    findingsDir: undefined,
    gate: undefined,
    out: undefined,
    prChecklistMatrix: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "findings-dir": { type: "string" },
      gate: { type: "string" },
      out: { type: "string" },
      "pr-checklist-matrix": { type: "string" },
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
    if (token.name === "findings-dir") {
      options.findingsDir = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "gate") {
      const gate = requireTokenValue(token, parseError).trim();
      if (!VALID_GATES.has(gate)) {
        throw parseError("--gate must be draft_gate or pre_approval_gate");
      }
      options.gate = gate;
      continue;
    }
    if (token.name === "out") {
      options.out = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr-checklist-matrix") {
      options.prChecklistMatrix = requireTokenValue(token, parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.findingsDir) {
    throw parseError("Missing required argument: --findings-dir <dir>");
  }
  return options;
}

// Validate the CLI's own fail-closed schema floor: a well-formed object with a
// non-empty angle, a non-empty verdict, and (when findings is present as an
// array) only recognized severities. Everything else — verdict enum value,
// findings/clean-vs-findings_present consistency, missing summary — is left
// to consolidateFanin()'s own malformed-input handling (folded into a soft
// overall "blocked" verdict rather than a hard CLI failure), so this stays a
// thin floor rather than a second copy of consolidateFanin()'s validation.
function validateArtifactShape(raw, sourceLabel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: artifact must be a JSON object`);
  }
  if (typeof raw.angle !== "string" || raw.angle.trim().length === 0) {
    throw new Error(`${sourceLabel}: missing "angle"`);
  }
  if (typeof raw.verdict !== "string" || raw.verdict.trim().length === 0) {
    throw new Error(`${sourceLabel}: missing "verdict"`);
  }
  if (Array.isArray(raw.findings)) {
    raw.findings.forEach((f, i) => {
      if (f && typeof f === "object" && !Array.isArray(f) && typeof f.severity === "string" && !VALID_SEVERITIES.has(f.severity.trim())) {
        throw new Error(`${sourceLabel}: findings[${i}] has unknown severity "${f.severity}" (expected must-fix|worth-fixing-now|defer)`);
      }
    });
  }
}

// Resolve the --pr-checklist-matrix upsert value: the literal "clean" keyword
// (the mandatory-angle convenience) or a JSON artifact object for a custom one.
function resolvePrChecklistMatrixUpsert(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.toLowerCase() === "clean") {
    return { angle: "pr-checklist-matrix", verdict: "clean", findings: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('--pr-checklist-matrix must be "clean" or a JSON artifact object: { angle?, verdict, findings }');
  }
  const artifact = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { angle: "pr-checklist-matrix", findings: [], ...parsed }
    : parsed;
  validateArtifactShape(artifact, "--pr-checklist-matrix");
  return artifact;
}

export async function consolidateGateFanin(options) {
  const dir = options.findingsDir;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`--findings-dir "${dir}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`--findings-dir "${dir}" contains no *.json findings artifacts`);
  }

  const rawArtifacts = [];
  for (const name of files) {
    const filePath = path.join(dir, name);
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`Cannot read findings artifact "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Findings artifact "${filePath}" is not valid JSON`);
    }
    validateArtifactShape(parsed, `"${filePath}"`);
    rawArtifacts.push(parsed);
  }

  if (options.prChecklistMatrix !== undefined) {
    const hasPrChecklistMatrix = rawArtifacts.some(
      (a) => typeof a.angle === "string" && a.angle.trim() === "pr-checklist-matrix",
    );
    if (!hasPrChecklistMatrix) {
      rawArtifacts.push(resolvePrChecklistMatrixUpsert(options.prChecklistMatrix));
    }
  }

  const angles = rawArtifacts.map((a) => ({
    angle: a.angle.trim(),
    verdict: a.verdict.trim(),
    findingCount: Array.isArray(a.findings) ? a.findings.length : 0,
  }));

  const consolidated = consolidateFanin({ angleResults: rawArtifacts });
  // toFindingsLogShape's output ({ severity, angle, summary, disposition?, files? })
  // is exactly both write-gate-findings-log.mjs's --findings shape and the flat
  // per-finding shape upsert-checkpoint-verdict.mjs's --findings-json accepts —
  // the same array satisfies both consumer contracts.
  const findings = toFindingsLogShape(consolidated.findings);

  const result = {
    ok: true,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    angles,
    findings,
    ledger: findings,
    severityCounts: consolidated.counts.bySeverity,
    overallVerdict: consolidated.verdict,
  };

  if (options.out !== undefined) {
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
  }

  return result;
}

async function main() {
  let options;
  try {
    options = parseConsolidateFaninCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await consolidateGateFanin(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
