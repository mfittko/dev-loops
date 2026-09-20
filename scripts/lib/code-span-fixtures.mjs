/**
 * Shared CommonMark code-span fixture set for approval / marker-text stripping.
 *
 * Any gate or reviewer that validates approval or marker text (for example the
 * release-approval gate's `stripNonAssertionMarkdown` in
 * scripts/release/verify-release-approval.mjs) can import this set to prove its
 * stripper treats every enumerated code-span form as CODE — never as a prose
 * assertion that could satisfy a marker match. The fail-open class this guards
 * is a nested / multi-backtick CommonMark code span surviving a naive stripping
 * regex; the shared set gives the internal gate its own independent coverage
 * rather than relying on an external reviewer as the backstop.
 *
 * `treatment` is `"code"` for every form here: the marker phrase is quoted in a
 * context CommonMark renders as code, so a correct stripper removes it and it
 * can never satisfy the marker match. Unterminated fences must FAIL CLOSED —
 * everything after an unterminated fence is code, so the marker is still
 * stripped. These are the forms enumerated by the fixture set:
 *   - single-backtick inline spans
 *   - multi-backtick (longer-delimiter) spans
 *   - spans whose content contains an inner backtick pair
 *   - unterminated fences (fail closed)
 * plus the tilde-fence and indented-code-block forms GitHub also renders as
 * code.
 *
 * No third-party imports: pure data + one builder, so a deps-free release-path
 * script (see scripts/lib/direct-run.mjs) could import it too.
 */

/**
 * The marker forms, parameterized by the marker phrase. Each `wrap(marker)`
 * returns a comment body that embeds `marker` inside a code context. `category`
 * names the AC-enumerated class the form covers.
 */
export const CODE_SPAN_FORMS = [
  {
    name: "single-backtick inline span",
    category: "single-backtick span",
    wrap: (m) => `Post \`${m}\` as a comment.`,
  },
  {
    name: "double-backtick span",
    category: "multi-backtick delimiter",
    wrap: (m) => `See the runbook step \`\`${m}\`\` (double-backtick span).`,
  },
  {
    name: "longer-delimiter (quad-backtick) span",
    category: "multi-backtick delimiter",
    wrap: (m) => `\`\`\`\` ${m} \`\`\`\``,
  },
  {
    name: "span whose content is an inner backtick pair",
    category: "inner-backtick pair",
    wrap: (m) => `\`\` \`${m}\` \`\``,
  },
  {
    name: "inner-backtick pair preceding the marker in one span",
    category: "inner-backtick pair",
    wrap: (m) => `\`\` \`x\` ${m} \`\``,
  },
  {
    name: "triple-backtick fenced block",
    category: "multi-backtick delimiter",
    wrap: (m) => `\`\`\`\n${m}\n\`\`\``,
  },
  {
    name: "tilde fenced block",
    category: "multi-backtick delimiter",
    wrap: (m) => `~~~\n${m}\n~~~`,
  },
  {
    name: "unterminated backtick fence (fail closed)",
    category: "unterminated fence",
    wrap: (m) => `\`\`\`\n${m}`,
  },
  {
    name: "unterminated tilde fence (fail closed)",
    category: "unterminated fence",
    wrap: (m) => `~~~\n${m}`,
  },
  {
    name: "four-space indented code block",
    category: "indented code block",
    wrap: (m) => `    ${m}`,
  },
  {
    name: "tab-indented code block",
    category: "indented code block",
    wrap: (m) => `\t${m}`,
  },
];

/**
 * Build the fixture set for a given marker phrase. Each fixture is
 * `{ name, category, body, treatment: "code" }`. A stripper is correct on the
 * set when the marker text no longer appears in the stripped body of any
 * fixture (so it can never satisfy the marker match).
 */
export function buildCodeSpanFixtures(marker) {
  if (typeof marker !== "string" || marker.trim().length === 0) {
    throw new Error("buildCodeSpanFixtures requires a non-empty marker string");
  }
  return CODE_SPAN_FORMS.map((f) => ({
    name: f.name,
    category: f.category,
    body: f.wrap(marker),
    treatment: "code",
  }));
}

/**
 * The release-approval marker phrase — the concrete instance of this fail-open
 * class. Exported so the release-gate coverage consumes the shared set rather
 * than a private copy.
 */
export const APPROVAL_MARKER = "approve release v1.0.0";

/** The fixture set for the release-approval marker. */
export const APPROVAL_CODE_SPAN_FIXTURES = buildCodeSpanFixtures(APPROVAL_MARKER);
