// A procedure doc must prescribe the launcher form for issue/PR creates and edits, because the
// Claude pre-check (packages/core/src/loop/bash-command-classify.mjs) denies the raw form and an
// agent copying it hits that denial. Only command contexts (inline code spans and fenced-block
// lines) are scanned; prose that merely names the raw command is allowed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RAW_GH_WRITE = /\bgh (?:issue|pr) (?:create|edit)\b/u;
// A line saying "never"/"raw"/"MUST NOT" names the raw command to forbid it, not to prescribe it.
const PROHIBITION = /\b(?:never|raw|MUST NOT)\b/iu;

// Mirrors sourceFiles() in claude-no-bare-invocation.test.mjs.
function listMarkdown(dir, suffix) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { recursive: true })
    .filter((rel) => String(rel).endsWith(suffix))
    .map((rel) => path.join(dir, String(rel)));
}

function sourceFiles() {
  return [
    ...listMarkdown("skills", ".md"),
    ...listMarkdown("agents", ".agent.md"),
    ...listMarkdown("commands", ".command.md"),
  ];
}

// Returns [startLine, commandText, fullLine] for every inline code span and fenced-block line.
// Backslash-continued fenced lines are joined into the line they start on.
function commandContexts(markdown) {
  const out = [];
  let fenced = false;
  let pending = null;
  markdown.split("\n").forEach((raw, i) => {
    const line = pending ? `${pending.text} ${raw.trim()}` : raw;
    const start = pending ? pending.start : i + 1;
    if (fenced && line.endsWith("\\")) {
      pending = { text: line.slice(0, -1).trimEnd(), start };
      return;
    }
    pending = null;
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) out.push([start, line, line]);
    else for (const m of line.matchAll(/`([^`]+)`/gu)) out.push([start, m[1], line]);
  });
  return out;
}

export function rawWriteHits(markdown) {
  return commandContexts(markdown)
    .filter(([, text, line]) => RAW_GH_WRITE.test(text) && !PROHIBITION.test(line))
    .map(([n]) => n);
}

// Documented exceptions, "<file>:<line>": each names the raw command only to describe what a
// launcher wraps, and prescribes nothing.
const ALLOWLIST = new Set([
  "skills/docs/merge-preconditions.md:417",
  "skills/docs/retrospective-checkpoint-contract.md:207",
  "skills/docs/retrospective-checkpoint-contract.md:208",
  "skills/docs/copilot-loop-operations.md:150",
]);

test("no procedure doc prescribes a raw `gh issue|pr create|edit` in a command context", () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, "expected source markdown files to scan");
  const hits = [];
  for (const file of files) {
    for (const n of rawWriteHits(fs.readFileSync(path.join(repoRoot, file), "utf8"))) {
      const site = `${file}:${n}`;
      if (!ALLOWLIST.has(site)) hits.push(site);
    }
  }
  assert.deepEqual(hits, []);
});

test("matcher flags the raw create form and accepts the launcher form", () => {
  const raw = "Create each child with `gh issue create --repo <resolved-repo> --title <title>`, then:";
  const launcher = "Create each child with `node <dev-loops-package-root>/cli/index.mjs issue create --repo <r> --title <t>`";
  assert.deepEqual(rawWriteHits(raw), [1]);
  assert.deepEqual(rawWriteHits(launcher), []);
  assert.deepEqual(rawWriteHits("```sh\ngh pr edit 5 \\\n  --body-file x\n```"), [2]);
  assert.deepEqual(rawWriteHits("Prose naming gh issue create is fine."), []);
});
