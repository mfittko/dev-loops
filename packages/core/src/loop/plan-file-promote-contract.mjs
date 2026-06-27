/**
 * Local-planning plan-file PR-FIRST promotion (P4).
 *
 * This is the P4 promotion step. A plan refined to the
 * `plan_refined_ready_for_promotion` state (P3 refinement produces it; P2
 * defines the intake-state machine) is the spec-of-record. Promotion
 * commits that plan doc and opens EXACTLY ONE draft PR — it never mints a
 * GitHub issue. The PR body links the committed plan doc path and carries the
 * full Acceptance criteria + Definition of done so the PR is a self-contained
 * spec-of-record that can enter the existing PR-followup loop unchanged
 * (`loop startup --pr <n>`), with no new lifecycle state and no issue.
 *
 * This module is pure: it decides promote-eligibility, parses/serializes the
 * plan↔PR link (a minimal YAML front-matter block), and builds the PR body
 * text. It performs no GitHub mutation, no network calls, and no filesystem
 * I/O. The CLI owns ALL I/O (read plan file, git add/commit/branch, call
 * create-pr.mjs, write the PR number back). That keeps the
 * no-issue-mint / zero-pre-promotion-mutation guarantee structural here: there
 * is no gh/network surface to reach from this module.
 *
 * It composes the already-shipped P2 intake-state machine: promotion is only
 * eligible from `plan_refined_ready_for_promotion` (the state P3 refinement
 * produces).
 */

import {
  evaluatePlanFileIntakeState,
  PLAN_FILE_INTAKE_STATE,
} from "./plan-file-intake-contract.mjs";

/** Promotion actions the eligibility decision can return. */
export const PLAN_FILE_PROMOTE_ACTION = Object.freeze({
  /** Eligible: commit the plan doc and open exactly one draft PR. */
  PROMOTE: "promote",
  /** Already linked to an open PR; idempotent no-op (report the existing PR). */
  ALREADY_PROMOTED: "already_promoted",
});

/**
 * Front-matter key that records the opened PR number on the plan doc, forming
 * the plan→PR half of the bidirectional link (the PR body carries the doc path,
 * the PR→plan half).
 */
export const PLAN_FILE_PR_FRONT_MATTER_KEY = "prNumber";

/**
 * Minimal additive front-matter support for plan files (an escalated extension
 * to P1's format): a leading `---\n...\n---\n` block of simple `key: value`
 * lines. Plans without a leading `---` are returned with an empty front-matter
 * object and the full text as the body, so existing front-matter-free plans are
 * never broken.
 *
 * ponytail: a flat scalar `key: value` parser, not a YAML engine. The only
 * front-matter this contract reads/writes is `prNumber:` (an integer); upgrade
 * to the `yaml` dep already in @dev-loops/core if richer front-matter is needed.
 *
 * @param {string} markdownText
 * @returns {{ frontMatter: Record<string, string>, body: string }}
 */
export function parsePlanFrontMatter(markdownText) {
  const text = typeof markdownText === "string" ? markdownText : "";
  // The opening fence must be the very first line.
  const fenceMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!fenceMatch || fenceMatch.index !== 0) {
    return { frontMatter: {}, body: text };
  }
  const block = fenceMatch[1];
  const body = text.slice(fenceMatch[0].length);
  const frontMatter = {};
  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (key.length === 0) continue;
    // Plan content is untrusted: never let prototype-pollution keys through.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    frontMatter[key] = line.slice(sep + 1).trim();
  }
  return { frontMatter, body };
}

/**
 * Read the linked PR number from a plan's front-matter. Returns a positive
 * integer when present and valid, otherwise null.
 *
 * @param {string} markdownText
 * @returns {number | null}
 */
export function readLinkedPrNumber(markdownText) {
  const { frontMatter } = parsePlanFrontMatter(markdownText);
  const raw = frontMatter[PLAN_FILE_PR_FRONT_MATTER_KEY];
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!/^\d+$/u.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Serialize a plan back to text with the given PR number recorded in
 * front-matter (the plan→PR link). Preserves an existing leading front-matter
 * block's other keys and sets/replaces `prNumber`; adds a fresh block to a plan
 * that had none. Idempotent: re-serializing with the same number reproduces the
 * same text.
 *
 * @param {string} markdownText  current plan text (with or without front-matter)
 * @param {number} prNumber  positive integer PR number to record
 * @returns {string}
 */
export function writeLinkedPrNumber(markdownText, prNumber) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("writeLinkedPrNumber requires a positive integer prNumber");
  }
  const { frontMatter, body } = parsePlanFrontMatter(markdownText);
  const merged = { ...frontMatter, [PLAN_FILE_PR_FRONT_MATTER_KEY]: String(prNumber) };
  const lines = Object.entries(merged).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * Pure promote-eligibility decision.
 *
 * Fail-closed: promotion is eligible ONLY from the
 * `plan_refined_ready_for_promotion` state (produced by P3 refinement). Any other intake state returns
 * `ok: false` with a reason and no action — the caller must make zero GitHub
 * mutation on that path. When the plan already carries a linked PR number in
 * front-matter, the decision is `already_promoted` (idempotent: open nothing,
 * report the existing PR).
 *
 * @param {object} facts
 * @param {boolean} facts.baseSectionsValid  whether the plan passes the base-section validator
 * @param {boolean} facts.hasAcceptanceCriteria  whether a non-empty Acceptance criteria section is present
 * @param {boolean} facts.hasDefinitionOfDone  whether a non-empty Definition of done section is present
 * @param {number|null} [facts.existingPrNumber]  PR number already recorded in the plan's front-matter, if any
 * @returns {{ ok: boolean, action?: string, reason?: string, planFileIntakeState?: string, existingPrNumber?: number }}
 */
export function evaluatePromoteEligibility({
  baseSectionsValid,
  hasAcceptanceCriteria,
  hasDefinitionOfDone,
  existingPrNumber = null,
} = {}) {
  const state = evaluatePlanFileIntakeState({
    baseSectionsValid,
    hasAcceptanceCriteria,
    hasDefinitionOfDone,
  }).state;

  // The ready gate: promotion only acts on a fully-refined plan. A plan that
  // still needs refinement, is ambiguous, or fails the base contract is not
  // promotable here; fail closed so the CLI makes no GitHub mutation.
  if (state !== PLAN_FILE_INTAKE_STATE.PLAN_REFINED_READY_FOR_PROMOTION) {
    return { ok: false, reason: "not_ready_for_promotion", planFileIntakeState: state };
  }

  // Idempotency: a plan already linked to a PR has been promoted. Report the
  // existing PR and open nothing.
  if (Number.isInteger(existingPrNumber) && existingPrNumber > 0) {
    return {
      ok: true,
      action: PLAN_FILE_PROMOTE_ACTION.ALREADY_PROMOTED,
      planFileIntakeState: state,
      existingPrNumber,
    };
  }

  return { ok: true, action: PLAN_FILE_PROMOTE_ACTION.PROMOTE, planFileIntakeState: state };
}

/**
 * Neutralize GitHub issue-closing keywords (`closes #12`, `fixes #3`,
 * `resolved #7`, …) by wrapping the keyword+reference in inline code, which
 * GitHub does not parse as a closing reference. The AC/DoD section bodies are
 * untrusted plan content; an accidental `Closes #123` in a plan would otherwise
 * flow into the PR body and auto-close an unrelated issue on merge — breaking
 * the PR-FIRST guarantee that promotion never closes a tracker artifact.
 *
 * ponytail: handles the realistic `#<n>` form; cross-repo (`owner/repo#n`) and
 * full-URL closing refs are not neutralized — out of scope for local plans.
 */
function neutralizeIssueCloseKeywords(text) {
  return String(text).replace(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+)(#\d+)\b/giu,
    "`$1$2$3`",
  );
}

/**
 * Build the draft-PR body for a promoted plan. The body is the self-contained
 * spec-of-record: it references the committed plan doc path (the PR→plan link)
 * and carries the FULL Acceptance criteria + Definition of done extracted from
 * the refined plan, so the PR alone fully specifies the work.
 *
 * Deliberately no `Closes #N` / issue reference: PR-FIRST promotion never mints
 * an issue, and the committed plan doc — not a tracker artifact — is the
 * authority. Issue-closing keywords inside the embedded AC/DoD are neutralized
 * so untrusted plan content cannot smuggle one in.
 *
 * @param {object} params
 * @param {string} params.planDocPath  repo-relative path of the committed plan doc
 * @param {string} params.acceptanceCriteria  full Acceptance criteria section body
 * @param {string} params.definitionOfDone  full Definition of done section body
 * @returns {string}
 */
export function buildPromotionPrBody({ planDocPath, acceptanceCriteria, definitionOfDone } = {}) {
  const docPath = String(planDocPath ?? "").trim();
  const ac = String(acceptanceCriteria ?? "").trim();
  const dod = String(definitionOfDone ?? "").trim();
  if (docPath.length === 0) {
    throw new Error("buildPromotionPrBody requires a planDocPath");
  }
  if (ac.length === 0) {
    throw new Error("buildPromotionPrBody requires acceptanceCriteria");
  }
  if (dod.length === 0) {
    throw new Error("buildPromotionPrBody requires definitionOfDone");
  }
  const safeAc = neutralizeIssueCloseKeywords(ac);
  const safeDod = neutralizeIssueCloseKeywords(dod);
  return [
    `Spec-of-record: the committed plan doc \`${docPath}\` is the authority for this work.`,
    "This PR was opened by PR-FIRST promotion; no tracker issue exists.",
    "",
    "## Acceptance criteria",
    "",
    safeAc,
    "",
    "## Definition of done",
    "",
    safeDod,
    "",
  ].join("\n");
}
