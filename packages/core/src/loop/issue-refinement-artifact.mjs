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
 * Extract bullet items from a section body. Counts both `- [ ]`/`- [x]`
 * checklist items and top-level plain `- ` bullets (dash at column 0, so
 * nested/indented sub-bullets are not counted). Empty checkbox placeholders
 * (`- [ ]` / `- [x]` with no trailing text) are skipped, not counted, so a
 * section of only unfilled placeholders reports as unrefined. Returns the
 * trimmed item text for each matching line. The checkbox state (checked vs
 * unchecked) is intentionally not preserved: callers only need the item
 * text to satisfy the refinement-artifact contract.
 *
 * This is only ever called on the body of an already-recognized AC/DoD
 * section (see `detectIssueRefinementArtifact`), so counting plain bullets
 * is scoped to those sections and never affects prose sections.
 */
export function extractChecklistItems(sectionBody) {
  if (typeof sectionBody !== "string" || sectionBody.length === 0) {
    return [];
  }

  const items = [];
  const lines = sectionBody.split(/\r?\n/u);
  let fence = null;

  for (const line of lines) {
    // Checkboxes/bullets inside a fenced code span are non-interactive text, not
    // real items — skip them so a body cannot spoof the AC/DoD gate with
    // code-fenced checkboxes (issue #1025). Same fence logic as parseMarkdownSections.
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
        items.push(text);
      }
      continue;
    }
    // Top-level plain bullet: dash at column 0, space required (so `---`
    // horizontal rules and `-x` do not match; indented sub-bullets do not).
    const bulletMatch = /^-\s+(.+?)\s*$/u.exec(line);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text.length > 0) {
        items.push(text);
      }
    }
  }

  return items;
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
  const dodItems = dodSection ? extractChecklistItems(dodSection.bodyLines.join("\n")) : [];

  const linkedDoc = detectLinkedRefinementDoc(body);

  if (acItems.length > 0) {
    return {
      hasACs: true,
      source: REFINEMENT_SOURCE.ISSUE_BODY_AC,
      acItems,
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
  const seen = new Set();
  const numbers = [];
  for (const match of unfenced.join("\n").matchAll(CLOSING_ISSUE_REFERENCE_PATTERN)) {
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
 * (>=1 checklist item), Open questions/risks, and a GitHub closing-keyword
 * issue reference (`Closes #N` and GitHub's other accepted forms — the
 * lightweight path's `Closes #N` linkage, issue #1181). Reuses the generic
 * markdown logic (parseMarkdownSections / AC + DoD patterns /
 * extractChecklistItems) so there is no parallel validator. Fails closed:
 * every missing invariant is reported under its distinct `missing_*` code.
 * Pure; no side effects.
 *
 * @param {{ body?: string, expectedIssue?: number }} input
 * @returns {{ checker: "validate-pr-body-spec", ok: boolean, errors: { code: string, message: string }[], sections: string[], acItems: string[], dodItems: string[], closesIssues: number[] }}
 */
export function validatePrBodySpec({ body = "", expectedIssue = null } = {}) {
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
  if (closesIssues.length === 0) {
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
