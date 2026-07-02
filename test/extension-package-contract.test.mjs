import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const fromRepoRoot = (relativePath) => new URL(`../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), "utf8");

test("package metadata exposes the extension entrypoint and root extension test script", async () => {
  const packageJson = JSON.parse(await readRepo("package.json"));

  assert.deepEqual(packageJson.pi.extensions, ["./extension/index.ts"]);
  assert.equal(packageJson.bin["dev-loops"], "./cli/index.mjs");
  assert.match(packageJson.engines.node, />=24/);
  assert.equal(typeof packageJson.peerDependencies["@earendil-works/pi-coding-agent"], "string");
  assert.equal(typeof packageJson.peerDependencies["@earendil-works/pi-tui"], "string");
  assert.equal(typeof packageJson.scripts["test:extension"], "string");
  assert.match(packageJson.scripts["test:extension"], /--import tsx/);
  assert.match(packageJson.scripts["test:extension"], /extension-checks/);
  assert.match(packageJson.scripts["test:extension"], /extension-post-merge-update/);
  assert.match(packageJson.scripts["test:extension"], /extension-command-contract/);
  assert.match(packageJson.scripts["test:extension"], /extension-package-contract/);
  assert.equal(packageJson.dependencies?.mermaid, undefined, "mermaid is vendored (#1089); must not be a runtime dependency");
  assert.deepEqual(packageJson.pi.skills, ["skills"]);
  assert.deepEqual(packageJson.pi.agents, ["agents"]);
});

test("extension README documents the supported command, install, and verification surfaces without exposing internal workflow seams", async () => {
  const readme = await readRepo("extension/README.md");

  for (const commandPattern of [
    /\/dev-loops status/i,
    /\/dev-loops doctor/i,
    /`dev-loops status`/i,
  ]) {
    assert.match(readme, commandPattern);
  }

  for (const installPattern of [
    /pi install git:github.com\/mfittko\/dev-loops/i,
    /pi install -l git:github.com\/mfittko\/dev-loops/i,
    /pi update git:github.com\/mfittko\/dev-loops/i,
  ]) {
    assert.match(readme, installPattern);
  }

  for (const runtimePattern of [
    /Node[^\n]*>=24/i,
    /source-loaded/i,
    /package\.json` `pi\.skills`/i,
    /agents\/\*\.agent\.md/i,
    /~\/\.agents/i,
    /single public workflow entry/i,
    /npm run verify/i,
    /npm run test:extension/i,
    /npm run test:dev-loop/i,
    /npm run test:playwright:viewer/i,
  ]) {
    assert.match(readme, runtimePattern);
  }

  assert.doesNotMatch(readme, /\/skill:copilot-dev-loop|\/skill:copilot-autopilot/i);
});

test("required installed runtime contract docs are bundled once in the shared installed docs location", async () => {
  const extensionReadme = await readRepo("extension/README.md");

  assert.match(extensionReadme, /required installed runtime contract docs/i);
  assert.match(extensionReadme, /public-dev-loop-contract\.md/i);
  assert.match(extensionReadme, /retrospective-checkpoint-contract\.md/i);

  assert.match(extensionReadme, /packaging\/installer bug/i);

  const requiredDocs = [
    "public-dev-loop-contract.md",
    "retrospective-checkpoint-contract.md",
  ];

  for (const doc of requiredDocs) {
    const bundledCopy = await readRepo(`skills/docs/${doc}`);
    assert.ok(bundledCopy.length > 0, `bundled contract doc skills/docs/${doc} must be present in the installed skills subtree`);
    assert.doesNotMatch(bundledCopy, /Packaged \/ installed skill use|Packaged \/ installed agent use/i, `skills/docs/${doc} should not restate the shared install contract block`);
    await assert.rejects(stat(fromRepoRoot(`docs/${doc}`)), /ENOENT/);
  }

  await assert.rejects(stat(fromRepoRoot(".pi/skills/dev-loop/docs")), /ENOENT/);
  for (const skillDir of ["dev-loop", "copilot-pr-followup", "issue-intake", "local-implementation", "final-approval"]) {
    await assert.rejects(stat(fromRepoRoot(`.pi/skills/${skillDir}/docs`)), /ENOENT/);
  }
});
