/**
 * Deterministic issue refinement-artifact detection.
 *
 * Implements the bounded refinement check required by the draft gate per
 * issue #532: a draft PR cannot leave draft unless the linked issue has an
 * explicit refinement artifact (Acceptance criteria section, DoD section,
 * or a linked refinement doc) that the pre-approval gate can verify
 * against. Prose-only issues (Problem / Root Cause / Fix) without an
 * `Acceptance criteria` or `DoD` section cause the draft gate to post
 * `verdict=blocked` with the `missing_refinement_artifact` finding.
 *
 * This module owns:
 * - canonical section-name matching for AC / DoD blocks
 * - bullet-item extraction (checklist `- [ ]`/`- [x]` and top-level `- ` bullets)
 * - linked-refinement-doc detection from issue body
 *
 * It deliberately does NOT:
 * - auto-generate ACs from prose
 * - mutate GitHub state
 * - re-implement the issue<->PR linkage detection (callers own that)
 */

export const REFINEMENT_SOURCE = Object.freeze({
  ISSUE_BODY_AC: "issue-body-ac",
  ISSUE_BODY_DOD: "issue-body-dod",
  LINKED_DOC: "linked-doc",
  MISSING: "missing",
});

const REFINEMENT_ARTIFACT_FINDING = "missing_refinement_artifact";

// The three artifact sources, any ONE of which satisfies the refinement gate.
// Single source of truth for the "missing" vocabulary reported when none is
// present — consumed by the enqueue gate and the parked-unrefined discovery.
export const REFINEMENT_ARTIFACT_SOURCES = Object.freeze([
  "Acceptance criteria section",
  "Definition of done section",
  "linked refinement doc",
]);

/**
 * Canonical list of section headings that satisfy the refinement check.
 * Matching is case-insensitive and tolerates trailing/leading whitespace.
 * The two-element minimum keeps the contract explicit:
 *   - one AC section (Acceptance criteria)
 *   - one DoD-style section (DoD or Definition of Done)
 */
const ACCEPTANCE_SECTION_PATTERNS = Object.freeze([
  /^acceptance criteria\s*$/i,
  /^ac\b.*$/i,
]);

const DOD_SECTION_PATTERNS = Object.freeze([
  /^definition of done\s*$/i,
  /^done\s*$/i,
  /^dod\s*$/i,
]);

/**
 * Fenced-code-span tracker. Given the previous fence state and the current
 * line, returns { fence, insideFence } where:
 *   - `fence` is the next state ({ char, len } while open, else null)
 *   - `insideFence` is true when the line's CONTENT is inside a code span
 *     (i.e. a fence line, or a line between an open and its close)
 *
 * CommonMark: an N-marker fence (``` or ~~~) closes only on a line of >= N
 * markers of the SAME char with no info string. This is the single source of
 * truth shared by parseMarkdownSections (headings) and extractChecklistItems
 * (checkboxes) so the two anti-spoof layers cannot drift (issue #1025).
 */
function stepFence(fence, line) {
  const openMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
  if (openMatch) {
    const char = openMatch[1][0];
    const len = openMatch[1].length;
    // A closing fence is a bare run of >= N markers of ONLY the opening char
    // (CommonMark: no mixed markers, no info string).
    const isBareRun = new RegExp(`^\\s*${char}+\\s*$`, "u").test(line);
    if (fence === null) {
      return { fence: { char, len }, insideFence: true };
    }
    if (fence.char === char && len >= fence.len && isBareRun) {
      return { fence: null, insideFence: true };
    }
    return { fence, insideFence: true };
  }
  return { fence, insideFence: fence !== null };
}

/**
 * Extract `## ...` heading boundaries from a Markdown body.
 * Returns a sorted array of { level, name, bodyLines } records.
 *
 * Headings inside a fenced code span (``` or ~~~) are NOT treated as headings —
 * otherwise a body could spoof the refinement/spec gate with real-looking
 * headings that carry no real spec (gate integrity, issue #1025).
 */
export function parseMarkdownSections(body) {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }

  const lines = body.split(/\r?\n/u);
  const sections = [];
  let current = null;
  let fence = null;

  for (const line of lines) {
    const step = stepFence(fence, line);
    fence = step.fence;
    if (step.insideFence) {
      if (current) current.bodyLines.push(line);
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (match) {
      if (current) {
        sections.push(current);
      }
      current = {
        level: match[1].length,
        name: match[2],
        bodyLines: [],
      };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

function findSectionByPatterns(sections, patterns) {
  for (const section of sections) {
    for (const pattern of patterns) {
      if (pattern.test(section.name)) {
        return section;
      }
    }
  }
  return null;
}

/**
 * Parse bullet/checkbox items from a section body into item states. Each
 * checkbox item (`- [ ]`/`- [x]`/`- [X]`) becomes `{ text, checked }`
 * (`checked` true only for a ticked `[x]`/`[X]`); a top-level plain bullet
 * (`- text`, dash at column 0 so nested/indented sub-bullets are not counted)
 * becomes `{ text, checked: null }` — it has no checkbox to tick. Empty
 * checkbox placeholders (`- [ ]` / `- [x]` with no trailing text) are skipped,
 * not counted, so a section of only unfilled placeholders reports as unrefined.
 * Code-fenced lines are skipped (same fence logic as parseMarkdownSections,
 * issue #1025) so a body cannot spoof the AC/DoD gate with code-fenced
 * checkboxes.
 *
 * Shared by `extractChecklistItems` (text-only) and the unticked-AC check
 * (`extractUncheckedChecklistItems`) so the two never drift on what counts as
 * a checklist item or on the checkbox-state read (#1621). Only ever called on
 * the body of an already-recognized AC/DoD section (see
 * `detectIssueRefinementArtifact`), so counting plain bullets is scoped to
 * those sections and never affects prose sections.
 */
function parseChecklistItems(sectionBody) {
  if (typeof sectionBody !== "string" || sectionBody.length === 0) {
    return [];
  }

  const items = [];
  const lines = sectionBody.split(/\r?\n/u);
  let fence = null;

  for (const line of lines) {
    const step = stepFence(fence, line);
    fence = step.fence;
    if (step.insideFence) {
      continue;
    }
    // Checklist item: `- [ ]` / `- [x]` (leading indentation tolerated).
    // Consume ANY checkbox-marker line here; push only when it carries text,
    // so empty placeholders (`- [ ]`) are skipped rather than counted.
    const checkboxMatch = /^\s*-\s+\[(?:[ xX])\](?:\s+(.+?))?\s*$/u.exec(line);
    if (checkboxMatch) {
      const text = (checkboxMatch[1] ?? "").trim();
      if (text.length > 0) {
        // `checked` is true only for a ticked box; `[ ]` (space) is false.
        // A plain bullet has no checkbox, so it stays `null` below — it is
        // neither ticked nor unticked and does not count as an unticked AC.
        items.push({ text, checked: /^\s*-\s+\[[xX]\]/u.test(line) });
      }
      continue;
    }
    // Top-level plain bullet: dash at column 0, space required (so `---`
    // horizontal rules and `-x` do not match; indented sub-bullets do not).
    const bulletMatch = /^-\s+(.+?)\s*$/u.exec(line);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text.length > 0) {
        items.push({ text, checked: null });
      }
    }
  }

  return items;
}

/**
 * Extract bullet items from a section body. Counts both `- [ ]`/`- [x]`
 * checklist items and top-level plain `- ` bullets. Empty checkbox placeholders
 * are skipped. Returns the trimmed item text for each matching line; the
 * checkbox state is not preserved (use `extractUncheckedChecklistItems` for
 * that). Thin wrapper over `parseChecklistItems` so the text-only contract
 * stays byte-identical to its pre-#1621 shape.
 */
export function extractChecklistItems(sectionBody) {
  return parseChecklistItems(sectionBody).map((item) => item.text);
}

/**
 * Extract the text of UNCHECKED checkbox items (`- [ ]`) from a section body.
 * A ticked box (`- [x]`/`- [X]`) and a plain bullet (no checkbox) are both
 * excluded — only an actual unticked checkbox is an "unticked AC item"
 * (#1621, ACCEPT-CRITERIA-VERIFY-AND-REFLECT). Empty placeholders are skipped.
 * Thin wrapper over `parseChecklistItems` so the unticked read never drifts
 * from `extractChecklistItems` on what counts as a checklist item.
 */
export function extractUncheckedChecklistItems(sectionBody) {
  return parseChecklistItems(sectionBody)
    .filter((item) => item.checked === false)
    .map((item) => item.text);
}

/**
 * Detect a linked refinement doc path from the issue body.
 * Looks for explicit `tmp/refinement/<n>-plan.md` style paths and the
 * `## Refinement` / `## Plan` / `## Refinement doc` sections.
 */
export function detectLinkedRefinementDoc(body) {

  if (typeof body !== "string" || body.length === 0) {
    return { found: false, path: null, reason: "empty-body" };
  }

  const pathMatch = /(?:^|\s|[`(\[<])(tmp\/refinement\/[A-Za-z0-9._/\-]+\.md)\b/u.exec(body);
  if (pathMatch) {
    return { found: true, path: pathMatch[1], reason: "explicit-path" };
  }

  const sections = parseMarkdownSections(body);
  const refinementSection = findSectionByPatterns(sections, [
    /^refinement doc\s*$/i,
    /^refinement\s*$/i,
    /^plan doc\s*$/i,
    /^plan\s*$/i,
  ]);
  if (refinementSection) {
    const inlinePath = /(?:^|\s)(tmp\/refinement\/[^\s)`'"]+\.md)\b/u.exec(refinementSection.bodyLines.join("\n"));
    if (inlinePath) {
      return { found: true, path: inlinePath[1], reason: "refinement-section-path" };
    }
  }

  return { found: false, path: null, reason: "no-linked-doc" };
}

/**
 * Detect the refinement artifact on a parsed issue body.
 *
 * @param {object} input
 * @param {string} [input.body]  Raw issue body Markdown.
 * @param {number} [input.issueNumber]  Issue number, used for linked-doc convention.
 * @returns {{
 *   hasACs: boolean,
 *   source: string,
 *   acItems: string[],
 *   uncheckedAcItems: string[],
 *   dodItems: string[],
 *   sections: string[],
 *   linkedDoc: { found: boolean, path: string|null, reason: string },
 *   reason: string,
 *   finding: string|null,
 * }}
 */
export function detectIssueRefinementArtifact({ body = "", issueNumber = null } = {}) {
  if (typeof body !== "string" || body.length === 0) {
    return {
      hasACs: false,
      source: REFINEMENT_SOURCE.MISSING,
      acItems: [],
      uncheckedAcItems: [],
      dodItems: [],
      sections: [],
      linkedDoc: { found: false, path: null, reason: "empty-body" },
      reason: "Issue body is empty; no ACs/DoD/linked-doc can be detected.",
      finding: REFINEMENT_ARTIFACT_FINDING,
    };
  }

  const sections = parseMarkdownSections(body);
  const sectionNames = sections.map((s) => s.name);

  const acceptanceSection = findSectionByPatterns(sections, ACCEPTANCE_SECTION_PATTERNS);
  const dodSection = findSectionByPatterns(sections, DOD_SECTION_PATTERNS);

  const acItems = acceptanceSection ? extractChecklistItems(acceptanceSection.bodyLines.join("\n")) : [];
  // Unticked AC checkboxes (`- [ ]`) of the spec-of-record — the
  // ACCEPT-CRITERIA-VERIFY-AND-REFLECT precondition a clean pre_approval_gate
  // must refuse on (#1621). Only actual unticked checkboxes count; a ticked
  // box and a plain bullet (no checkbox) are both excluded.
  const uncheckedAcItems = acceptanceSection ? extractUncheckedChecklistItems(acceptanceSection.bodyLines.join("\n")) : [];
  const dodItems = dodSection ? extractChecklistItems(dodSection.bodyLines.join("\n")) : [];

  const linkedDoc = detectLinkedRefinementDoc(body);

  if (acItems.length > 0) {
    return {
      hasACs: true,
      source: REFINEMENT_SOURCE.ISSUE_BODY_AC,
      acItems,
      uncheckedAcItems,
      dodItems,
      sections: sectionNames,
      linkedDoc,
      reason: `Found ${acItems.length} Acceptance criteria checklist item(s) in the issue body.`,
      finding: null,
    };
  }

  if (dodItems.length > 0) {
    return {
      hasACs: true,
      source: REFINEMENT_SOURCE.ISSUE_BODY_DOD,
      acItems,
      uncheckedAcItems,
      dodItems,
      sections: sectionNames,
      linkedDoc,
      reason: `Found ${dodItems.length} DoD checklist item(s) in the issue body.`,
      finding: null,
    };
  }

  if (linkedDoc.found) {
    return {
      hasACs: true,
      source: REFINEMENT_SOURCE.LINKED_DOC,
      acItems: [],
      uncheckedAcItems: [],
      dodItems: [],
      sections: sectionNames,
      linkedDoc,
      reason: `Issue body links a refinement doc at ${linkedDoc.path}; treating that as the refinement artifact source.`,
      finding: null,
    };
  }

  return {
    hasACs: false,
    source: REFINEMENT_SOURCE.MISSING,
    acItems: [],
    uncheckedAcItems: [],
    dodItems: [],
    sections: sectionNames,
    linkedDoc,
    reason: "Issue body has no Acceptance criteria section, no DoD section, and no linked refinement doc.",
    finding: REFINEMENT_ARTIFACT_FINDING,
  };
}

/**
 * PR-body-as-spec invariant sections (issue #1025, lightweight path).
 *
 * When a lightweight session uses the PR description itself as the
 * spec-of-record (no committed phase/plan doc), the PR body must still carry
 * the same invariants a durable spec doc would. AC/DoD reuse the checklist
 * patterns above; these are the narrative sections not covered by those.
 * Key order = validation/report order. Each key maps to its distinct
 * `missing_*` code (mirrors `checkBaseSections` in _refine-helpers.mjs).
 */
export const PR_BODY_SPEC_NARRATIVE_SECTIONS = Object.freeze({
  objective: {
    code: "missing_objective",
    label: "Objective/why",
    patterns: [/^objective\b/iu, /^why\b/iu, /^goals?\b/iu, /^summary\b/iu, /^problem\b/iu],
  },
  in_scope: {
    code: "missing_in_scope",
    label: "In scope",
    patterns: [/^in[- ]?scope\b/iu, /^scope\b/iu],
  },
  non_goals: {
    code: "missing_explicit_non_goals",
    label: "Explicit non-goals",
    patterns: [/^explicit non-?goals\b/iu, /^non-?goals\b/iu, /^out of scope\b/iu],
  },
  open_questions: {
    code: "missing_open_questions",
    label: "Open questions/risks",
    patterns: [/^open questions\b/iu, /^risks?\b/iu, /^questions\b/iu],
  },
});

/**
 * GitHub's accepted closing-keyword issue references (close/closes/closed,
 * fix/fixes/fixed, resolve/resolves/resolved), case-insensitive, followed by
 * `#N` or the cross-repo `owner/repo#N` form. Mirrors the linkage the
 * lightweight path (#1025) requires the PR body to carry (issue #1181: five
 * lightweight PRs merged without this and none auto-closed their issue).
 */
const CLOSING_ISSUE_REFERENCE_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/giu;

function extractClosingIssueNumbers(body) {
  // Same fence-skip as sectionHasBody: a `Closes #N` line quoted inside a
  // ```fenced``` example (e.g. a PR-template sample) must not spoof the gate.
  let fence = null;
  const unfenced = [];
  for (const line of body.split("\n")) {
    const step = stepFence(fence, line);
    fence = step.fence;
    if (step.insideFence) continue;
    unfenced.push(line);
  }
  // Inline `code` spans don't auto-close on GitHub either: blank out any
  // backtick-run-delimited span (equal-length runs pair, so ``a `b` c`` works).
  // ponytail: not full CommonMark span matching; an unbalanced stray backtick
  // over-strips toward fail-closed, which is the safe direction for this gate.
  // Revisit with a real CommonMark span parser only if valid closing refs in
  // backtick-heavy bodies start being over-stripped into false negatives.
  const text = unfenced.join("\n").replace(/(`+)[\s\S]*?\1/gu, " ");
  const seen = new Set();
  const numbers = [];
  for (const match of text.matchAll(CLOSING_ISSUE_REFERENCE_PATTERN)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      numbers.push(n);
    }
  }
  return numbers;
}

function sectionHasBody(section) {
  // A real body needs >=1 non-whitespace line OUTSIDE any fenced code span —
  // a section whose only content is a ```fenced``` block is treated as empty so
  // it cannot spoof the narrative-invariant gate (issue #1025, same stepFence as
  // parseMarkdownSections + extractChecklistItems).
  if (!section) return false;
  let fence = null;
  for (const line of section.bodyLines) {
    const step = stepFence(fence, line);
    fence = step.fence;
    if (step.insideFence) continue;
    if (line.trim().length > 0) return true;
  }
  return false;
}

/**
 * Validate that a PR body carries every invariant required to serve as the
 * lightweight spec-of-record: Objective/why, in-scope, explicit non-goals,
 * testable Acceptance criteria (>=1 checklist item), Definition of done
 * (>=1 checklist item), Open questions/risks, and — unless explicit
 * issue-less mode is requested — a GitHub closing-keyword issue reference
 * (`Closes #N` and GitHub's other accepted forms — the lightweight path's
 * `Closes #N` linkage, issue #1181). Reuses the generic markdown logic
 * (parseMarkdownSections / AC + DoD patterns / extractChecklistItems) so
 * there is no parallel validator. Fails closed: every missing invariant is
 * reported under its distinct `missing_*` code. Pure; no side effects.
 *
 * Issue-less mode (`issueLess: true`, issue #1210): the narrative invariants
 * stay unconditional, but the closing-issue linkage flips from REQUIRED to
 * FORBIDDEN — the PR is the sole artifact, so it MUST NOT carry a closing
 * reference to an issue that doesn't back it. A present reference in this
 * mode fails closed under `unexpected_closing_issue_reference`, distinct
 * from `missing_closing_issue_reference` (tracker-backed mode, the default)
 * so callers can tell "no issue expected" apart from "issue expected but
 * absent". `expectedIssue` and `issueLess` are mutually exclusive; callers
 * pick exactly one mode (tracker-backed, with or without a specific
 * expected issue) or issue-less — never both.
 *
 * @param {{ body?: string, expectedIssue?: number, issueLess?: boolean }} input
 * @returns {{ checker: "validate-pr-body-spec", ok: boolean, errors: { code: string, message: string }[], sections: string[], acItems: string[], dodItems: string[], closesIssues: number[] }}
 */

// ---------------------------------------------------------------------------
// Grill sub-loop body predicates (GRILL-SUBLOOP-*, #1628)
// ---------------------------------------------------------------------------
// The loop-grill skill writes its raw Q&A transcript and synthesis to an
// ephemeral tmp artifact and keeps only the canonical synthesized sections
// (Acceptance criteria / Definition of done / Non-goals) plus the sanctioned
// `<!-- loop-grill: ... -->` marker in the durable issue/PR body. The body
// MUST NOT embed the raw grill transcript/synthesis/Q&A headings
// (GRILL-SUBLOOP-NO-EMBED-SYNTHESIS). These pure predicates are the only
// mechanically-enforceable part of that contract; the judgment-bound clauses
// ("resolve every gap the grill decided", "stale contradicting prose") stay
// agent-level.

export const GRILL_MARKER_PATTERN = /<!--\s*loop-grill:\s*.*?-->/iu;

/** Case-insensitive **section heading names** that embed grill material. */
export const GRILL_EMBED_HEADING_PATTERNS = Object.freeze([
  /^grill\s+findings$/iu,
  /^grill\s+transcript$/iu,
  /^grill\s+synthesis$/iu,
  /^grill\s+q&a$/iu,
  /^grill\s+qa$/iu,
]);

/**
 * Detect the sanctioned `<!-- loop-grill: ... -->` marker. Pure predicate.
 * @param {string} [body]
 * @returns {boolean} true when the marker is present.
 */
export function detectGrillMarker(body = "") {
  return typeof body === "string" && GRILL_MARKER_PATTERN.test(body);
}

/**
 * Detect a grill transcript/synthesis/Q&A embed heading in the body. Pure
 * predicate; returns the first offending `##`-level heading name or null.
 * @param {string} [body]
 * @returns {string|null} the offending heading name, or null when none.
 */
export function detectGrillEmbedHeading(body = "") {
  if (typeof body !== "string" || body.length === 0) return null;
  for (const section of parseMarkdownSections(body)) {
    for (const pattern of GRILL_EMBED_HEADING_PATTERNS) {
      if (pattern.test(String(section.name))) {
        return String(section.name);
      }
    }
  }
  return null;
}

export function validatePrBodySpec({ body = "", expectedIssue = null, issueLess = false } = {}) {
  if (issueLess && Number.isInteger(expectedIssue)) {
    // Fail closed at the library boundary too (not just the CLI): the two modes
    // are contradictory and silently preferring one would hide caller bugs.
    throw new Error("validatePrBodySpec: issueLess and expectedIssue are mutually exclusive; pass exactly one issue-linkage mode");
  }
  const bodyText = typeof body === "string" ? body : "";
  const sections = parseMarkdownSections(bodyText);
  const errors = [];

  for (const { code, label, patterns } of Object.values(PR_BODY_SPEC_NARRATIVE_SECTIONS)) {
    const section = findSectionByPatterns(sections, patterns);
    if (!sectionHasBody(section)) {
      errors.push({ code, message: `Missing or empty ${label} section.` });
    }
  }

  const acSection = findSectionByPatterns(sections, ACCEPTANCE_SECTION_PATTERNS);
  const acItems = acSection ? extractChecklistItems(acSection.bodyLines.join("\n")) : [];
  if (acItems.length === 0) {
    errors.push({
      code: "missing_acceptance_criteria",
      message: "Missing testable Acceptance criteria (no checklist items found).",
    });
  }

  const dodSection = findSectionByPatterns(sections, DOD_SECTION_PATTERNS);
  const dodItems = dodSection ? extractChecklistItems(dodSection.bodyLines.join("\n")) : [];
  if (dodItems.length === 0) {
    errors.push({
      code: "missing_definition_of_done",
      message: "Missing Definition of done (no checklist items found).",
    });
  }

  const closesIssues = extractClosingIssueNumbers(bodyText);
  if (issueLess) {
    if (closesIssues.length > 0) {
      errors.push({
        code: "unexpected_closing_issue_reference",
        message: `Issue-less PR body MUST NOT carry a closing reference to an issue that doesn't back it (found ${closesIssues.map((n) => `#${n}`).join(", ")}).`,
      });
    }
  } else if (closesIssues.length === 0) {
    errors.push({
      code: "missing_closing_issue_reference",
      message: "Missing a GitHub closing-keyword issue reference (e.g. `Closes #123`).",
    });
  } else if (Number.isInteger(expectedIssue) && !closesIssues.includes(expectedIssue)) {
    errors.push({
      code: "closes_wrong_issue",
      message: `PR body closes ${closesIssues.map((n) => `#${n}`).join(", ")}, not the expected #${expectedIssue}.`,
    });
  }

  return {
    checker: "validate-pr-body-spec",
    ok: errors.length === 0,
    errors,
    sections: sections.map((s) => s.name),
    acItems,
    dodItems,
    closesIssues,
  };
}

/**
 * Decide what an enqueue caller should do with a refinement-artifact result,
 * so an un-refined item never lands in the Next Up pickup column in the first
 * place. The draft gate remains the backstop for whatever slips through.
 *
 * Pure decision table, no I/O:
 *   - target isn't the pickup column, or the artifact is present → enqueue
 *     as requested.
 *   - pickup target, artifact missing, interactive caller → block (caller
 *     throws; no mutation).
 *   - pickup target, artifact missing, headless/auto caller → divert (caller
 *     parks the item in the non-pickup column instead of failing the run).
 *
 * @param {{ artifact: ReturnType<typeof detectIssueRefinementArtifact>, targetIsPickup: boolean, auto?: boolean }} input
 * @returns {{ action: "enqueue" } | { action: "block"|"divert", reason: string, missing: string[] }}
 */
export function decideEnqueueRefinementGate({ artifact, targetIsPickup, auto = false }) {
  // `artifact.finding === null` is the explicit "has ANY refinement artifact"
  // signal (AC checklist OR DoD checklist OR linked doc) — clearer than reading
  // `hasACs`, whose name understates that a DoD or linked doc also satisfies it.
  if (!targetIsPickup || artifact.finding === null) {
    return { action: "enqueue" };
  }
  const missing = [...REFINEMENT_ARTIFACT_SOURCES];
  const reason =
    `Issue has no refinement artifact (none of: ${missing.join(", ")}). ` +
    "Add at least ONE of them — an Acceptance criteria section, a Definition of done section, or a linked refinement doc " +
    "(e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself), or the refiner) — before it enters the pickup queue.";
  return { action: auto ? "divert" : "block", reason, missing };
}

/**
 * Apply the pickup-column refinement gate to one issue: fetch the issue body,
 * run `decideEnqueueRefinementGate`, and throw the canonical `GH_API_ERROR` /
 * `MISSING_REFINEMENT_ARTIFACT` on failure. This is the single
 * gate-application orchestration shared by `queue add` (enqueue-time) and
 * `queue move` (move-time) — never a second copy. It returns the gate decision
 * so add-only (divert/park) and move-only (refined-flag) handling stays with
 * each caller.
 *
 * @param {{ issueNumber: number, repo: string, env: object, runChild: Function, auto?: boolean }} input
 * @returns {Promise<{ action: "enqueue" } | { action: "divert"|"block", reason: string, missing: string[] }>}
 */
export async function runPickupRefinementGate({ issueNumber, repo, env, runChild, auto = false }) {
  const bodyResult = await runChild(
    "gh",
    ["issue", "view", String(issueNumber), "--repo", repo, "--json", "body"],
    env,
  );
  if (bodyResult.code !== 0) {
    const detail = bodyResult.stderr?.trim() || `exit code ${bodyResult.code}`;
    throw Object.assign(new Error(`gh issue view failed: ${detail}`), { code: "GH_API_ERROR" });
  }
  let bodyPayload;
  try {
    bodyPayload = JSON.parse(bodyResult.stdout);
  } catch {
    throw new Error("Invalid JSON input");
  }
  const body = typeof bodyPayload?.body === "string" ? bodyPayload.body : "";
  const artifact = detectIssueRefinementArtifact({ body, issueNumber });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto });
  if (decision.action === "block") {
    throw Object.assign(new Error(decision.reason), {
      code: "MISSING_REFINEMENT_ARTIFACT",
      missing: decision.missing,
    });
  }
  return decision;
}

/**
 * Map a draft-gate refinement check to the result surface consumed by
 * `evaluatePrGateCoordination`. The mapping keeps the contract
 * deterministic: the draft gate must not produce a `clean` verdict
 * for the current head when the refinement check is `missing`.
 */
export function summarizeRefinementGateCheck({ body = "", issueNumber = null } = {}) {
  const artifact = detectIssueRefinementArtifact({ body, issueNumber });
  const verdict = artifact.hasACs ? "clean" : "blocked";
  const finding = artifact.finding;
  return {
    artifact,
    verdict,
    finding,
    blocking: !artifact.hasACs,
    reason: artifact.reason,
  };
}
