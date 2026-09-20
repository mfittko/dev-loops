import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

// #2145: the pi-only resolver ladder must give a live source checkout precedence as candidate #1,
// mirroring `.claude/bin/dev-loops-run`'s `isCheckout`/`findCheckout` — so a stale `~/.pi` (or
// global) install never silently shadows the checkout's own CLI. Both prose sites are duplicate
// ladders and must carry the identical self-contained walk-up snippet (node: builtins only).

// The exact JS body embedded as `node -e '<SNIPPET>'` in both ladders. Single source of truth so
// the prose and the executed behavioral check never drift.
const CHECKOUT_WALKUP_SNIPPET =
  'const fs=require("node:fs"),p=require("node:path");const isCheckout=d=>{const j=p.join(d,"package.json");if(!fs.existsSync(j)||!fs.existsSync(p.join(d,"scripts")))return false;try{return JSON.parse(fs.readFileSync(j,"utf8")).name==="dev-loops"}catch{return false}};let d=process.cwd();for(;;){if(isCheckout(d)){console.log(d);process.exit(0)}const parent=p.dirname(d);if(parent===d)process.exit(1);d=parent}';

const LADDER_SOURCE_FILES = ["skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md"];

test("both pi ladders carry the checkout walk-up as candidate #1 with the shared no-version-comparison rule (#2145)", () => {
  for (const rel of LADDER_SOURCE_FILES) {
    const raw = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    assert.ok(
      raw.includes(`node -e '${CHECKOUT_WALKUP_SNIPPET}'`),
      `${rel} must embed the checkout walk-up probe verbatim`,
    );
    assert.match(raw, /no version comparison/i, `${rel} must assert "checkout wins, no version comparison"`);
    // Candidate #1 must be the checkout walk-up (it appears before the Node module resolution candidate).
    const walkupAt = raw.indexOf("Live source checkout");
    const nodeResolveAt = raw.indexOf("Node module resolution");
    assert.ok(walkupAt > 0 && walkupAt < nodeResolveAt, `${rel} must list the checkout walk-up as candidate #1`);
    // The pi-only ladder note lives inside a stripped block, but the "NEVER find /" prohibition stays.
    assert.match(raw, /NEVER fall back to `find \/`/, `${rel} must preserve the unbounded-walk prohibition`);
  }
});

test("the `.claude/bin/dev-loops-run` launcher shares the checkout-wins-no-version-comparison rule (#2145)", () => {
  const launcher = fs.readFileSync(path.join(repoRoot, ".claude/bin/dev-loops-run"), "utf8");
  assert.match(launcher, /NO version\s*\n?\/\/\s*comparison|NO version comparison/i, "dev-loops-run must state no version comparison");
  assert.ok(launcher.includes("function isCheckout") && launcher.includes("function findCheckout"),
    "dev-loops-run must define the isCheckout/findCheckout predicate the pi ladder mirrors");
  // Lock the predicate PARITY, not just its presence: the launcher's isCheckout must key on the
  // same two conditions the pi walk-up snippet does — a sibling `scripts` dir AND
  // package.json name === "dev-loops". If a future launcher change drops either condition, this
  // fails so the pi prose ladder cannot silently diverge (AC: predicate uniform across harnesses).
  const isCheckoutBody = launcher.slice(launcher.indexOf("function isCheckout"), launcher.indexOf("function findCheckout"));
  assert.match(isCheckoutBody, /"scripts"/, "dev-loops-run isCheckout must require a sibling scripts/ dir");
  assert.match(isCheckoutBody, /=== *"dev-loops"/, 'dev-loops-run isCheckout must require package.json name === "dev-loops"');
  for (const token of ['"scripts"', '"dev-loops"']) {
    assert.ok(CHECKOUT_WALKUP_SNIPPET.includes(token), `walk-up snippet must key on the same condition: ${token}`);
  }
  assert.match(CHECKOUT_WALKUP_SNIPPET, /=== *"dev-loops"/, "walk-up snippet must gate on name === dev-loops");
});

test("the embedded walk-up finds a checkout ancestor and falls through on a miss (#2145)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ladder-walkup-"));
  try {
    // Build a fake checkout: <root>/checkout with package.json name=dev-loops + sibling scripts/,
    // and a nested cwd two levels down.
    const checkout = path.join(root, "checkout");
    const nested = path.join(checkout, "tmp", "worktrees", "x");
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "dev-loops" }));

    const hit = execFileSync(process.execPath, ["-e", CHECKOUT_WALKUP_SNIPPET], { cwd: nested, encoding: "utf8" });
    assert.equal(hit.trim(), fs.realpathSync(checkout), "walk-up must resolve the checkout root from a nested cwd");

    // Miss: a dir tree with no dev-loops checkout ancestor exits non-zero (fall through).
    const orphan = path.join(root, "orphan", "deep");
    fs.mkdirSync(orphan, { recursive: true });
    let exitCode = 0;
    try {
      execFileSync(process.execPath, ["-e", CHECKOUT_WALKUP_SNIPPET], { cwd: orphan, encoding: "utf8" });
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 1, "walk-up must exit non-zero when no checkout ancestor exists");

    // A package.json named something else is not a checkout (predicate matches dev-loops-run).
    const notDevloops = path.join(root, "other");
    fs.mkdirSync(path.join(notDevloops, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(notDevloops, "package.json"), JSON.stringify({ name: "something-else" }));
    let otherExit = 0;
    try {
      execFileSync(process.execPath, ["-e", CHECKOUT_WALKUP_SNIPPET], { cwd: notDevloops, encoding: "utf8" });
    } catch (err) {
      otherExit = err.status;
    }
    assert.equal(otherExit, 1, "a non-dev-loops package.json must not be treated as a checkout");

    // The predicate is a two-condition AND: a dev-loops package.json WITHOUT a sibling scripts/
    // dir is not a checkout. Exercises the scripts/ branch's negative (the other half of the
    // mirrored predicate), so both conditions — not just the name — are proven.
    const noScripts = path.join(root, "no-scripts");
    fs.mkdirSync(noScripts, { recursive: true });
    fs.writeFileSync(path.join(noScripts, "package.json"), JSON.stringify({ name: "dev-loops" }));
    let noScriptsExit = 0;
    try {
      execFileSync(process.execPath, ["-e", CHECKOUT_WALKUP_SNIPPET], { cwd: noScripts, encoding: "utf8" });
    } catch (err) {
      noScriptsExit = err.status;
    }
    assert.equal(noScriptsExit, 1, "a dev-loops package.json without a sibling scripts/ dir is not a checkout");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
