import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";

const fromRepoRoot = (relativePath) => new URL(`../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), "utf8");

const USER_FACING_AGENT_SURFACE = Object.freeze({
  "dev-loop": { kind: "workflow-entrypoint" },
});

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected frontmatter block");

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) continue;

    const [, key, rawValue] = entry;
    const value = rawValue.trim();
    if (value === "true") {
      frontmatter[key] = true;
      continue;
    }
    if (value === "false") {
      frontmatter[key] = false;
      continue;
    }
    frontmatter[key] = value.replace(/^"([\s\S]*)"$/, "$1");
  }

  return frontmatter;
}

function assertMatchesAll(content, patterns, label = "content") {
  for (const pattern of patterns) {
    assert.match(content, pattern, `${label} should match ${pattern}`);
  }
}

// --- Prose-structure helpers -------------------------------------------------
// Doc contracts protect obligations, not sentences. These let a contract test
// assert that an obligation is STRUCTURALLY present (the right tokens co-occur
// in one clause, the right steps appear in the right order) without pinning the
// wording or the line wrapping a future edit is free to change. Exact pins stay
// appropriate for API literals, CLI flags, rule IDs, and verbatim payloads.

/** Collapse whitespace so a reflowed or rewrapped passage reads the same. */
function flat(content) {
  return content.replace(/\s+/g, " ");
}

/**
 * A global or sticky marker breaks both helpers silently, which is the one
 * failure a fail-closed checker must never have: `String.match` with `/g`
 * returns a match array with no `.index` (so an order cursor becomes NaN and
 * every later marker searches from offset 0), and `RegExp.test` with `/g` or
 * `/y` advances `lastIndex` between calls (so a result depends on how many
 * candidates were tested first). Reject them loudly instead.
 */
function assertStatelessMarker(pattern, label) {
  if (pattern instanceof RegExp && /[gy]/.test(pattern.flags)) {
    throw new TypeError(
      `${label}: marker ${pattern} must not carry the g or y flag — a stateful regex silently disables this check`,
    );
  }
}

/**
 * Split `content` into the statement units `hasClauseWith` treats as "one
 * statement".
 *
 * Markdown structure comes first: a list item, a table row, a heading and a
 * blank-line-separated paragraph are each their own unit, because bullets
 * routinely carry no terminal punctuation and would otherwise merge into one
 * multi-thousand-character pseudo-sentence. Each unit is then split on a
 * sentence terminator FOLLOWED BY whitespace, so a dotted identifier
 * (`artifact.fanout.wavePlan`) is never split, and a colon or semicolon — which
 * joins a statement to its own elaboration — does not split one obligation in
 * two.
 */
function statementUnits(content) {
  return content
    .split(/\r?\n/)
    .reduce((units, line) => {
      const startsUnit = /^\s*(?:[-*+]\s|\d+\.\s|#{1,6}\s|\||>)/.test(line) || line.trim().length === 0;
      if (startsUnit || units.length === 0) units.push([line]);
      else units[units.length - 1].push(line);
      return units;
    }, /** @type {string[][]} */([]))
    .flatMap((unit) => flat(unit.join(" ")).split(/(?<=[.!?])\s+/))
    .filter((unit) => unit.trim().length > 0);
}

/**
 * True when ONE statement of `content` satisfies every pattern.
 *
 * Co-occurrence within one statement is the structural stand-in for "this
 * states X about Y": it survives rewording and reflow while refusing to join
 * two unrelated statements — two bullets, two table rows, two paragraphs, or
 * two sentences — into a match.
 */
function hasClauseWith(content, ...patterns) {
  for (const pattern of patterns) assertStatelessMarker(pattern, "hasClauseWith");
  return statementUnits(content).some((unit) => patterns.every((pattern) => pattern.test(unit)));
}

/**
 * Assert that `markers` appear in `content` in the given order, each at least
 * once. Order is a structural property of a procedure (authorize before you
 * reconcile; re-gate after the head moves) that survives any rewording of the
 * steps themselves.
 *
 * Flattens `content` itself, so a caller passes raw document text and a marker
 * spanning a line wrap still matches.
 */
function assertOrder(rawContent, markers, label = "content") {
  const content = flat(rawContent);
  let cursor = -1;
  let previous = null;
  for (const marker of markers) {
    assertStatelessMarker(marker, label);
    let index;
    if (typeof marker === "string") {
      index = content.indexOf(marker, cursor + 1);
    } else {
      const match = content.slice(cursor + 1).match(marker);
      index = match ? cursor + 1 + match.index : -1;
    }
    assert.ok(
      Number.isInteger(index) && index !== -1,
      `${label}: expected ${marker} to appear${previous ? ` after ${previous}` : ""}`,
    );
    cursor = index;
    previous = marker;
  }
}

export {
  assert,
  assertMatchesAll,
  assertOrder,
  flat,
  fromRepoRoot,
  hasClauseWith,
  parseFrontmatter,
  readRepo,
  readdir,
  stat,
  test,
  USER_FACING_AGENT_SURFACE,
};
