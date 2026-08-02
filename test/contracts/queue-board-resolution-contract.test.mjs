// Every operator-facing queue command must resolve the board from .devloops
// when no explicit --project is passed. The shared helper is applyDevloopsBoard
// (scripts/projects/_resolve-project.mjs), and it fills in EITHER args.project
// (board number/id) OR args.projectTitle (board title) — never both.
//
// Two structural layers, both discovered automatically so a newly added command
// cannot ship without the wiring:
//
//   1. Every scripts/projects/*.mjs command that accepts --project must call
//      applyDevloopsBoard. Missing it fails closed with INVALID_PROJECT on a
//      repo that configures the board by title only (the resolve-active-board-item
//      gap that broke bare /loop-continue).
//   2. Every delegation into list-queue-items' main() must forward projectTitle
//      alongside project. Forwarding only `project` silently drops a
//      title-configured board and reproduces the same INVALID_PROJECT.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const projectsRoot = path.join(repoRoot, "scripts", "projects");

// Helper modules and board bootstrap, not operator-facing queue commands.
const EXCLUDED = new Set([
  "_resolve-project.mjs", // the helper itself
  // Bootstraps the board (it may not exist yet) and carries its own partial
  // inline .devloops fallback rather than applyDevloopsBoard.
  "ensure-queue-board.mjs",
]);

async function projectScripts() {
  const names = (await readdir(projectsRoot)).filter((n) => n.endsWith(".mjs") && !EXCLUDED.has(n));
  return Promise.all(
    names.map(async (name) => ({ name, source: await readFile(path.join(projectsRoot, name), "utf8") })),
  );
}

test("every queue command accepting --project resolves the board via applyDevloopsBoard", async () => {
  const missing = (await projectScripts())
    .filter(({ source }) => /"?--project"?/.test(source) || /\bargs\.project\b/.test(source))
    .filter(({ source }) => !source.includes("applyDevloopsBoard("))
    .map(({ name }) => name);

  assert.deepEqual(
    missing,
    [],
    `these queue commands read --project but never call applyDevloopsBoard(args, cwd), so a title-configured .devloops board fails with INVALID_PROJECT: ${missing.join(", ")}`,
  );
});

test("delegations into list-queue-items forward projectTitle alongside project", async () => {
  const offenders = [];
  for (const { name, source } of await projectScripts()) {
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (!/\bproject: args\.project\b/.test(line)) return;
      // projectTitle may sit on the same line or within the next few lines of
      // the same object literal — a single-line requirement would fail on
      // harmless formatting changes.
      const window = lines.slice(i, i + 4).join("\n");
      if (!window.includes("projectTitle")) offenders.push(`${name}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `these delegations pass project but drop projectTitle, silently losing a title-configured board:\n${offenders.join("\n")}`,
  );
});
