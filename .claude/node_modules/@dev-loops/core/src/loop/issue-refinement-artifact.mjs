/**
 * Deterministic issue refinement-artifact detection.
 *
 * The authoritative refined-issue artifact is the semantic AC→DoD mapping
 * MATRIX (a two-column table mapping each acceptance-criterion outcome to its
 * required completion evidence) plus an explicit Non-goals section — or a
 * linked refinement doc that is a complete artifact on its own (the doc carries
 * the matrix). Interactive issue-side AC/DoD checklists are NOT a substitute
 * for the matrix; the PR carries the derived self-contained list-form
 * checklists (`derivePrChecklistsFromIssueMatrix`; the PR body is validated by
 * `validateTrackerBackedPrBodySpec`, never this predicate).
 *
 * Detection validates the structural PRESENCE and SHAPE of the mapping table,
 * not its semantic truthfulness (a reviewer responsibility). A matrix that is
 * absent, empty, malformed, or identifier-only fails closed with the matching
 * finding (`missing_ac_dod_matrix`, `malformed_ac_dod_matrix`,
 * `missing_explicit_non_goals`, or `missing_refinement_artifact`). A body
 * carrying only checklists and no matrix fails closed and is re-grilled; no
 * compatibility alias is retained.
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
  ISSUE_BODY_MATRIX: "issue-body-matrix",
  ISSUE_BODY_AC: "issue-body-ac",
  ISSUE_BODY_DOD: "issue-body-dod",
  LINKED_DOC: "linked-doc",
  MISSING: "missing",
});

const REFINEMENT_ARTIFACT_FINDING = "missing_refinement_artifact";

// REFINEMENT_ARTIFACT_SOURCES: the shape of a COMPLETE refinement artifact,
// not a menu where any one entry suffices. A linked refinement doc
// remains a complete artifact on its own.
export const REFINEMENT_ARTIFACT_SOURCES = Object.freeze([
  "AC→DoD mapping matrix (a two-column table)",
  "explicit Non-goals section",
  "linked refinement doc",
]);

/**
 * Finding: refinement artifact present but no explicit Non-goals section.
 * Mirrors the PR-path code (`PR_BODY_SPEC_NARRATIVE_SECTIONS.non_goals.code`)
 * so both spec surfaces name the missing invariant identically.
 */
export const MISSING_EXPLICIT_NON_GOALS_FINDING = "missing_explicit_non_goals";

/**
 * Finding: refinement content present but NO authoritative AC→DoD mapping
 * matrix table. The mapping table is the authoritative issue artifact;
 * issue-side checklists are not a substitute. Fails closed so the issue is
 * re-grilled to add the matrix.
 */
export const MISSING_AC_DOD_MATRIX_FINDING = "missing_ac_dod_matrix";

/**
 * Finding: an AC→DoD mapping table is present but empty (header/separator only)
 * or identifier-only/tautological (cells such as `AC1 → D1` with no concrete
 * criterion or evidence prose). Structural shape validation only — semantic
 * truthfulness stays a reviewer responsibility.
 */
export const MALFORMED_AC_DOD_MATRIX_FINDING = "malformed_ac_dod_matrix";

/**
 * Canonical list of section headings that satisfy the refinement check.
 * Matching is case-insensitive and tolerates trailing/leading whitespace.
 * The two-element minimum keeps the contract explicit:
 *   - one AC section (Acceptance criteria)
 *   - one DoD-style section (DoD or Definition of Done)
 */
const ACCEPTANCE_SECTION_PATTERNS = Object.freeze([
  // Index 0 is the exact-canonical ANCHOR (`^acceptance criteria\b`); the rest
  // are aliases. A decorated-variant canonical heading (`## Acceptance criteria
  // (v2)`) still lands in the exact bucket rather than matching no pattern. The
  // anchor stays distinct from the `/^ac\b/` alias, so a spelled-out canonical
  // heading always outranks an abbreviation-shaped alias heading.
  /^acceptance criteria\b.*$/i,
  /^ac\b.*$/i,
]);

const DOD_SECTION_PATTERNS = Object.freeze([
  // Same anchor-family widening as the AC family. A decorated-variant alias
  // heading (`## DoD (v2)`) must land in the alias bucket, not in no bucket: a
  // `$`-anchored alias silently disarms the PR-side DoD read and false-blocks
  // the issue side.
  /^definition of done\b.*$/i,
  /^done\b.*$/i,
  /^dod\b.*$/i,
]);

/**
 * Normalize a heading name before section-pattern matching. Strip
 * harmless decoration once, at the parse boundary, so decorated canonical
 * headings (`## **Acceptance criteria**`, `## Acceptance criteria:`) still
 * match their pattern family instead of silently disarming the AC/DoD reads.
 * Exact-vs-alias precedence stays intact: a normalized `Acceptance criteria`
 * still matches the exact pattern, a decorated alias still matches its alias
 * family. Strips surrounding emphasis/backtick runs (bold and single-char
 * italic), trailing `:`, closing ATX `#`, and surrounding whitespace.
 * NOT touched: interior text, and leading `#` (never reaches `match[2]`).
 */
function normalizeHeadingName(name) {
  if (typeof name !== "string") return name;
  return name
    // trailing decoration first: closing `##` ATX-style, colons, whitespace
    .replace(/\s*:*\s*$/u, "")
    .replace(/\s*#+\s*$/u, "")
    // surrounding emphasis/backtick runs (any length, must pair; a run may be
    // single-char italic `*`/`_` as well as bold `**`/`__`)
    .replace(/^[*_`]+/u, "")
    .replace(/[*_`]+$/u, "")
    .trim();
}

// Exact canonical headings (pattern index 0 in each family) must outrank loose
// aliases (`/^ac\b/`, `/^dod\b/`) so a matrix-shaped heading (`## AC/DoD
// matrix`) can never hijack the canonical section read. Index 0 is the exact
// canonical match, the rest are aliases.
const EXACT_PATTERN_INDEX = 0;

/**
 * Resolve the section matching a heading-pattern family with exact-first
 * precedence: the first EXACT canonical match (index 0) wins over any
 * earlier alias-only match. Falls back to the first alias match, else null.
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
 * Collect ALL sections matching a heading-pattern family, exact-first ordered.
 * Shares `findSectionByPatterns`'s precedence semantics so single-section and
 * union consumers (PR-body unchecked-box extraction) cannot drift.
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
 * Flatten a section into a body string that extends past `###` sub-headings
 * by joining the section and every following DEEPER-level section up to the
 * next same-or-shallower heading, so nested checklist items stay visible to
 * consumers that must see ALL of a canonical section's boxes.
 */
function flattenSectionDeep(sections, startIndex) {
  const start = sections[startIndex];
  // Anti-spoof: the raw sub-heading NAME is NEVER re-injected into the text the
  // checklist parser re-parses. A fence-opening name (`### ``` `) would corrupt
  // fence state and eat real boxes (fail-open); a checkbox-shaped name
  // (`### - [ ] fake`) would count as a phantom unchecked item (fail-closed).
  // Only already-classified bodyLines are joined; real boxes under sub-headings
  // stay visible because their bodyLines still join normally.
  const parts = [start.bodyLines.join("\n")];
  for (let i = startIndex + 1; i < sections.length; i += 1) {
    if (sections[i].level <= start.level) break;
    parts.push(sections[i].bodyLines.join("\n"));
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
 * (checkboxes) so the two anti-spoof layers cannot drift.
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
 * headings that carry no real spec (gate integrity).
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
        // Normalize the captured name so decorated canonical headings
        // (`## **Acceptance criteria**`) match the section patterns. The raw
        // form is never re-parsed as body text, so it is not retained.
        name: normalizeHeadingName(match[2]),
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
 * Parse bullet/checkbox items from a section body into item states. A checkbox
 * item — any GFM/CommonMark task-list marker (`-`/`*`/`+` bullets, ordered
 * `N.`/`N)`, blockquote-nested `> - [ ]`; parity with
 * tick-verified-checkboxes.mjs) — becomes `{ text, checked }`, where `checked`
 * is true only for a ticked `[x]`/`[X]` marker read from the captured marker
 * group, never a whole-line re-test. A top-level plain bullet (`- text`, dash
 * at column 0) becomes `{ text, checked: null }` — it has no checkbox. Empty
 * placeholders (`- [ ]` with no text) are skipped. Code-fenced lines are
 * skipped (same fence logic as parseMarkdownSections) so a body cannot spoof
 * the AC/DoD gate with code-fenced checkboxes.
 *
 * Shared by `extractChecklistItems` and `extractUncheckedChecklistItems` so the
 * two never drift on what counts as an item or on the checkbox-state read.
 * Only called on an already-recognized AC/DoD section, so counting
 * plain bullets never affects prose sections.
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
    // Checklist item: GFM/CommonMark task-list markers (`-`/`*`/`+` bullets,
    // ordered `N.`/`N)`, blockquote-nested `> - [ ]`) — grammar parity with
    // tick-verified-checkboxes.mjs so every form surfaced as unchecked is
    // flippable by the tick tool. Push only when the line carries text, so
    // empty placeholders are skipped. The tick state comes from the CAPTURED
    // marker group, never a second whole-line re-test: an unanchored
    // `/\[[xX]\]/.test(line)` would read an unchecked box whose label merely
    // mentions `[x]` (`- [ ] verify [x] flags`) as checked, a fail-open the
    // marker-anchored read cannot produce.
    const checkboxMatch =
      /^\s*(?:>|\s)*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s+(.+?))?\s*$/u.exec(line);
    if (checkboxMatch) {
      const text = (checkboxMatch[2] ?? "").trim();
      if (text.length > 0) {
        // `checked` is true only for a ticked marker (`[x]`/`[X]`); a space
        // marker (`[ ]`) is false — regardless of what the label text says.
        // A plain bullet has no checkbox, so it stays `null` below — it is
        // neither ticked nor unticked and does not count as an unticked AC.
        items.push({ text, checked: checkboxMatch[1] !== " " });
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
 * stays byte-identical to its original shape.
 */
export function extractChecklistItems(sectionBody) {
  return parseChecklistItems(sectionBody).map((item) => item.text);
}

/**
 * Extract the text of UNCHECKED checkbox items (`- [ ]`) from a section body.
 * A ticked box (`- [x]`/`- [X]`) and a plain bullet (no checkbox) are both
 * excluded — only an actual unticked checkbox is an "unticked AC item"
 * (ACCEPT-CRITERIA-VERIFY-AND-REFLECT). Empty placeholders are skipped.
 * Thin wrapper over `parseChecklistItems` so the unticked read never drifts
 * from `extractChecklistItems` on what counts as a checklist item.
 */
export function extractUncheckedChecklistItems(sectionBody) {
  return parseChecklistItems(sectionBody)
    .filter((item) => item.checked === false)
    .map((item) => item.text);
}

// ---------------------------------------------------------------------------
// AC→DoD mapping matrix detection
// ---------------------------------------------------------------------------
// The authoritative refined-issue artifact is a semantic AC→DoD mapping table:
// a GFM pipe table whose rows map each acceptance-criterion outcome to its
// required completion evidence. This is the "matrix on the issue" half of
// "matrix on the issue, checklist on the PR". Detection validates the table's
// PRESENCE and SHAPE only — its semantic truthfulness stays a reviewer duty.

// Heading families that name the mapping-matrix section. A qualifying table
// under one of these headings is treated as the matrix even when its column
// headers do not name criterion/evidence explicitly.
const MATRIX_SECTION_PATTERNS = Object.freeze([
  /\bac\b.*\bdod\b.*\b(matrix|mapping|map)\b/i,
  /\b(acceptance|criteri\w*)\b.*\b(matrix|mapping|map)\b/i,
  /\bmapping (matrix|table)\b/i,
  /\bac\s*(?:\/|→|->|to)\s*dod\b/i,
]);

// Header column families: col0 names the criterion side, col1 the evidence
// side. Recognizes an unheaded but clearly criterion→evidence table anywhere in
// the body. Kept STRONG on purpose: a generic status table like
// `| Outcome | Done |` must NOT be mistaken for the refinement matrix — only
// headers naming acceptance criteria AND completion evidence / DoD qualify
// without a matrix heading. A matrix under a weaker header still qualifies via
// its `## AC / DoD matrix` heading (MATRIX_SECTION_PATTERNS).
const MATRIX_CRITERION_HEADER = /\b(criteri\w*|acceptance|ac)\b/i;
const MATRIX_EVIDENCE_HEADER = /\b(evidence|dod|definition of done)\b/i;

const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/u;

/** Split one GFM table row into trimmed cell strings (drops leading/trailing pipes). */
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // ponytail: no escaped-pipe (`\|`) handling — refined-issue matrix cells are
  // short prose, not pipe-bearing code. Add a split-on-unescaped-pipe pass only
  // if a real matrix cell ever needs a literal `|`.
  return s.split("|").map((c) => c.trim());
}

/**
 * Count real prose words in a matrix cell: runs of >=3 letters that are not the
 * `dod` identifier token. Bare identifiers (`AC1`, `D1`, `DoD`), arrows, and
 * digits contribute nothing, so a tautological/identifier-only cell scores 0.
 */
function cellProseWordCount(cell) {
  if (typeof cell !== "string") return 0;
  const stripped = cell.replace(/[*_`]+/gu, " ");
  const runs = stripped.match(/[A-Za-z]{3,}/gu) ?? [];
  return runs.filter((w) => w.toLowerCase() !== "dod").length;
}

// A matrix data row is semantic when BOTH mapped cells carry at least one real
// prose word. This rejects identifier-only/tautological rows (`AC1 | D1`,
// `AC1 → D1`, `DoD`, empty cells) WITHOUT false-rejecting a terse-but-real
// mapping (`Feature works | Regression test added`). The threshold is
// deliberately >=1, not >=2: reject bare identifiers, do not mandate a minimum
// verbosity.
function rowIsSemantic(criterion, evidence) {
  return cellProseWordCount(criterion) >= 1 && cellProseWordCount(evidence) >= 1;
}

/**
 * Resolve which columns hold the criterion and evidence by HEADER NAME, so a
 * leading index column (`#`, `No`, `Idx`, empty, …) shifts the mapped columns
 * off positions 0/1 without breaking detection. Returns `{ criterionCol,
 * evidenceCol }` when both header families are named in distinct columns.
 * Falls back to positions 0/1 for a matrix-heading table whose columns are not
 * explicitly named (the pre-index-aware behavior); returns null otherwise.
 */
function resolveMatrixColumns(headerCells, underHeading) {
  const criterionCol = headerCells.findIndex((h) => MATRIX_CRITERION_HEADER.test(h ?? ""));
  const evidenceCol = headerCells.findIndex((h) => MATRIX_EVIDENCE_HEADER.test(h ?? ""));
  if (criterionCol >= 0 && evidenceCol >= 0 && criterionCol !== evidenceCol) {
    return { criterionCol, evidenceCol };
  }
  if (underHeading) return { criterionCol: 0, evidenceCol: 1 };
  return null;
}

/**
 * Parse every GFM pipe table in a Markdown body (skipping fenced code spans via
 * the shared `stepFence`). Returns an array of
 * `{ heading, headerCells, rows }` where `rows` is the list of data rows (each
 * an array of trimmed cell strings). A table is a header line containing `|`,
 * a delimiter row (`|---|---|`), and >=0 data rows.
 */
function parseMarkdownTables(body) {
  if (typeof body !== "string" || body.length === 0) return [];
  const lines = body.split(/\r?\n/u);
  const tables = [];
  let fence = null;
  let heading = null;
  let i = 0;
  while (i < lines.length) {
    const step = stepFence(fence, lines[i]);
    fence = step.fence;
    if (step.insideFence) {
      i += 1;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[i]);
    if (headingMatch) {
      heading = normalizeHeadingName(headingMatch[2]);
      i += 1;
      continue;
    }
    const header = lines[i];
    const delim = lines[i + 1];
    if (header.includes("|") && typeof delim === "string" && TABLE_DELIMITER_RE.test(delim)) {
      const headerCells = splitTableRow(header);
      const rows = [];
      let j = i + 2;
      while (j < lines.length) {
        const rowStep = stepFence(fence, lines[j]);
        // A table ends at the first non-fence line without a pipe, or a heading.
        if (rowStep.insideFence) break;
        if (!lines[j].includes("|") || /^#{1,6}\s+/u.test(lines[j])) break;
        rows.push(splitTableRow(lines[j]));
        j += 1;
      }
      tables.push({ heading, headerCells, rows });
      i = j;
      continue;
    }
    i += 1;
  }
  return tables;
}

/**
 * Detect the authoritative AC→DoD mapping matrix in an issue body.
 *
 * A qualifying table has >=2 columns and EITHER sits under a matrix-named
 * heading ({@link MATRIX_SECTION_PATTERNS}) OR names criterion/evidence-like
 * columns in its header. The matrix is VALID when it carries at least one
 * SEMANTIC data row (both mapped cells carry real prose — see
 * {@link rowIsSemantic}); a header/separator-only table (no data rows) or a
 * table whose rows are all identifier-only/tautological (`AC1 → D1`) is
 * malformed.
 *
 * @param {string} [body]
 * @returns {{ found: boolean, valid: boolean, rowCount: number, rows: { criterion: string, evidence: string }[], reason: string }}
 */
export function detectAcDodMatrix(body = "") {
  const tables = parseMarkdownTables(body);
  const candidates = [];
  for (const t of tables) {
    if (!Array.isArray(t.headerCells) || t.headerCells.length < 2) continue;
    const underHeading = typeof t.heading === "string" &&
      MATRIX_SECTION_PATTERNS.some((p) => p.test(t.heading));
    const cols = resolveMatrixColumns(t.headerCells, underHeading);
    if (cols) candidates.push({ ...t, ...cols });
  }
  if (candidates.length === 0) {
    return { found: false, valid: false, rowCount: 0, rows: [], reason: "No AC→DoD mapping matrix table found." };
  }
  // Prefer the first candidate that has >=1 semantic row; otherwise report the
  // first candidate as malformed.
  for (const table of candidates) {
    const { criterionCol, evidenceCol } = table;
    const minCells = Math.max(criterionCol, evidenceCol) + 1;
    const semanticRows = [];
    for (const cells of table.rows) {
      if (cells.length < minCells) continue;
      const criterion = cells[criterionCol] ?? "";
      const evidence = cells[evidenceCol] ?? "";
      if (rowIsSemantic(criterion, evidence)) {
        semanticRows.push({ criterion, evidence });
      }
    }
    if (semanticRows.length > 0) {
      return {
        found: true,
        valid: true,
        rowCount: semanticRows.length,
        rows: semanticRows,
        reason: `Found an AC→DoD mapping matrix with ${semanticRows.length} semantic row(s).`,
      };
    }
  }
  const dataRowCount = candidates[0].rows.length;
  return {
    found: true,
    valid: false,
    rowCount: 0,
    rows: [],
    reason: dataRowCount === 0
      ? "AC→DoD mapping matrix table is empty (header/separator only, no data rows)."
      : "AC→DoD mapping matrix table is identifier-only/tautological (no row maps a concrete criterion to concrete completion evidence).",
  };
}

/**
 * Project an issue's AC→DoD mapping matrix into self-contained list-form PR
 * checklists: the PR carries list-form Acceptance criteria and
 * Definition of done checkboxes derived from the matrix — never a matrix/table,
 * never checkboxes inside table cells. Accepts a pre-parsed `matrix` (from
 * {@link detectAcDodMatrix}) or a raw `body` to parse. Fails closed on a
 * missing/malformed matrix rather than emitting empty checklists.
 *
 * @param {{ matrix?: ReturnType<typeof detectAcDodMatrix>, body?: string }} input
 * @returns {{ acChecklist: string[], dodChecklist: string[], markdown: string }}
 */
export function derivePrChecklistsFromIssueMatrix({ matrix = null, body = "" } = {}) {
  const m = matrix ?? detectAcDodMatrix(body);
  if (!m || !m.found || !m.valid || !Array.isArray(m.rows) || m.rows.length === 0) {
    throw Object.assign(
      new Error(`derivePrChecklistsFromIssueMatrix: ${m?.reason ?? "no valid AC→DoD mapping matrix to project"}`),
      { code: "MALFORMED_MATRIX_SOURCE" },
    );
  }
  const dedupe = (items) => [...new Set(items.map((s) => s.trim()).filter((s) => s.length > 0))];
  const acChecklist = dedupe(m.rows.map((r) => r.criterion));
  const dodChecklist = dedupe(m.rows.map((r) => r.evidence));
  const render = (heading, items) =>
    `## ${heading}\n\n${items.map((t) => `- [ ] ${t}`).join("\n")}\n`;
  const markdown = `${render("Acceptance criteria", acChecklist)}\n${render("Definition of done", dodChecklist)}`;
  return { acChecklist, dodChecklist, markdown };
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
 * The floor is a valid AC→DoD mapping matrix (or a resolvable linked refinement
 * doc) AND an explicit, non-empty Non-goals section. A missing Non-goals
 * section fails closed with the distinct finding
 * `MISSING_EXPLICIT_NON_GOALS_FINDING`; its matcher is shared with
 * `validatePrBodySpec` so the two spec surfaces cannot drift. `hasACs` is true
 * only when the FULL check passes, so every `.hasACs` consumer fails closed with
 * no call-site change. `acItems`/`dodItems` stay populated for downstream
 * consumers: from the issue's own checklist sections when present, otherwise
 * projected from the matrix rows.
 *
 * `resolveLinkedDoc` (optional): a `(path) => boolean` callback verifying that a
 * linked `tmp/refinement/*.md` doc actually resolves (e.g. `existsSync`). When
 * not supplied the predicate stays pure/no-I/O and `linkedDoc` carries no
 * `resolves` field; when supplied and the doc does not resolve, the linked doc
 * does not satisfy the check (other artifact sources still count).
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
 *   matrix: { found: boolean, valid: boolean, rowCount: number, rows: { criterion: string, evidence: string }[], reason: string },
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
      matrix: { found: false, valid: false, rowCount: 0, rows: [], reason: "empty-body" },
      reason: "Issue body is empty; no matrix/ACs/DoD/linked-doc can be detected.",
      finding: REFINEMENT_ARTIFACT_FINDING,
    };
  }

  const sections = parseMarkdownSections(body);
  const sectionNames = sections.map((s) => s.name);

  const acceptanceSection = findSectionByPatterns(sections, ACCEPTANCE_SECTION_PATTERNS);
  const dodSection = findSectionByPatterns(sections, DOD_SECTION_PATTERNS);

  // CONSUMER-CONTRACT BOUNDARY (intentional asymmetry): the issue-side
  // reads above are strict — ONE exact-first section, NO deep flattening —
  // while extractPrBodyUncheckedChecklistItems (PR side) unions ALL matching
  // sections and deep-flattens past ### sub-headings. The issue side is a
  // presence check of the refinement matrix: a checklist hidden entirely
  // under a ### sub-heading fails CLOSED (reported missing, the issue stays
  // parked for human refinement). The PR side enforces a hard gate over the
  // derived checklist: it must NEVER miss an unchecked box, so it fails open
  // on nothing — it unions and deep-flattens. Do not "unify" these reads: the
  // two failure directions are both deliberate (issue side = safe direction,
  // PR side = fail-closed gate).

  const acItems = acceptanceSection ? extractChecklistItems(acceptanceSection.bodyLines.join("\n")) : [];
  // Unticked AC checkboxes (`- [ ]`) of the spec-of-record — the
  // ACCEPT-CRITERIA-VERIFY-AND-REFLECT precondition a clean pre_approval_gate
  // must refuse on. Only actual unticked checkboxes count; a ticked
  // box and a plain bullet (no checkbox) are both excluded.
  const uncheckedAcItems = acceptanceSection ? extractUncheckedChecklistItems(acceptanceSection.bodyLines.join("\n")) : [];
  const dodItems = dodSection ? extractChecklistItems(dodSection.bodyLines.join("\n")) : [];

  let linkedDoc = detectLinkedRefinementDoc(body);
  let linkedDocResolves = linkedDoc.found;
  if (linkedDoc.found && typeof resolveLinkedDoc === "function") {
    linkedDocResolves = resolveLinkedDoc(linkedDoc.path) === true;
    linkedDoc = { ...linkedDoc, resolves: linkedDocResolves };
  }

  // explicit Non-goals section required on a refined tracker-backed
  // issue body — same matcher the PR-body spec path uses, so the two cannot
  // drift. A heading-only or fenced-only section does not count
  // (sectionHasBody anti-spoof).
  const hasNonGoals = sectionHasBody(
    findSectionByPatterns(sections, PR_BODY_SPEC_NARRATIVE_SECTIONS.non_goals.patterns),
  );

  // the authoritative issue artifact is the AC→DoD mapping MATRIX, not
  // duplicate interactive issue-side checklists. Detect its presence + shape.
  const matrix = detectAcDodMatrix(body);

  // Keep acItems/dodItems populated for downstream consumers (gate context,
  // coordination state) even when the issue carries only the matrix and no
  // interactive checklists: project the matrix rows into AC/DoD items.
  const effectiveAcItems = acItems.length > 0 ? acItems : matrix.rows.map((r) => r.criterion.trim()).filter(Boolean);
  const effectiveDodItems = dodItems.length > 0 ? dodItems : matrix.rows.map((r) => r.evidence.trim()).filter(Boolean);

  const base = {
    hasNonGoals,
    acItems,
    uncheckedAcItems,
    dodItems,
    sections: sectionNames,
    linkedDoc,
    matrix,
  };

  // A linked refinement doc remains a complete artifact on its own (the doc
  // carries the matrix). It still requires an explicit Non-goals section.
  if (linkedDocResolves) {
    if (!hasNonGoals) {
      return {
        ...base,
        hasACs: false,
        source: REFINEMENT_SOURCE.LINKED_DOC,
        reason:
          "Issue body links a refinement doc but has no explicit Non-goals section; " +
          "the tracker-backed refinement contract requires one (rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; " +
          "e.g. run the loop-grill synthesis). Refusing: the refinement check fails closed without an explicit Non-goals section.",
        finding: MISSING_EXPLICIT_NON_GOALS_FINDING,
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

  // Matrix present but empty/malformed/identifier-only: fail closed.
  if (matrix.found && !matrix.valid) {
    return {
      ...base,
      hasACs: false,
      source: REFINEMENT_SOURCE.ISSUE_BODY_MATRIX,
      reason:
        `Issue body carries an AC→DoD mapping matrix but it is not a valid semantic mapping (${matrix.reason}); ` +
        "the refinement contract requires a real criterion→completion-evidence mapping " +
        "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run the loop-grill synthesis). " +
        "Refusing: the refinement check fails closed on a malformed/identifier-only matrix.",
      finding: MALFORMED_AC_DOD_MATRIX_FINDING,
    };
  }

  // Matrix present and valid: the refinement floor is the matrix + explicit
  // Non-goals. Interactive issue-side AC/DoD checklists are NOT required.
  if (matrix.found && matrix.valid) {
    if (!hasNonGoals) {
      return {
        ...base,
        hasACs: false,
        source: REFINEMENT_SOURCE.ISSUE_BODY_MATRIX,
        reason:
          "Issue body carries a valid AC→DoD mapping matrix but no explicit Non-goals section; " +
          "the tracker-backed refinement contract requires one (rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; " +
          "e.g. run the loop-grill synthesis). Refusing: the refinement check fails closed without an explicit Non-goals section.",
        finding: MISSING_EXPLICIT_NON_GOALS_FINDING,
      };
    }
    return {
      ...base,
      hasACs: true,
      source: REFINEMENT_SOURCE.ISSUE_BODY_MATRIX,
      acItems: effectiveAcItems,
      dodItems: effectiveDodItems,
      reason: `Found a valid AC→DoD mapping matrix with ${matrix.rowCount} semantic row(s) and an explicit Non-goals section.`,
      finding: null,
    };
  }

  // Matrix absent. If the body carries AC/DoD checklist content it is a
  // checklist-bearing issue missing the authoritative matrix during
  // migration: fail closed on the missing matrix so it is re-grilled. A body
  // with no matrix and no AC/DoD content (prose-only, or only a Non-goals
  // section / an unresolved linked-doc mention) stays the pre-existing
  // missing_refinement_artifact.
  if (acItems.length > 0 || dodItems.length > 0) {
    return {
      ...base,
      hasACs: false,
      source: REFINEMENT_SOURCE.MISSING,
      reason:
        "Issue body carries Acceptance criteria / Definition of done content but no authoritative AC→DoD mapping matrix table; " +
        "under matrix-on-issue/checklist-on-PR the mapping table is the authoritative issue artifact " +
        "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run the loop-grill synthesis). " +
        "Refusing: the refinement check fails closed without the mapping matrix.",
      finding: MISSING_AC_DOD_MATRIX_FINDING,
    };
  }

  return {
    ...base,
    hasACs: false,
    source: REFINEMENT_SOURCE.MISSING,
    acItems: [],
    uncheckedAcItems: [],
    dodItems: [],
    reason: "Issue body has no AC→DoD mapping matrix, no Acceptance criteria/DoD content, and no linked refinement doc.",
    finding: REFINEMENT_ARTIFACT_FINDING,
  };
}

/**
 * PR-body-as-spec invariant sections (lightweight path).
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
 * `#N` or the cross-repo `owner/repo#N` form. Required linkage on the PR body:
 * five lightweight PRs merged without this and none auto-closed their issue.
 */
const CLOSING_ISSUE_REFERENCE_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/giu;

export function extractClosingIssueNumbers(body) {
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
  // it cannot spoof the narrative-invariant gate (same stepFence as
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
 * (>=1 checklist item), Open questions/risks, and — unless issue-less mode is
 * requested — a GitHub closing-keyword issue reference. Reuses the generic
 * markdown logic so there is no parallel validator. Fails closed: every missing
 * invariant is reported under its distinct `missing_*` code. Pure; no I/O.
 *
 * Issue-less mode (`issueLess: true`): the closing-issue linkage flips from
 * REQUIRED to FORBIDDEN (the PR is the sole artifact), failing closed under
 * `unexpected_closing_issue_reference` — distinct from
 * `missing_closing_issue_reference` (tracker-backed, the default).
 * `expectedIssue` and `issueLess` are mutually exclusive; callers pick exactly
 * one mode.
 *
 * `requireOpenQuestions` (default `true`): the tracker-backed PR-description
 * contract does not name an Open questions/risks section; pass `false` (see
 * `validateTrackerBackedPrBodySpec`) to skip that check without touching any
 * other invariant.
 *
 * @param {{ body?: string, expectedIssue?: number, issueLess?: boolean, requireOpenQuestions?: boolean }} input
 * @returns {{ checker: "validate-pr-body-spec", ok: boolean, errors: { code: string, message: string }[], sections: string[], acItems: string[], dodItems: string[], closesIssues: number[] }}
 */

// ---------------------------------------------------------------------------
// Grill sub-loop body predicates (GRILL-SUBLOOP-*)
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
 * (skills/docs/copilot-loop-operations.md "PR description contract"):
 * Acceptance criteria + Definition of done checklists, an explicit
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
 * Extract the UNCHECKED AC/DoD checkbox items from a PR body's own
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
 * draft-exit `validateTrackerBackedPrBodySpec` check already owns
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
  // sub-headings: a body nesting ACs under `###` subsections, or
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
  // check" signal (a valid AC→DoD mapping matrix + an explicit Non-goals
  // section, or a resolvable linked refinement doc + Non-goals), clearer than
  // reading `hasACs`, whose name understates what it covers.
  if (!targetIsPickup || artifact.finding === null) {
    return { action: "enqueue" };
  }
  // artifact present but the contract-mandated Non-goals section is
  // absent/empty — a distinct failure with its own guidance.
  if (artifact.finding === MISSING_EXPLICIT_NON_GOALS_FINDING) {
    const reason =
      "Issue carries a refinement artifact but no explicit Non-goals section. " +
      "Add an explicit `## Non-goals` section to the issue body " +
      "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself)) — refusing to enqueue without an explicit Non-goals section.";
    return { action: auto ? "divert" : "block", reason, missing: ["explicit Non-goals section"] };
  }
  // matrix present but empty/malformed/identifier-only — name the shape
  // defect so the fix targets the mapping table, not a missing section.
  if (artifact.finding === MALFORMED_AC_DOD_MATRIX_FINDING) {
    const reason =
      "Issue carries an AC→DoD mapping matrix but it is empty, malformed, or identifier-only/tautological (e.g. `AC1 → D1`). " +
      "Rewrite the mapping table so each row maps a concrete acceptance-criterion outcome to concrete completion evidence " +
      "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself)) — refusing to enqueue on a malformed matrix.";
    return { action: auto ? "divert" : "block", reason, missing: ["valid AC→DoD mapping matrix"] };
  }
  // matrix absent (whether or not the body carries duplicate issue-side
  // checklists) — the mapping table is the authoritative issue artifact.
  if (artifact.finding === MISSING_AC_DOD_MATRIX_FINDING) {
    const reason =
      "Issue carries Acceptance criteria / Definition of done content but no authoritative AC→DoD mapping matrix — under matrix-on-issue/checklist-on-PR the mapping table is the authoritative issue artifact (#1951). " +
      "Add a semantic AC→DoD mapping table to the issue body (each acceptance-criterion outcome mapped to its required completion evidence), and an explicit Non-goals section if one is not already present " +
      "(rule ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR; e.g. run `/dev-loops:loop-grill <issue> --auto` (or `/loop-grill <issue> --auto` in the dev-loops repo itself)) — refusing to enqueue without the mapping matrix.";
    return { action: auto ? "divert" : "block", reason, missing: ["AC→DoD mapping matrix"] };
  }
  const missing = [...REFINEMENT_ARTIFACT_SOURCES];
  const reason =
    `Issue has no refinement artifact (none of: ${missing.join(", ")}). ` +
    "Refine the issue to the authoritative AC→DoD mapping matrix (a two-column table mapping each acceptance-criterion outcome to its required completion evidence) plus an explicit Non-goals section — " +
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
  // a linked refinement doc satisfies the gate only when it actually
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
