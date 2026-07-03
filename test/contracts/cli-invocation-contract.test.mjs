import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";

// #801 + #833: the Pi runtime sources invoke the CLI as the package-local
// `node <dev-loops-package-root>/cli/index.mjs` form (resolves unambiguously from the installed
// package, no global install). The generated Claude tree rewrites that to the version-pinned
// `npx dev-loops@<version>` form, because the Claude plugin does not bundle `cli/` and pinning
// the version eliminates CLI-vs-plugin version skew.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const currentVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

const PI_TOKEN = "node <dev-loops-package-root>/cli/index.mjs";

// `npx dev-loops` (any whitespace: space, tab, or newline) NOT immediately followed by `@`
// is the unversioned, ambiguous form we ban across both the runtime source (#801/#833) and the
// consumer-facing surface (#1036). Single source so the test and the enforced intent never drift.
const UNVERSIONED_NPX = /npx\s+dev-loops(?!@)/g;

/** Every runtime source skill/agent file (the files Pi consumes directly). */
function runtimeSourceFiles() {
  const files = [];
  const skillsDir = path.join(repoRoot, "skills");
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(skillsDir, entry.name, "SKILL.md");
    if (fs.existsSync(abs)) files.push(path.relative(repoRoot, abs));
  }
  const agentsDir = path.join(repoRoot, "agents");
  for (const entry of fs.readdirSync(agentsDir)) {
    if (entry.endsWith(".agent.md")) files.push(path.relative(repoRoot, path.join(agentsDir, entry)));
  }
  return files;
}

test("no unversioned `npx dev-loops` remains in the runtime source skills/agents (#801, #833)", () => {
  for (const rel of runtimeSourceFiles()) {
    const raw = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    const unversioned = raw.match(UNVERSIONED_NPX) ?? [];
    assert.deepEqual(unversioned, [], `${rel} must not contain unversioned \`npx dev-loops\``);
  }
});

test("the dev-loop runtime source uses the package-local `node .../cli/index.mjs` form (#801)", () => {
  const skill = fs.readFileSync(path.join(repoRoot, "skills/dev-loop/SKILL.md"), "utf8");
  const agent = fs.readFileSync(path.join(repoRoot, "agents/dev-loop.agent.md"), "utf8");
  assert.ok(skill.includes(PI_TOKEN), "dev-loop SKILL.md must invoke the package-local CLI form");
  assert.ok(agent.includes(PI_TOKEN), "dev-loop agent must invoke the package-local CLI form");
});

test("generated Claude skill/agent pin `npx dev-loops@<version>` and drop the package-local form (#833)", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const byTarget = new Map(assets.map((a) => [a.target, a.content]));
  for (const target of [".claude/skills/dev-loop/SKILL.md", ".claude/agents/dev-loop.md"]) {
    const content = byTarget.get(target);
    assert.ok(content, `expected generated ${target}`);
    assert.ok(
      content.includes(`npx dev-loops@${currentVersion}`),
      `${target} must pin npx dev-loops@${currentVersion}`,
    );
    assert.equal(
      content.includes(PI_TOKEN),
      false,
      `${target} must not contain the package-local CLI form (Claude bundles no cli/)`,
    );
    assert.equal(
      content.includes("<dev-loops-package-root>"),
      false,
      `${target} must not contain the Pi-only package-root note`,
    );
  }
});

// #1036: the consumer-facing invocation surface (docs, README, CLI help/usage strings) must
// also pin `npx dev-loops@<version>` — never the bare, ambiguous `npx dev-loops` that resolves
// a possibly-stale global/cached copy. `<version>` is the documented placeholder; concrete
// majors stay enforced by docs-identity-contract.
function collectFiles(dir, exts) {
  const out = [];
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(rel, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel);
  }
  return out;
}

test("no unversioned `npx dev-loops` in the consumer-facing docs/CLI/tooling surface (#1036)", () => {
  // Glob the whole doc + CLI + script tree instead of hardcoding files, so a bare
  // `npx dev-loops` added anywhere later is caught. Internal tooling should invoke
  // the package-local `node .../cli/index.mjs` form, never bare npx.
  const surface = [
    "README.md",
    ...collectFiles("docs", [".md"]),
    ...collectFiles("extension", [".md"]),
    ...collectFiles("cli", [".mjs"]),
    ...collectFiles("scripts", [".mjs"]),
  ];
  const offenders = [];
  for (const rel of surface) {
    const raw = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    if ((raw.match(UNVERSIONED_NPX) ?? []).length > 0) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `consumer surface must pin npx dev-loops@<version>: ${offenders.join(", ")}`);
});
