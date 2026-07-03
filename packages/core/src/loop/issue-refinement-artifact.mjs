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
 * Extract `## ...` heading boundaries from a Markdown body.
 * Returns a sorted array of { level, name, bodyLines } records.
 */
export function parseMarkdownSections(body) {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }

  const lines = body.split(/\r?\n/u);
  const sections = [];
  let current = null;

  for (const line of lines) {
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
 * unchecked) is
 * intentionally not preserved: callers only need the item text to satisfy
 * the refinement-artifact contract.
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

  for (const line of lines) {
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
