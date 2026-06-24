import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// #774 (rescoped): the public `npx dev-loops` CLI must be harness-neutral — it must run with
// no `@earendil-works/pi-*` present, and must not show Pi-only install strings unconditionally.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PI_IMPORT_RE = /\b(?:from|import)\s+['"]@earendil-works\/pi-[^'"]+['"]|import\(\s*['"]@earendil-works\/pi-/;

async function collectSourceFiles(dir) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSourceFiles(rel)));
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("the CLI/lib source imports no @earendil-works/pi-* (Pi SDK not required)", async () => {
  const files = (await Promise.all(["cli", "lib"].map(collectSourceFiles))).flat();
  assert.ok(files.length > 0, "expected to scan CLI/lib sources");
  const offenders = [];
  for (const rel of files) {
    if (PI_IMPORT_RE.test(await readFile(path.join(repoRoot, rel), "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `CLI/lib must not import the Pi SDK: ${offenders.join(", ")}`);
});

function runCli(args) {
  return spawnSync("node", [path.join(repoRoot, "cli", "index.mjs"), ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

test("`dev-loops --help` runs standalone and is harness-neutral", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  // Names both harness entrypoints (neutral), not Pi-only.
  assert.match(out, /\/dev-loop` \(Claude Code\)/);
  assert.match(out, /\/skill:dev-loop` \(Pi\)/);
  // No unconditional Pi install/update push on the neutral CLI surface.
  assert.doesNotMatch(out, /pi install git:/);
  assert.doesNotMatch(out, /pi update git:/);
});

test("`dev-loops status` runs standalone and exits 0", () => {
  const res = runCli(["status"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dev-loops status:/);
});

test("Pi packaging is preserved in package.json (dual-harness)", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./extension/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["skills"]);
  assert.deepEqual(pkg.pi.agents, ["agents"]);
});
