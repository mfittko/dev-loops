/**
 * primer-evidence.mjs — primer dispatch ordering evidence + fail-closed fan-in
 * validation (issue #1468 slice 3).
 *
 * Slice 1-2 (review-dispatch-plan.mjs) produced the deterministic request-plan
 * artifact, request-prefix fingerprints, stable/volatile separation, and
 * per-model primer-group partitioning. This slice closes the gap between
 * "the rules say prime before fan-out" and "we can assert it happened": it
 * records evidence that each request group's primer actually landed before any
 * of that group's reviewers were released, and makes fan-in fail closed when
 * that ordering — or the model group / request fingerprint / shared-prefix hash
 * binding — is missing or mismatched.
 *
 * This module is pure and offline (no GitHub, no harness, no clock). It owns:
 *
 *  1. primer-evidence artifact builder — one deterministic per-gate-run record
 *     ('<gate>-<headSha>.primer-evidence.json') pairing the request plan with
 *     the observed primer runs and reviewer releases and deriving the ordering
 *     verdict.
 *  2. fail-closed validator — checks, named individually, that every request
 *     group got its own primer run, that each primer is scoped to its own
 *     model/prefix (never credited to another group), and that every reviewer
 *     release happened after its group's primer landed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- API surface reserved for future harness adapters

export const PRIMER_EVIDENCE_SCHEMA_VERSION = 1;

/** @param {string} s */
const isHex = (s) => /^[0-9a-f]{64}$/i.test(String(s));
const sha = (s) => `sha256:${String(s).replace(/^sha256:/, "").trim().toLowerCase()}`;

/**
 * Deterministic artifact path for a gate run's primer evidence.
 *
 * @param {object} input
 * @param {string} input.dir - directory to write under (e.g. the gate-context dir).
 * @param {string} input.gate - gate name (pre_approval_gate, draft_gate, ...).
 * @param {string} input.headSha - reviewed head SHA (hex, 7-64).
 * @returns {string} absolute-style path joined under `dir`.
 */
export function primerEvidencePath({ dir, gate, headSha } = {}) {
  if (typeof dir !== "string" || dir.length === 0) throw new Error("primerEvidencePath requires a dir");
  if (typeof gate !== "string" || gate.length === 0) throw new Error("primerEvidencePath requires a gate");
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha.trim())) {
    throw new Error("primerEvidencePath requires a hex headSha");
  }
  return path.join(dir, `${gate}-${headSha.trim().toLowerCase()}.primer-evidence.json`);
}

/**
 * Import a plan's request groups into a plain lookup keyed by canonical
 * (model, requestPrefixFingerprint). Fingerprint-less groups are keyed by
 * `model` only (they never collapse, mirroring partitionPrimerGroups).
 *
 * @param {object[]} requestGroups
 * @returns {Map<string, object>}
 */
function planGroupIndex(requestGroups) {
  const idx = new Map();
  for (let i = 0; i < requestGroups.length; i++) {
    const g = requestGroups[i];
    const key = g.requestPrefixFingerprint ? `${g.model}::${g.requestPrefixFingerprint}` : `${g.model}::__unkeyed:${i}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(g);
  }
  return idx;
}

/** Normalize a fingerprint to a canonical `sha256:<hex>` or null. */
function normFp(v) {
  if (v == null) return null;
  return sha(v);
}

/**
 * Build the primer-evidence artifact for a gate run.
 *
 * @param {object} input
 * @param {object} input.plan - the dispatch plan from buildReviewDispatchPlan().
 * @param {Array<object>} input.primerRuns - [{ model, requestPrefixFingerprint, primerForm, landedAt }]
 * @param {Array<object>} input.reviewerReleases - [{ model, requestPrefixFingerprint, releasedAt }]
 * @returns {object} canonical evidence artifact.
 */
export function buildPrimerEvidence({ plan, primerRuns = [], reviewerReleases = [], _now = 0 } = {}) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.requestGroups)) {
    throw new Error("buildPrimerEvidence requires a plan with requestGroups");
  }
  if (!Array.isArray(primerRuns)) throw new Error("primerRuns must be an array");
  if (!Array.isArray(reviewerReleases)) throw new Error("reviewerReleases must be an array");

  const groups = plan.requestGroups;
  const idx = planGroupIndex(groups);

  const normRuns = primerRuns.map((r, i) => {
    if (typeof r.model !== "string" || r.model.length === 0) {
      throw new Error(`primerRuns[${i}].model must be a non-empty concrete model`);
    }
    const fp = normFp(r.requestPrefixFingerprint);
    const key = fp ? `${r.model}::${fp}` : `${r.model}::__unkeyed:${i}`;
    if (!idx.has(key)) {
      throw new Error(
        `primerRuns[${i}] references model ${JSON.stringify(r.model)} with a prefix not present in the plan's request groups`,
      );
    }
    return Object.freeze({
      model: r.model,
      requestPrefixFingerprint: fp,
      primerForm: r.primerForm ?? null,
      landedAt: Number.isFinite(r.landedAt) ? r.landedAt : null,
    });
  });

  const normReleases = reviewerReleases.map((r, i) => {
    return Object.freeze({
      model: r.model,
      requestPrefixFingerprint: normFp(r.requestPrefixFingerprint),
      releasedAt: Number.isFinite(r.releasedAt) ? r.releasedAt : null,
    });
  });

  return Object.freeze({
    schemaVersion: PRIMER_EVIDENCE_SCHEMA_VERSION,
    gate: plan.gate,
    headSha: plan.headSha,
    planHash: plan.planHash,
    sharedPrefixHash: plan.sharedPrefixHash ?? null,
    primerRuns: Object.freeze(normRuns),
    reviewerReleases: Object.freeze(normReleases),
  });
}

/**
 * Fail-closed validation of primer-evidence against the request plan.
 *
 * @param {object} input
 * @param {object} input.plan - dispatch plan.
 * @param {object} input.evidence - artifact from buildPrimerEvidence().
 * @returns {{ ok: boolean, failures: Array<{check: string, reason: string}> }}
 */
export function validatePrimerEvidence({ plan, evidence } = {}) {
  const failures = [];

  // shared-prefix hash binding.
  if (evidence.sharedPrefixHash == null || evidence.sharedPrefixHash !== (plan.sharedPrefixHash ?? null)) {
    failures.push({
      check: "shared_prefix_hash",
      reason: `evidence sharedPrefixHash ${JSON.stringify(evidence.sharedPrefixHash)} does not match the plan's ${JSON.stringify(plan.sharedPrefixHash ?? null)}`,
    });
  }

  // plan hash binding: evidence must reference the same search.
  if (evidence.planHash != null && plan.planHash != null && evidence.planHash !== plan.planHash) {
    failures.push({
      check: "plan_hash",
      reason: `evidence planHash ${JSON.stringify(evidence.planHash)} does not match the plan's ${JSON.stringify(plan.planHash)}`,
    });
  }

  const groups = plan.requestGroups ?? [];
  const idx = planGroupIndex(groups);

  // group coverage: every request group must have a primer run bound to its
  // model + request fingerprint.
  const coveredKeys = new Set(
    evidence.primerRuns.map((r) =>
      r.requestPrefixFingerprint
        ? `${r.model}::${r.requestPrefixFingerprint}`
        : `${r.model}::__unkeyed`,
    ),
  );
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const key = g.requestPrefixFingerprint
      ? `${g.model}::${g.requestPrefixFingerprint}`
      : `${g.model}::__unkeyed`;
    if (!coveredKeys.has(key)) {
      failures.push({
        check: "group_coverage",
        reason: `request group ${i} (model ${JSON.stringify(g.model)}) has no primer run in the evidence`,
      });
    }
  }

  // model-group / request-fingerprint binding per reviewer release.
  for (let i = 0; i < evidence.reviewerReleases.length; i++) {
    const rel = evidence.reviewerReleases[i];
    const key = rel.requestPrefixFingerprint
      ? `${rel.model}::${rel.requestPrefixFingerprint}`
      : `${rel.model}::__unkeyed`;
    if (rel.requestPrefixFingerprint && idx.has(key)) {
      // bound to a known group -> ok
    } else if (rel.requestPrefixFingerprint && !idx.has(key)) {
      failures.push({
        check: "model_group",
        reason: `reviewer release ${i} bound to model ${JSON.stringify(rel.model)} + fingerprint that is not a request group (heterogeneous routing must not credit one model's primer to another)`,
      });
    }
    // ordering: a released reviewer must have a primer landed before it.
    const primerForRel = evidence.primerRuns.find(
      (r) =>
        r.model === rel.model &&
        (rel.requestPrefixFingerprint == null || r.requestPrefixFingerprint === rel.requestPrefixFingerprint),
    );
    if (!primerForRel) {
      failures.push({
        check: "model_group",
        reason: `reviewer release ${i} has no primer run for model ${JSON.stringify(rel.model)}`,
      });
    } else if (Number.isFinite(rel.releasedAt) && Number.isFinite(primerForRel.landedAt) && rel.releasedAt < primerForRel.landedAt) {
      failures.push({
        check: "primer_order",
        reason: `reviewer release ${i} released at ${rel.releasedAt} before its primer landed at ${primerForRel.landedAt} (ordering barrier violated)`,
      });
    }
  }

  // request-fingerprint binding for primer runs that reference a real prefix.
  for (let i = 0; i < evidence.primerRuns.length; i++) {
    const r = evidence.primerRuns[i];
    if (r.requestPrefixFingerprint) {
      const key = `${r.model}::${r.requestPrefixFingerprint}`;
      if (!idx.has(key)) {
        failures.push({
          check: "request_fingerprint",
          reason: `primer run ${i} request-prefix fingerprint not present in the plan's request groups for model ${JSON.stringify(r.model)}`,
        });
      }
    }
  }

  // Drop duplicate entries (same check on the same release).
  const seen = new Set();
  const unique = failures.filter((f) => {
    const key = `${f.check}|${f.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ok: unique.length === 0, failures: unique };
}

/**
 * Strict fail-closed enforcement surface (GATE-EXEC-PRIMER-EVIDENCE): throws
 * when fan-in evidence is missing or invalid, naming the failing check. This is
 * the refusal path a gate conductor calls after validatePrimerEvidence returns
 * ok:false — it turns a reported failure into a hard stop.
 *
 * @param {object} input
 * @param {object} input.plan - dispatch plan.
 * @param {object} input.evidence - artifact from buildPrimerEvidence().
 * @returns {true}
 * @throws {Error} when any primer-evidence check fails.
 */
export function enforcePrimerEvidence({ plan, evidence } = {}) {
  const r = validatePrimerEvidence({ plan, evidence });
  if (!r.ok) {
    throw new Error(
      `GATE-EXEC-PRIMER-EVIDENCE: primer evidence failed validation; refusing to proceed (${r.failures.map((f) => `${f.check}: ${f.reason}`).join("; ")})`,
    );
  }
  return true;
}

/**
 * Persist the evidence artifact to its deterministic path.
 *
 * @param {object} input
 * @param {string} input.dir
 * @param {object} input.evidence
 * @returns {Promise<{ path: string }>}
 */
export async function writePrimerEvidence({ dir, evidence } = {}) {
  const target = primerEvidencePath({
    dir,
    gate: evidence.gate,
    headSha: evidence.headSha,
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { path: target };
}
