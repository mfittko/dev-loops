import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { parseBunLock } from "../../scripts/release/assert-core-dependency-version.mjs";

const root = path.resolve(import.meta.dir, "../..");
const read = (file) => readFile(path.join(root, file), "utf8");
const json = async (file) => JSON.parse(await read(file));

test("Bun owns development while Node and npm retain consumer boundaries", async () => {
  const [pkg, core, lock, bunfig] = await Promise.all([
    json("package.json"), json("packages/core/package.json"), read("bun.lock").then(parseBunLock), read("bunfig.toml"),
  ]);
  assert.equal(pkg.packageManager, "bun@1.4.1");
  assert.equal(pkg.engines.node, ">=24");
  assert.equal(core.engines.node, ">=24");
  assert.equal(lock.lockfileVersion, 2);
  assert.equal(lock.packages["@dev-loops/core"][0], "@dev-loops/core@workspace:packages/core");
  assert.deepEqual(new Set(lock.workspaces[""].optionalPeers), new Set(["@axe-core/playwright", "@playwright/test"]));
  assert.match(bunfig, /^auto\s*=\s*"disable"$/m);
  assert.doesNotMatch(bunfig, /^peer\s*=/m);
  await assert.rejects(access(path.join(root, "package-lock.json")));
  assert.equal(pkg.scripts.verify, "bun scripts/verify.mjs");
  assert.equal(pkg.devDependencies["npm-run-all2"], undefined);
  assert.equal(pkg.devDependencies.tsx, undefined);
});

test("automation pins Bun 1.4.1 and preserves intentional npm publication", async () => {
  const files = [
    ".github/workflows/ci.yml", ".github/workflows/gate-evidence.yml", ".github/workflows/pages.yml",
    ".github/workflows/wiki.yml", ".github/workflows/npm-publish.yml", ".github/actions/playwright-webkit/action.yml",
  ];
  const sources = await Promise.all(files.map(read));
  for (const [index, source] of sources.entries()) {
    assert.match(source, /node-version:\s*24/i, `${files[index]} keeps Node 24`);
    assert.match(source, /bun-version:\s*1\.4\.1/i, `${files[index]} pins Bun`);
    assert.match(source, /bun install --frozen-lockfile/i, `${files[index]} uses bun.lock`);
    assert.doesNotMatch(source, /\bnpm ci\b/i, `${files[index]} has no ordinary npm install`);
  }
  const publish = sources[4];
  for (const boundary of [/npm pack --dry-run/, /npm view /, /npm publish -w packages\/core --provenance/, /npm publish --provenance/]) assert.match(publish, boundary);
  assert.match(sources[5], /hashFiles\('bun\.lock'\)/);
  assert.match(sources[5], /playwright\/test\/cli\.js install --with-deps webkit/);
  const docker = await read("Dockerfile");
  assert.match(docker, /^FROM node:24-/m);
  assert.match(docker, /ARG BUN_VERSION=1\.4\.1/);
  assert.match(docker, /bun install --frozen-lockfile/);
});

test("durable guidance records the toolchain and accepted benchmark", async () => {
  const surfaces = ["README.md", "AGENTS.md", "extension/README.md", "scripts/README.md", ".github/copilot-instructions.md", "skills/docs/validation-policy.md", "skills/copilot-pr-followup/SKILL.md", ".claude/skills/copilot-pr-followup/SKILL.md", "packages/core/src/loop/handoff-envelope.mjs"];
  for (const file of surfaces) assert.match(await read(file), /bun run verify/i, `${file} names canonical verification`);
  assert.match(await read("docs/decisions/0061-bun-development-toolchain.md"), /Bun 1\.4\.1[\s\S]*Node `>=24`[\s\S]*npm/i);
  assert.match(await read("docs/benchmarks/bun-1.4.1/verdict.md"), /Verdict: \*\*pass\*\*/);
  const sessions = await Promise.all([1, 2].map((number) => json(`docs/benchmarks/bun-1.4.1/session-${number}.raw.json`)));
  assert.notEqual(sessions[0].sessionRoot, sessions[1].sessionRoot);
  assert.deepEqual(sessions[0].sourceFingerprint, sessions[1].sourceFingerprint);
  const migrationTests = ["test/benchmarks/package-manager-benchmark.test.mjs", "test/contracts/bun-toolchain-contract.test.mjs", "test/contracts/bun-verification-orchestrator.test.mjs", "test/loop/run-bun-test.test.mjs", "test/loop/test-inventory.test.mjs"];
  for (const evidence of sessions) {
    assert.deepEqual(evidence.suiteInventory.npm, evidence.suiteInventory.bun);
    assert.deepEqual(evidence.testInventory.bun, [...evidence.testInventory.npm, ...migrationTests].sort());
    for (const key of ["workspaceLinks", "peerMetadata"]) assert.deepEqual(evidence.inventory.npm[key], evidence.inventory.bun[key]);
  }
  await assert.rejects(access(path.join(root, "scripts/benchmarks/run-package-manager.mjs")));
});
