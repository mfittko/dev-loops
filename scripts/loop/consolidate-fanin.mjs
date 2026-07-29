#!/usr/bin/env node
/**
 * consolidate-fanin.mjs — sanctioned fan-in CLI over the pure helpers in
 * @dev-loops/core/loop/gate-fanin (issue #1481). Reads every per-angle
 * findings artifact a gate-review fan-out produced, consolidates them with
 * consolidateFanin()/toFindingsLogShape(), and emits the JSON shapes
 * write-gate-findings-log.mjs (--findings / --findings-file), post-gate-findings.mjs
 * (--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json,
 * via the result's "findingsJson" field / --out) accept directly — the orchestrator
 * no longer hand-authors this JSON with inline interpreters. "findingsJson"/--out is
 * the NESTED per-angle shape (one section per source artifact, clean angles included
 * with an empty findings array); "findings"/"ledger" is the FLAT per-finding shape.
 *
 * Per-angle findings artifact shape (one *.json file per angle in --findings-dir):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present" | "blocked",
 *     findings: [{ severity, summary, file?, line?, disposition? }]
 *   }
 * `disposition` on an input finding is IGNORED — consolidateFanin() always
 * DERIVES it from severity (accepted-for-fix for a blocking severity,
 * deferred otherwise). It is accepted on the input shape only so a reviewer's
 * own artifact schema round-trips without a separate strip step.
 *
 * An angle reporting verdict "blocked" (or any malformed artifact) makes the
 * whole fan-in FAIL CLOSED (exit 1, naming the offending angles): a blocked
 * consolidation has no publishable findings shape, and emitting one would
 * present an all-clean structure that silently discards real findings. Fix or
 * re-run the offending reviewer, then re-consolidate. Two artifacts naming the
 * SAME angle also fails closed (ambiguous fan-out) — see "duplicate angle
 * name" below.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { loadDevLoopConfig, resolveGateConfig } from "@dev-loops/core/config";
import { consolidateFanin, toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";

const USAGE = `Usage: consolidate-fanin.mjs --findings-dir <dir> [--gate <draft_gate|pre_approval_gate>] [--out <path>] [--pr-checklist-matrix <clean|json>] [--repo-root <path>]
Consolidate the per-angle *.json findings artifacts a gate-review fan-out wrote into
--findings-dir into the JSON shapes write-gate-findings-log.mjs, post-gate-findings.mjs
(--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json) accept.
Required:
  --findings-dir <dir>          Directory containing one *.json per-angle findings
                                 artifact: { angle, verdict, findings: [{ severity, summary, file?, line?, disposition? }] }.
                                 An input finding's "disposition" (if present) is IGNORED — the
                                 output disposition is always DERIVED from severity (see below).
                                 Two artifacts naming the SAME angle fail closed (ambiguous fan-out).
Optional:
  --gate <draft_gate|pre_approval_gate>   Echoed onto the result as "gate"; also loads this
                                 worktree's config and applies gates.<gate>.blockCleanOnFindingSeverities
                                 to the overall verdict (default when omitted: ["must-fix"]). When given,
                                 a config that could not be fully loaded/validated FAILS CLOSED (exit 1)
                                 rather than silently falling back to the shipped default severities.
  --out <path>                  Write the nested per-angle "findingsJson" shape (below) to this
                                 path as JSON — the exact input upsert-checkpoint-verdict.mjs's
                                 --findings-json accepts
  --pr-checklist-matrix <clean|json>      When no pr-checklist-matrix angle artifact was found,
                                 upsert one: "clean" for { angle: "pr-checklist-matrix", verdict: "clean", findings: [] },
                                 or a JSON artifact object ({ angle?, verdict, findings }) for a custom one
  --repo-root <path>             Root used to resolve this worktree's config (loadDevLoopConfig) when
                                 --gate is given (default: process.cwd()) — makes the overall verdict
                                 deterministic regardless of the CLI's invocation directory
Output (stdout, JSON):
  { "ok": true, "gate"?: "...", "angles": [{ "angle", "verdict", "findingCount" }],
    "findingsJson": [{ "angle", "verdict", "findings": [...] }], "findings": [...], "ledger": [...],
    "severityCounts": { "must-fix", "worth-fixing-now", "defer" },
    "overallVerdict": "clean"|"findings_present" }
  "findingsJson" is the nested per-angle shape (one section per source artifact, including clean
  angles with an empty findings array) — pass --out's file straight to
  upsert-checkpoint-verdict.mjs's --findings-json. Every output finding's "disposition" is DERIVED
  from severity (accepted-for-fix for a blocking severity, deferred otherwise) — an input
  finding's own "disposition" is never honored.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, missing/empty --findings-dir, unparseable artifact, schema
     violation, duplicate angle name across artifacts, blocked fan-in (a malformed or
     blocked per-angle artifact), or (with --gate) an unloadable/invalid worktree config
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
    repoRoot: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "findings-dir": { type: "string" },
      gate: { type: "string" },
      out: { type: "string" },
      "pr-checklist-matrix": { type: "string" },
      "repo-root": { type: "string" },
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
    if (token.name === "repo-root") {
      const repoRoot = requireTokenValue(token, parseError).trim();
      if (repoRoot.length === 0) {
        throw parseError("--repo-root requires a non-empty path");
      }
      options.repoRoot = repoRoot;
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
// to consolidateFanin()'s own malformed-input handling; a consolidation it
// marks blocked then FAILS CLOSED below (exit 1) rather than emitting any
// findings shape, so this stays a thin floor rather than a second copy of
// consolidateFanin()'s validation.
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
  // A per-angle artifact SYMLINKED into --findings-dir (a reviewer writing via
  // a symlink) must resolve like a regular file, not vanish silently: readdir
  // reports a symlink as isSymbolicLink(), never isFile(), so a bare isFile()
  // filter drops it with no warning — the exact fail-open this tool exists to
  // prevent, reached through a different input path than the blocked-verdict
  // guard below. stat() (which follows symlinks) each *.json dirent instead;
  // fail closed, naming the entry, on anything that isn't a regular file or a
  // symlink resolving to one (a dangling symlink, a directory, a fifo, ...).
  const jsonEntries = entries.filter((e) => e.name.endsWith(".json"));
  const files = [];
  for (const e of jsonEntries) {
    const entryPath = path.join(dir, e.name);
    if (e.isFile()) {
      files.push(e.name);
      continue;
    }
    if (e.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await stat(entryPath);
      } catch (err) {
        throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" that could not be resolved (dangling symlink?): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (resolved.isFile()) {
        files.push(e.name);
        continue;
      }
      throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" whose symlink target is not a regular file`);
    }
    const kind = e.isDirectory() ? "a directory" : e.isFIFO?.() ? "a fifo" : "not a regular file";
    throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" that is ${kind}, not a regular file or a symlink to one`);
  }
  files.sort();
  if (files.length === 0) {
    throw new Error(`--findings-dir "${dir}" contains no *.json findings artifacts`);
  }

  const rawArtifacts = [];
  const angleSourceFiles = new Map(); // angle -> file paths that declared it
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
    const angle = parsed.angle.trim();
    if (!angleSourceFiles.has(angle)) angleSourceFiles.set(angle, []);
    angleSourceFiles.get(angle).push(filePath);
    rawArtifacts.push(parsed);
  }

  // Duplicate angle name across two artifact files is an ambiguous fan-out
  // (which one is authoritative?) — without this guard, findingsJson would
  // duplicate that angle's findings into EVERY matching section while the
  // flat findings/ledger shape counts them once, silently inflating counts.
  // Fail closed instead, naming every offending angle + its source files.
  const duplicateAngles = [...angleSourceFiles.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicateAngles.length > 0) {
    const detail = duplicateAngles
      .map(([angle, paths]) => `"${angle}" declared in ${paths.join(", ")}`)
      .join("; ");
    throw new Error(`--findings-dir "${dir}" has duplicate angle name(s) across multiple artifact files (ambiguous fan-out): ${detail}`);
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

  // Load this worktree's config to resolve the gate's configured blocking
  // severities when --gate is supplied, so the overall verdict honors e.g. a
  // repo that also blocks clean on worth-fixing-now. Without --gate, keep
  // consolidateFanin's own ["must-fix"] default (no config side effects).
  // --repo-root anchors this explicitly (default process.cwd()) so the overall
  // verdict is deterministic regardless of the CLI's invocation directory.
  let blockCleanOnFindingSeverities;
  if (options.gate !== undefined) {
    const repoRoot = options.repoRoot ?? process.cwd();
    // A nonexistent/non-directory root would make loadDevLoopConfig silently
    // fall back to shipped defaults — the exact clean-ward fail-open
    // --repo-root exists to remove. Fail closed instead.
    const rootStat = await stat(repoRoot).catch(() => null);
    if (!rootStat?.isDirectory()) {
      throw new Error(`--repo-root ${JSON.stringify(repoRoot)} is not an existing directory`);
    }
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    // loadDevLoopConfig never throws: on a parse/validation failure it still
    // returns `config` merged from the shipped defaults, silently REPLACING
    // this worktree's real gates.<gate>.blockCleanOnFindingSeverities with
    // ["must-fix"]. Since --gate was given specifically to honor that
    // config, a failed load must fail closed here rather than silently
    // emitting a verdict computed from the wrong severities.
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`--gate ${options.gate} was given but this worktree's config (--repo-root ${JSON.stringify(repoRoot)}) could not be fully loaded/validated: ${JSON.stringify(errors)}`);
    }
    const gateKey = options.gate === "draft_gate" ? "draft" : "preApproval";
    blockCleanOnFindingSeverities = resolveGateConfig(config, gateKey).blockCleanOnFindingSeverities;
  }

  const consolidated = consolidateFanin({ angleResults: rawArtifacts, blockCleanOnFindingSeverities });
  // toFindingsLogShape's output ({ severity, angle, summary, disposition?, files? })
  // is exactly both write-gate-findings-log.mjs's --findings shape and the flat
  // per-finding shape upsert-checkpoint-verdict.mjs's --findings-json accepts —
  // the same array satisfies both consumer contracts.
  const findings = toFindingsLogShape(consolidated.findings);
  // The NESTED per-angle shape upsert-checkpoint-verdict.mjs's --findings-json
  // natively accepts (normalizeStructuredFindings/checkFanoutAngleCoverage): one
  // section per source artifact — including clean angles with an empty findings
  // array — so an all-clean fan-out and mandatory-angle coverage both validate.
  const findingsByAngle = new Map();
  for (const f of consolidated.findings) {
    if (!findingsByAngle.has(f.angle)) findingsByAngle.set(f.angle, []);
    findingsByAngle.get(f.angle).push(f);
  }
  // Fail closed on a blocked consolidation BEFORE deriving the nested shape:
  // consolidateFanin() returns blocked with an EMPTY findings array whenever
  // any artifact is malformed or itself blocked, so deriving per-angle
  // verdicts from that array would emit an all-clean findingsJson that
  // upsert-checkpoint-verdict accepts verbatim — silently discarding real
  // findings. A blocked fan-in has no publishable consolidated shape; the
  // caller must fix/re-run the offending reviewer first.
  if (consolidated.verdict === "blocked") {
    const detail = Array.isArray(consolidated.malformed) && consolidated.malformed.length > 0
      ? consolidated.malformed
          .map(({ index, reason }) => {
            const artifact = rawArtifacts[index];
            const angle = artifact?.angle ?? `artifact[${index}]`;
            // A "blocked" verdict is a LEGAL artifact shape (a reviewer's
            // documented signal that its review is contaminated/incomplete),
            // not a schema violation. gate-fanin's validateAngleResult only
            // knows the enum clean|findings_present, so it reports this case
            // as "invalid verdict" — steering an operator toward "fixing" it
            // by rewriting blocked -> clean instead of re-running the
            // reviewer. Detect it here and say what actually happened.
            if (artifact && typeof artifact === "object" && artifact.verdict === "blocked") {
              return `${angle}: reported verdict "blocked" — re-run that reviewer, then re-consolidate`;
            }
            return `${angle}: ${reason}`;
          })
          .join("; ")
      : "one or more per-angle artifacts report a blocked verdict";
    throw new Error(`fan-in is blocked — refusing to emit a consolidated findings shape (${detail})`);
  }

  const findingsJson = rawArtifacts.map((a) => {
    const angle = a.angle.trim();
    const angleFindings = findingsByAngle.get(angle) ?? [];
    return {
      angle,
      verdict: angleFindings.length > 0 ? "findings_present" : "clean",
      findings: angleFindings.map((f) => {
        const entry = { severity: f.severity, summary: f.summary, disposition: f.disposition };
        if (f.file) entry.file = f.file;
        if (typeof f.line === "number") entry.line = f.line;
        return entry;
      }),
    };
  });

  const result = {
    ok: true,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    angles,
    findingsJson,
    findings,
    ledger: findings,
    severityCounts: consolidated.counts.bySeverity,
    overallVerdict: consolidated.verdict,
  };

  if (options.out !== undefined) {
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(findingsJson, null, 2)}\n`, "utf8");
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
