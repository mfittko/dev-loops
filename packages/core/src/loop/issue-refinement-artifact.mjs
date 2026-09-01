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
 * Since #1866 the check ALSO requires an explicit Non-goals section on the
 * issue body (see `MISSING_EXPLICIT_NON_GOALS_FINDING` below).
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
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

// REFINEMENT_ARTIFACT_SOURCES: the full-matrix floor vocabulary (#1877). The
// refinement floor is the FULL AC/DoD/Non-goals matrix (a linked refinement
// doc remains a complete artifact on its own) — this list is the shape of a
// COMPLETE artifact, not a menu where any one entry suffices.
export const REFINEMENT_ARTIFACT_SOURCES = Object.freeze([
  "Acceptance criteria section",
  "Definition of done section",
  "linked refinement doc",
]);

/**
 * #1866: finding reported when the issue body carries a refinement artifact
 * (AC/DoD checklist or a resolvable linked doc) but no explicit Non-goals
 * section. Mirrors the PR-path narrative-invariant code
 * (`PR_BODY_SPEC_NARRATIVE_SECTIONS.non_goals.code`) so both spec surfaces
 * name the missing invariant identically.
 */
export const MISSING_EXPLICIT_NON_GOALS_FINDING = "missing_explicit_non_goals";

/**
 * #1877: finding reported when the issue body carries an AC checklist (and
 * the Non-goals floor is met) but NO DoD checklist — the tracker-backed
 * refinement floor is the full AC/DoD/Non-goals matrix (each AC mapped to its
 * DoD item(s), plus explicit Non-goals), not AC-or-DoD. This lifts the
 * epic-only matrix requirement (epic-tree-refinement-procedure.md) into the
 * general refinement predicate, reconciled with #1866's Non-goals parity.
 */
export const MISSING_DOD_CHECKLIST_FINDING = "missing_dod_checklist";

/**
 * #1877: the symmetric matrix miss — a DoD checklist with no Acceptance
 * criteria checklist. The matrix is authored at refinement on the issue; the
 * PR then carries the derived checklist whose boxes the pre-approval gate
 * requires all ticked.
 */
export const MISSING_AC_CHECKLIST_FINDING = "missing_ac_checklist";

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

// #1877 alias-precedence: exact canonical headings (the first pattern in each
// family) must outrank loose aliases (`/^ac\b/`, `/^dod\b/`) so a matrix-shaped
// heading the refined-issue contract itself produces (`## AC/DoD matrix`,
// `## AC → DoD mapping`) can never hijack the canonical section read. Split
// each pattern family into [exact, aliases] by convention: pattern index 0
// is the exact canonical match, the rest are aliases.
const EXACT_PATTERN_INDEX = 0;

/**
 * Resolve the sections matching a heading-pattern family with exact-first
 * precedence (#1877): the first section matching the EXACT canonical pattern
 * (index 0) wins over any earlier section that only matched a loose alias
 * (e.g. `## AC/DoD matrix` before `## Acceptance criteria`). When no exact
 * match exists, the first alias match is returned (alias-only bodies keep
 * working). Returns null when no section matches at all.
 */
function findSectionByPatterns(sections, patterns) {
  const exact = patterns[EXACT_PATTERN_INDEX];
  for (const section of sections) {
    if (exact.test(section.name)) {
      return section;
    }
  }
  for (const section of sections) {
    for (let i = 1; i < patterns.length; i += 1) {
      if (patterns[i].test(section.name)) {
        return section;
      }
    }
  }
  return null;
}

/**
 * Collect ALL sections matching a heading-pattern family, exact-first ordered
 * (exact canonical matches before alias-only matches). Shared with
 * `findSectionByPatterns`'s precedence semantics so single-section consumers
 * and union consumers (#1877 PR-body unchecked-box extraction) cannot drift.
 */
function findAllSectionsByPatterns(sections, patterns) {
  const exact = patterns[EXACT_PATTERN_INDEX];
  const exactMatches = [];
  const aliasMatches = [];
  for (const section of sections) {
    if (exact.test(section.name)) {
      exactMatches.push(section);
    } else {
      for (let i = 1; i < patterns.length; i += 1) {
        if (patterns[i].test(section.name)) {
          aliasMatches.push(section);
          break;
        }
      }
    }
  }
  return [...exactMatches, ...aliasMatches];
}

/**
 * Flatten a section (heading record) into a body string that extends past
 * `###` sub-headings (#1877): a section's checklist may nest items under
 * deeper sub-headings (`### edge cases` inside `## Acceptance criteria`), so
 * join the section and every following section of a DEEPER heading level up
 * to the next same-or-shallower heading. `parseMarkdownSections` terminates a
 * section's `bodyLines` at ANY heading, which is correct for heading
 * matching but hides unchecked boxes from consumers that must see ALL of a
 * canonical section's boxes.
 */
function flattenSectionDeep(sections, startIndex) {
  const start = sections[startIndex];
  const parts = [start.bodyLines.join("\n")];
  for (let i = startIndex + 1; i < sections.length; i += 1) {
    if (sections[i].level <= start.level) break;
    parts.push(sections[i].name, sections[i].bodyLines.join("\n"));
  }
  return parts.join("\n");
}

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
    // Containment guard: reject actual '..' path segments (not benign
    // double-dot filenames) so the new fs-probe wiring can never be used as a
    // filesystem existence oracle outside tmp/refinement
    // (e.g. `tmp/refinement/../../docs/some-existing.md`).
    if (pathMatch[1].split("/").some((segment) => segment === "..")) {
      return { found: false, path: null, reason: "path-escapes-refinement-dir" };
    }
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
      // Containment guard: same segment-based '..' rejection as the
      // explicit-path branch.
      if (inlinePath[1].split("/").some((segment) => segment === "..")) {
        return { found: false, path: null, reason: "path-escapes-refinement-dir" };
      }
      return { found: true, path: inlinePath[1], reason: "refinement-section-path" };
    }
  }

  return { found: false, path: null, reason: "no-linked-doc" };
}

/**
 * Detect the refinement artifact on a parsed issue body.
 *
 * #1866: the tracker-backed refinement floor is the artifact (AC checklist,
 * DoD checklist, or a resolvable linked refinement doc) AND an explicit,
 * non-empty Non-goals section — the loop-grill / artifact-authority contract
 * requires Non-goals on a refined issue body, so the deterministic check
 * enforces it (fail-closed) with the distinct finding
 * `MISSING_EXPLICIT_NON_GOALS_FINDING`. The non-goals matcher is shared with
 * `validatePrBodySpec` (`PR_BODY_SPEC_NARRATIVE_SECTIONS.non_goals.patterns`),
 * so the two spec surfaces cannot drift on what counts as an explicit
 * Non-goals section. `hasACs` keeps its caller-facing meaning: true only when
 * the FULL check passes, so every `.hasACs` consumer (enqueue gate, draft
 * gate, parked-items discovery, gate context) fails closed with no call-site
 * change.
 *
 * `resolveLinkedDoc` (optional, #1866): a `(path) => boolean` callback used to
 * verify that a linked `tmp/refinement/*.md` doc actually resolves (e.g.
 * `existsSync`). Enforcement-point callers (enqueue gate, draft-gate
 * linked-issue path) supply it; a linked doc found in the body then satisfies
 * the artifact check only when the callback returns true. When the callback is
 * not supplied the predicate stays pure/no-I/O and behavior is unchanged, and
 * the `linkedDoc` result carries no `resolves` field. When supplied and the
 * doc does not resolve, `linkedDoc.resolves === false` and the linked doc does
 * not satisfy the artifact check (other artifact sources still count).
 *
 * Result-shape note: on a `missing_explicit_non_goals` result, `source` keeps
 * the detected artifact origin (e.g. `issue-body-ac`) so callers/reporting can
 * still see what artifact exists; `hasACs` is false because the full
 * refinement check did not pass.
 *
 * @param {object} input
 * @param {string} [input.body]  Raw issue body Markdown.
 * @param {number} [input.issueNumber]  Issue number, used for linked-doc convention.
 * @param {Function} [input.resolveLinkedDoc]  Optional `(path) => boolean` doc-resolution check.
 * @returns {{
 *   hasACs: boolean,
 *   hasNonGoals: boolean,
 *   source: string,
 *   acItems: string[],
 *   uncheckedAcItems: string[],
 *   dodItems: string[],
 *   sections: string[],
 *   linkedDoc: { found: boolean, path: string|null, reason: string, resolves?: boolean },
 *   reason: string,
 *   finding: string|null,
 * }}
 */
export function detectIssueRefinementArtifact({ body = "", issueNumber = null, resolveLinkedDoc = null } = {}) {
  if (typeof body !== "string" || body.length === 0) {
    return {
      hasACs: false,
      hasNonGoals: false,
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

  let linkedDoc = detectLinkedRefinementDoc(body);
  let linkedDocResolves = linkedDoc.found;
  if (linkedDoc.found && typeof resolveLinkedDoc === "function") {
    linkedDocResolves = resolveLinkedDoc(linkedDoc.path) === true;
    linkedDoc = { ...linkedDoc, resolves: linkedDocResolves };
  }

  // #1866: explicit Non-goals section required on a refined tracker-backed
  // issue body — same matcher the PR-body spec path uses, so the two cannot
  // drift. A heading-only or fenced-only section does not count
  // (sectionHasBody anti-spoof).
  const hasNonGoals = sectionHasBody(
    findSectionByPatterns(sections, PR_BODY_SPEC_NARRATIVE_SECTIONS.non_goals.patterns),
  );

  const artifactSource = acItems.length > 0
    ? REFINEMENT_SOURCE.ISSUE_BODY_AC
    : dodItems.length > 0
      ? REFINEMENT_SOURCE.ISSUE_BODY_DOD
      : linkedDocResolves
        ? REFINEMENT_SOURCE.LINKED_DOC
        : null;

  const base = {
    hasNonGoals,
    acItems,
    uncheckedAcItems,
    dodItems,
    sections: sectionNames,
    linkedDoc,
  };

  if (artifactSource !== null) {
    if (!hasNonGoals) {
      return {
        ...base,
        hasACs: false,
        source: artifactSource,
        reason:
          `Issue body carries a refinement artifact (${artifactSource}) but no explicit Non-goals section; ` +
          "the tracker-backed refinement contract requires one (rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; " +
          "e.g. run the loop-grill synthesis). Refusing: the refinement check fails closed without an explicit Non-goals section.",
        finding: MISSING_EXPLICIT_NON_GOALS_FINDING,
      };
    }
    if (artifactSource === REFINEMENT_SOURCE.ISSUE_BODY_AC) {
      // #1877 matrix floor: an AC checklist alone is no longer a complete
      // refinement artifact on a tracker-backed issue — the matrix is each AC
      // mapped to its DoD item(s) plus explicit Non-goals, so a missing DoD
      // checklist fails closed with its own finding. A linked refinement doc
      // stays a complete artifact on its own (the doc itself carries the
      // matrix).
      if (dodItems.length === 0) {
        return {
          ...base,
          hasACs: false,
          source: artifactSource,
          reason:
            "Issue body carries an Acceptance criteria checklist but no Definition of done checklist; " +
            "the tracker-backed refinement contract requires the full AC/DoD/Non-goals matrix " +
            "(#1877, rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR). Refusing: the refinement check fails closed " +
            "without a DoD checklist mapped to the acceptance criteria.",
          finding: MISSING_DOD_CHECKLIST_FINDING,
        };
      }
      return {
        ...base,
        hasACs: true,
        source: REFINEMENT_SOURCE.ISSUE_BODY_AC,
        reason: `Found ${acItems.length} Acceptance criteria checklist item(s) in the issue body.`,
        finding: null,
      };
    }
    if (artifactSource === REFINEMENT_SOURCE.ISSUE_BODY_DOD) {
      // #1877 matrix floor, symmetric arm: a DoD checklist with no Acceptance
      // criteria checklist is an incomplete matrix, not a refined issue.
      return {
        ...base,
        hasACs: false,
        source: REFINEMENT_SOURCE.ISSUE_BODY_DOD,
        reason:
          "Issue body carries a Definition of done checklist but no Acceptance criteria checklist; " +
          "the tracker-backed refinement contract requires the full AC/DoD/Non-goals matrix " +
          "(#1877, rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR). Refusing: the refinement check fails closed " +
          "without acceptance criteria for the DoD items to map to.",
        finding: MISSING_AC_CHECKLIST_FINDING,
      };
    }
    return {
      ...base,
      hasACs: true,
      source: REFINEMENT_SOURCE.LINKED_DOC,
      acItems: [],
      uncheckedAcItems: [],
      dodItems: [],
      reason: `Issue body links a refinement doc at ${linkedDoc.path}; treating that as the refinement artifact source.`,
      finding: null,
    };
  }

  return {
    ...base,
    hasACs: false,
    source: REFINEMENT_SOURCE.MISSING,
    acItems: [],
    uncheckedAcItems: [],
    dodItems: [],
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
 * `requireOpenQuestions` (default `true`, issue #1863): the lightweight
 * PR-body-as-spec contract (this function's original scope) requires an Open
 * questions/risks section; the ordinary tracker-backed PR-description
 * contract (skills/docs/copilot-loop-operations.md "PR description
 * contract") does not name one. Pass `false` (see
 * `validateTrackerBackedPrBodySpec` below) to skip the `missing_open_questions`
 * check without touching any other invariant — the lightweight caller's
 * default stays byte-identical.
 *
 * @param {{ body?: string, expectedIssue?: number, issueLess?: boolean, requireOpenQuestions?: boolean }} input
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
 * predicate; returns the first offending heading name at any markdown level
 * (# through ######) or null.
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

export function validatePrBodySpec({ body = "", expectedIssue = null, issueLess = false, requireOpenQuestions = true } = {}) {
  if (issueLess && Number.isInteger(expectedIssue)) {
    // Fail closed at the library boundary too (not just the CLI): the two modes
    // are contradictory and silently preferring one would hide caller bugs.
    throw new Error("validatePrBodySpec: issueLess and expectedIssue are mutually exclusive; pass exactly one issue-linkage mode");
  }
  const bodyText = typeof body === "string" ? body : "";
  const sections = parseMarkdownSections(bodyText);
  const errors = [];

  for (const [key, { code, label, patterns }] of Object.entries(PR_BODY_SPEC_NARRATIVE_SECTIONS)) {
    if (key === "open_questions" && !requireOpenQuestions) continue;
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
 * Validate a TRACKER-BACKED PR's own body against the PR-description contract
 * (skills/docs/copilot-loop-operations.md "PR description contract", issue
 * #1863): Acceptance criteria + Definition of done checklists, an explicit
 * Non-goals section, and a `Closes #N`/`Fixes #N` reference — regardless of
 * whether the linked issue itself already carries a refinement artifact. A
 * linked issue with real ACs is necessary but not sufficient: the PR body is
 * the portable spec-of-record a tracker-agnostic consumer reads.
 *
 * Thin wrapper over `validatePrBodySpec`, not a second divergent checker:
 * `requireOpenQuestions: false` because the tracker-backed contract, unlike
 * the lightweight PR-body-as-spec path, does not require an Open
 * questions/risks section. `expectedIssue` is only checked when the PR closes
 * exactly ONE issue — an umbrella PR closing several is not required to name
 * any single one of them in the `expectedIssue` slot (each linked issue's
 * refinement is verified separately by the caller).
 *
 * @param {{ body?: string, closingIssues?: number[] }} input
 * @returns {ReturnType<typeof validatePrBodySpec>}
 */
export function validateTrackerBackedPrBodySpec({ body = "", closingIssues = [] } = {}) {
  const expectedIssue = Array.isArray(closingIssues) && closingIssues.length === 1 ? closingIssues[0] : null;
  return validatePrBodySpec({ body, expectedIssue, requireOpenQuestions: false });
}

/**
 * #1877: extract the UNCHECKED AC/DoD checkbox items from a PR body's own
 * Acceptance criteria / Definition of done checklists — the derived,
 * self-contained checklist that mirrors the linked issue's AC/DoD/Non-goals
 * matrix. Any unchecked `- [ ]` in those sections means an acceptance
 * criterion or definition-of-done item is still open, and the deterministic
 * pre-approval block (`upsert-checkpoint-verdict.mjs`) fails the gate closed:
 * the round is `blocked` and the PR cannot reach approval with an open
 * acceptance criterion. This enforces COMPLETENESS (nothing left
 * unchecked/forgotten), not truthfulness — a dishonestly-ticked `[x]` passes
 * this mechanical check and remains the reviewer/judge's responsibility
 * (ACCEPT-CRITERIA-VERIFY-AND-REFLECT). Composes with
 * `tick-verified-checkboxes.mjs`: a box the gate could not verify stays
 * unchecked and therefore blocks.
 *
 * Pure; no I/O. Reuses the shared section patterns and checklist parser
 * (same `parseMarkdownSections` + `extractUncheckedChecklistItems` seams as
 * `detectIssueRefinementArtifact` / `validatePrBodySpec`) so no parallel
 * parser can drift. Sections absent from the body contribute no items — the
 * draft-exit `validateTrackerBackedPrBodySpec` check (#1863) already owns
 * requiring the sections to EXIST.
 *
 * @param {{ body?: string }} input
 * @returns {{ uncheckedAcItems: string[], uncheckedDodItems: string[] }}
 */
export function extractPrBodyUncheckedChecklistItems({ body = "" } = {}) {
  if (typeof body !== "string" || body.length === 0) {
    return { uncheckedAcItems: [], uncheckedDodItems: [] };
  }
  const sections = parseMarkdownSections(body);
  // Union the unchecked boxes across ALL sections matching each pattern
  // family (exact-first ordered), flattening each section past its deeper
  // sub-headings (#1877): a body nesting ACs under `###` subsections, or
  // repeating an AC/DoD heading, must not hide unchecked boxes from the
  // deterministic completeness block. Deduped by text (same box re-read in a
  // duplicate section is the same box).
  const collect = (patterns) => {
    const matched = findAllSectionsByPatterns(sections, patterns);
    const items = [];
    for (let i = 0; i < sections.length; i += 1) {
      if (!matched.includes(sections[i])) continue;
      items.push(...extractUncheckedChecklistItems(flattenSectionDeep(sections, i)));
    }
    return [...new Set(items)];
  };
  return {
    uncheckedAcItems: collect(ACCEPTANCE_SECTION_PATTERNS),
    uncheckedDodItems: collect(DOD_SECTION_PATTERNS),
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
  // `artifact.finding === null` is the explicit "passes the full refinement
  // check" signal (artifact AND — since #1866 — an explicit Non-goals
  // section AND — since #1877 — the full AC/DoD checklist matrix), clearer
  // than reading `hasACs`, whose name understates what it covers.
  if (!targetIsPickup || artifact.finding === null) {
    return { action: "enqueue" };
  }
  // #1866: artifact present but the contract-mandated Non-goals section is
  // absent/empty — a distinct failure with its own guidance.
  if (artifact.finding === MISSING_EXPLICIT_NON_GOALS_FINDING) {
    const reason =
      "Issue carries a refinement artifact but no explicit Non-goals section. " +
      "Add an explicit `## Non-goals` section to the issue body " +
      "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself)) — refusing to enqueue without an explicit Non-goals section.";
    return { action: auto ? "divert" : "block", reason, missing: ["explicit Non-goals section"] };
  }
  // #1877 matrix arms: name the actual missing matrix arm — an AC-only or
  // DoD-only issue is NOT artifact-less, so the generic reason below would be
  // factually wrong and would misdirect the fix.
  if (artifact.finding === MISSING_DOD_CHECKLIST_FINDING) {
    const reason =
      "Issue carries an Acceptance criteria checklist but no Definition of done checklist — the refinement floor is the full AC/DoD/Non-goals matrix (#1877). " +
      "Add a Definition of done checklist to the issue body (mapped to the acceptance criteria) " +
      "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself)) — refusing to enqueue without the full matrix.";
    return { action: auto ? "divert" : "block", reason, missing: ["Definition of done checklist"] };
  }
  if (artifact.finding === MISSING_AC_CHECKLIST_FINDING) {
    const reason =
      "Issue carries a Definition of done checklist but no Acceptance criteria checklist — the refinement floor is the full AC/DoD/Non-goals matrix (#1877). " +
      "Add an Acceptance criteria checklist to the issue body (for the DoD items to map to) " +
      "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself)) — refusing to enqueue without the full matrix.";
    return { action: auto ? "divert" : "block", reason, missing: ["Acceptance criteria checklist"] };
  }
  const missing = [...REFINEMENT_ARTIFACT_SOURCES];
  const reason =
    `Issue has no refinement artifact (none of: ${missing.join(", ")}, and no explicit ## Non-goals section). ` +
    "Refine the issue to the full AC/DoD/Non-goals matrix — an Acceptance criteria checklist, a Definition of done checklist, and an explicit Non-goals section — " +
    "or link a refinement doc (tmp/refinement/*.md), which is a complete artifact on its own " +
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
export async function runPickupRefinementGate({ issueNumber, repo, env, runChild, auto = false, repoRoot = null }) {
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
  // #1866: a linked refinement doc satisfies the gate only when it actually
  // resolves. Paths follow the `tmp/refinement/*.md` convention and are
  // anchored to the caller's repo root (`repoRoot` option, falling back to
  // process.cwd()) — never the ambient cwd of whichever subdirectory the
  // gate happened to run from.
  const docAnchor = repoRoot ?? process.cwd();
  const artifact = detectIssueRefinementArtifact({
    body,
    issueNumber,
    resolveLinkedDoc: (p) => existsSync(path.isAbsolute(p) ? p : path.resolve(docAnchor, p)),
  });
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
