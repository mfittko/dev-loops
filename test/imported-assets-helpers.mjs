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
 * True when ONE sentence of `content` satisfies every pattern.
 *
 * Splits on a sentence terminator FOLLOWED BY whitespace, so a dotted
 * identifier (`artifact.fanout.wavePlan`) is never split, and so a colon or
 * semicolon — which joins a statement to its own elaboration — does not split
 * one obligation into two. Co-occurrence within one sentence is the structural
 * stand-in for "this states X about Y": it survives rewording and reflow while
 * still refusing to join two unrelated statements into a match.
 */
function hasClauseWith(content, ...patterns) {
  return flat(content)
    .split(/(?<=[.!?])\s+/)
    .some((clause) => patterns.every((pattern) => pattern.test(clause)));
}

/**
 * Assert that `markers` appear in `content` in the given order, each at least
 * once. Order is a structural property of a procedure (authorize before you
 * reconcile; re-gate after the head moves) that survives any rewording of the
 * steps themselves.
 */
function assertOrder(content, markers, label = "content") {
  let cursor = -1;
  let previous = null;
  for (const marker of markers) {
    const index = typeof marker === "string"
      ? content.indexOf(marker, cursor + 1)
      : (() => {
        const slice = content.slice(cursor + 1);
        const match = slice.match(marker);
        return match ? cursor + 1 + match.index : -1;
      })();
    assert.ok(
      index !== -1,
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
