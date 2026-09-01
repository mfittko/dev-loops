import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertCoreDependencyInLockstep,
  assertPackageLockInLockstep,
  extractFullVersion,
  extractMajorMinor,
} from "../../scripts/release/assert-core-dependency-version.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const scriptPath = path.join(repoRoot, "scripts/release/assert-core-dependency-version.mjs");

test("rejects a #1033-shaped manifest (dev-loops@0.6.2 shipping @dev-loops/core@^0.2.6)", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: "^0.2.6" }),
    /does not match the release version 0\.6\.2/,
  );
});

test("accepts a manifest whose core range matches the release full version", () => {
  const result = assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: "^0.6.2" });
  assert.equal(result.fullVersion, "0.6.2");
  assert.equal(result.majorMinor, "0.6");
});

test("rejects patch drift and tilde ranges that do not match the release full version", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: "^0.6.0" }),
    /does not match/,
  );
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "1.4.0", coreRange: "~1.4.9" }),
    /does not match/,
  );
});

test("rejects prerelease drift: rc.6 core range vs rc.7 release (issue #1886)", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "1.0.0-rc.7", coreRange: "^1.0.0-rc.6" }),
    /does not match the release version 1\.0\.0-rc\.7/,
  );
});

test("accepts a core range whose prerelease token matches the release", () => {
  assert.doesNotThrow(() =>
    assertCoreDependencyInLockstep({ releaseVersion: "1.0.0-rc.7", coreRange: "^1.0.0-rc.7" }),
  );
});

test("rejects a major mismatch even when minor agrees", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "1.6.0", coreRange: "^0.6.0" }),
    /does not match/,
  );
});

test("fails closed on a missing core dependency", () => {
  assert.throws(
    () => assertCoreDependencyInLockstep({ releaseVersion: "0.6.2", coreRange: undefined }),
    /must declare a "@dev-loops\/core" dependency/,
  );
});

test("extractMajorMinor strips range operators and compound ranges", () => {
  assert.equal(extractMajorMinor("^0.6.0"), "0.6");
  assert.equal(extractMajorMinor("~1.4.9"), "1.4");
  assert.equal(extractMajorMinor(">=0.6.0 <0.7.0"), "0.6");
  assert.equal(extractMajorMinor("0.6.2"), "0.6");
  assert.throws(() => extractMajorMinor("latest"), /cannot parse/);
});

test("extractFullVersion keeps the prerelease token and strips range operators", () => {
  assert.equal(extractFullVersion("1.0.0-rc.7"), "1.0.0-rc.7");
  assert.equal(extractFullVersion("^1.0.0-rc.7"), "1.0.0-rc.7");
  assert.equal(extractFullVersion("~1.4.9"), "1.4.9");
  assert.equal(extractFullVersion(">=0.6.0 <0.7.0"), "0.6.0");
  assert.equal(extractFullVersion("0.6.2"), "0.6.2");
  assert.throws(() => extractFullVersion("latest"), /cannot parse/);
});

function lockfileAtVersion(version) {
  return {
    name: "dev-loops",
    version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: "dev-loops",
        version,
        dependencies: { "@dev-loops/core": `^${version}` },
      },
      "packages/core": { name: "@dev-loops/core", version },
    },
  };
}

test("assertPackageLockInLockstep accepts a fully lockstep lockfile", () => {
  assert.doesNotThrow(() =>
    assertPackageLockInLockstep({ releaseVersion: "1.0.0-rc.7", lockfile: lockfileAtVersion("1.0.0-rc.7") }),
  );
});

test("assertPackageLockInLockstep rejects a stale lockfile (rc.6 fields vs rc.7 release)", () => {
  assert.throws(
    () => assertPackageLockInLockstep({ releaseVersion: "1.0.0-rc.7", lockfile: lockfileAtVersion("1.0.0-rc.6") }),
    /out of lockstep/,
  );
});

test("assertPackageLockInLockstep rejects a missing workspace entry", () => {
  const lockfile = lockfileAtVersion("1.0.0-rc.7");
  delete lockfile.packages["packages/core"];
  assert.throws(
    () => assertPackageLockInLockstep({ releaseVersion: "1.0.0-rc.7", lockfile }),
    /workspace entry version/,
  );
});

test("the real root package.json is in lockstep (guards against real drift at CI)", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.doesNotThrow(() =>
    assertCoreDependencyInLockstep({
      releaseVersion: pkg.version,
      coreRange: pkg.dependencies?.["@dev-loops/core"],
    }),
  );
});

test("the real package-lock.json is in full lockstep with the real manifest", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  assert.doesNotThrow(() =>
    assertPackageLockInLockstep({ releaseVersion: pkg.version, lockfile }),
  );
});

test("CLI exits 0 on the real in-lockstep manifest", () => {
  const res = spawnSync(
    "node",
    [scriptPath, "--manifest", "package.json"],
    { encoding: "utf8", cwd: repoRoot },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /in lockstep with release/);
  assert.match(res.stdout, /package-lock\.json version fields are in lockstep/);
});

test("CLI exits 2 on an unreadable or invalid-JSON manifest (usage/parse error)", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");

  const missing = spawnSync("node", [scriptPath, "--manifest", "does-not-exist.json"], { encoding: "utf8" });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /cannot read or parse manifest/);

  const dir = await mkdtemp(path.join(os.tmpdir(), "core-dep-bad-"));
  const bad = path.join(dir, "package.json");
  await writeFile(bad, "{ not valid json");
  try {
    const res = spawnSync("node", [scriptPath, "--manifest", bad], { encoding: "utf8" });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /cannot read or parse manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI exits 2 on a usage error (unknown arg or a flag missing its value)", () => {
  const unknown = spawnSync("node", [scriptPath, "--nope"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /unknown argument/);

  const bareFlag = spawnSync("node", [scriptPath, "--release-version"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(bareFlag.status, 2, bareFlag.stderr);
  assert.match(bareFlag.stderr, /requires a value/);
});

test("CLI fails closed (exit 1) on a synthetic #1033 manifest", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "core-dep-"));
  const manifest = path.join(dir, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({ version: "0.6.2", dependencies: { "@dev-loops/core": "^0.2.6" } }),
  );
  try {
    const res = spawnSync("node", [scriptPath, "--manifest", manifest], { encoding: "utf8" });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /::error::/);
    assert.match(res.stderr, /does not match the release version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI fails closed (exit 1) on a synthetic stale lockfile (rc.6 vs rc.7)", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lockfile-drift-"));
  const manifest = path.join(dir, "package.json");
  const lockfile = path.join(dir, "package-lock.json");
  await writeFile(
    manifest,
    JSON.stringify({ version: "1.0.0-rc.7", dependencies: { "@dev-loops/core": "^1.0.0-rc.7" } }),
  );
  await writeFile(lockfile, JSON.stringify(lockfileAtVersion("1.0.0-rc.6")));
  try {
    const res = spawnSync(
      "node",
      [scriptPath, "--manifest", manifest, "--lockfile", lockfile],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /::error::/);
    assert.match(res.stderr, /package-lock\.json is out of lockstep/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI exits 2 on an unreadable lockfile (parse error)", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lockfile-missing-"));
  const manifest = path.join(dir, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({ version: "1.0.0-rc.7", dependencies: { "@dev-loops/core": "^1.0.0-rc.7" } }),
  );
  try {
    const res = spawnSync(
      "node",
      [scriptPath, "--manifest", manifest, "--lockfile", path.join(dir, "does-not-exist.json")],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /cannot read or parse lockfile/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
