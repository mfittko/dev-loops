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
const RAW_GH_WRITE = /\bgh(?:\s+(?:-R|--repo)(?:\s+|=)\S+)?\s+(?:issue|pr)\s+(?:create|edit|comment)\b/u;
// A prohibition phrase right before a prose span ("never raw `gh ...`") forbids the raw command.
const PROHIBITION = /\b(?:never|MUST NOT)(?:\s+(?:use|call|run|pass))?(?:\s+raw)?[\s*_]*$/iu;

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

// Returns { start, text, before } for every inline code span and fenced-block line. `before` is the
// prose preceding an inline span (null for a fenced line). Backslash-continued fenced lines are
// joined into the line they start on, and consecutive prose lines are joined into one paragraph so a
// hard-wrapped span is seen whole; a paragraph reports its first line.
function commandContexts(markdown) {
  const out = [];
  let fenced = false;
  let pending = null;
  let para = null;
  const flushPending = () => {
    if (pending) out.push({ start: pending.start, text: pending.text, before: null });
    pending = null;
  };
  const flushPara = () => {
    if (para) {
      for (const m of para.text.matchAll(/`([^`]+)`/gu)) {
        out.push({ start: para.start, text: m[1], before: para.text.slice(0, m.index) });
      }
    }
    para = null;
  };
  markdown.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/u.test(raw)) {
      flushPending();
      flushPara();
      fenced = !fenced;
      return;
    }
    if (fenced) {
      const line = pending ? `${pending.text} ${raw.trim()}` : raw;
      const start = pending ? pending.start : i + 1;
      if (line.endsWith("\\")) pending = { text: line.slice(0, -1).trimEnd(), start };
      else {
        pending = null;
        out.push({ start, text: line, before: null });
      }
      return;
    }
    if (raw.trim() === "") {
      flushPara();
      return;
    }
    para = para ? { start: para.start, text: `${para.text} ${raw.trim()}` } : { start: i + 1, text: raw.trim() };
  });
  flushPending();
  flushPara();
  return out;
}

export function rawWriteContexts(markdown) {
  return commandContexts(markdown).filter(
    ({ text, before }) => RAW_GH_WRITE.test(text) && !(before !== null && PROHIBITION.test(before)),
  );
}

export function rawWriteHits(markdown) {
  return rawWriteContexts(markdown).map(({ start }) => start);
}

// Documented exceptions: each names the raw command only to describe what a launcher wraps, and
// prescribes nothing. Keyed on the file plus the prose tail right before the span and the span
// itself (`ctx` is a suffix of `${before}${span}`), so an entry pins one site, not a line number.
const ALLOWLIST = [
  { file: "skills/docs/merge-preconditions.md", ctx: "which runs gh pr edit --add-assignee" },
  { file: "skills/docs/retrospective-checkpoint-contract.md", ctx: "issue #1939), gh issue create" },
  { file: "skills/docs/retrospective-checkpoint-contract.md", ctx: "create-issue.mjs`), gh issue edit" },
  { file: "skills/docs/copilot-loop-operations.md", ctx: "The wrapper preserves gh pr create" },
  // Prohibitions phrased outside the narrow "never/MUST NOT [use|call] [raw]" form.
  { file: "skills/local-implementation/SKILL.md", ctx: "MUST NOT open them via raw gh pr create" },
  { file: "skills/docs/merge-preconditions.md", ctx: "prefer it over a raw gh pr edit --remove-reviewer" },
  { file: "skills/docs/main-agent-contract.md", ctx: "which names raw gh issue create" },
  { file: "skills/docs/decision-record-contract.md", ctx: "JSON line after the gh pr create" },
  { file: "commands/loop-enqueue.command.md", ctx: "do not call raw gh issue create" },
];

test("no procedure doc prescribes a raw `gh issue|pr create|edit|comment` in a command context", () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, "expected source markdown files to scan");
  const hits = [];
  const used = new Map();
  for (const file of files) {
    for (const { start, text, before } of rawWriteContexts(fs.readFileSync(path.join(repoRoot, file), "utf8"))) {
      const site = `${before ?? ""}${text}`;
      const entry = ALLOWLIST.find((e) => e.file === file && site.endsWith(e.ctx));
      if (entry) used.set(entry, (used.get(entry) ?? 0) + 1);
      else hits.push(`${file}:${start}`);
    }
  }
  assert.deepEqual(hits, []);
  assert.deepEqual(
    ALLOWLIST.filter((e) => used.get(e) !== 1),
    [],
    "each ALLOWLIST entry must match exactly one raw hit",
  );
});

test("matcher flags the raw create form and accepts the launcher form", () => {
  const raw = "Create each child with `gh issue create --repo <resolved-repo> --title <title>`, then:";
  const launcher = "Create each child with `node <dev-loops-package-root>/cli/index.mjs issue create --repo <r> --title <t>`";
  assert.deepEqual(rawWriteHits(raw), [1]);
  assert.deepEqual(rawWriteHits(launcher), []);
  assert.deepEqual(rawWriteHits("```sh\ngh pr edit 5 \\\n  --body-file x\n```"), [2]);
  assert.deepEqual(rawWriteHits("Prose naming gh issue create is fine."), []);
});

test("matcher keeps fence state when a fenced line ends in a backslash", () => {
  const doc = "```sh\ngh pr edit 5 \\\n```\n\n```sh\ngh issue create --body-file b.md\n```";
  assert.deepEqual(rawWriteHits(doc), [2, 6]);
});

test("matcher covers the comment verbs", () => {
  assert.deepEqual(rawWriteHits("Reply with `gh pr comment 5 --body-file reply.md`."), [1]);
  assert.deepEqual(rawWriteHits("Post `gh issue comment 5 --body-file c.md`."), [1]);
  const launcher = "Post it with `node <dev-loops-package-root>/scripts/github/comment-issue.mjs --repo <r> --issue 5 --body-file f`.";
  assert.deepEqual(rawWriteHits(launcher), []);
});

test("matcher flags a gh global repo flag before the subcommand", () => {
  assert.deepEqual(rawWriteHits("Run `gh issue create --repo <r> --body-file f`."), [1]);
  assert.deepEqual(rawWriteHits("Run `gh -R <r> issue create --body-file f`."), [1]);
  assert.deepEqual(rawWriteHits("Run `gh --repo <r> pr edit --body-file f`."), [1]);
  assert.deepEqual(rawWriteHits("Run `gh --repo=<r> issue comment --body-file f`."), [1]);
  assert.deepEqual(rawWriteHits("Run `dev-loops-run --repo-root <checkout> cli/index.mjs issue create --repo <r> --title <t> --body-file <p>`."), []);
  assert.deepEqual(rawWriteHits("Run `node <dev-loops-package-root>/scripts/github/comment-issue.mjs --repo <r> --issue 5 --body-file f`."), []);
  assert.deepEqual(rawWriteHits("Run `gh issue view 5 --repo <r>`."), []);
});

test("matcher exempts only a prohibition phrase right before a prose span", () => {
  assert.deepEqual(rawWriteHits("Never `gh issue comment` directly."), []);
  assert.deepEqual(rawWriteHits("**never raw `gh issue create`**"), []);
  assert.deepEqual(rawWriteHits("MUST NOT use raw `gh pr edit`."), []);
  assert.deepEqual(rawWriteHits("```sh\ngh pr edit 5 --body-file raw-body.md\n```"), [2]);
  assert.deepEqual(rawWriteHits("Write the raw body to a file, then run `gh issue edit 5 --body-file f`."), [1]);
});

test("matcher scans a code span split by a hard wrap", () => {
  assert.deepEqual(rawWriteHits("Create the child with `gh issue create --repo <r>\n--body-file <p>`."), [1]);
  assert.deepEqual(
    rawWriteHits("Create the child with `node <dev-loops-package-root>/cli/index.mjs issue create --repo <r>\n--body-file <p>`."),
    [],
  );
});
