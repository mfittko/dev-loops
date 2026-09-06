#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  applyJudgeDispositions,
  validateJudgeVerdict,
} from "@dev-loops/core/loop/gate-fanin";
import {
  SPEC_AUTHORITY_OUTCOMES,
  buildRevisionIdentity,
  resolveAffectedCriteria,
  resolveCriterionInvalidation,
  specCriterionIds,
  stampSpecAuthorityIdentity,
  validateSpecAuthorityVerdict,
} from "@dev-loops/core/loop/spec-authority";
import { ensureFollowUpIssue, fingerprintFinding } from "../github/_gate-finding-surface.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { resolveFindingsInput } from "../github/_findings-input.mjs";
import {
  JQ_OUTPUT_PARSE_OPTIONS,
  JQ_OUTPUT_USAGE,
  emitResult,
  matchJqOutputToken,
} from "../lib/jq-output.mjs";

const USAGE = `Usage: judge-pass.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --findings-file <path> --judge-verdict <path> [--out <act-list-path>] [--ledger-out <path>] [--repo-root <path>]

Bridge the judge pass between gate fan-in (Phase 3) and the fixer pass (Phase 4).
Reads the judge agent's verdict artifact, enforces current-head freshness, applies
the judge's relevance dispositions (act/defer/reject) to the consolidated ledger,
and emits the fixer's ACT list — the findings the judge marked 'act' that the fix
pass executes (#1658).

Inputs:
  --findings-file <path>       The consolidated flat ledger from consolidate-fanin
                               --ledger-out ({ overallVerdict, findings } wrapper,
                               or a bare findings array). Same unwrap semantics as
                               write-gate-findings-log --findings-file.
  --judge-verdict <path>       The judge agent's verdict artifact (JSON) at the
                               deterministic tmp/gate-judge/.../judge-verdict.json
                               path. Validated by validateJudgeVerdict and must be
                               current-head (headSha == --head-sha) or the pass
                               FAILS CLOSED — a stale verdict must not feed the
                               fixer's act list.
  --head-sha <sha>             The round's current head. The verdict's headSha must
                               equal this (trim+lowercase compare) or the pass fails
                               closed.
  --repo <owner/name>          Echoed onto the result (owner/name format checked).
  --pr <number>                Echoed onto the result.
  --gate <name>                Echoed onto the result (draft_gate|pre_approval_gate).
  --out <path>                 Write the fixer's ACT list (enriched findings with
                               judgeDisposition === "act") to this path as JSON.
  --ledger-out <path>          Write the enriched { overallVerdict, findings, scopeDrift }
                               to this path as JSON, so the durable disposition ledger
                               carries what the judge consciously marked act/defer/reject.
                               Every disposed finding also carries a \`fingerprint\`; a
                               \`defer\` finding additionally carries \`followUpIssueNumber\`
                               — the PR's ONE tracked follow-up GitHub issue (created or
                               appended to, batched across every defer in the round; never
                               one issue per finding). A re-run reads this same path back
                               first, so an already-linked finding is not re-created (#1807).
  --repo-root <path>           Root used to resolve relative --findings-file /
                               --judge-verdict / --out / --ledger-out paths
                               (default: process.cwd()).

Immutable spec-authority enforcement (opt-in; enabled by --spec-file):
  --spec-file <path>           JSON structured spec { acceptanceCriteria,
                               definitionOfDone, nonGoals } (arrays of strings) —
                               the canonical tracker AC/DoD/Non-goals. When
                               supplied, the judge must additionally provide a
                               whole-spec authority verdict (--spec-authority-verdict)
                               that pins the run's specDigest, head, and content
                               digest and disposes every finding with one of the
                               four named outcomes. specDigest is computed here
                               from the normalized spec, independently of the head.
  --content-digest <digest>    The reviewed content identity ("sha256:<hex>").
                               Required with --spec-file. Distinct from --head-sha.
  --spec-authority-verdict <p> The judge's whole-spec authority verdict artifact.
                               Required with --spec-file. Validated against the
                               computed specDigest, --head-sha, --content-digest,
                               and the finding count. A spec_cannot_decide outcome
                               FAILS CLOSED (exit 1) with humanDecisionRequired so
                               the loop stops at the human-spec-decision state
                               instead of feeding the fixer. A finding_conflicts
                               outcome removes that finding from the act list (it
                               cannot authorize a fix) even if its relevance
                               disposition was 'act'.
  --prior-approvals <path>     Prior clean round's --approvals-out record. When
                               supplied, resolveCriterionInvalidation stales the
                               approvals a changed revision invalidates (a new
                               specDigest stales all; a fixer push stales affected
                               criteria, carrying unaffected ones only with proof).
                               Requires --spec-file.
  --carry-forward-proof <path> JSON map criterionId -> { specTextUnchanged,
                               coveredSurfaceUnchanged }; an unaffected criterion
                               carries forward only when both are true. Requires
                               --spec-file (used with --prior-approvals).
  --changed-paths <path>       JSON string array of repo-relative paths a fixer
                               push changed. Given together with --coverage-map,
                               resolveAffectedCriteria (AC7) computes which
                               criteria the push actually affects, narrowing the
                               all-stale fallback. Requires --spec-file and
                               --prior-approvals (only meaningful during
                               invalidation).
  --coverage-map <path>        JSON object mapping criterionId -> glob pattern
                               array (the declared coverage for that criterion).
                               Required together with --changed-paths. When the
                               producer is UNCERTAIN (a changed path matches no
                               criterion's coverage), affectedCriteria falls back
                               to the full prior-approved set (fail closed).
  --approvals-out <path>       Persist the durable, re-entry-safe approval record
                               (revision identities + approved criteria +
                               invalidation result + humanDecision +
                               authorizedRemediations + criterionCoverage when
                               supplied). Requires --spec-file.

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Fail closed (stale verdict head, malformed verdict, out-of-range disposition, etc.)
  2   Invalid --jq filter
`.trim();

const GATES = GATE_NAMES;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseJudgePassCliArgs(argv) {
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    findingsFile: undefined,
    judgeVerdict: undefined,
    out: undefined,
    ledgerOut: undefined,
    repoRoot: undefined,
    specFile: undefined,
    contentDigest: undefined,
    specAuthorityVerdict: undefined,
    priorApprovals: undefined,
    approvalsOut: undefined,
    carryForwardProof: undefined,
    changedPaths: undefined,
    coverageMap: undefined,
    jq: undefined,
    silent: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      "findings-file": { type: "string" },
      "judge-verdict": { type: "string" },
      out: { type: "string" },
      "ledger-out": { type: "string" },
      "repo-root": { type: "string" },
      "spec-file": { type: "string" },
      "content-digest": { type: "string" },
      "spec-authority-verdict": { type: "string" },
      "prior-approvals": { type: "string" },
      "approvals-out": { type: "string" },
      "carry-forward-proof": { type: "string" },
      "changed-paths": { type: "string" },
      "coverage-map": { type: "string" },
      help: { type: "boolean", short: "h" },
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
      continue;
    }
    if (matchJqOutputToken(token, options)) continue;
    if (token.name === "repo") {
      options.repo = token.value;
      continue;
    }
    if (token.name === "pr") {
      options.pr = token.value;
      continue;
    }
    if (token.name === "gate") {
      options.gate = token.value;
      continue;
    }
    if (token.name === "head-sha") {
      options.headSha = token.value;
      continue;
    }
    if (token.name === "findings-file") {
      options.findingsFile = token.value;
      continue;
    }
    if (token.name === "judge-verdict") {
      options.judgeVerdict = token.value;
      continue;
    }
    if (token.name === "out") {
      options.out = token.value;
      continue;
    }
    if (token.name === "ledger-out") {
      options.ledgerOut = token.value;
      continue;
    }
    if (token.name === "repo-root") {
      options.repoRoot = token.value;
      continue;
    }
    if (token.name === "spec-file") {
      options.specFile = token.value;
      continue;
    }
    if (token.name === "content-digest") {
      options.contentDigest = token.value;
      continue;
    }
    if (token.name === "spec-authority-verdict") {
      options.specAuthorityVerdict = token.value;
      continue;
    }
    if (token.name === "prior-approvals") {
      options.priorApprovals = token.value;
      continue;
    }
    if (token.name === "approvals-out") {
      options.approvalsOut = token.value;
      continue;
    }
    if (token.name === "carry-forward-proof") {
      options.carryForwardProof = token.value;
      continue;
    }
    if (token.name === "changed-paths") {
      options.changedPaths = token.value;
      continue;
    }
    if (token.name === "coverage-map") {
      options.coverageMap = token.value;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  return validateCliArgs(options);
}

function requireValue(value, flag, parseErr) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw parseErr(`${flag} requires a non-empty value`);
  }
  return value.trim();
}

export function validateCliArgs(options) {
  const missing = [];
  for (const key of ["repo", "pr", "gate", "headSha", "findingsFile", "judgeVerdict"]) {
    if (options[key] === undefined) missing.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  try {
    parseRepoSlug(requireValue(options.repo, "--repo", parseError));
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  if (!/^\d+$/.test(String(options.pr).trim())) {
    throw parseError("--pr must be a positive integer");
  }
  const gate = String(options.gate).trim().toLowerCase();
  if (!GATES.includes(gate)) {
    throw parseError(`--gate must be one of: ${GATES.join(", ")}`);
  }
  options.gate = gate;
  const sha = requireValue(options.headSha, "--head-sha", parseError);
  if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
    throw parseError("--head-sha must be a 7-64 char hex SHA");
  }
  options.headSha = sha;
  options.findingsFile = requireValue(options.findingsFile, "--findings-file", parseError);
  options.judgeVerdict = requireValue(options.judgeVerdict, "--judge-verdict", parseError);
  // Every configured path flag must be pairwise distinct: inputs must never be
  // clobbered by an output, and --out must never be silently deduped against
  // --ledger-out (which would yield no act list with no warning).
  // Spec-authority enforcement is opt-in via --spec-file, but once opted in the
  // content-digest identity and the whole-spec verdict are BOTH mandatory — a
  // half-configured authority gate must fail closed, not silently skip.
  if (options.specFile !== undefined) {
    for (const [key, flag] of [["contentDigest", "--content-digest"], ["specAuthorityVerdict", "--spec-authority-verdict"]]) {
      if (options[key] === undefined) {
        throw parseError(`${flag} is required when --spec-file is supplied (spec-authority enforcement)`);
      }
    }
    // --carry-forward-proof only takes effect inside the --prior-approvals
    // invalidation path; accepting it without --prior-approvals would silently
    // ignore it (a half-configured re-entry run that appears to supply proof but
    // does not apply it). Fail closed.
    if (options.carryForwardProof !== undefined && options.priorApprovals === undefined) {
      throw parseError("--carry-forward-proof requires --prior-approvals (it is only applied during criterion invalidation)");
    }
    // AC7 (issue 2008 / ADR 0061): --changed-paths and --coverage-map are the
    // affected-criteria producer's inputs. Both required together — one
    // without the other would silently drop the producer with no diagnostic —
    // and, like --carry-forward-proof, only meaningful inside the
    // --prior-approvals invalidation path.
    if ((options.changedPaths !== undefined) !== (options.coverageMap !== undefined)) {
      throw parseError("--changed-paths and --coverage-map must be supplied together (AC7 affected-criteria producer)");
    }
    if (options.changedPaths !== undefined && options.priorApprovals === undefined) {
      throw parseError("--changed-paths and --coverage-map require --prior-approvals (they are only applied during criterion invalidation)");
    }
  } else {
    // The spec-authority flags only make sense under an active gate (--spec-file).
    // Guard BOTH directions: supplying --content-digest/--spec-authority-verdict
    // (or the invalidation/persistence flags) WITHOUT --spec-file must fail
    // closed, never silently drop the authority verdict (enforceSpecAuthority
    // early-returns null when --spec-file is absent).
    for (const [key, flag] of [
      ["contentDigest", "--content-digest"],
      ["specAuthorityVerdict", "--spec-authority-verdict"],
      ["priorApprovals", "--prior-approvals"],
      ["approvalsOut", "--approvals-out"],
      ["carryForwardProof", "--carry-forward-proof"],
      ["changedPaths", "--changed-paths"],
      ["coverageMap", "--coverage-map"],
    ]) {
      if (options[key] !== undefined) {
        throw parseError(`${flag} requires --spec-file (spec-authority enforcement)`);
      }
    }
  }
  const pathFlags = ["findingsFile", "judgeVerdict", "out", "ledgerOut", "specFile", "specAuthorityVerdict", "priorApprovals", "approvalsOut", "carryForwardProof", "changedPaths", "coverageMap"].filter(
    (k) => options[k] !== undefined,
  );
  for (let i = 0; i < pathFlags.length; i += 1) {
    for (let j = i + 1; j < pathFlags.length; j += 1) {
      if (options[pathFlags[i]] === options[pathFlags[j]]) {
        const flag = (k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        throw parseError(`${flag(pathFlags[i])} and ${flag(pathFlags[j])} must be different paths`);
      }
    }
  }
  return options;
}

/**
 * Apply a valid, current-head judge verdict to a consolidated findings ledger and
 * derive the fixer's ACT list. Pure + fail-closed:
 *   - validates the verdict shape (`validateJudgeVerdict`)
 *   - enforces current-head freshness: verdict.headSha must equal `headSha`
 *     (trim+lowercase) or the pass fails closed — a stale verdict staged from an
 *     earlier head must never feed the fixer's act list
 *   - applies the judge's relevance dispositions via `applyJudgeDispositions`
 *     (fail-closed on an out-of-range index and on undisposed findings)
 *
 * The fix pass consumes ONLY the returned `act` list (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`);
 * the returned `enriched` ledger carries `judgeDisposition` / `judgeRationale` /
 * `judgeCriterion` / `followUpDraft` so the durable ledger and posted findings comment
 * show what was consciously not acted on and why.
 *
 * @param {Array<object>} findings — the flat consolidated findings array (already unwrapped)
 * @param {object} judgeVerdict — the judge agent's verdict artifact (JSON object)
 * @param {string} headSha — the round's current head (the verdict must be current-head)
 * @returns {{ enriched: Array<object>, act: Array<object>, scopeDrift: object,
 *             counts: { act: number, defer: number, reject: number }, headSha: string }}
 */
export function runJudgePass(findings, judgeVerdict, headSha) {
  const validated = validateJudgeVerdict(judgeVerdict);
  const verdictHead = validated.headSha.trim().toLowerCase();
  const currentHead = String(headSha).trim().toLowerCase();
  if (verdictHead !== currentHead) {
    throw new Error(
      `judge verdict headSha ${JSON.stringify(validated.headSha)} does not match current head ${JSON.stringify(headSha)} — refuse a stale verdict; re-run the judge at the current head`
    );
  }
  // applyJudgeDispositions fails closed on both an out-of-range index and an
  // undisposed finding (the coverage check lives in that shared pure seam),
  // so runJudgePass inherits fail-closed coverage without restating it here.
  const applied = applyJudgeDispositions(findings, judgeVerdict);
  const enriched = applied.findings;
  return {
    enriched,
    act: enriched.filter((f) => f.judgeDisposition === "act"),
    scopeDrift: applied.scopeDrift,
    counts: countByDisposition(enriched),
    headSha: validated.headSha,
  };
}

/**
 * Tally judge dispositions (act/defer/reject) over an enriched findings list.
 * The ONE counting rule shared by runJudgePass and the spec-authority act-list
 * recount, so the two cannot drift.
 * @param {Array<{judgeDisposition?: string}>} enriched
 * @returns {{ act: number, defer: number, reject: number }}
 */
function countByDisposition(enriched) {
  const counts = { act: 0, defer: 0, reject: 0 };
  for (const f of enriched) {
    if (f.judgeDisposition === "act") counts.act += 1;
    else if (f.judgeDisposition === "defer") counts.defer += 1;
    else if (f.judgeDisposition === "reject") counts.reject += 1;
  }
  return counts;
}

async function resolvePayload(options, repoRoot) {
  const findingsInput = await resolveFindingsInput(
    { findingsFile: path.resolve(repoRoot, options.findingsFile) },
    { parseError, validate: validateFindingsArray },
  );
  return { findings: findingsInput.findings, overallVerdict: findingsInput.overallVerdict };
}

function validateFindingsArray(parsed, flagLabel) {
  if (!Array.isArray(parsed)) {
    throw parseError(`${flagLabel} must resolve to a findings array`);
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw parseError(`${flagLabel}[${i}] must be a finding object`);
    }
    return f;
  });
}

// Best-effort read of a prior --ledger-out artifact (the same path this run
// is about to overwrite) to recover the PR's already-linked follow-up issue
// (#1807 idempotency, batching policy): a re-run of the judge pass over the
// same round must reuse the PR's ONE tracked follow-up issue rather than
// mint a duplicate, and must not re-append fingerprints it already recorded
// there. Tolerates a missing/malformed prior artifact (first-ever run) by
// returning an empty link set — never fails the pass over a stale/partial
// read of its own prior output.
//
// This is a FAST-PATH cache only, not the authority: this pass's own
// --ledger-out is a disjoint store from close-gate-findings.mjs's thread
// markers, so a `null` here does not mean no follow-up issue exists — it only
// means this run doesn't know of one locally. `ensureFollowUpIssue`
// (_gate-finding-surface.mjs) resolves against GitHub itself before creating
// whenever the number passed in here is `null`, which is what actually closes
// the cross-path duplicate-issue gap between the two independent defer paths.
async function readPriorFollowUpLinks(ledgerOutPath) {
  if (!ledgerOutPath) return { issueNumber: null, linkedFingerprints: new Set() };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(ledgerOutPath, "utf8"));
  } catch {
    return { issueNumber: null, linkedFingerprints: new Set() };
  }
  const priorFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const issueNumber = priorFindings
    .map((f) => f?.followUpIssueNumber)
    .find((n) => Number.isInteger(n) && n > 0) ?? null;
  const linkedFingerprints = new Set(
    issueNumber === null
      ? []
      : priorFindings.filter((f) => f?.followUpIssueNumber === issueNumber).map((f) => f.fingerprint),
  );
  return { issueNumber, linkedFingerprints };
}

/**
 * Attach a stable per-finding `fingerprint` to every judge-disposed finding
 * (act/defer/reject — #1807's one-line reject audit entry keys on it too),
 * then — for every `defer` disposition — create or append to the PR's ONE
 * tracked follow-up GitHub issue (batched: never one issue per finding).
 * Mutates `enriched` in place (each element already the judge-pass's own
 * fresh copy from `applyJudgeDispositions`). A re-run over the same
 * `ledgerOutPath` links the already-linked findings without creating a
 * duplicate issue or re-appending fingerprints already recorded on it.
 */
async function applyFollowUpIssues(enriched, { repo, pr, ledgerOutPath }, deps) {
  for (const f of enriched) {
    f.fingerprint = fingerprintFinding(f);
  }
  const deferred = enriched.filter((f) => f.judgeDisposition === "defer");
  if (deferred.length === 0) return;
  const { issueNumber: priorIssueNumber, linkedFingerprints } = await readPriorFollowUpLinks(ledgerOutPath);
  const newlyDeferred = deferred.filter((f) => !linkedFingerprints.has(f.fingerprint));
  if (priorIssueNumber !== null && newlyDeferred.length === 0) {
    // Every currently-deferred finding is already linked to the PR's
    // follow-up issue — a pure retry. No gh call at all.
    for (const f of deferred) f.followUpIssueNumber = priorIssueNumber;
    return;
  }
  const entries = (newlyDeferred.length > 0 ? newlyDeferred : deferred).map((f) => ({
    fingerprint: f.fingerprint,
    severity: f.severity,
    angle: f.angle,
    summary: f.summary,
  }));
  const { issueNumber } = await ensureFollowUpIssue(
    { repo, pr, entries, existingIssueNumber: priorIssueNumber },
    deps,
  );
  for (const f of deferred) f.followUpIssueNumber = issueNumber;
}

/**
 * Read + parse a JSON artifact from disk, failing closed with an actionable
 * message. Shared by the spec-file and spec-authority-verdict loads.
 */
async function readJsonArtifact(artifactPath, label, parseErr) {
  let raw;
  try {
    raw = await readFile(artifactPath, "utf8");
  } catch (error) {
    throw parseErr(`Cannot read ${label} "${artifactPath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw parseErr(`${label} "${artifactPath}" must contain valid JSON`);
  }
}

/**
 * Enforce the immutable spec-authority gate when --spec-file is supplied.
 *
 * Derives the two revision identities on the LIVE path via buildRevisionIdentity
 * (so SPEC-AUTHORITY-REVISION-IDENTITIES' collision/derivation checks actually
 * run for a real gate, not only in unit tests): specDigest from the normalized
 * spec, plus the reviewed headSha + contentDigest. Then validates the judge's
 * whole-spec authority verdict against those identities, the finding count, and
 * the complete criterion set.
 *
 * Returns the resolved outcomes so the caller can ENFORCE them on the fixer act
 * list (a finding_conflicts finding is dropped — it cannot authorize a fix) and
 * fail closed on a spec_cannot_decide (human-spec-decision state). When
 * --prior-approvals is supplied, computes resolveCriterionInvalidation against
 * the prior clean round's approval record so a changed revision stales the
 * right approvals (a new specDigest stales all; a fixer push stales affected
 * criteria, carrying an unaffected one forward only with positive proof). The
 * new approval record is persisted durably to --approvals-out for re-entry.
 *
 * @returns {{ specDigest: string, headSha: string, contentDigest: string,
 *   outcomeCounts: Record<string, number>, humanDecisionRequired: boolean,
 *   humanDecisionIndices: number[], findingConflictIndices: number[],
 *   approvedCriteria: string[], invalidation: object|null } | null}
 */
async function enforceSpecAuthority(options, findings, resolvedRoot) {
  if (options.specFile === undefined) return null;
  const spec = await readJsonArtifact(path.resolve(resolvedRoot, options.specFile), "--spec-file", parseError);
  let identity;
  let criterionIds;
  try {
    // buildRevisionIdentity computes specDigest from the normalized spec AND
    // enforces the distinct-identity / not-derived-from-headSha invariants on
    // this live call, not only in the unit test.
    identity = buildRevisionIdentity({
      spec,
      headSha: options.headSha,
      contentDigest: options.contentDigest,
    });
    criterionIds = specCriterionIds(spec);
  } catch (error) {
    throw parseError(`--spec-file / revision identities invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { specDigest, headSha, contentDigest } = identity;
  const verdict = await readJsonArtifact(
    path.resolve(resolvedRoot, options.specAuthorityVerdict),
    "--spec-authority-verdict",
    parseError,
  );
  let validated;
  try {
    validated = validateSpecAuthorityVerdict(verdict, { findingsCount: findings.length, criterionIds });
  } catch (error) {
    throw new Error(`spec-authority verdict failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (validated.specDigest !== specDigest) {
    throw new Error(
      `spec-authority verdict.specDigest ${JSON.stringify(validated.specDigest)} does not match the current spec digest ${JSON.stringify(specDigest)} — re-judge against the current spec (fail closed)`,
    );
  }
  if (validated.headSha !== headSha) {
    throw new Error(
      `spec-authority verdict.headSha ${JSON.stringify(validated.headSha)} does not match current head ${JSON.stringify(headSha)} — re-judge at the current head (fail closed)`,
    );
  }
  if (validated.contentDigest !== contentDigest) {
    throw new Error(
      `spec-authority verdict.contentDigest ${JSON.stringify(validated.contentDigest)} does not match --content-digest ${JSON.stringify(contentDigest)} (fail closed)`,
    );
  }

  const indicesFor = (outcome) => validated.decisions.filter((d) => d.outcome === outcome).map((d) => d.index);
  const findingConflictIndices = indicesFor(SPEC_AUTHORITY_OUTCOMES.FINDING_CONFLICTS);
  const remediationConflictIndices = indicesFor(SPEC_AUTHORITY_OUTCOMES.REMEDIATION_CONFLICTS);

  // Criterion-scoped invalidation across re-entry: when a prior clean round's
  // approval record is supplied, resolve which approvals survive this revision.
  let invalidation = null;
  let criterionCoverageUsed;
  if (options.priorApprovals !== undefined) {
    const prior = await readJsonArtifact(path.resolve(resolvedRoot, options.priorApprovals), "--prior-approvals", parseError);
    // Fail closed on a malformed durable record — a non-array approvedCriteria
    // must not silently degrade to a no-op invalidation.
    if (!Array.isArray(prior?.approvedCriteria)) {
      throw new Error("--prior-approvals record is malformed: approvedCriteria must be an array (fail closed)");
    }
    let carryForwardProof = {};
    if (options.carryForwardProof !== undefined) {
      carryForwardProof = await readJsonArtifact(path.resolve(resolvedRoot, options.carryForwardProof), "--carry-forward-proof", parseError);
    }
    // AC7 (issue 2008 / ADR 0061): when the changed-content->criteria producer's
    // inputs are BOTH supplied, use it to narrow affectedCriteria instead of the
    // all-stale fallback. An UNCERTAIN result (some changed path matched no
    // criterion's coverage) still fails closed to all-stale, but now against the
    // FULL prior-approved set rather than an unconditional empty array — a
    // strict improvement, never a loosening (ADR 0061 decision 4).
    let affectedCriteria = [];
    if (options.changedPaths !== undefined && options.coverageMap !== undefined) {
      const changedPaths = await readJsonArtifact(path.resolve(resolvedRoot, options.changedPaths), "--changed-paths", parseError);
      const coverageMap = await readJsonArtifact(path.resolve(resolvedRoot, options.coverageMap), "--coverage-map", parseError);
      let resolved;
      try {
        resolved = resolveAffectedCriteria({ changedPaths, criterionCoverage: coverageMap });
      } catch (error) {
        throw new Error(`spec-authority affected-criteria resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      affectedCriteria = resolved.uncertain ? [...prior.approvedCriteria] : resolved.affectedCriteria;
      criterionCoverageUsed = coverageMap;
    }
    try {
      invalidation = resolveCriterionInvalidation({
        priorSpecDigest: prior.specDigest,
        currentSpecDigest: specDigest,
        priorApprovedCriteria: prior.approvedCriteria,
        affectedCriteria,
        carryForwardProof,
      });
    } catch (error) {
      throw new Error(`spec-authority criterion invalidation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // AC6 (issue 2008 / ADR 0061): durable provenance the approval record must
  // ALSO persist — the human-decision requirement in its own named shape, and
  // the chosen (authorized) remedy for every valid_compliant decision — derived
  // straight from the validated whole-spec verdict so writeApprovalsRecord
  // never re-derives it independently.
  const humanDecision = {
    required: validated.humanDecisionRequired,
    indices: validated.humanDecisionIndices,
    reason: validated.humanDecisionRequired
      ? validated.decisions.filter((d) => d.requiresHumanDecision).map((d) => d.rationale).join("; ")
      : null,
  };
  const authorizedRemediations = validated.decisions
    .filter((d) => d.outcome === SPEC_AUTHORITY_OUTCOMES.VALID_COMPLIANT)
    .map((d) => ({ index: d.index, checkedCriteria: d.checkedCriteria, authorizedRemediation: d.authorizedRemediation }));

  return {
    specDigest,
    headSha,
    contentDigest,
    criterionIds,
    outcomeCounts: validated.outcomeCounts,
    humanDecisionRequired: validated.humanDecisionRequired,
    humanDecisionIndices: validated.humanDecisionIndices,
    findingConflictIndices,
    remediationConflictIndices,
    invalidation,
    humanDecision,
    authorizedRemediations,
    ...(criterionCoverageUsed !== undefined ? { criterionCoverage: criterionCoverageUsed } : {}),
  };
}

/**
 * Persist the durable, re-entry-safe approval record. Written only after the
 * act list is finalized, so `approvedCriteria` reflects a genuinely clean round:
 * the whole checked criterion set is approved ONLY when no act findings remain
 * (a round with open work approves nothing). A fresh process reconstructs the
 * revision identities, the approved criterion set, and the invalidation result
 * without prompt memory.
 */
async function writeApprovalsRecord(approvalsPath, specAuthority, roundClean) {
  const approvedCriteria = roundClean ? specAuthority.criterionIds : [];
  await mkdir(path.dirname(approvalsPath), { recursive: true });
  await writeFile(
    approvalsPath,
    JSON.stringify(
      {
        specDigest: specAuthority.specDigest,
        headSha: specAuthority.headSha,
        contentDigest: specAuthority.contentDigest,
        approvedCriteria,
        invalidation: specAuthority.invalidation,
        // AC6 (issue 2008 / ADR 0061): provenance + the chosen compliant remedy,
        // so a fresh process reconstructs why the round did/did not need a human
        // spec decision and what remedy each valid_compliant finding authorized,
        // without prompt memory.
        humanDecision: specAuthority.humanDecision,
        authorizedRemediations: specAuthority.authorizedRemediations,
        // The coverage map used THIS round (when the AC7 producer was supplied).
        // This is a durable audit / re-entry-reconstruction record only: judge-pass
        // does NOT read prior.criterionCoverage back in. A re-entry round MUST still
        // pass --coverage-map explicitly for changed-paths narrowing to engage;
        // without it, the round fails closed to the all-stale fallback.
        ...(specAuthority.criterionCoverage !== undefined ? { criterionCoverage: specAuthority.criterionCoverage } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  return approvedCriteria;
}

export async function judgePassCli(
  options,
  { repoRoot = process.cwd(), env = process.env, ghCommand = "gh", run, createIssue, commentIssue, listIssues } = {},
) {
  const resolvedRoot = options.repoRoot ? path.resolve(repoRoot, options.repoRoot) : repoRoot;
  const { findings, overallVerdict } = await resolvePayload(options, resolvedRoot);
  const judgeVerdict = await readJsonArtifact(
    path.resolve(resolvedRoot, options.judgeVerdict),
    "--judge-verdict",
    parseError,
  );
  const result = runJudgePass(findings, judgeVerdict, options.headSha);

  // Immutable spec-authority gate (opt-in via --spec-file). A spec_cannot_decide
  // outcome fails closed here so the loop stops at the human-spec-decision state
  // and never writes an act list from an undecidable spec.
  const specAuthority = await enforceSpecAuthority(options, findings, resolvedRoot);
  if (specAuthority && specAuthority.humanDecisionRequired) {
    return {
      ok: false,
      humanDecisionRequired: true,
      gate: options.gate,
      repo: options.repo,
      pr: Number(options.pr),
      headSha: result.headSha,
      specAuthority,
      reason: `SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT: the pass is blocked and cannot emit an act list — ${specAuthority.humanDecisionIndices.length} finding(s) need a human spec decision (indexes: ${specAuthority.humanDecisionIndices.join(", ")}); stop at the human-spec-decision state`,
    };
  }

  // Spec-authority outcomes ENFORCE against the act list, not just record it:
  //  - `finding_conflicts`: the finding conflicts with the spec and is rejected
  //    regardless of its relevance disposition (act OR defer) — it must neither
  //    reach the fixer nor spawn a follow-up issue merely by existing.
  //  - `remediation_conflicts`: the finding is valid and stays actionable, but
  //    its PROPOSED remedy is rejected — the act entry is flagged so the fixer
  //    routes to a spec-compliant alternative instead of applying it as written.
  if (specAuthority) {
    const rejected = new Set(specAuthority.findingConflictIndices);
    const remedyRejected = new Set(specAuthority.remediationConflictIndices);
    for (const [i, f] of result.enriched.entries()) {
      if (rejected.has(i) && f.judgeDisposition !== "reject") {
        f.judgeRationale = `spec-authority finding_conflicts: rejected against the spec (was relevance-${f.judgeDisposition}) — ${f.judgeRationale ?? ""}`.trim();
        f.judgeDisposition = "reject";
      }
      if (remedyRejected.has(i)) {
        f.remediationRejected = true;
        f.judgeRationale = `spec-authority remediation_conflicts: finding valid, proposed remedy rejected — route to a spec-compliant alternative. ${f.judgeRationale ?? ""}`.trim();
      }
    }
    result.act = result.enriched.filter((f) => f.judgeDisposition === "act");
    result.counts = countByDisposition(result.enriched);
  }

  // Persist the durable approval record AFTER the act list is finalized, so a
  // round with remaining act findings approves nothing (re-entry stays honest).
  if (specAuthority && options.approvalsOut) {
    specAuthority.approvedCriteria = await writeApprovalsRecord(
      path.resolve(resolvedRoot, options.approvalsOut),
      specAuthority,
      result.act.length === 0,
    );
  }

  // #1807: a `defer` disposition always tracks a GitHub issue — never only the
  // ephemeral tmp ledger. One issue per PR, batched; idempotent across re-runs
  // via the prior --ledger-out artifact this run is about to overwrite.
  await applyFollowUpIssues(
    result.enriched,
    { repo: options.repo, pr: Number(options.pr), ledgerOutPath: options.ledgerOut ? path.resolve(resolvedRoot, options.ledgerOut) : null },
    { env, ghCommand, run, createIssue, commentIssue, listIssues },
  );

  // AC1 (issue 2008 / ADR 0061): when spec-authority is engaged, both the
  // enriched ledger and the fixer act list carry the pinned revision identity +
  // the whole checked criterion set, via the ONE shared stamp helper — never
  // recomputed per writer. A no-op (byte-identical to before) when
  // spec-authority is not engaged (no --spec-file).
  const specAuthorityIdentity = specAuthority
    ? {
        specDigest: specAuthority.specDigest,
        headSha: specAuthority.headSha,
        contentDigest: specAuthority.contentDigest,
        checkedCriteria: specAuthority.criterionIds,
      }
    : undefined;

  const written = new Set();
  if (options.ledgerOut) {
    const ledgerPath = path.resolve(resolvedRoot, options.ledgerOut);
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const ledgerRecord = { overallVerdict, findings: result.enriched, scopeDrift: result.scopeDrift };
    await writeFile(
      ledgerPath,
      JSON.stringify(
        specAuthorityIdentity ? stampSpecAuthorityIdentity(ledgerRecord, specAuthorityIdentity) : ledgerRecord,
        null,
        2,
      ) + "\n",
    );
    written.add(ledgerPath);
  }
  if (options.out) {
    const outPath = path.resolve(resolvedRoot, options.out);
    if (!written.has(outPath)) {
      await mkdir(path.dirname(outPath), { recursive: true });
      // ALWAYS a bare act-list array (byte-identical to before spec-authority
      // was introduced), spec-authority engaged or not: the fix pass consumes
      // ONLY --out's act list (skills/dev-loop/SKILL.md, gate-review-sub-loop
      // -contract.md). AC1's durable fixer-facing record of the pinned
      // revision identity is carried by the STAMPED --ledger-out above, never
      // by --out.
      await writeFile(outPath, JSON.stringify(result.act, null, 2) + "\n");
    }
  }

  const payload = {
    ok: true,
    gate: options.gate,
    repo: options.repo,
    pr: Number(options.pr),
    headSha: result.headSha,
    scopeDrift: result.scopeDrift,
    counts: result.counts,
    actCount: result.counts.act,
    act: result.act,
    ledgerOut: options.ledgerOut || undefined,
    out: options.out || undefined,
    specAuthority: specAuthority || undefined,
  };
  return payload;
}

function main() {
  let opts;
  try {
    opts = parseJudgePassCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    if (err && err.usage) process.stderr.write(`\n${err.usage}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  judgePassCli(opts)
    .then((payload) => {
      process.exitCode = emitResult(payload, { jq: opts.jq, silent: opts.silent });
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}

const isDirectRun =
  process.argv[1] && process.argv[1].endsWith(path.sep + "judge-pass.mjs");
if (isDirectRun) {
  main();
}
