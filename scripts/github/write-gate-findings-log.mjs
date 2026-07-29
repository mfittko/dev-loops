#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { checkFanoutAngleCoverage, fanoutReviewerPairingError, provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
import { loadDevLoopConfig, resolveGateAngleContract, resolveRejectForeignAngles } from "@dev-loops/core/config";
const USAGE = `Usage: write-gate-findings-log.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings <json> | --findings-file <path>) [--tmp-root <path>]
Write a durable <gate>-<headSha>.json log under deterministic tmp/ paths.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>              FULL head commit SHA (40 or 64 hex chars) — a short prefix is rejected (it would write an unfindable ledger)
  --verdict <clean|findings_present|blocked>
  --findings <json>              JSON array of finding objects with severity, disposition, angle, and summary
  --findings-file <path>         Read the --findings JSON array from a file instead of an inline argument
                                 (mutually exclusive with --findings; identical validation)
Optional:
  --provenance <json>            Fan-out provenance object: { distinctReviewers: <int>, perAngle: [{ angle, reviewer?, dispatchId?, model?, carriedFromHead? }] }
                                 carriedFromHead (7-64 hex) marks an angle whose clean verdict was carried forward from that prior head (reviewer stays the prior reviewer)
                                 distinctReviewers must be <= the distinct reviewers recorded in perAngle (perAngle non-empty when distinctReviewers > 0)
                                 no two fresh (non-carried) angles may share one reviewer identity, and every fresh angle must record one (reviewer or dispatchId) — one scoped reviewer per angle (use inline_single_agent + --inline-reason for a sanctioned single-reviewer run)
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
const GATE_CONFIG_KEY = { draft_gate: "draft", pre_approval_gate: "preApproval" };
function normalizeVerdict(value) {
  const verdicts = new Set(["clean", "findings_present", "blocked"]);
  const normalized = String(value).trim().toLowerCase();
  return verdicts.has(normalized) ? normalized : null;
}
const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
const VALID_DISPOSITIONS = new Set(["accepted-for-fix", "deferred", "disputed", "operator_acknowledged"]);
// Validate + normalize a parsed --findings / --findings-file JSON array. Shared
// by both flags so they carry identical validation — flagLabel only changes the
// error-message prefix (--findings vs --findings-file).
function validateFindingsArray(parsed, flagLabel) {
  if (!Array.isArray(parsed)) {
    throw parseError(`${flagLabel} must be a JSON array`);
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object") {
      throw parseError(`${flagLabel}[${i}] must be an object`);
    }
    if (!f.severity || !VALID_SEVERITIES.has(f.severity)) {
      throw parseError(`${flagLabel}[${i}].severity must be one of: must-fix, worth-fixing-now, defer`);
    }
    if (!f.angle || typeof f.angle !== "string" || f.angle.trim().length === 0) {
      throw parseError(`${flagLabel}[${i}].angle is required`);
    }
    if (!f.summary || typeof f.summary !== "string" || f.summary.trim().length === 0) {
      throw parseError(`${flagLabel}[${i}].summary is required`);
    }
    const entry = {
      severity: f.severity,
      angle: f.angle.trim(),
      summary: f.summary.trim(),
    };
    if ("disposition" in f) {
      if (typeof f.disposition !== "string" || f.disposition.trim().length === 0) {
        throw parseError(`${flagLabel}[${i}].disposition must be a non-empty string`);
      }
      const disp = f.disposition.trim();
      if (!VALID_DISPOSITIONS.has(disp)) {
        throw parseError(`${flagLabel}[${i}].disposition must be one of: accepted-for-fix, deferred, disputed, operator_acknowledged`);
      }
      entry.disposition = disp;
    } else if (f.severity === "defer") {
      // A non-blocking defer finding with no explicit disposition defaults to
      // "deferred" so a hand-authored (or consolidate-fanin.mjs-produced) array
      // need not repeat the obvious disposition for every defer-severity entry.
      // Explicit dispositions (including an explicit "deferred") always keep the
      // validation above unchanged.
      entry.disposition = "deferred";
    }
    if (Array.isArray(f.files)) {
      entry.files = f.files.filter(x => typeof x === "string" && x.trim().length > 0);
    }
    if ("resolvedIn" in f) {
      if (typeof f.resolvedIn !== "string" || f.resolvedIn.trim().length === 0) {
        throw parseError(`${flagLabel}[${i}].resolvedIn must be a non-empty string`);
      }
      const sha = f.resolvedIn.trim();
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
        throw parseError(`${flagLabel}[${i}].resolvedIn must be a 7-64 char hex SHA`);
      }
      entry.resolvedIn = sha;
    }
    return entry;
  });
}
function parseFindingsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--findings must be valid JSON");
  }
  return validateFindingsArray(parsed, "--findings");
}
// Resolve the findings array from either --findings (inline JSON) or
// --findings-file (a path to a file containing the same JSON array) —
// mutually exclusive, identical validation either way.
async function resolveFindings(options) {
  if (options.findings !== undefined && options.findingsFile !== undefined) {
    throw parseError("--findings and --findings-file are mutually exclusive; pass only one");
  }
  if (options.findingsFile !== undefined) {
    let raw;
    try {
      raw = await readFile(options.findingsFile, "utf8");
    } catch (err) {
      throw parseError(`Cannot read --findings-file "${options.findingsFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw parseError(`--findings-file "${options.findingsFile}" must contain valid JSON`);
    }
    return validateFindingsArray(parsed, "--findings-file");
  }
  if (options.findings === undefined) {
    throw parseError("Either --findings <json> or --findings-file <path> is required");
  }
  return parseFindingsJson(options.findings);
}
/**
 * Validate + normalize the fan-out provenance object. Records how many distinct
 * reviewer agents were dispatched (distinctReviewers) and per-angle dispatch
 * provenance (perAngle). Rejects MALFORMED or self-INCONSISTENT provenance (bad
 * shape, or a distinctReviewers claim not backed by recorded dispatch entries).
 * This raises the bar; it does NOT make provenance un-forgeable — a determined
 * single agent can still write an internally-consistent blob. Un-forgeable
 * recording is the Pi-harness bridge (subagent tool at child depth). Returns the
 * normalized object.
 */
export function parseProvenanceJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--provenance must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw parseError("--provenance must be a JSON object");
  }
  if (!Number.isInteger(parsed.distinctReviewers) || parsed.distinctReviewers < 0) {
    throw parseError("--provenance.distinctReviewers must be a non-negative integer");
  }
  if (!Array.isArray(parsed.perAngle)) {
    throw parseError("--provenance.perAngle must be an array");
  }
  const perAngle = parsed.perAngle.map((a, i) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      throw parseError(`--provenance.perAngle[${i}] must be an object`);
    }
    if (typeof a.angle !== "string" || a.angle.trim().length === 0) {
      throw parseError(`--provenance.perAngle[${i}].angle is required`);
    }
    const entry = { angle: a.angle.trim() };
    for (const key of ["reviewer", "dispatchId", "model"]) {
      if (key in a) {
        if (typeof a[key] !== "string" || a[key].trim().length === 0) {
          throw parseError(`--provenance.perAngle[${i}].${key} must be a non-empty string`);
        }
        entry[key] = a[key].trim();
      }
    }
    // carriedFromHead marks an angle whose CLEAN verdict was CARRIED FORWARD from
    // a prior head (the delta since that head provably did not touch this angle's
    // review surface — see @dev-loops/core/loop/gate-carry-forward). It records
    // the prior head SHA the verdict came from; the `reviewer` on this entry is
    // that prior head's reviewer (honest attribution, NOT a fabricated fresh
    // review). It does not relax the distinctReviewers consistency check below —
    // a carried angle still names the real reviewer identity that reviewed it.
    if ("carriedFromHead" in a) {
      if (typeof a.carriedFromHead !== "string" || !/^[0-9a-f]{7,64}$/i.test(a.carriedFromHead.trim())) {
        throw parseError(`--provenance.perAngle[${i}].carriedFromHead must be a 7-64 char hex SHA`);
      }
      entry.carriedFromHead = a.carriedFromHead.trim().toLowerCase();
    }
    return entry;
  });
  const normalized = { distinctReviewers: parsed.distinctReviewers, perAngle };
  // Internal-consistency gate: a distinctReviewers claim must be backed by that
  // many distinct recorded reviewer identities (closes the {n, perAngle:[]} loophole).
  const consistencyError = provenanceConsistencyError(normalized);
  if (consistencyError) {
    throw parseError(`--${consistencyError}`);
  }
  // One-scoped-reviewer-per-fresh-angle floor (always-on, #1431): no two fresh
  // (non-carried) angles may share one reviewer identity — closes the gap
  // where an internally-consistent distinctReviewers count still let one
  // reviewer cover multiple angles. Carried angles are exempt (see
  // fanoutReviewerPairingError).
  const pairingError = fanoutReviewerPairingError(normalized.perAngle);
  if (pairingError) {
    throw parseError(`--provenance.perAngle ${pairingError}`);
  }
  return normalized;
}
/**
 * Validate recorded provenance.perAngle against the gate's configured angle
 * contract (mandatoryAngles + pool, resolved from .devloops/defaults). A
 * missing mandatory angle always fails the write. A foreign (out-of-pool)
 * angle fails the write unless `gates.rejectForeignAngles: false`, in which
 * case it is returned as a warning instead. Throws a `parseError`-shaped Error
 * (matching this module's other validation failures) on a fail-closed
 * rejection.
 *
 * @param {{ perAngle: Array<{ angle: string }> }} provenance
 * @param {"draft_gate"|"pre_approval_gate"} gate
 * @param {{ repoRoot?: string }} [options]
 * @returns {Promise<{ warning: string|null }>}
 */
export async function checkProvenanceAngleCoverage(provenance, gate, { repoRoot = process.cwd() } = {}) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  const gateKey = GATE_CONFIG_KEY[gate];
  const { mandatoryAngles, pool } = resolveGateAngleContract(config, gateKey);
  const { missingMandatory, foreignAngles } = checkFanoutAngleCoverage(provenance.perAngle, {
    mandatoryAngles,
    pool,
  });
  if (missingMandatory.length > 0) {
    throw parseError(
      `--provenance.perAngle is missing mandatory angle(s) for ${gate}: ${missingMandatory.join(", ")} (configured in gates.${gateKey}.mandatoryAngles)`,
    );
  }
  if (foreignAngles.length > 0) {
    const message = `--provenance.perAngle names angle(s) outside the configured pool for ${gate}: ${foreignAngles.join(", ")}`;
    if (resolveRejectForeignAngles(config)) {
      throw parseError(`${message} (add them to gates.${gateKey}.angles, or set gates.rejectForeignAngles: false to warn instead of fail)`);
    }
    return { warning: `${message} (gates.rejectForeignAngles is false; recorded as a warning)` };
  }
  return { warning: null };
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
      "findings-file": { type: "string" },
      provenance: { type: "string" },
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
    findingsFile: undefined,
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
      const sha = normalizeFullHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError(FULL_HEAD_SHA_ERROR);
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
    if (token.name === "findings-file") {
      const findingsFile = requireTokenValue(token, parseError).trim();
      if (findingsFile.length === 0) {
        throw parseError("--findings-file requires a non-empty path");
      }
      options.findingsFile = findingsFile;
      continue;
    }
    if (token.name === "provenance") {
      options.provenance = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "headSha", "verdict"]
    .filter(k => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  if (options.findings === undefined && options.findingsFile === undefined) {
    throw parseError("Missing required arguments: findings (pass --findings <json> or --findings-file <path>)");
  }
  if (options.findings !== undefined && options.findingsFile !== undefined) {
    throw parseError("--findings and --findings-file are mutually exclusive; pass only one");
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
  const findings = await resolveFindings(options);
  const provenance = options.provenance === undefined ? undefined : parseProvenanceJson(options.provenance);
  // Angle-coverage enforcement (fail-closed on missing mandatory angles / foreign
  // angles) only applies when provenance is actually recorded — provenance
  // remains optional and additive (inline_single_agent writes never carry it).
  const angleCoverage = provenance !== undefined
    ? await checkProvenanceAngleCoverage(provenance, options.gate, { repoRoot })
    : { warning: null };
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
  // Provenance is optional and additive: when absent the ledger writes exactly
  // as before (no provenance key), preserving byte-identical output for the
  // default / Claude-Code path. When present it records fan-out provenance for
  // gates.requireFanoutProvenance enforcement.
  if (provenance !== undefined) {
    log.provenance = provenance;
  }
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(log, null, 2) + "\n", "utf8");
  return angleCoverage.warning
    ? { ok: true, path: logPath, log, warning: angleCoverage.warning }
    : { ok: true, path: logPath, log };
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
    // rejectForeignAngles: false is WARNING mode, not silence — surface the
    // angle-coverage warning on stderr too (the JSON result carries it as
    // `warning`). Suppressed under --silent.
    if (result.warning && !options.silent) {
      process.stderr.write(`WARNING: ${result.warning}\n`);
    }
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
