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

/**
 * @param {string} version — a SemVer version string
 * @returns {string} the npm dist-tag
 */
export function resolveNpmDistTag(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("version must be a non-empty string");
  }
  const v = version.trim();
  // SemVer: the prerelease component is everything after the first `-` and
  // before any `+build` metadata.
  const withoutBuild = v.split("+", 1)[0];
  const dashIndex = withoutBuild.indexOf("-");
  if (dashIndex === -1) return "latest"; // stable release
  const prerelease = withoutBuild.slice(dashIndex + 1);
  const firstIdentifier = prerelease.split(".")[0] ?? "";
  const alpha = (firstIdentifier.match(/^[a-zA-Z]+/) ?? [])[0];
  // A purely-numeric prerelease identifier (e.g. `1.0.0-1`) has no alpha token;
  // fall back to `next` — anything but `latest`.
  return alpha ? alpha.toLowerCase() : "next";
}

function parseArgs(argv) {
  let version = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") {
      version = argv[i + 1];
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
