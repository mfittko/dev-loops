#!/usr/bin/env node
/**
 * Resolve the npm dist-tag to publish a given version under.
 *
 * A stable release (no SemVer prerelease component) publishes under `latest` —
 * the tag `npm install dev-loops` resolves by default. A prerelease
 * (e.g. `1.0.0-rc.1`) publishes under the leading ALPHABETIC token of its first
 * prerelease identifier (`rc`, `next`, `beta`, …) and NEVER under `latest`, so a
 * release candidate can never hijack the default-install tag. This is the check
 * that keeps a `v1.0.0-rc.1` tag from overwriting `latest` when release.yml
 * dispatches npm-publish.yml.
 *
 * Usage:
 *   node scripts/release/resolve-npm-dist-tag.mjs --version <v>
 *   node scripts/release/resolve-npm-dist-tag.mjs            # defaults to ./package.json version
 *
 * Prints the dist-tag to stdout. Exit 0 on success, 2 on usage/parse error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Inlined (node: builtins only): this script runs in npm-publish.yml as a CLI; a
// workspace import would be fragile in the release environment. realpath-based so
// a relative `node scripts/release/resolve-npm-dist-tag.mjs` invocation (as the
// workflow uses) still detects direct-run — a brittle `file://${argv[1]}` string
// compare could miss and skip main(), yielding an empty `npm publish --tag ""`.
// Mirrors scripts/release/extract-changelog-section.mjs.
function isDirectCliRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/**
 * @param {string} version — a SemVer version string
 * @returns {string} the npm dist-tag
 */
// A release-safety helper must fail closed: a non-SemVer input (e.g. "foo", a
// truncated tag, or one with a leading-zero component like "01.2.3") must NOT
// slip through as a stable release and publish under the default `latest`
// dist-tag. This is the canonical SemVer 2.0.0 regex (semver.org) — it forbids
// leading zeros in numeric identifiers and validates prerelease/build fields.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function resolveNpmDistTag(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("version must be a non-empty string");
  }
  const v = version.trim();
  if (!SEMVER_RE.test(v)) {
    throw new Error(`not a valid SemVer version: ${version}`);
  }
  // SemVer: the prerelease component is everything after the first `-` and
  // before any `+build` metadata.
  const withoutBuild = v.split("+", 1)[0];
  const dashIndex = withoutBuild.indexOf("-");
  if (dashIndex === -1) return "latest"; // stable release
  const prerelease = withoutBuild.slice(dashIndex + 1);
  const firstIdentifier = prerelease.split(".")[0] ?? "";
  const alpha = (firstIdentifier.match(/^[a-zA-Z]+/) ?? [])[0];
  const tag = alpha ? alpha.toLowerCase() : "next";
  // A prerelease NEVER publishes under `latest`. A purely-numeric prerelease
  // (`1.0.0-1`) has no alpha token, and the pathological `1.0.0-latest` would
  // otherwise resolve to `latest` — both fall back to `next` so the invariant
  // holds for every input, not just bump-script-generated `rc.N` tags.
  return tag === "latest" ? "next" : tag;
}

function parseArgs(argv) {
  let version = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") {
      version = argv[i + 1];
      if (version === undefined) {
        throw new Error("Missing value for --version");
      }
      i++;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { version };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  let { version } = parsed;
  if (version == null) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version;
    } catch (error) {
      process.stderr.write(`Could not read version from ./package.json: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  }
  try {
    process.stdout.write(`${resolveNpmDistTag(version)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

if (isDirectCliRun(import.meta.url)) {
  main();
}
