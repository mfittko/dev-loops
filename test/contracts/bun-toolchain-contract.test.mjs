import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "bun:test";
import { parseBunLock } from "../../scripts/release/assert-core-dependency-version.mjs";

const repoRoot = path.resolve(import.meta.dir, "../..");
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
const readRepo = async (relativePath) => readFile(path.join(repoRoot, relativePath), "utf8");

describe("Bun 1.4.1 toolchain authority", () => {
  test("pins Bun exactly while keeping both published Node engines at >=24", async () => {
    const [root, core] = await Promise.all([readJson("package.json"), readJson("packages/core/package.json")]);
    assert.equal(root.packageManager, "bun@1.4.1");
    assert.equal(root.engines.node, ">=24");
    assert.equal(core.engines.node, ">=24");
  });

  test("uses one text Bun lock and no npm lock", async () => {
    const lock = parseBunLock(await readFile(path.join(repoRoot, "bun.lock"), "utf8"));
    assert.equal(lock.lockfileVersion, 2);
    await assert.rejects(access(path.join(repoRoot, "package-lock.json")));
  });

  test("preserves npm-compatible peer resolution while disabling runtime auto-install", async () => {
    const bunfig = await readFile(path.join(repoRoot, "bunfig.toml"), "utf8");
    assert.match(bunfig, /^\[install\]$/m);
    assert.match(bunfig, /^auto\s*=\s*"disable"$/m);
    assert.doesNotMatch(bunfig, /^peer\s*=/m, "Bun's default peer installation must match plain npm ci");

    const lock = parseBunLock(await readFile(path.join(repoRoot, "bun.lock"), "utf8"));
    assert.equal(lock.workspaces[""].peerDependencies["@earendil-works/pi-coding-agent"], "^0.84.0");
    assert.deepEqual(new Set(lock.workspaces[""].optionalPeers), new Set(["@axe-core/playwright", "@playwright/test"]));
    assert.ok(lock.packages["@earendil-works/pi-coding-agent"], "required root peer remains in the install graph");
    assert.ok(lock.packages["@earendil-works/pi-tui"], "required root peer remains in the install graph");
  });

  test("locks workspace linkage, bins, peer/optional metadata, and omits obsolete runners", async () => {
    const [root, core, lock] = await Promise.all([
      readJson("package.json"),
      readJson("packages/core/package.json"),
      readFile(path.join(repoRoot, "bun.lock"), "utf8").then(parseBunLock),
    ]);
    assert.equal(lock.packages["@dev-loops/core"][0], "@dev-loops/core@workspace:packages/core");
    assert.equal(lock.workspaces["packages/core"].name, "@dev-loops/core");
    assert.deepEqual(
      lock.workspaces["packages/core"].bin,
      Object.fromEntries(Object.entries(core.bin).map(([name, target]) => [name, target.replace(/^\.\//u, "")])),
    );
    assert.deepEqual(new Set(lock.workspaces[""].optionalPeers), new Set(["@axe-core/playwright", "@playwright/test"]));
    assert.equal(root.peerDependenciesMeta["@playwright/test"].optional, true);
    assert.equal(root.peerDependenciesMeta["@axe-core/playwright"].optional, true);
    assert.equal(root.devDependencies["npm-run-all2"], undefined);
    assert.equal(root.devDependencies.tsx, undefined);
  });

  test("keeps npm publication provenance while ordinary verification uses Bun", async () => {
    const [root, core] = await Promise.all([readJson("package.json"), readJson("packages/core/package.json")]);
    assert.deepEqual(root.publishConfig, { access: "public", provenance: true });
    assert.deepEqual(core.publishConfig, { access: "public", provenance: true });
    assert.equal(root.scripts.verify, "bun scripts/verify.mjs");
    assert.match(root.scripts["test:pack"], /^bun test /);
    const bunTestScripts = [...Object.entries(root.scripts), ["packages/core#test", core.scripts.test]].filter(([, script]) =>
      script.includes("bun test"),
    );
    for (const [name, script] of bunTestScripts) {
      assert.match(script, /\bbun test --only-failures --parallel=2\b/, `${name} uses the bounded quiet test defaults`);
    }
    for (const script of Object.values(root.scripts).filter((value) => value.includes("playwright"))) {
      assert.match(script, /node \.\/node_modules\/@playwright\/test\/cli\.js/);
    }
  });

  test("pins Bun in automation while preserving Node 24 and npm publication boundaries", async () => {
    const paths = [
      ".github/workflows/ci.yml",
      ".github/workflows/gate-evidence.yml",
      ".github/workflows/pages.yml",
      ".github/workflows/wiki.yml",
      ".github/workflows/npm-publish.yml",
      ".github/actions/playwright-webkit/action.yml",
    ];
    const entries = await Promise.all(paths.map(async (file) => [file, await readFile(path.join(repoRoot, file), "utf8")]));
    for (const [file, source] of entries) {
      assert.match(source, /actions\/setup-node@v5[\s\S]*node-version:\s*24/i, `${file} keeps Node 24`);
      assert.match(source, /oven-sh\/setup-bun@v2[\s\S]*bun-version:\s*1\.4\.1/i, `${file} pins Bun`);
      assert.match(source, /bun install --frozen-lockfile/i, `${file} uses the frozen Bun lock`);
      assert.doesNotMatch(source, /\bnpm ci\b/i, `${file} has no ordinary npm install`);
    }

    const publish = Object.fromEntries(entries)[".github/workflows/npm-publish.yml"];
    for (const boundary of [/npm pack --dry-run -w packages\/core/, /npm pack --dry-run\s*$/m, /npm view /, /npm publish -w packages\/core --provenance/, /npm publish --provenance/]) {
      assert.match(publish, boundary);
    }

    const action = Object.fromEntries(entries)[".github/actions/playwright-webkit/action.yml"];
    assert.match(action, /hashFiles\('bun\.lock'\)/);
    assert.match(action, /node \.\/node_modules\/@playwright\/test\/cli\.js install --with-deps webkit/);

    const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8");
    assert.match(dockerfile, /^FROM node:24-/m);
    assert.match(dockerfile, /ARG BUN_VERSION=1\.4\.1/);
    assert.match(dockerfile, /npm install -g "bun@\$\{BUN_VERSION\}"/);
    assert.match(dockerfile, /RUN bun install --frozen-lockfile/);
  });

  test("documents the contributor, consumer-runtime, and publication boundaries", async () => {
    const [readme, agents, extension, scripts, copilot, validation, followup, claudeFollowup, handoff, release, adr, benchmark] = await Promise.all([
      readRepo("README.md"),
      readRepo("AGENTS.md"),
      readRepo("extension/README.md"),
      readRepo("scripts/README.md"),
      readRepo(".github/copilot-instructions.md"),
      readRepo("skills/docs/validation-policy.md"),
      readRepo("skills/copilot-pr-followup/SKILL.md"),
      readRepo(".claude/skills/copilot-pr-followup/SKILL.md"),
      readRepo("packages/core/src/loop/handoff-envelope.mjs"),
      readRepo("skills/docs/release-runbook.md"),
      readRepo("docs/decisions/0059-bun-development-toolchain.md"),
      readRepo(path.join("docs", "benchmarks", "bun-1.4.1", "README.md")),
    ]);

    for (const [file, source] of [
      ["README.md", readme],
      ["AGENTS.md", agents],
      ["extension/README.md", extension],
      ["scripts/README.md", scripts],
      [".github/copilot-instructions.md", copilot],
      ["skills/docs/validation-policy.md", validation],
      ["skills/copilot-pr-followup/SKILL.md", followup],
      [".claude/skills/copilot-pr-followup/SKILL.md", claudeFollowup],
      ["packages/core/src/loop/handoff-envelope.mjs", handoff],
    ]) {
      assert.match(source, /bun run verify/i, `${file} names the canonical Bun verification command`);
    }
    assert.match(readme, /Bun 1\.4\.1/);
    assert.match(readme, /Node `>=24`/);
    assert.match(readme, /npm[\s\S]{0,200}(pack|publish|dist-tag|provenance)/i);
    assert.match(release, /bun install --frozen-lockfile/);
    assert.match(release, /npm publish --provenance/);
    assert.match(adr, /Bun 1\.4\.1[\s\S]*Node `>=24`[\s\S]*npm/i);
    assert.match(benchmark, /two independent sessions/i);
    assert.match(benchmark, /evidence status:\s*not yet captured/i);
    assert.match(benchmark, /must not/i);
  });
});
