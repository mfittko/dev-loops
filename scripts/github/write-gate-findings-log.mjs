#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { readSpecAuthorityIdentity, stampOptionalSpecAuthority } from "../lib/spec-authority-stamp.mjs";
import { GATE_NAMES, normalizeGate as normalizeGateShared, normalizeVerdict as normalizeVerdictShared } from "./_gate-names.mjs";
const USAGE = `Usage: write-gate-findings-log.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings <json> | --findings-file <path>) [--tmp-root <path>]
Write a durable <gate>-<headSha>.json log under deterministic tmp/ paths.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate|review>
  --head-sha <sha>              FULL head commit SHA (40 or 64 hex chars) — a short prefix is rejected (it would write an unfindable ledger)
  --verdict <clean|findings_present|blocked>
  --findings <json>              JSON array of finding objects with severity, disposition, angle, summary, and optional positive-integer line
                                 A "low" finding may also carry operatorVisible: true (net-reduction policy, #1846) — the
                                 explicit signal close-gate-findings.mjs's disposition pass requires before filing a "low"
                                 to the PR's tracked follow-up issue; absent/false is the conservative default (resolved
                                 in-thread, never filed). A "nit" is never filed regardless of operatorVisible.
                                 operatorVisible on any OTHER severity fails closed (exit 2) — it has no meaning there.
  --findings-file <path>         Read the --findings JSON array from a file instead of an inline argument
                                 (mutually exclusive with --findings; identical validation)
Optional:
  --provenance <json>            Fan-out provenance object: { distinctReviewers: <int>, perAngle: [{ angle, reviewer?, dispatchId?, model?, carriedFromHead?, carriedVerdict?, group? }] }
                                 carriedFromHead (7-64 hex) marks an angle whose verdict was carried forward from that prior head (reviewer stays the prior reviewer)
                                 carriedVerdict ("clean"|"findings_present", requires carriedFromHead) records WHICH verdict was carried (issue #2017): "findings_present"
                                 distinguishes a carry that preserved open findings from an ordinary clean carry — the findings themselves are recorded separately in --findings, not here
                                 distinctReviewers must be <= the distinct reviewers recorded in perAngle (perAngle non-empty when distinctReviewers > 0)
                                 no two fresh (non-carried) angles may share one reviewer identity, and every fresh angle must record one (reviewer or dispatchId) — one scoped reviewer per angle (use inline_single_agent + --inline-reason for a sanctioned single-reviewer run)
                                 EXCEPTION: fresh angles sharing a reviewer may all declare the same "group" name (grouped fan-out dispatch); differing or missing group names still fail closed
  --emit-plan <path>             Optional keyed emit-fanout-dispatch plan. When supplied, requires --provenance and fails closed unless that caller-supplied provenance matches the plan's round key and emitted fresh units exactly. The plan is a guard only; it never supplies provenance or findings. Omitted preserves current behavior.
  --full-label                   The PR carries the gate:full label: dispatch groups resolve to one angle per unit, so any reviewer identity shared across fresh angles is rejected regardless of a declared "group" (mirrors write-gate-context.mjs's --full-label). Only meaningful when --provenance is supplied. Omitted (default false) keeps current behavior.
  --judge-verdict <path>         Path to the judge agent's verdict artifact (JSON). When supplied, the findings are
                                 enriched with the judge's relevance-based dispositions (judgeDisposition /
                                 judgeRationale / judgeCriterion / followUpDraft) via applyJudgeDispositions before
                                 the ledger is written, so the durable ledger and posted findings comment carry what
                                 was consciously not acted on and why (#1525). The verdict must dispose every finding
                                 (one disposition per 0-based ledger position) or the run FAILS CLOSED and writes no
                                 ledger. Optional; when absent the ledger writes byte-identically to before.
  --tmp-root <path>              Root tmp directory (default: tmp/)
  --spec-authority <path>        JSON { specDigest, headSha, contentDigest, checkedCriteria }
                                  (issue 2008 / ADR 0061 AC1). When supplied, stamps the log
                                  with the pinned revision identity via the ONE shared stamp
                                  helper. Pure no-op (byte-identical log) when absent.

${JQ_OUTPUT_USAGE}
`.trim();
function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}
const normalizeGate = normalizeGateShared;
const normalizeVerdict = normalizeVerdictShared;
// Exported so other tools (e.g. upsert-checkpoint-verdict.mjs) derive their
// own subset from this one copy instead of hand-copying it out of sync.
// "needs-answer" is the disposition a "question" finding gets (see
// consolidateFanin, @dev-loops/core/loop/gate-fanin): a question is
// answered, never deferred or fixed, so it needs its own disposition.
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
      // Trimmed, not just filtered: hasLocatableShape only checks non-empty,
      // but every downstream consumer (diff commentable-line lookup, posted
      // review `path`, renderNonLocatableBlock's Location line) compares
      // against the TRIMMED form — an untrimmed entry would derive
      // "needs-answer"/locatable here yet never match a real in-diff position
      // later, silently downgrading it at a different layer.
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
      // to "deferred", so callers need not repeat the obvious per entry. A
      // question defaults to "needs-answer" instead (LOCATABLE) via the SAME
      // shared rule every producer uses (deriveDisposition, @dev-loops/core/
      // loop/gate-fanin) — this producer and post-gate-findings.mjs's own
      // validator both route through it so the two can never drift.
      entry.disposition = deriveDisposition(f.severity, { locatable: hasLocatableShape(entry) });
    }
    // net-reduction disposition policy: the explicit operator-visibility signal for a "low" finding —
    // see buildFindingMarker's doc (_gate-finding-surface.mjs) for the full
    // contract. Boolean-only; absent/false is the conservative default.
    if ("operatorVisible" in f) {
      if (typeof f.operatorVisible !== "boolean") {
        throw parseError(`${flagLabel}[${i}].operatorVisible must be a boolean`);
      }
      // Fail closed: operatorVisible only means something for a "low" finding
      // (the net-reduction disposition policy's filing signal) — any other
      // severity is a caller error the ledger must not silently swallow.
      if (f.severity !== "low") {
        throw parseError(`${flagLabel}[${i}].operatorVisible is only meaningful for a "low" finding (got severity ${JSON.stringify(f.severity)})`);
      }
      entry.operatorVisible = f.operatorVisible;
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
    // Judge relevance-based dispositions (GATE-EXEC-JUDGE-PHASE): optional and additive —
    // absent when no judge verdict ran, the finding writes exactly as before.
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
    // GATE-EXEC-DEFERRAL-RECORD: a judge-pass-enriched finding may carry a stable `fingerprint`
    // ([0-9a-f]{16}, matching the finding-marker regex) and a `defer` finding
    // additionally carries `followUpIssueNumber` (the PR's one tracked
    // follow-up issue). Both optional; a malformed fingerprint fails closed.
    if (typeof f.fingerprint === "string" && f.fingerprint.trim().length > 0) {
      const fp = f.fingerprint.trim();
      if (!/^[0-9a-f]{16}$/.test(fp)) {
        throw parseError(`${flagLabel}[${i}].fingerprint must be a 16-char lowercase hex string`);
      }
      entry.fingerprint = fp;
    }
    if (Number.isInteger(f.followUpIssueNumber) && f.followUpIssueNumber > 0) {
      entry.followUpIssueNumber = f.followUpIssueNumber;
    }
    if (f.followUpDraft !== undefined && f.followUpDraft !== null) {
      // Mirrors validateJudgeVerdict's followUpDraft shape rule
      // (packages/core/src/loop/gate-fanin.mjs): only undefined/null counts
      // as absent, so a present-but-falsy draft ("", 0, false) is rejected
      // rather than silently dropped, and a present draft must have a
      // non-empty title plus a body string.
      if (typeof f.followUpDraft !== "object" || Array.isArray(f.followUpDraft)) {
        throw parseError(`${flagLabel}[${i}].followUpDraft must be an object`);
      }
      const draft = f.followUpDraft;
      if (typeof draft.title !== "string" || draft.title.trim().length === 0 || typeof draft.body !== "string") {
        throw parseError(`${flagLabel}[${i}].followUpDraft must have a non-empty title and a body string`);
      }
      // Validated against the trimmed title but stored raw, mirroring
      // validateJudgeVerdict's own untrimmed pass-through.
      entry.followUpDraft = f.followUpDraft;
    }
    // Mirrors validateJudgeVerdict's defer rule (packages/core/src/loop/
    // gate-fanin.mjs): followUpDraft is mandatory when judgeDisposition is
    // "defer" (soft-cap contract). A hand-authored --findings array bypasses
    // that upstream check, so this validator re-enforces it independently.
    if (entry.judgeDisposition === "defer" && entry.followUpDraft === undefined) {
      throw parseError(`${flagLabel}[${i}].followUpDraft is required when judgeDisposition is "defer"`);
    }
    return entry;
  });
}
// Resolve the findings array from either --findings (inline JSON) or
// --findings-file (a path), with identical validation either way. Shared
// plumbing lives in _findings-input.mjs.
function resolveFindings(options) {
  return resolveFindingsInput(options, { parseError, validate: validateFindingsArray });
}
/**
 * Validate + normalize the fan-out provenance object (distinctReviewers +
 * perAngle). Rejects malformed or self-inconsistent provenance; this raises
 * the bar but does not make provenance unforgeable (see the Pi-harness
 * subagent-tool bridge for that).
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
    // carriedFromHead marks an angle whose verdict was carried forward from a
    // prior head whose delta provably did not touch this angle's surface
    // (GATE-EXEC-ANGLE-CARRY-FORWARD; @dev-loops/core/loop/gate-carry-forward). `reviewer` stays that
    // prior head's reviewer (honest attribution) and still counts toward the
    // distinctReviewers consistency check below.
    if ("carriedFromHead" in a) {
      if (typeof a.carriedFromHead !== "string" || !/^[0-9a-f]{7,64}$/i.test(a.carriedFromHead.trim())) {
        throw parseError(`--provenance.perAngle[${i}].carriedFromHead must be a 7-64 char hex SHA`);
      }
      entry.carriedFromHead = a.carriedFromHead.trim().toLowerCase();
    }
    // carriedVerdict (GATE-EXEC-ANGLE-CARRY-FORWARD) records which verdict a carried angle preserved:
    // "findings_present" means its prior open findings carried forward
    // unchanged (still recorded in --findings, never substituted here).
    // Requires carriedFromHead — it only labels provenance, it never itself
    // supplies findings content.
    if ("carriedVerdict" in a) {
      if (!("carriedFromHead" in a)) {
        throw parseError(`--provenance.perAngle[${i}].carriedVerdict requires carriedFromHead (it only distinguishes a carried entry's prior verdict)`);
      }
      if (a.carriedVerdict !== "clean" && a.carriedVerdict !== "findings_present") {
        throw parseError(`--provenance.perAngle[${i}].carriedVerdict must be "clean" or "findings_present"`);
      }
      entry.carriedVerdict = a.carriedVerdict;
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
  // One-scoped-reviewer-per-fresh-angle floor (ADR 0039): no two fresh
  // (non-carried) angles may share a reviewer identity, except fresh angles
  // sharing one under the SAME declared `group` (grouped fan-out dispatch —
  // see fanoutReviewerPairingError). `resolvedGroups` additionally rejects a
  // claimed group the configured table does not actually place together.
  const pairingError = fanoutReviewerPairingError(normalized.perAngle, resolvedGroups);
  if (pairingError) {
    throw parseError(`--provenance.perAngle ${pairingError}`);
  }
  return normalized;
}
/**
 * Validate recorded provenance.perAngle against the gate's configured angle
 * contract (mandatoryAngles + pool). A missing mandatory angle always fails
 * the write; a foreign angle fails unless `gates.rejectForeignAngles: false`,
 * in which case it returns as a warning instead.
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

/**
 * Guard caller-supplied provenance against the sanctioned emitter's persisted
 * plan. The plan is never used to construct provenance: it only proves that
 * the already-validated fresh rows describe exactly the units actually emitted.
 */
export async function verifyEmitPlanProvenance(planPath, provenance, round, { repoRoot = process.cwd() } = {}) {
  let plan;
  const fullPath = path.resolve(repoRoot, planPath);
  try {
    plan = JSON.parse(await readFile(fullPath, "utf8"));
  } catch (error) {
    throw parseError(`GATE-EXEC-EMIT-PLAN-KEY: cannot verify emit-plan provenance: --emit-plan "${planPath}" could not be read/parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const planHeadSha = normalizeFullHeadSha(plan?.headSha);
  const planPr = typeof plan?.pr === "string" && /^\d+$/.test(plan.pr) ? Number(plan.pr) : plan?.pr;
  if (plan?.repo !== round.repo || planPr !== round.pr || normalizeGate(plan?.gate) !== round.gate || planHeadSha !== round.headSha) {
    throw parseError(`--emit-plan "${planPath}" is stamped for ${JSON.stringify({ repo: plan?.repo, pr: plan?.pr, gate: plan?.gate, headSha: plan?.headSha })} but this findings log writes ${JSON.stringify(round)} — a stale or foreign emit plan must not be consumed`);
  }
  if (plan.ok !== true || !Array.isArray(plan.units) || plan.units.length === 0 || plan.count !== plan.units.length) {
    throw parseError(`cannot verify emit-plan provenance: --emit-plan "${planPath}" must carry a non-empty units array whose length equals count`);
  }

  const expected = new Map();
  for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex += 1) {
    const unit = plan.units[unitIndex];
    if (!unit || typeof unit !== "object" || !Array.isArray(unit.angles) || unit.angles.length === 0) {
      throw parseError(`cannot verify emit-plan provenance: --emit-plan units[${unitIndex}] must carry a non-empty angles array`);
    }
    const group = unit.group === null ? undefined : unit.group;
    if (group !== undefined && (typeof group !== "string" || group.trim().length === 0)) {
      throw parseError(`cannot verify emit-plan provenance: --emit-plan units[${unitIndex}].group must be null or a non-empty string`);
    }
    if ((unit.angles.length === 1) !== (group === undefined)) {
      throw parseError(`cannot verify emit-plan provenance: --emit-plan units[${unitIndex}].group must be null for a singleton and non-empty for a multi-angle unit`);
    }
    for (const rawAngle of unit.angles) {
      if (typeof rawAngle !== "string" || rawAngle.trim().length === 0) {
        throw parseError(`cannot verify emit-plan provenance: --emit-plan units[${unitIndex}].angles must contain only non-empty strings`);
      }
      const angle = rawAngle.trim();
      if (expected.has(angle)) {
        throw parseError(`cannot verify emit-plan provenance: --emit-plan emits angle ${JSON.stringify(angle)} more than once`);
      }
      expected.set(angle, { group: group?.trim(), unitIndex });
    }
  }

  const actual = new Map();
  for (const entry of provenance.perAngle.filter((item) => item.carriedFromHead === undefined)) {
    if (actual.has(entry.angle)) {
      throw parseError(`--provenance.perAngle records fresh angle ${JSON.stringify(entry.angle)} more than once; it cannot correspond to one emitted unit`);
    }
    actual.set(entry.angle, entry);
  }
  const missing = [...expected.keys()].filter((angle) => !actual.has(angle));
  const extra = [...actual.keys()].filter((angle) => !expected.has(angle));
  if (missing.length > 0 || extra.length > 0) {
    throw parseError(`--provenance.perAngle does not correspond to --emit-plan fresh angles (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }

  const identitiesByUnit = new Map();
  for (const [angle, expectedEntry] of expected) {
    const actualEntry = actual.get(angle);
    if (actualEntry.group !== expectedEntry.group) {
      throw parseError(`--provenance.perAngle angle ${JSON.stringify(angle)} records group ${JSON.stringify(actualEntry.group ?? null)} but --emit-plan records ${JSON.stringify(expectedEntry.group ?? null)}`);
    }
    const identity = actualEntry.reviewer ?? actualEntry.dispatchId;
    const prior = identitiesByUnit.get(expectedEntry.unitIndex);
    if (prior !== undefined && prior !== identity) {
      throw parseError(`--provenance.perAngle records multiple reviewer identities for --emit-plan unit ${expectedEntry.unitIndex}; one emitted unit must correspond to one reviewer`);
    }
    identitiesByUnit.set(expectedEntry.unitIndex, identity);
  }
  if (provenance.distinctReviewers < plan.units.length) {
    throw parseError(`--provenance.distinctReviewers (${provenance.distinctReviewers}) is smaller than --emit-plan's ${plan.units.length} fresh dispatch units`);
  }
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
      "emit-plan": { type: "string" },
      "full-label": { type: "boolean" },
      "judge-verdict": { type: "string" },
      "tmp-root": { type: "string" },
      "spec-authority": { type: "string" },
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
    specAuthority: undefined,
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
      if (!gate) throw parseError(`--gate must be one of: ${GATE_NAMES.join(", ")}`);
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
    if (token.name === "emit-plan") {
      const emitPlan = requireTokenValue(token, parseError).trim();
      if (emitPlan.length === 0) throw parseError("--emit-plan requires a non-empty path");
      options.emitPlan = emitPlan;
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
    if (token.name === "spec-authority") {
      options.specAuthority = requireTokenValue(token, parseError).trim();
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
  if (options.emitPlan !== undefined && options.provenance === undefined) {
    throw parseError("--emit-plan requires --provenance so the emitted units have caller-supplied provenance to validate");
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
  // judge's relevance-based dispositions (GATE-EXEC-JUDGE-PHASE) before writing the ledger:
  // applyJudgeDispositions fails closed on a malformed verdict, an
  // out-of-range index, or dispositions that do not cover every finding.
  let findings = rawFindings;
  let scopeDrift;
  if (options.judgeVerdict) {
    const judgePath = path.resolve(repoRoot, options.judgeVerdict);
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
  // The consolidator's own computed verdict (consolidate-fanin.mjs's
  // `overallVerdict`) threads through `--ledger-out`'s wrapper into here — a
  // bare-array input (legacy --findings-file, hand-authored --findings) has
  // no wrapper, so `overallVerdict` stays undefined, but the persisted
  // `verdict` is always the canonical normalized caller verdict either way
  // (GATE-COMMENT-VERDICT-VALUES).

  // Validate --verdict domain up front: the shared normalizeVerdict
  // (scripts/github/_gate-names.mjs) already guards non-strings internally,
  // so this outer typeof check is redundant defense-in-depth, not
  // load-bearing — it ensures a bare-array input never persists a
  // null/undefined/out-of-domain verdict un-normalized.
  const callerVerdict = typeof options.verdict === "string" ? normalizeVerdict(options.verdict) : null;
  if (!callerVerdict) {
    throw parseError("--verdict must be clean, findings_present, or blocked");
  }
  let normalizedOverallVerdict;
  // Persist the canonical (normalized) verdict on both input paths, in a
  // local rather than mutating `options` (which programmatic callers may
  // reuse across calls).
  let persistedVerdict = callerVerdict;
  if (overallVerdict !== undefined) {
    // Same redundant defense-in-depth as above: normalizeVerdict already
    // rejects non-strings.
    const verdict = typeof overallVerdict === "string" ? normalizeVerdict(overallVerdict) : null;
    if (!verdict) {
      throw parseError(
        `--${options.findingsFile ? "findings-file" : "findings"} "${options.findingsFile ?? "<inline>"}" wrapper "overallVerdict" must be one of: clean, findings_present, or blocked (got: ${JSON.stringify(overallVerdict)})`,
      );
    }
    normalizedOverallVerdict = verdict;
    // Fail closed on a caller-passed --verdict that contradicts the
    // consolidator's computed verdict (GATE-COMMENT-VERDICT-VALUES).
    // The judge only enriches findings with act/defer/reject dispositions —
    // it never revises the round verdict — so this comparison runs the same
    // with or without --judge-verdict. A --judge-verdict run can still fail
    // earlier: an unreadable, malformed, or incomplete-coverage judge
    // artifact throws its own error before this contradiction check runs.
    if (callerVerdict !== normalizedOverallVerdict) {
      throw parseError(
        `--verdict ${JSON.stringify(callerVerdict)} contradicts the wrapper's "overallVerdict" ${JSON.stringify(normalizedOverallVerdict)} (GATE-COMMENT-VERDICT-VALUES; skills/docs/gate-review-comment-contract.md) — the consolidator's computed round verdict, which judge dispositions from --judge-verdict never alter`,
      );
    }
  }
  let provenance;
  if (options.provenance === undefined) {
    provenance = undefined;
  } else {
    // Resolve this round's dispatch groups before validating pairing, so a
    // claimed `group` is cross-checked against the gate's configured
    // grouping table (see fanoutReviewerPairingError), not just self-attested.
    // A raw-JSON parse failure here is swallowed; the real error resurfaces
    // inside parseProvenanceJson below.
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
  if (options.emitPlan !== undefined) {
    await verifyEmitPlanProvenance(options.emitPlan, provenance, {
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: options.headSha,
    }, { repoRoot });
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
    verdict: persistedVerdict,
    loggedAt: new Date().toISOString(),
    findings,
  };
  // `overallVerdict` is optional and additive (absent on a bare-array input);
  // `verdict` above is always the canonical normalized caller value (GATE-COMMENT-VERDICT-VALUES).
  if (normalizedOverallVerdict !== undefined) {
    log.overallVerdict = normalizedOverallVerdict;
  }
  // Provenance is optional and additive: absent keeps the ledger byte-
  // identical to before; present records fan-out provenance for
  // gates.requireFanoutProvenance enforcement.
  if (provenance !== undefined) {
    log.provenance = provenance;
  }
  // The judge's scope-drift verdict on the PR as a whole (GATE-EXEC-JUDGE-PHASE); optional
  // and additive.
  if (scopeDrift !== undefined) {
    log.scopeDrift = scopeDrift;
  }
  // AC1 (issue 2008 / ADR 0061): optional --spec-authority stamps the pinned
  // revision identity + checked criteria onto the log via the ONE shared
  // helper. Pure no-op (byte-identical log) when the flag is absent.
  const specAuthorityIdentity = await readSpecAuthorityIdentity(
    options.specAuthority !== undefined ? path.resolve(repoRoot, options.specAuthority) : undefined,
    parseError,
  );
  const stampedLog = stampOptionalSpecAuthority(log, specAuthorityIdentity);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(stampedLog, null, 2) + "\n", "utf8");
  return angleCoverage.warning
    ? { ok: true, path: logPath, log: stampedLog, warning: angleCoverage.warning }
    : { ok: true, path: logPath, log: stampedLog };
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
