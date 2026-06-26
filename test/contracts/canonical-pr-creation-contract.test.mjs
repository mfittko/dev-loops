// Enforcement guard for issue #894: PR creation must always flow through the
// canonical wrapper (`scripts/github/create-pr.mjs` / `dev-loops pr create`),
// which is ALWAYS draft and always assigned — self-assigned by default
// (`--assignee @me`), while honoring an explicit `--assignee <login>` / `-a <login>`.
// No skill/agent procedure doc may instruct an operator to OPEN a PR with raw
// `gh pr create`.
//
// The heuristic is deliberately conservative: it only flags an imperative
// `gh pr create` occurrence whose surrounding sentence does NOT carry a
// safe-context marker. Legitimate prose that *explains* the wrapper preserves
// the underlying `gh pr create` output contract, or that negates raw usage
// ("never call raw `gh pr create`"), is allowed and must not false-positive.

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const repoRootUrl = new URL("../../", import.meta.url);
const fromRepoRoot = (relativePath) => new URL(relativePath, repoRootUrl);

// Stable repo-root-relative path (e.g. `skills/foo/SKILL.md`), so allowlist
// entries are unambiguous and two files sharing trailing segments can never
// collide.
const toRepoRelativePath = (fileUrl) =>
  decodeURIComponent(fileUrl.pathname).slice(decodeURIComponent(repoRootUrl.pathname).length);

// Directories whose `*.md` procedure docs are subject to the guard.
const GUARDED_ROOTS = ["skills", "agents"];

// A `gh pr create` mention is allowed when its sentence also contains any of
// these markers — i.e. it is explanatory (describes the wrapper's contract) or
// it negates raw usage rather than instructing it.
const SAFE_CONTEXT_MARKERS = [
  /\bwraps?\b/i,
  /\bwrapper\b/i,
  /\bunderlying\b/i,
  /\boutput contract\b/i,
  /\bpreserves?\b/i,
  /\bnever\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bnot call\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  // A co-mention of the canonical path on the same sentence means the
  // `gh pr create` reference is descriptive of what the wrapper forwards to.
  /create-pr\.mjs/i,
  /dev-loops pr create\b/i,
];

// Per-path allowlist escape hatch (path → array of exact sentences permitted).
// Empty by design: the heuristic above already exempts legitimate prose.
const ALLOWLIST = Object.freeze({});

const GH_PR_CREATE_PATTERN = /gh pr create/i;

// Split a markdown blob into rough "sentences" so a marker elsewhere in a long
// bullet does not accidentally exempt an unrelated imperative. We split on
// sentence terminators and hard line breaks.
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSafeSentence(sentence) {
  return SAFE_CONTEXT_MARKERS.some((marker) => marker.test(sentence));
}

function findRawGhPrCreateInstructions(content, { allow = [] } = {}) {
  const offenders = [];
  for (const sentence of splitSentences(content)) {
    if (!GH_PR_CREATE_PATTERN.test(sentence)) continue;
    if (isSafeSentence(sentence)) continue;
    if (allow.includes(sentence)) continue;
    offenders.push(sentence);
  }
  return offenders;
}

async function* walkMarkdown(dirUrl) {
  let entries;
  try {
    entries = await readdir(dirUrl, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      yield* walkMarkdown(childUrl);
    } else if (entry.name.endsWith(".md")) {
      yield childUrl;
    }
  }
}

test("no skill/agent procedure doc instructs raw `gh pr create` to open a PR (#894)", async () => {
  const offendersByFile = {};
  for (const root of GUARDED_ROOTS) {
    const rootUrl = fromRepoRoot(`${root}/`);
    try {
      await stat(rootUrl);
    } catch {
      continue;
    }
    for await (const fileUrl of walkMarkdown(rootUrl)) {
      const content = await readFile(fileUrl, "utf8");
      const relPath = toRepoRelativePath(fileUrl);
      const allow = ALLOWLIST[relPath] ?? [];
      const offenders = findRawGhPrCreateInstructions(content, { allow });
      if (offenders.length > 0) {
        offendersByFile[relPath] = offenders;
      }
    }
  }

  assert.deepEqual(
    offendersByFile,
    {},
    `Found raw \`gh pr create\` instruction(s) that should route through the canonical ` +
      `\`dev-loops pr create\` / \`create-pr.mjs\` path (always draft, self-assigned by default):\n` +
      `${JSON.stringify(offendersByFile, null, 2)}`,
  );
});

// --- heuristic unit tests: positive (caught) and negative (allowed) ---

test("heuristic FLAGS an imperative raw `gh pr create` instruction (positive case)", () => {
  const bad = "Open the PR by running `gh pr create --base main --head feature --title \"x\"`.";
  const offenders = findRawGhPrCreateInstructions(bad);
  assert.equal(offenders.length, 1, "a bare imperative `gh pr create` should be flagged");
});

test("heuristic ALLOWS the wrapper's own explanatory mention (negative case)", () => {
  const good = "This wrapper preserves the underlying `gh pr create` output contract while enforcing draft-first.";
  assert.deepEqual(findRawGhPrCreateInstructions(good), []);
});

test("heuristic ALLOWS a negated raw mention (`never call raw gh pr create`)", () => {
  const good = "Always use `dev-loops pr create`; never call raw `gh pr create` to open a PR.";
  assert.deepEqual(findRawGhPrCreateInstructions(good), []);
});

test("heuristic ALLOWS the canonical fallback that references the create-pr.mjs script", () => {
  const good = "When the CLI is unavailable, run `node <resolved-skill-scripts>/github/create-pr.mjs ...`; this forwards to `gh pr create`.";
  assert.deepEqual(findRawGhPrCreateInstructions(good), []);
});

test("heuristic respects the per-path allowlist escape hatch", () => {
  const sentence = "Open the PR by running `gh pr create`.";
  assert.equal(findRawGhPrCreateInstructions(sentence).length, 1);
  assert.deepEqual(findRawGhPrCreateInstructions(sentence, { allow: [sentence] }), []);
});
