/**
 * Shared cross-harness spec-authority scenarios (issue 2008 / ADR-0061 AC11).
 *
 * spec-authority.mjs is pure and never reads a harness adapter — the whole
 * point of AC11 is to make that parity-by-construction explicit and
 * regression-pinned, not just implicit. Each scenario here is run once per
 * harness adapter (Pi / Claude Code / Codex); `runScenario` deliberately
 * calls the adapter's identity methods (proving a REAL, distinct harness
 * object drove the run) but never feeds anything the adapter returns into the
 * spec-authority decision itself. The cross-harness test asserts the outputs
 * are byte-identical across all three.
 */
import { createNoopAdapter } from "../../../src/harness/noop-adapter.mjs";
import { createPiAdapter } from "../../../src/harness/pi-adapter.mjs";
import {
  buildRevisionIdentity,
  computeSpecDigest,
  resolveAffectedCriteria,
  resolveCriterionInvalidation,
  specCriterionIds,
  SPEC_AUTHORITY_OUTCOMES,
  validateSpecAuthorityVerdict,
} from "../../../src/loop/spec-authority.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const SPEC = {
  acceptanceCriteria: ["Remove repetitive A/B contrast scaffolding", "Ship a working demo"],
  definitionOfDone: ["npm run verify passes"],
  nonGoals: ["Do not flatten the decks' voice or product identity"],
};

// Today only Pi has a dedicated concrete adapter (packages/core/src/harness/
// pi-adapter.mjs's own doc: "the only active adapter ... future harnesses
// (Claude, etc.) can implement the same interface without changing call
// sites"). Claude Code and Codex route through the generic noop/batch adapter
// with a distinct env stamp — real, distinct HarnessAdapter objects, not
// fakes, satisfying the "per-harness fixture" requirement without inventing
// adapters this repo does not ship.
export const HARNESSES = Object.freeze({
  pi: () => createPiAdapter({ cwd: "/repo", env: { HARNESS: "pi" } }),
  claudeCode: () => createNoopAdapter({ cwd: "/repo", env: { HARNESS: "claude-code" } }),
  codex: () => createNoopAdapter({ cwd: "/repo", env: { HARNESS: "codex" } }),
});

export const SCENARIO_NAMES = Object.freeze([
  "valid_compliant_authorize",
  "finding_conflicts_reject",
  "remediation_conflicts_route",
  "spec_cannot_decide_escalate",
  "spec_change_invalidation",
  "fixer_push_criterion_invalidation",
  "durable_reentry_reconstruction",
]);

function touchAdapterIdentity(adapter) {
  // Exercise every required HarnessAdapter method so a real, complete adapter
  // backed this run — never fed into the pure decision below.
  void adapter.getCwd();
  void adapter.getEnv();
  void adapter.isInteractive();
  void adapter.isInsidePi();
  void adapter.getRepoRoot();
}

function baseIdentity(content = "reviewed-impl") {
  return buildRevisionIdentity({ spec: SPEC, headSha: HEAD_A, content });
}

function wholeSpecDecision(overrides = {}) {
  const id = baseIdentity();
  return {
    index: 0,
    ...id,
    outcome: SPEC_AUTHORITY_OUTCOMES.VALID_COMPLIANT,
    checkedCriteria: specCriterionIds(SPEC),
    rationale: "evaluated against the whole spec",
    authorizedRemediation: "apply the compliant fix",
    ...overrides,
  };
}

/**
 * Run one named scenario. `adapter` is a real HarnessAdapter (touched for
 * identity, never for decision data) — the return value must be identical
 * regardless of which harness ran it.
 * @param {string} name
 * @param {import("../../../src/harness/adapter.mjs").HarnessAdapter} adapter
 * @returns {object}
 */
export function runScenario(name, adapter) {
  touchAdapterIdentity(adapter);
  switch (name) {
    case "valid_compliant_authorize": {
      const id = baseIdentity();
      const decision = wholeSpecDecision();
      const out = validateSpecAuthorityVerdict(
        { ...id, decisions: [decision] },
        { findingsCount: 1, criterionIds: specCriterionIds(SPEC) },
      );
      return { specDigest: out.specDigest, humanDecisionRequired: out.humanDecisionRequired, outcomeCounts: out.outcomeCounts, decisions: out.decisions };
    }
    case "finding_conflicts_reject": {
      const id = baseIdentity();
      const decision = wholeSpecDecision({
        outcome: SPEC_AUTHORITY_OUTCOMES.FINDING_CONFLICTS,
        conflictingCriteria: ["ng:0"],
        authorizedRemediation: undefined,
        rationale: "the finding demands flattening the deck voice, which the non-goal forbids",
      });
      const out = validateSpecAuthorityVerdict(
        { ...id, decisions: [decision] },
        { findingsCount: 1, criterionIds: specCriterionIds(SPEC) },
      );
      return { specDigest: out.specDigest, humanDecisionRequired: out.humanDecisionRequired, outcomeCounts: out.outcomeCounts, decisions: out.decisions };
    }
    case "remediation_conflicts_route": {
      const id = baseIdentity();
      const decision = wholeSpecDecision({
        outcome: SPEC_AUTHORITY_OUTCOMES.REMEDIATION_CONFLICTS,
        conflictingCriteria: ["ng:0"],
        authorizedRemediation: undefined,
        rationale: "repetition is real but the proposed rewrite flattens voice — route to a voice-preserving dedup",
        rejectedRemediations: ["delete all contrast framing"],
      });
      const out = validateSpecAuthorityVerdict(
        { ...id, decisions: [decision] },
        { findingsCount: 1, criterionIds: specCriterionIds(SPEC) },
      );
      return { specDigest: out.specDigest, humanDecisionRequired: out.humanDecisionRequired, outcomeCounts: out.outcomeCounts, decisions: out.decisions };
    }
    case "spec_cannot_decide_escalate": {
      const contradictory = {
        acceptanceCriteria: ["Delete every contrast sentence", "Keep every contrast sentence verbatim"],
        definitionOfDone: ["ship"],
        nonGoals: ["change nothing"],
      };
      const id = buildRevisionIdentity({ spec: contradictory, headSha: HEAD_A, content: "impl" });
      const decision = {
        ...id,
        index: 0,
        outcome: SPEC_AUTHORITY_OUTCOMES.SPEC_CANNOT_DECIDE,
        checkedCriteria: specCriterionIds(contradictory),
        rationale: "ac:0 and ac:1 are mutually exclusive; compliant action is undecidable without a human spec decision",
      };
      const out = validateSpecAuthorityVerdict(
        { ...id, decisions: [decision] },
        { findingsCount: 1, criterionIds: specCriterionIds(contradictory) },
      );
      return { specDigest: out.specDigest, humanDecisionRequired: out.humanDecisionRequired, humanDecisionIndices: out.humanDecisionIndices, outcomeCounts: out.outcomeCounts };
    }
    case "spec_change_invalidation": {
      const priorDigest = computeSpecDigest(SPEC);
      const newDigest = computeSpecDigest({ ...SPEC, acceptanceCriteria: [...SPEC.acceptanceCriteria, "extra"] });
      const out = resolveCriterionInvalidation({
        priorSpecDigest: priorDigest,
        currentSpecDigest: newDigest,
        priorApprovedCriteria: specCriterionIds(SPEC),
      });
      return out;
    }
    case "fixer_push_criterion_invalidation": {
      const digest = computeSpecDigest(SPEC);
      const affected = resolveAffectedCriteria({
        changedPaths: ["src/dedup.mjs"],
        criterionCoverage: { "ac:0": ["src/dedup.mjs"], "ac:1": ["src/demo.mjs"] },
      });
      const out = resolveCriterionInvalidation({
        priorSpecDigest: digest,
        currentSpecDigest: digest,
        priorApprovedCriteria: ["ac:0", "ac:1", "dod:0"],
        affectedCriteria: affected.affectedCriteria,
        carryForwardProof: {
          "ac:1": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
          "dod:0": { specTextUnchanged: true, coveredSurfaceUnchanged: true },
        },
      });
      return { affected, invalidation: out };
    }
    case "durable_reentry_reconstruction": {
      // A fresh process reconstructing a prior clean round's durable approval
      // record: identical revision identity + full checked criterion set,
      // with no prompt memory — asserted byte-identical across harnesses.
      const id = baseIdentity();
      const criterionIds = specCriterionIds(SPEC);
      const decision = wholeSpecDecision();
      const verdict = validateSpecAuthorityVerdict(
        { ...id, decisions: [decision] },
        { findingsCount: 1, criterionIds },
      );
      const durableRecord = {
        specDigest: verdict.specDigest,
        headSha: verdict.headSha,
        contentDigest: verdict.contentDigest,
        approvedCriteria: criterionIds,
      };
      // Re-entry at the SAME revision reconstructs the same invalidation result
      // (nothing affected, nothing to prove — spec unchanged, no fixer push).
      const reentry = resolveCriterionInvalidation({
        priorSpecDigest: durableRecord.specDigest,
        currentSpecDigest: durableRecord.specDigest,
        priorApprovedCriteria: durableRecord.approvedCriteria,
      });
      return { durableRecord, reentry };
    }
    default:
      throw new Error(`Unknown spec-authority cross-harness scenario: ${name}`);
  }
}
