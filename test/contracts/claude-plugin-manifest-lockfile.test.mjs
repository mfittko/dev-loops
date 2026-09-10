// #2123: `.claude/package.json` + `.claude/package-lock.json` are the hand-authored, committed
// surfaces Claude Code's native plugin dependency auto-install reads (`npm ci --ignore-scripts`)
// to provide the whole dev-loops toolchain to a plugin-only install. This locks: the manifest pins
// `dev-loops` exactly to the root package.json version; the committed lock is a valid, internally
// consistent npm v3 lock whose two first-party entries (`dev-loops`, `@dev-loops/core`) carry NO
// `integrity` (unknown pre-publish — recomputed by npm on download) while every OTHER entry still
// carries its real integrity; no `bun.lock` exists under `.claude/` (lockfile precedence would
// pick bun over npm); and `.claude/node_modules` is untracked in git and outside the publish tree.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const claudeDir = path.join(repoRoot, ".claude");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("manifest pins dev-loops exactly to the root package.json version", () => {
  const rootVersion = readJson(path.join(repoRoot, "package.json")).version;
  const manifest = readJson(path.join(claudeDir, "package.json"));
  assert.equal(manifest.name, "dev-loops-plugin");
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies["dev-loops"], rootVersion);
});

test("lockfile parses as lockfileVersion 3, internally consistent with the manifest pin", () => {
  const rootVersion = readJson(path.join(repoRoot, "package.json")).version;
  const lock = readJson(path.join(claudeDir, "package-lock.json"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[""].dependencies["dev-loops"], rootVersion);
  assert.ok(lock.packages["node_modules/dev-loops"], "lock must carry node_modules/dev-loops");
  assert.ok(lock.packages["node_modules/@dev-loops/core"], "lock must carry node_modules/@dev-loops/core");
  assert.equal(lock.packages["node_modules/dev-loops"].version, rootVersion);
  assert.equal(lock.packages["node_modules/@dev-loops/core"].version, rootVersion);
});

// A key's nearest ancestor package dir (the deepest enclosing `node_modules/<pkg>` above it), or
// null at the top level. E.g. "node_modules/a/node_modules/b" -> "node_modules/a".
function nearestAncestorKey(key) {
  const segments = key.split("/node_modules/");
  if (segments.length < 2) return null;
  return segments.slice(0, -1).join("/node_modules/");
}

test("the two first-party lock entries carry resolved + NO integrity; every other entry HAS integrity (or is covered by an ancestor's own bundled shrinkwrap)", () => {
  const rootVersion = readJson(path.join(repoRoot, "package.json")).version;
  const lock = readJson(path.join(claudeDir, "package-lock.json"));
  const dl = lock.packages["node_modules/dev-loops"];
  const core = lock.packages["node_modules/@dev-loops/core"];

  assert.equal(dl.resolved, `https://registry.npmjs.org/dev-loops/-/dev-loops-${rootVersion}.tgz`);
  assert.equal("integrity" in dl, false, "first-party dev-loops entry must not carry integrity");
  assert.equal(core.resolved, `https://registry.npmjs.org/@dev-loops/core/-/core-${rootVersion}.tgz`);
  assert.equal("integrity" in core, false, "first-party @dev-loops/core entry must not carry integrity");

  // npm itself omits integrity for a package nested under a dependency that ships its own
  // `hasShrinkwrap: true` (that ancestor's own integrity covers its whole shrinkwrapped subtree —
  // a real, pre-existing npm lockfile shape unrelated to the two first-party entries we strip).
  const missingIntegrity = [];
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (key === "" || key === "node_modules/dev-loops" || key === "node_modules/@dev-loops/core") continue;
    if (pkg.link || "integrity" in pkg) continue;
    const ancestorKey = nearestAncestorKey(key);
    const ancestor = ancestorKey ? lock.packages[ancestorKey] : null;
    if (ancestor?.hasShrinkwrap) continue;
    missingIntegrity.push(key);
  }
  assert.deepEqual(missingIntegrity, [], `every non-first-party, non-shrinkwrap-nested entry must carry integrity; missing on:\n${missingIntegrity.join("\n")}`);
});

test("no bun.lock under .claude/ (lockfile precedence would pick bun over npm)", () => {
  const entries = fs.readdirSync(claudeDir);
  assert.equal(entries.some((name) => name.startsWith("bun.lock")), false);
});

test(".claude/node_modules is untracked (git-ignored) and not committed", () => {
  // A dir-only .gitignore pattern (`node_modules/`) does not match a not-yet-existing path, so probe
  // a path INSIDE the dir (finding recorded in the phase plan) rather than the bare dir itself.
  const out = execFileSync("git", ["-C", repoRoot, "check-ignore", ".claude/node_modules/dev-loops/package.json"], {
    encoding: "utf8",
  });
  assert.match(out, /\.claude\/node_modules\/dev-loops\/package\.json/);

  const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", ".claude"], { encoding: "utf8" });
  const nodeModulesLines = tracked.split("\n").filter((line) => line.includes("node_modules"));
  assert.deepEqual(nodeModulesLines, [], "no committed .claude/node_modules path");
});

test("the manifest + lockfile are in the publish files allowlist", () => {
  const pkg = readJson(path.join(repoRoot, "package.json"));
  assert.ok(pkg.files.includes(".claude/package.json"), "files allowlist must include .claude/package.json");
  assert.ok(pkg.files.includes(".claude/package-lock.json"), "files allowlist must include .claude/package-lock.json");
  assert.ok(pkg.files.includes(".claude/bin/"), "files allowlist must include .claude/bin/");
});
