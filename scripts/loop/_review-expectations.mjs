/**
 * Review expectations section (issue 2588 slice 3): the implementation-relevant
 * review angle criteria of the merged config, bounded for inline use. Tooling
 * derives it from repository files only; it adds no authority and no gate
 * evidence. The brief builds it, and the fixer role adapter and verifier accept it
 * as an optional work-order section.
 *
 * Shape: { angles: [{ angle, criterion }], overflow?: { angles: [name], reads: [{ path, sha256 }] } }
 * Overflow carries names and digest-pinned config reads, never criterion text.
 */
export const EXPECTATIONS_MAX_CRITERIA = 12;
export const EXPECTATIONS_MAX_CHARS = 2000;

const SHA256_RE = /^[a-f0-9]{64}$/u;

/**
 * Split ordered `{ angle, criterion }` entries into the inline part (at most 12
 * criteria and 2,000 criterion characters) and the overflow, which keeps order.
 * `overflowReads` are the digest-pinned config files holding the overflow text.
 */
export function buildReviewExpectations(entries, overflowReads = []) {
  const angles = [];
  let chars = 0;
  let cut = entries.length;
  for (const [index, entry] of entries.entries()) {
    if (angles.length >= EXPECTATIONS_MAX_CRITERIA || chars + entry.criterion.length > EXPECTATIONS_MAX_CHARS) { cut = index; break; }
    chars += entry.criterion.length;
    angles.push({ angle: entry.angle, criterion: entry.criterion });
  }
  const rest = entries.slice(cut);
  return rest.length === 0 ? { angles } : { angles, overflow: { angles: rest.map((entry) => entry.angle), reads: overflowReads } };
}

/** Returns an error message for a malformed section, else null. */
export function expectationsSectionError(section) {
  if (section === undefined) return null;
  const bad = (reason) => `expectations section ${reason}`;
  if (!section || typeof section !== "object" || Array.isArray(section)) return bad("must be an object");
  if (!Array.isArray(section.angles) || section.angles.length > EXPECTATIONS_MAX_CRITERIA
    || section.angles.some((a) => typeof a?.angle !== "string" || typeof a.criterion !== "string" || a.criterion === "")) return bad(`needs at most ${EXPECTATIONS_MAX_CRITERIA} { angle, criterion } entries`);
  if (section.angles.reduce((sum, a) => sum + a.criterion.length, 0) > EXPECTATIONS_MAX_CHARS) return bad(`holds more than ${EXPECTATIONS_MAX_CHARS} criterion characters`);
  if (section.overflow !== undefined) {
    const { overflow } = section;
    if (!Array.isArray(overflow?.angles) || overflow.angles.length === 0 || overflow.angles.some((n) => typeof n !== "string")
      || !Array.isArray(overflow.reads) || overflow.reads.some((r) => typeof r?.path !== "string" || !SHA256_RE.test(r.sha256 ?? ""))) return bad("overflow needs angle names and digest-pinned reads");
  }
  return null;
}

/** Render the section for a work-order prompt. An absent section renders nothing. */
export function renderExpectationsSection(section) {
  if (!section) return "";
  const lines = section.angles.map((a) => `- ${a.angle}: ${a.criterion.replace(/\s+/g, " ").trim()}`);
  if (section.overflow) {
    lines.push(`- More criteria for ${section.overflow.angles.join(", ")}: read ${section.overflow.reads.map((r) => `${r.path} (sha256 ${r.sha256})`).join(", ")}.`);
  }
  return `## Review expectations\n\nThe reviewers apply these criteria to your change. They create no gate evidence.\n\n${lines.join("\n")}\n\n`;
}
