#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { resolveFindingsInput } from "./_findings-input.mjs";
import { GATE_CONFIG_KEY, SEVERITY_ORDER, VALID_SEVERITIES, applyJudgeDispositions, checkFanoutAngleCoverage, deriveDisposition, fanoutReviewerPairingError, freshAngleNames, hasLocatableShape, isDefaultDeferrableSeverity, normalizeSeverity, provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
// JUDGE_DISPOSITIONS is a frozen array in the core export; wrap as a Set for
// the validator's membership check so validateFindingsArray stays self-contained.
import { JUDGE_DISPOSITIONS as _JUDGE_DISPOSITIONS_ARRAY } from "@dev-loops/core/loop/gate-fanin";
const JUDGE_DISPOSITIONS = new Set(_JUDGE_DISPOSITIONS_ARRAY);
import { loadDevLoopConfig, resolveFanoutGroups, resolveGateAngleContract, resolveRejectForeignAngles } from "@dev-loops/core/config";
const USAGE = `Usage: write-gate-findings-log.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings <json> | --findings-file <path>) [--tmp-root <path>]
Write a durable <gate>-<headSha>.json log under deterministic tmp/ paths.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>              FULL head commit SHA (40 or 64 hex chars) — a short prefix is rejected (it would write an unfindable ledger)
  --verdict <clean|findings_present|blocked>
  --findings <json>              JSON array of finding objects with severity, disposition, angle, summary, and optional positive-integer line
  --findings-file <path>         Read the --findings JSON array from a file instead of an inline argument
                                 (mutually exclusive with --findings; identical validation)
Optional:
  --provenance <json>            Fan-out provenance object: { distinctReviewers: <int>, perAngle: [{ angle, reviewer?, dispatchId?, model?, carriedFromHead?, group? }] }
                                 carriedFromHead (7-64 hex) marks an angle whose clean verdict was carried forward from that prior head (reviewer stays the prior reviewer)
                                 distinctReviewers must be <= the distinct reviewers recorded in perAngle (perAngle non-empty when distinctReviewers > 0)
                                 no two fresh (non-carried) angles may share one reviewer identity, and every fresh angle must record one (reviewer or dispatchId) — one scoped reviewer per angle (use inline_single_agent + --inline-reason for a sanctioned single-reviewer run)
                                 EXCEPTION: fresh angles sharing a reviewer may all declare the same "group" name (grouped fan-out dispatch); differing or missing group names still fail closed
  --full-label                   The PR carries the gate:full label: dispatch groups resolve to one angle per unit, so any reviewer identity shared across fresh angles is rejected regardless of a declared "group" (mirrors write-gate-context.mjs's --full-label). Only meaningful when --provenance is supplied. Omitted (default false) keeps current behavior.
  --judge-verdict <path>         Path to the judge agent's verdict artifact (JSON). When supplied, the findings are
                                 enriched with the judge's relevance-based dispositions (judgeDisposition /
                                 judgeRationale / judgeCriterion / followUpDraft) via applyJudgeDispositions before
                                 the ledger is written, so the durable ledger and posted findings comment carry what
                                 was consciously not acted on and why (#1525). Optional; when absent the ledger
                                 writes byte-identically to before.
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
// Exported so other tools (e.g. upsert-checkpoint-verdict.mjs's
// RESOLVED_DISPOSITIONS) derive their own subset from this single copy of the
// disposition vocabulary instead of hand-copying it out of sync.
// "needs-answer" is the disposition a "question" severity finding gets
// (@dev-loops/core/loop/gate-fanin's consolidateFanin): a question is
// answered, never deferred or fixed, so it needs its own disposition rather
// than being forced into "deferred" like every other non-blocking finding.
export const VALID_DISPOSITIONS = new Set(["accepted-for-fix", "deferred", "needs-answer", "disputed", "operator_acknowledged"]);
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
    const severity = normalizeSeverity(f.severity);
    if (!severity || !VALID_SEVERITIES.has(severity)) {
      throw parseError(`${flagLabel}[${i}].severity must be one of: ${SEVERITY_ORDER.join(", ")}`);
    }
    f = { ...f, severity };
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
    if (Array.isArray(f.files)) {
      // Trimmed, not just filtered: an untrimmed files[0] (e.g. " src/a.mjs ")
      // would still count as locatable-SHAPED (hasLocatableShape only checks
      // non-empty, not exact form) while every downstream consumer that keys
      // on the raw value (the diff's commentable-line set lookup, the posted
      // review `path`, renderNonLocatableBlock's Location line) compares
      // against the TRIMMED form — an untrimmed entry would derive
      // "needs-answer"/locatable here yet never actually match a real
      // in-diff position later, silently downgrading it back to
      // non-locatable at a different layer instead of agreeing everywhere.
      entry.files = f.files.filter(x => typeof x === "string" && x.trim().length > 0).map(x => x.trim());
    }
    if ("line" in f) {
      if (!Number.isInteger(f.line) || f.line < 1) {
        throw parseError(`${flagLabel}[${i}].line must be a positive integer`);
      }
      entry.line = f.line;
    }
    if ("disposition" in f) {
      if (typeof f.disposition !== "string" || f.disposition.trim().length === 0) {
        throw parseError(`${flagLabel}[${i}].disposition must be a non-empty string`);
      }
      const disp = f.disposition.trim();
      if (!VALID_DISPOSITIONS.has(disp)) {
        throw parseError(`${flagLabel}[${i}].disposition must be one of: ${[...VALID_DISPOSITIONS].join(", ")}`);
      }
      entry.disposition = disp;
    } else if (isDefaultDeferrableSeverity(f.severity)) {
      // A non-blocking low/nit finding with no explicit disposition defaults
      // to "deferred" so a hand-authored (or consolidate-fanin.mjs-produced)
      // array need not repeat the obvious disposition for every lowest-tier
      // entry. A question routes through the SAME shared rule
      // (deriveDisposition, @dev-loops/core/loop/gate-fanin) every other
      // producer uses: LOCATABLE (hasLocatableShape) defaults to
      // "needs-answer", non-locatable to "deferred" — see that function's
      // own doc for the full rule. Explicit dispositions (including an
      // explicit "deferred") always keep the validation above unchanged.
      // isDefaultDeferrableSeverity (gate-fanin) is the shared guard this
      // producer and post-gate-findings.mjs's own validator both route
      // through, so the two can never restate it out of sync.
      entry.disposition = deriveDisposition(f.severity, { locatable: hasLocatableShape(entry) });
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
    // Judge relevance-based dispositions (#1525) — carried through so the
    // durable ledger and posted findings comment show what was consciously
    // not acted on and why. Optional and additive: when absent (a round with
    // no judge verdict) the finding writes exactly as before.
    if (typeof f.judgeDisposition === "string" && f.judgeDisposition.trim().length > 0) {
      const jd = f.judgeDisposition.trim();
      if (!JUDGE_DISPOSITIONS.has(jd)) {
        throw parseError(`${flagLabel}[${i}].judgeDisposition must be one of: ${[...JUDGE_DISPOSITIONS].join(", ")}`);
      }
      entry.judgeDisposition = jd;
    }
    if (typeof f.judgeRationale === "string" && f.judgeRationale.trim().length > 0) {
      entry.judgeRationale = f.judgeRationale.trim();
    }
    if (typeof f.judgeCriterion === "string" && f.judgeCriterion.trim().length > 0) {
      entry.judgeCriterion = f.judgeCriterion.trim();
    }
    if (f.followUpDraft && typeof f.followUpDraft === "object" && !Array.isArray(f.followUpDraft)) {
      entry.followUpDraft = f.followUpDraft;
    }
    return entry;
  });
}
// Resolve the findings array from either --findings (inline JSON) or
// --findings-file (a path to a file containing the same JSON array) —
// mutually exclusive, identical validation either way. Shared plumbing lives
// in _findings-input.mjs; this file's own validateFindingsArray is the
// injected element validator.
function resolveFindings(options) {
  return resolveFindingsInput(options, { parseError, validate: validateFindingsArray });
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
export function parseProvenanceJson(raw, resolvedGroups = null) {
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
    for (const key of ["reviewer", "dispatchId", "model", "group"]) {
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
  // reviewer cover multiple angles. Carried angles are exempt, and fresh
  // angles sharing a reviewer under the SAME declared `group` are exempt too
  // (grouped fan-out dispatch — see fanoutReviewerPairingError). `resolvedGroups`
  // (this round's resolveFanoutGroups output, computed by the caller — it
  // already loads config) additionally rejects a claimed group that the
  // configured table does not actually place these angles into together.
  const pairingError = fanoutReviewerPairingError(normalized.perAngle, resolvedGroups);
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
      "full-label": { type: "boolean" },
      "judge-verdict": { type: "string" },
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
    fullLabel: false,
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
    if (token.name === "full-label") {
      options.fullLabel = true;
      continue;
    }
    if (token.name === "judge-verdict") {
      const judgeVerdict = requireTokenValue(token, parseError).trim();
      if (judgeVerdict.length === 0) {
        throw parseError("--judge-verdict requires a non-empty path");
      }
      options.judgeVerdict = judgeVerdict;
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
  const { findings: rawFindings, overallVerdict } = await resolveFindings(options);
  // When a judge verdict artifact is supplied, enrich the findings with the
  // judge's relevance-based dispositions (act/defer/reject + rationale +
  // follow-up drafts) before writing the ledger (#1525). The judge runs after
  // fan-in and before the fix pass; applyJudgeDispositions is the pure merge
  // seam that fails closed on a malformed verdict or an out-of-range index.
  let findings = rawFindings;
  let scopeDrift;
  if (options.judgeVerdict) {
    const judgePath = path.resolve(repoRoot, options.judgeVerdict);
    const { readFile } = await import("node:fs/promises");
    let judgeVerdict;
    try {
      judgeVerdict = JSON.parse(await readFile(judgePath, "utf8"));
    } catch (error) {
      throw parseError(`--judge-verdict could not be read/parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const enriched = applyJudgeDispositions(rawFindings, judgeVerdict);
    findings = enriched.findings;
    scopeDrift = enriched.scopeDrift;
  }
  // The consolidator's computed verdict (consolidate-fanin.mjs's
  // `overallVerdict`) threads through `--ledger-out`'s `{overallVerdict,
  // findings}` wrapper into here, so the durable ledger records the verdict
  // the fan-in actually computed for this head/gate — not whatever a caller
  // hand-passed to `--verdict`. Optional and additive: a bare-array input
  // (legacy `--findings-file`, hand-authored `--findings`) leaves it
  // undefined and the ledger writes exactly as before. Validated here so a
  // malformed wrapper cannot silently record an invalid verdict as the
  // consolidator's truth (#1616).
  let normalizedOverallVerdict;
  if (overallVerdict !== undefined) {
    const verdict = normalizeVerdict(overallVerdict);
    if (!verdict) {
      throw parseError(
        `--${options.findingsFile ? "findings-file" : "findings"} "${options.findingsFile ?? "<inline>"}" wrapper "overallVerdict" must be one of: clean, findings_present, or blocked (got: ${JSON.stringify(overallVerdict)})`,
      );
    }
    normalizedOverallVerdict = verdict;
    // Fail closed on a caller-passed --verdict that contradicts the
    // consolidator's computed verdict, mirroring the consumer-side refusal in
    // upsert-checkpoint-verdict.mjs (#1616, GATE-COMMENT-VERDICT-VALUES).
    // Normalize options.verdict here so the comparison is symmetric for every
    // caller — a direct programmatic caller passes a non-canonical verdict by
    // the same normalizeVerdict path the CLI parse normally canonicalizes it
    // through, so a canonical-value wrapper never false-rejects a
    // differently-cased/whitespaced but semantically equal caller verdict.
    // Validate options.verdict's own domain first (same message the CLI parse
    // path throws for --verdict) so a null/undefined/non-string/out-of-domain
    // value is reported as an invalid verdict, not misattributed as a
    // contradiction with the wrapper. typeof is checked before normalizeVerdict
    // runs because normalizeVerdict coerces via String(), which would otherwise
    // let a non-string (e.g. an array) silently pass as its stringified form.
    const callerVerdict = typeof options.verdict === "string" ? normalizeVerdict(options.verdict) : null;
    if (!callerVerdict) {
      throw parseError("--verdict must be clean, findings_present, or blocked");
    }
    if (callerVerdict !== normalizedOverallVerdict) {
      throw parseError(
        `--verdict ${JSON.stringify(callerVerdict)} contradicts the wrapper's "overallVerdict" ${JSON.stringify(normalizedOverallVerdict)} (GATE-COMMENT-VERDICT-VALUES; skills/docs/gate-review-comment-contract.md)`,
      );
    }
    // Persist the canonical (normalized) verdict, not the raw caller value, so
    // the durable ledger never records a differently-cased/whitespaced verdict
    // beside the canonical overallVerdict it was just checked against.
    options.verdict = callerVerdict;
  }
  let provenance;
  if (options.provenance === undefined) {
    provenance = undefined;
  } else {
    // Resolve this round's dispatch groups BEFORE validating pairing, so a
    // claimed `group` is cross-checked against the gate's actual configured
    // grouping table (see fanoutReviewerPairingError) — not just accepted as
    // an internally-consistent self-attested label. Best-effort: a raw-JSON
    // parse failure here is swallowed and re-surfaces as the real, specific
    // error inside parseProvenanceJson below.
    let resolvedGroups = null;
    try {
      const rawPerAngle = JSON.parse(options.provenance)?.perAngle;
      const { config } = await loadDevLoopConfig({ repoRoot });
      resolvedGroups = resolveFanoutGroups(config, GATE_CONFIG_KEY[options.gate] ?? options.gate, freshAngleNames(rawPerAngle), { fullLabel: options.fullLabel === true });
    } catch {
      resolvedGroups = null;
    }
    provenance = parseProvenanceJson(options.provenance, resolvedGroups);
  }
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
  // The consolidator's computed verdict, threaded from `--ledger-out`'s
  // wrapper. Optional and additive: when absent (a bare-array input or an
  // older producer) the ledger writes byte-identically to before, so inline
  // and fallback paths are unaffected (#1616 AC: absent ledger unchanged).
  if (normalizedOverallVerdict !== undefined) {
    log.overallVerdict = normalizedOverallVerdict;
  }
  // Provenance is optional and additive: when absent the ledger writes exactly
  // as before (no provenance key), preserving byte-identical output for the
  // default / Claude-Code path. When present it records fan-out provenance for
  // gates.requireFanoutProvenance enforcement.
  if (provenance !== undefined) {
    log.provenance = provenance;
  }
  // The judge's scope-drift verdict on the PR as a whole (#1525). Optional
  // and additive: when no judge verdict was supplied, the ledger writes
  // byte-identically to before.
  if (scopeDrift !== undefined) {
    log.scopeDrift = scopeDrift;
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
