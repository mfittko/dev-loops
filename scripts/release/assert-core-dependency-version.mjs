#!/usr/bin/env node
/**
 * Release-time guard: fail closed when the published `dev-loops` package's
 * `@dev-loops/core` dependency OR the committed `package-lock.json` version
 * fields are out of lockstep with the version being released — comparing the
 * full version token (major.minor.patch + prerelease), not just major.minor.
 *
 * Two checks:
 * 1. The `@dev-loops/core` dependency range in the root manifest must resolve
 *    to the same full version (including prerelease token) as the release.
 *    The old major.minor-only comparison let rc.6 vs rc.7 pass (`1.0 == 1.0`),
 *    the root cause of #1033's original shape and the #1886 prerelease drift.
 * 2. `package-lock.json` must be in full lockstep: root version, root package
 *    entry version, the `packages/core` workspace entry version, and the
 *    `@dev-loops/core` dependency spec must all resolve to the same full
 *    version as the release. rc.7 shipped a lockfile still pinned to rc.6
 *    through every green gate because no guard read the lockfile at all.
 *
 * Runs in release.yml BEFORE the GitHub Release is created, so a mismatched
 * manifest or stale lockfile never becomes a release (and never fires
 * npm-publish). release.yml has no `npm ci`, so this script imports only
 * `node:` builtins — a workspace import here would ERR_MODULE_NOT_FOUND and
 * skip the guard entirely (same constraint as extract-changelog-section.mjs).
 *
 * Usage:
 *   node scripts/release/assert-core-dependency-version.mjs [--release-version <v>] [--manifest <path>] [--lockfile <path>]
 *
 * --release-version defaults to the manifest `version`. Pass the tag-derived
 * version in release.yml so a manifest that forgot its own bump is also caught.
 * --manifest defaults to package.json, --lockfile to package-lock.json.
 * Exits 0 on lockstep, 1 on mismatch, 2 on usage/parse errors.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CORE_DEP = "@dev-loops/core";
const CORE_WORKSPACE_KEY = "packages/core";

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
 * Extract the full version token (`major.minor.patch[-prerelease]`) from a
 * semver version or npm range. Anchored at the start of the spec: only leading
 * range operators (^, ~, >=, <, =) and whitespace plus a `v`/`V` shorthand may
 * precede the version, so a spec that merely CONTAINS a version substring
 * (e.g. `workspace:^1.0.0-rc.7`, `file:core-1.0.0-rc.7.tgz`) fails closed
 * instead of false-passing (Copilot round-2 finding on #1886). Takes the first
 * version token in a compound range; build metadata (`+build`) is dropped
 * because it does not affect version precedence.
 * @param {string} spec
 * @returns {string} e.g. "1.0.0-rc.7"
 */
export function extractFullVersion(spec) {
  const match = String(spec).match(
    /^[\s^~>=<]*[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?/,
  );
  if (!match) {
    throw new Error(`cannot parse a full version from "${spec}"`);
  }
  const [, major, minor, patch, prerelease] = match;
  return prerelease === undefined
    ? `${major}.${minor}.${patch}`
    : `${major}.${minor}.${patch}-${prerelease}`;
}

/**
 * Assert the `@dev-loops/core` dependency range is in lockstep (same full
 * version, including the prerelease token) with the release version. Throws on
 * mismatch (fail closed).
 * @param {{releaseVersion: string, coreRange: string}} input
 * @returns {{releaseVersion: string, coreRange: string, fullVersion: string, majorMinor: string}}
 */
export function assertCoreDependencyInLockstep({ releaseVersion, coreRange } = {}) {
  if (!releaseVersion) throw new Error("releaseVersion is required");
  if (!coreRange) {
    throw new Error(`root package must declare a "${CORE_DEP}" dependency`);
  }
  const releaseFull = extractFullVersion(releaseVersion);
  const coreFull = extractFullVersion(coreRange);
  if (releaseFull !== coreFull) {
    throw new Error(
      `${CORE_DEP} dependency "${coreRange}" (version ${coreFull}) does not match ` +
        `the release version ${releaseVersion} (version ${releaseFull}). ` +
        `Bump the ${CORE_DEP} range to ^${releaseFull} before releasing ` +
        `(root cause of #1033; #1886 adds prerelease-token coverage).`,
    );
  }
  return {
    releaseVersion,
    coreRange,
    fullVersion: releaseFull,
    majorMinor: extractMajorMinor(releaseVersion),
  };
}

/**
 * Assert every `package-lock.json` version field is in full lockstep (same
 * full version, including the prerelease token) with the release version.
 * Covers the four fields rc.7 left stale: root version, root package entry
 * version, the `packages/core` workspace entry version, and the
 * `@dev-loops/core` dependency spec. Throws on any mismatch (fail closed).
 * @param {{releaseVersion: string, lockfile: object}} input
 * @returns {{releaseVersion: string, expectedVersion: string, checked: string[]}}
 */
export function assertPackageLockInLockstep({ releaseVersion, lockfile } = {}) {
  if (!releaseVersion) throw new Error("releaseVersion is required");
  if (!lockfile || typeof lockfile !== "object") {
    throw new Error("a parsed package-lock.json object is required");
  }
  const expectedVersion = extractFullVersion(releaseVersion);
  const root = lockfile.packages?.[""] ?? {};
  const workspace = lockfile.packages?.[CORE_WORKSPACE_KEY];
  const checks = [
    ["root version", lockfile.version],
    ["root package entry version", root.version],
    ["workspace entry version", workspace?.version],
    [`${CORE_DEP} dependency spec`, root.dependencies?.[CORE_DEP]],
  ];
  const failures = [];
  for (const [label, value] of checks) {
    let actualFull;
    try {
      actualFull = value === undefined ? undefined : extractFullVersion(value);
    } catch {
      actualFull = undefined;
    }
    if (actualFull !== expectedVersion) {
      const shown = value === undefined ? "<missing>" : `"${value}"`;
      failures.push(
        `${label}: ${shown} does not match release version ${releaseVersion} (${expectedVersion})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `package-lock.json is out of lockstep with the release version:\n  ${failures.join("\n  ")}`,
    );
  }
  return {
    releaseVersion,
    expectedVersion,
    checked: [
      "root version",
      "root package entry version",
      "workspace entry version",
      `${CORE_DEP} dependency spec`,
    ],
  };
}

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function parseArgs(argv) {
  const out = { manifest: "package.json", lockfile: "package-lock.json", releaseVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--release-version" || arg === "--manifest" || arg === "--lockfile") {
      const value = argv[++i];
      // Fail closed like extract-changelog-section.mjs: a flag missing its value
      // is a usage error (exit 2), not a silent fallback that defeats the guard.
      if (value === undefined) throw usageError(`${arg} requires a value`);
      if (arg === "--release-version") out.releaseVersion = value;
      else if (arg === "--manifest") out.manifest = value;
      else out.lockfile = value;
    } else {
      throw usageError(`unknown argument: ${arg}`);
    }
  }
  return out;
}

async function main(argv) {
  const { manifest, lockfile: lockfilePath, releaseVersion } = parseArgs(argv);
  // An unreadable or invalid manifest is a usage/parse error (exit 2), not a
  // lockstep mismatch (exit 1) — matches the header contract and extract-changelog-section.mjs.
  let pkg;
  try {
    pkg = JSON.parse(await readFile(manifest, "utf8"));
  } catch (err) {
    throw usageError(`cannot read or parse manifest "${manifest}": ${err.message}`);
  }
  const version = releaseVersion ?? pkg.version;
  const coreResult = assertCoreDependencyInLockstep({
    releaseVersion: version,
    coreRange: pkg.dependencies?.[CORE_DEP],
  });
  process.stdout.write(
    `${CORE_DEP} ${coreResult.coreRange} is in lockstep with release ${coreResult.releaseVersion} (version ${coreResult.fullVersion}).\n`,
  );

  // #1886: the lockfile version fields are also part of the release contract.
  // Same exit discipline as the manifest: unreadable/invalid = exit 2,
  // out-of-lockstep = exit 1.
  let lockfile;
  try {
    lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
  } catch (err) {
    throw usageError(`cannot read or parse lockfile "${lockfilePath}": ${err.message}`);
  }
  const lockResult = assertPackageLockInLockstep({ releaseVersion: version, lockfile });
  process.stdout.write(
    `package-lock.json version fields are in lockstep with release ${lockResult.releaseVersion} (version ${lockResult.expectedVersion}).\n`,
  );
}

if (isDirectCliRun(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`::error::${err.message}\n`);
    process.exit(err.usage ? 2 : 1);
  });
}
