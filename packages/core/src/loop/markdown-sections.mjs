/**
 * Shared `## <heading>` markdown-section helpers. A "section" is an H2
 * heading line and everything up to (but not including) the next H2.
 */

/** Build the case-insensitive, multiline `^## <heading>$` matcher shared by
 * extractSection/hasSection/stripSection. */
export function buildSectionHeadingPattern(headingText) {
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^##\\s+${escapedHeading}\\s*$`, "imu");
}

/**
 * Extract the trimmed body of a `## <headingText>` section from `body`, or
 * null when the heading isn't present.
 */
export function extractSection(body, headingText) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }
  const headingPattern = buildSectionHeadingPattern(headingText);
  const match = headingPattern.exec(body);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index + match[0].length;
  const remaining = body.slice(start);
  const nextHeadingMatch = /^##\s+/imu.exec(remaining);
  const end = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? start + nextHeadingMatch.index
    : body.length;
  return body.slice(start, end).trim();
}
