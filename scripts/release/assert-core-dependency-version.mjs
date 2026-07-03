#!/usr/bin/env node
/**
 * Release-time guard: fail closed when the published `dev-loops` package's
 * `@dev-loops/core` dependency does not resolve to the same major.minor as the
 * version being released. This is the check that would have caught #1033
 * (`dev-loops@0.6.2` shipping `@dev-loops/core@^0.2.6`).
 *
 * Runs in release.yml BEFORE the GitHub Release is created, so a mismatched
 * manifest never becomes a release (and never fires npm-publish). release.yml
 * has no `npm ci`, so this script imports only `node:` builtins — a workspace
 * import here would ERR_MODULE_NOT_FOUND and skip the guard entirely (same
 * constraint as extract-changelog-section.mjs).
 *
 * Usage:
 *   node scripts/release/assert-core-dependency-version.mjs [--release-version <v>] [--manifest <path>]
 *
 * --release-version defaults to the manifest `version`. Pass the tag-derived
 * version in release.yml so a manifest that forgot its own bump is also caught.
 * Exits 0 on lockstep, 1 on mismatch, 2 on usage/parse errors.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CORE_DEP = "@dev-loops/core";

function isDirectCliRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/**
 * Extract the `major.minor` token from a semver version or npm range.
 * Handles leading range operators (^, ~, >=, >, <=, <, =, v) and compound
 * ranges by taking the first `<digits>.<digits>` occurrence.
 * @param {string} spec
 * @returns {string} e.g. "0.6"
 */
export function extractMajorMinor(spec) {
  const match = String(spec).match(/(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`cannot parse a major.minor version from "${spec}"`);
  }
  return `${match[1]}.${match[2]}`;
}

/**
 * Assert the `@dev-loops/core` dependency range is in lockstep (same
 * major.minor) with the release version. Throws on mismatch (fail closed).
 * @param {{releaseVersion: string, coreRange: string}} input
 * @returns {{releaseVersion: string, coreRange: string, majorMinor: string}}
 */
export function assertCoreDependencyInLockstep({ releaseVersion, coreRange } = {}) {
  if (!releaseVersion) throw new Error("releaseVersion is required");
  if (!coreRange) {
    throw new Error(`root package must declare a "${CORE_DEP}" dependency`);
  }
  const releaseMajorMinor = extractMajorMinor(releaseVersion);
  const coreMajorMinor = extractMajorMinor(coreRange);
  if (releaseMajorMinor !== coreMajorMinor) {
    throw new Error(
      `${CORE_DEP} dependency "${coreRange}" (major.minor ${coreMajorMinor}) does not match ` +
        `the release version ${releaseVersion} (major.minor ${releaseMajorMinor}). ` +
        `Bump the ${CORE_DEP} range to ^${releaseMajorMinor}.0 before releasing (root cause of #1033).`,
    );
  }
  return { releaseVersion, coreRange, majorMinor: releaseMajorMinor };
}

function parseArgs(argv) {
  const out = { manifest: "package.json", releaseVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--release-version") out.releaseVersion = argv[++i];
    else if (arg === "--manifest") out.manifest = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function main(argv) {
  const { manifest, releaseVersion } = parseArgs(argv);
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  const coreRange = pkg.dependencies?.[CORE_DEP];
  const result = assertCoreDependencyInLockstep({
    releaseVersion: releaseVersion ?? pkg.version,
    coreRange,
  });
  process.stdout.write(
    `${CORE_DEP} ${result.coreRange} is in lockstep with release ${result.releaseVersion} (major.minor ${result.majorMinor}).\n`,
  );
}

if (isDirectCliRun(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`::error::${err.message}\n`);
    process.exit(err.message.startsWith("unknown argument") ? 2 : 1);
  });
}
