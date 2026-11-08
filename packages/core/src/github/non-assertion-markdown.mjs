// The one non-assertion markdown stripper. The release-approval reader
// (scripts/release/verify-release-approval.mjs) and the operator-owned-line
// registry (operator-owned-lines.mjs) both import it, so the guard strips
// exactly what the reader strips. Pure, dependency-free: the release workflows
// run before `npm ci`.

/**
 * Remove the markdown contexts where the approval phrase is being QUOTED or
 * referenced rather than asserted.
 * Removes, in order: fenced code blocks (backtick/tilde, incl. an unterminated
 * fence to end-of-text), inline code spans (any backtick form, coarsely — see
 * the inline-strip note in the body), indented code blocks (4+ spaces / tab
 * lead), and block-quote lines (`> …`). An agent-authored handoff/summary
 * comment that quotes the phrase inside any of these is not a genuine top-level
 * operator approval, so it must not satisfy the gate. Each stripped span becomes
 * a space so surrounding words never fuse into a false phrase match. The strip
 * only ever refuses more (fail-closed): it can never expose a quoted phrase as a
 * genuine one.
 */
export function stripNonAssertionMarkdown(body) {
  let s = String(body ?? "");
  // Fenced code blocks first (paired ``` / ~~~), then any unterminated fence to
  // end-of-text — an unterminated fence still means "everything after is code".
  s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, " ");
  s = s.replace(/^[ \t]*(?:`{3,}|~{3,})[\s\S]*$/m, " ");
  // Inline code spans: strip everything from the FIRST
  // to the LAST backtick on each line, then blank any lone leftover backtick.
  // This is deliberately coarser than a precise `(`+)…\1` code-span matcher and
  // strictly more fail-closed: a phrase quoted in ANY backtick form — including
  // a CommonMark longer-delimiter span whose content itself contains backticks
  // (`` `x` approve release v… ``), which a precise matcher could leave for the
  // leftover-backtick blanking to re-expose as prose (a fail-OPEN) — is removed.
  // The only cost is over-stripping a phrase sandwiched BETWEEN two separate
  // code spans on one line; that refuses a contrived approval (fail-closed),
  // never accepts a quoted one. A phrase entirely before the first or after the
  // last backtick (a genuine assertion with an unrelated inline code span) still
  // survives.
  s = s.replace(/`[^\n]*`/g, " ");
  s = s.replace(/`/g, " ");
  // Indented code blocks: a line led by 4+ spaces or a tab
  // renders as a code block on GitHub, so a phrase quoted that way is code, not
  // a top-level assertion. Blanking such a line is fail-closed-safe: a genuine
  // one-line "approve release v<version>" is never indented, so this can only
  // ever refuse a quoted occurrence, never a real approval.
  s = s.replace(/^(?: {4,}|\t+).*$/gm, " ");
  // Block-quote lines (`>` at line start, optional leading whitespace).
  s = s.replace(/^[ \t]*>.*$/gm, " ");
  return s;
}
