import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

// #3147: on Claude Code the main session dispatches the dev-loop coordinator and never runs loop steps itself.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const normalize = (s) => s.replace(/\s+/g, " ");
const readNorm = (rel) => normalize(read(rel));

const OLD_PHRASES = [
  /run these steps directly/i,
  /no separate async-subagent dispatch/i,
  /a single agent runs the steps directly/i,
  /inline in a single agent/i,
  /Claude Code continues inline/i,
  /no Pi-style main-agent.{1,3}dev-loop async hop/i,
  /run the next watch cycle inline/i,
  /continue pending non-terminal waits inline in the same agent/i,
  /dev-loop runs as a single agent/i,
  /no separate read-only "main agent"/i,
];

function listMarkdown(dir) {
  return fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.relative(repoRoot, path.join(e.parentPath, e.name)));
}

test("no skill, command or agent text tells the main session to run loop steps directly", () => {
  for (const file of ["skills", "commands", "agents"].flatMap(listMarkdown)) {
    const text = readNorm(file);
    for (const re of OLD_PHRASES) assert.doesNotMatch(text, re, `${file} contains ${re}`);
  }
});

test("loop commands dispatch dev-loops:dev-loop and run no loop step in the main session", () => {
  for (const name of ["loop-start", "loop-continue", "loop-auto"]) {
    const text = readNorm(`commands/${name}.command.md`);
    assert.match(text, /dispatches the `dev-loops:dev-loop` coordinator/, `${name} must name the dispatch target`);
    assert.match(text, /main session runs no gate, fixer or reviewer step/, `${name} must bar main-session steps`);
  }
});

test("dev-loop skill and main-agent contract name the coordinator as the runner", () => {
  assert.match(readNorm("skills/dev-loop/SKILL.md"), /main session dispatches the `dev-loops:dev-loop` coordinator/);
  assert.match(readNorm("skills/docs/main-agent-contract.md"), /main session dispatches the `dev-loops:dev-loop` coordinator/);
});

test("Pi wording stays: read-only main agent and async dispatch (#1086)", () => {
  const full = read("skills/docs/main-agent-contract.md");
  const start = full.indexOf("<!-- pi-only -->");
  const end = full.lastIndexOf("<!-- /pi-only -->"); // the Pi span is split around the shared Claude model-tier text
  assert.ok(start >= 0 && end > start, "pi-only markers must exist");
  const text = normalize(full.slice(start, end));
  assert.match(text, /All tracked-file mutations flow through the `dev-loop` async subagent\./);
  assert.match(text, /## Async dispatch posture \(Pi\)/);
  assert.match(text, /Delegate to the `dev-loop` agent \(async, with worktree cwd\)/);
});

test("old-phrase guard catches a phrase split by a line break", () => {
  const wrapped = normalize("the dev-loop runs as a single\nagent");
  assert.ok(OLD_PHRASES.some((re) => re.test(wrapped)));
});
