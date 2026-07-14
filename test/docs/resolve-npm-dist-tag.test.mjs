import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveNpmDistTag } from "../../scripts/release/resolve-npm-dist-tag.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "release", "resolve-npm-dist-tag.mjs");
const runCli = (...args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });

test("resolveNpmDistTag: stable release -> latest", () => {
  assert.equal(resolveNpmDistTag("1.0.0"), "latest");
  assert.equal(resolveNpmDistTag("0.9.0"), "latest");
  assert.equal(resolveNpmDistTag("2.3.4"), "latest");
  // build metadata is not a prerelease
  assert.equal(resolveNpmDistTag("1.0.0+build.5"), "latest");
});

test("resolveNpmDistTag: rc prerelease -> rc (never latest)", () => {
  assert.equal(resolveNpmDistTag("1.0.0-rc.1"), "rc");
  assert.equal(resolveNpmDistTag("1.0.0-rc.10"), "rc");
  assert.equal(resolveNpmDistTag("1.0.0-rc.1+build.2"), "rc");
});

test("resolveNpmDistTag: other prerelease channels map to their identifier", () => {
  assert.equal(resolveNpmDistTag("1.2.0-next.3"), "next");
  assert.equal(resolveNpmDistTag("1.0.0-beta.2"), "beta");
  assert.equal(resolveNpmDistTag("1.0.0-alpha"), "alpha");
  assert.equal(resolveNpmDistTag("1.0.0-RC.1"), "rc"); // case-normalized
});

test("resolveNpmDistTag: purely-numeric prerelease falls back to next, never latest", () => {
  assert.equal(resolveNpmDistTag("1.0.0-1"), "next");
});

test("resolveNpmDistTag: a prerelease is NEVER latest (the load-bearing invariant)", () => {
  for (const v of ["1.0.0-rc.1", "1.0.0-next.1", "1.0.0-beta", "1.0.0-1", "1.0.0-0.3.7"]) {
    assert.notEqual(resolveNpmDistTag(v), "latest", `${v} must not publish to latest`);
  }
});

test("resolveNpmDistTag: rejects empty/invalid input", () => {
  assert.throws(() => resolveNpmDistTag(""), /non-empty string/);
  assert.throws(() => resolveNpmDistTag(null), /non-empty string/);
  assert.throws(() => resolveNpmDistTag(42), /non-empty string/);
});

// CLI entrypoint — the workflow captures stdout via $(...), so the CLI MUST
// print a non-empty tag and exit 0 on success (an empty capture would become
// `npm publish --tag ""`), and fail closed (exit 2) on bad input.
test("CLI: prints the resolved tag and exits 0", () => {
  const rc = runCli("--version", "1.0.0-rc.1");
  assert.equal(rc.status, 0);
  assert.equal(rc.stdout.trim(), "rc");
  const stable = runCli("--version", "1.0.0");
  assert.equal(stable.status, 0);
  assert.equal(stable.stdout.trim(), "latest");
});

test("CLI: fails closed (exit 2) on an unknown arg", () => {
  const r = runCli("--bogus", "x");
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "must not print a tag on error");
});
