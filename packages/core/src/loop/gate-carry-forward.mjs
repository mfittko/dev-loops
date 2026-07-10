/**
 * Gate carry-forward: a pure, fail-closed seam that decides whether a clean gate
 * angle verdict recorded at head A may be CARRIED FORWARD to head B without
 * re-running that angle's reviewer.
 *
 * Motivation: fresh-context-per-head re-fans ALL gate angles on every head bump,
 * even when the delta between the two heads provably cannot affect most angles
 * (e.g. a doc-only follow-up commit cannot change what a code-correctness angle
 * would find). Carry-forward lets the gate reuse the prior clean verdict for such
 * angles — but ONLY when it is provably safe.
 *
 * FAIL-CLOSED is paramount. An angle carries forward ONLY when EVERY changed file
 * in the delta A..B is provably OUTSIDE that angle's declared review surface. The
 * default in every uncertain case (non-clean prior verdict, empty/unavailable
 * delta, an unclassifiable file, an angle with no declared surface, a mandatory /
 * always-run angle) is MUST-RE-RUN. Carry-forward never fabricates a verdict: the
 * caller records the carried verdict with provenance pointing at the PRIOR head's
 * reviewer (that reviewer genuinely reviewed this angle's surface, which the delta
 * did not touch), clearly marked as carried — see
 * docs/gate-review-sub-loop-contract.md and write-gate-findings-log.mjs's
 * `carriedFromHead` provenance field.
 *
 * The angle -> review-surface mapping is DERIVED from the single source of truth
 * for change-category -> angle relevance (CATEGORY_ANGLE_MAP in
 * ../analysis/change-classifier.mjs) so the two never drift: an angle's review
 * surface is exactly the set of file "surface kinds" whose change could, under the
 * existing dynamic-angle rules, implicate that angle. File classification reuses
 * classifyFile() from the diff analyzer (the same classifier dynamic angle
 * resolution already trusts).
 *
 * This module is intentionally pure and side-effect free.
 */

import { classifyFile } from "../analysis/diff-analyzer.mjs";
import { ALWAYS_INCLUDE, CATEGORY_ANGLE_MAP } from "../analysis/change-classifier.mjs";

/**
 * File surface kind (classifyFile output) -> the change categories a change of
 * that kind can produce. A code file can be either a logic change or a
 * comment-only change; the other kinds each map to their single `_ONLY` category.
 * "unknown" is intentionally ABSENT: an unclassifiable file is treated as
 * touching EVERY angle's surface (fail-closed), so it never appears here.
 *
 * RENAME_ONLY is not a file kind — a renamed file still classifies by its
 * destination path's kind, so the destination kind's own categories already
 * implicate the right angles (a renamed code file -> code -> LOGIC_CHANGE, a
 * renamed doc -> docs -> DOCS_ONLY). Folding RENAME_ONLY into every kind would
 * over-attribute code angles to a doc-only delta and defeat the primary
 * carry-forward case, so it is deliberately omitted here. A destination-kind
 * classification alone, though, misses what the RENAME itself implicates (a
 * moved doc can break a link; a moved test/code file shifts scope /
 * contract-surface). Rename detection therefore lives at the DELTA layer: the
 * CLI notices any rename/copy row and forces {@link RENAME_ONLY_ANGLES} to
 * re-run for that run (fail-closed), instead of encoding a phantom "rename" file
 * kind here.
 *
 * @type {Record<string, string[]>}
 */
const KIND_TO_CATEGORIES = {
  docs: ["DOCS_ONLY"],
  config: ["CONFIG_ONLY"],
  test: ["TEST_ONLY"],
  ci: ["CI_ONLY"],
  code: ["LOGIC_CHANGE", "COMMENT_ONLY"],
};

/**
 * The angles a pure rename implicates (CATEGORY_ANGLE_MAP[RENAME_ONLY]), minus
 * any always-run angle (already never carried). A delta containing ANY rename
 * forces these to re-run — a rename's effect (moved doc breaking a link, moved
 * test/code shifting scope/contract-surface) is not captured by classifying the
 * destination path alone. Derived from the single source of truth so it never
 * drifts from the dynamic-angle rules.
 *
 * @type {string[]}
 */
export const RENAME_ONLY_ANGLES = (CATEGORY_ANGLE_MAP.RENAME_ONLY ?? []).filter(
  (angle) => !ALWAYS_INCLUDE.has(angle),
);

/**
 * angle -> Set<surface kind>: an angle's review surface is the set of file kinds
 * whose change could implicate it, inverted from CATEGORY_ANGLE_MAP via
 * KIND_TO_CATEGORIES. Built once at module load. ALWAYS_INCLUDE angles are NOT
 * given a kinds surface here — they always re-run (handled in angleReviewSurface).
 *
 * @type {Map<string, Set<string>>}
 */
const ANGLE_SURFACE_KINDS = (() => {
  const map = new Map();
  for (const [kind, categories] of Object.entries(KIND_TO_CATEGORIES)) {
    for (const category of categories) {
      for (const angle of CATEGORY_ANGLE_MAP[category] ?? []) {
        if (ALWAYS_INCLUDE.has(angle)) continue;
        if (!map.has(angle)) map.set(angle, new Set());
        map.get(angle).add(kind);
      }
    }
  }
  return map;
})();

/**
 * @typedef {{ kind: "always" }
 *   | { kind: "unknown" }
 *   | { kind: "kinds", kinds: Set<string> }} AngleReviewSurface
 */

/**
 * Resolve an angle's declared review surface (the pure angle -> surface mapping).
 *
 * - ALWAYS_INCLUDE angles (gate-evidence, renderer-security, pr-description) plus
 *   any explicit alwaysRerun angle -> `{ kind: "always" }`. These review a surface
 *   we cannot fully bound from the file delta alone (e.g. pr-description also
 *   depends on the PR body, which is not a changed FILE), so they NEVER carry
 *   forward.
 * - A mapped angle -> `{ kind: "kinds", kinds }` (the file kinds that implicate it).
 * - An unmapped / unknown angle -> `{ kind: "unknown" }` (fail-closed: never carry).
 *
 * @param {string} angle
 * @param {{ alwaysRerun?: Iterable<string> }} [options]
 * @returns {AngleReviewSurface}
 */
export function angleReviewSurface(angle, { alwaysRerun } = {}) {
  const name = typeof angle === "string" ? angle.trim() : "";
  if (name.length === 0) return { kind: "unknown" };
  if (ALWAYS_INCLUDE.has(name)) return { kind: "always" };
  if (alwaysRerun && new Set(alwaysRerun).has(name)) return { kind: "always" };
  const kinds = ANGLE_SURFACE_KINDS.get(name);
  if (!kinds || kinds.size === 0) return { kind: "unknown" };
  return { kind: "kinds", kinds: new Set(kinds) };
}

/**
 * Pure, deterministic, FAIL-CLOSED carry-forward decision for a single angle.
 *
 * Given a prior CLEAN verdict recorded at head A, the changed files of the delta
 * A..B, and the angle's declared review surface, decide whether the clean verdict
 * may be carried forward to head B (carryForward: true) or the angle MUST re-run
 * (carryForward: false). Defaults to must-re-run in every uncertain case.
 *
 * @param {object} input
 * @param {string} input.angle
 * @param {AngleReviewSurface} [input.angleSurface] — the angle's declared surface;
 *   derived from {@link angleReviewSurface} when omitted.
 * @param {string[]} input.changedFiles — repo-relative paths changed between head
 *   A and head B (the delta, NOT the full PR diff against base).
 * @param {string} input.prevVerdict — the angle's verdict at head A. Only "clean"
 *   is carry-forward-eligible.
 * @returns {{ carryForward: boolean, reason: string }}
 */
export function resolveAngleCarryForward({ angle, angleSurface, changedFiles, prevVerdict }) {
  if (prevVerdict !== "clean") {
    return { carryForward: false, reason: `prior verdict is ${JSON.stringify(prevVerdict ?? null)}, not "clean"` };
  }
  const surface = angleSurface ?? angleReviewSurface(angle);
  if (surface.kind === "always") {
    return { carryForward: false, reason: "angle always re-runs (mandatory / always-include surface)" };
  }
  if (surface.kind === "unknown") {
    return { carryForward: false, reason: "angle has no declared review surface (fail-closed)" };
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { carryForward: false, reason: "delta is empty or unavailable (fail-closed)" };
  }
  for (const file of changedFiles) {
    const kind = classifyFile(file);
    if (kind === "unknown") {
      return { carryForward: false, reason: `delta contains an unclassifiable file (fail-closed): ${file}` };
    }
    if (surface.kinds.has(kind)) {
      return { carryForward: false, reason: `delta touches the angle's review surface (${kind}): ${file}` };
    }
  }
  return {
    carryForward: true,
    reason: `delta is provably outside the angle's review surface (surface kinds: ${[...surface.kinds].sort().join(", ")})`,
  };
}

/**
 * Convenience: partition a set of previously-clean angles into those that may be
 * carried forward and those that must re-run, given the delta A..B. Each entry
 * carries the decision reason. Non-clean angles are not carry-forward-eligible and
 * belong in the re-run set — callers should pass only angles whose prior verdict
 * was clean, or set `prevVerdict` per angle via the single-angle function.
 *
 * @param {object} input
 * @param {string[]} input.prevAngles — angles that were clean at head A
 * @param {string[]} input.changedFiles — delta A..B
 * @param {{ alwaysRerun?: Iterable<string> }} [input.options]
 * @returns {{ carried: Array<{ angle: string, reason: string }>, mustRerun: Array<{ angle: string, reason: string }> }}
 */
export function resolveCarryForwardAngles({ prevAngles, changedFiles, options = {} }) {
  const carried = [];
  const mustRerun = [];
  for (const angle of Array.isArray(prevAngles) ? prevAngles : []) {
    const decision = resolveAngleCarryForward({
      angle,
      angleSurface: angleReviewSurface(angle, options),
      changedFiles,
      prevVerdict: "clean",
    });
    (decision.carryForward ? carried : mustRerun).push({ angle, reason: decision.reason });
  }
  return { carried, mustRerun };
}

/**
 * The file surface kinds the external Copilot code review actually reviews. Docs
 * and comment-only prose are NOT part of it; everything a Copilot review could
 * legitimately raise a code nit about is (code, tests, config, CI).
 * @type {Set<string>}
 */
const COPILOT_REVIEW_SURFACE_KINDS = new Set(["code", "test", "config", "ci"]);

/**
 * AC2, fail-closed: decide whether a post-convergence head bump may carry forward
 * a settled clean Copilot convergence instead of forcing a fresh BLOCKING Copilot
 * round. Carries forward ONLY when the delta since the converged head is provably
 * outside Copilot's review surface — a pure doc/prose-only bump (every changed
 * file classifies as `docs`; a code comment-only change classifies as `code` and
 * re-runs, since classifyFile is path-based). Any code/test/config/CI file, an unclassifiable
 * file, or an empty/unavailable delta -> re-run (fresh blocking round required).
 *
 * @param {object} input
 * @param {string[]} input.changedFiles — delta since the converged head
 * @returns {{ carryForward: boolean, reason: string }}
 */
export function resolveConvergenceCarryForward({ changedFiles }) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { carryForward: false, reason: "delta is empty or unavailable (fail-closed)" };
  }
  for (const file of changedFiles) {
    const kind = classifyFile(file);
    if (kind === "unknown") {
      return { carryForward: false, reason: `delta contains an unclassifiable file (fail-closed): ${file}` };
    }
    if (COPILOT_REVIEW_SURFACE_KINDS.has(kind)) {
      return { carryForward: false, reason: `delta touches Copilot's review surface (${kind}): ${file}` };
    }
  }
  return { carryForward: true, reason: "delta is a pure doc/prose bump, provably outside Copilot's review surface" };
}
