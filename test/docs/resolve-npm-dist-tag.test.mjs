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
  // build metadata is not a prerelease — even when it contains a hyphen, which
  // must not be mistaken for a prerelease separator (release.yml derives the
  // GitHub-Release --latest/--prerelease flag from this same result).
  assert.equal(resolveNpmDistTag("1.0.0+build.5"), "latest");
  assert.equal(resolveNpmDistTag("1.0.0+build-1"), "latest");
  assert.equal(resolveNpmDistTag("1.0.0+20130313144700"), "latest");
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
  // incl. the pathological `-latest` identifier, which must be guarded, not passed through.
  for (const v of ["1.0.0-rc.1", "1.0.0-next.1", "1.0.0-beta", "1.0.0-1", "1.0.0-0.3.7", "1.0.0-latest", "1.0.0-latest.2", "1.0.0-LATEST"]) {
    assert.notEqual(resolveNpmDistTag(v), "latest", `${v} must not publish to latest`);
  }
  assert.equal(resolveNpmDistTag("1.0.0-latest"), "next");
});

test("resolveNpmDistTag: rejects empty/invalid input", () => {
  assert.throws(() => resolveNpmDistTag(""), /non-empty string/);
  assert.throws(() => resolveNpmDistTag(null), /non-empty string/);
  assert.throws(() => resolveNpmDistTag(42), /non-empty string/);
});

test("resolveNpmDistTag: fails closed on a non-SemVer string (never latest for garbage)", () => {
  // A truncated/garbled tag must NOT be treated as a stable release -> latest.
  for (const bad of ["foo", "1.0", "1", "v1.0.0", "1.0.0.0", "1.0.0-", "latest", "1.2.x", "01.2.3", "1.02.3", "1.2.03"]) {
    assert.throws(() => resolveNpmDistTag(bad), /not a valid SemVer version/, `${bad} must fail closed`);
  }
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

test("CLI: --version with no value is a usage error (exit 2, no fallback)", () => {
  const r = runCli("--version");
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "must not silently fall back or print a tag");
});

test("CLI: no args is a usage error (--version is required, exit 2)", () => {
  const r = runCli();
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "must fail closed, not guess from package.json");
});

test("CLI: a non-SemVer --version value fails closed (exit 2)", () => {
  const r = runCli("--version", "foo");
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "garbage must not publish under latest");
});
