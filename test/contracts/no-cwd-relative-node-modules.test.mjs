import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { walkByExt } from "./_walk-helpers.mjs";

// A cwd-relative node_modules path skips Node's parent node_modules lookup, so it
// breaks in a worktree without its own node_modules.
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SPAWN_WITH_RELATIVE_NODE_MODULES = /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\([^;]*?["'`](?:\.\/)?node_modules\//;

test("test files do not pass a cwd-relative node_modules path to child-process spawns", () => {
  const offenders = walkByExt(path.join(repoRoot, "test"), [".mjs"], [])
    .filter((file) => SPAWN_WITH_RELATIVE_NODE_MODULES.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(repoRoot, file));
  assert.deepEqual(offenders, []);
});

test("root package.json scripts do not contain a node_modules path", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const offenders = Object.entries(scripts).filter(([, cmd]) => /node_modules\//.test(cmd)).map(([name]) => name);
  assert.deepEqual(offenders, []);
});

test("the spawn regex matches cwd-relative forms and ignores unrelated paths", () => {
  // Samples are built from parts so this file does not match its own scan.
  const nm = "node" + "_modules/a/cli.js";
  assert.match(`execFileSync('node', ['${nm}'])`, SPAWN_WITH_RELATIVE_NODE_MODULES);
  assert.match(`spawn("node", ["./${nm}"])`, SPAWN_WITH_RELATIVE_NODE_MODULES);
  assert.doesNotMatch(`execFileSync('git', ['check-ignore', '.claude/${nm}'])`, SPAWN_WITH_RELATIVE_NODE_MODULES);
});
