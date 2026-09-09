// Sanctioned atomic version-bump contract (five-surface lockstep bump).
//
// Coverage layers, all CI-safe (no bun install, no resolvable @dev-loops/core):
//  - Pure fixture units for the surface logic: manifest edits, per-surface drift
//    detection, and non-bare-token rejection.
//  - The real fail-closed lockstep guard (`assert-core-dependency-version.mjs`,
//    node:-pure) driven against a bumped fixture — accepts lockstep, fails
//    closed on a stale field.
//  - The `bumpVersion` orchestration driven with an injected runner that
//    simulates the regen subprocesses: proves the surfaces→guards→staging
//    sequence, that only the enumerated release paths are staged, and that a
//    residual drift throws.
//
// The full real pipeline (actual `bun install` + `generate-claude-assets`) is
// proven by the release rehearsal in the PR and by the `claude-assets-reproducible`
// / `claude-plugin-manifest` contracts that already run under `bun run verify`.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bumpVersion, inspectSurfaces, run, stampChangelog, writeManifestSurfaces } from "../../scripts/release/bump-version.mjs";
import { extractChangelogSection } from "../../scripts/release/extract-changelog-section.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_DEP = "@dev-loops/core";
const PRERELEASE = "1.0.2-rc.99"; // a token that is never the repo's own version

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function lockfile(version) {
  return `{\n  "workspaces": {\n    "": { "dependencies": { "${CORE_DEP}": "^${version}" } },\n    "packages/core": { "name": "${CORE_DEP}", "version": "${version}" }\n  }\n}\n`;
}

// A minimal fixture carrying all five surfaces, initially at `from`.
function makeFixture(from) {
  const dir = mkdtempSync(path.join(tmpdir(), "bump-version-fixture-"));
  mkdirSync(path.join(dir, "packages/core"), { recursive: true });
  mkdirSync(path.join(dir, ".claude/.claude-plugin"), { recursive: true });
  mkdirSync(path.join(dir, ".claude/agents"), { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    name: "dev-loops",
    version: from,
    dependencies: { [CORE_DEP]: `^${from}` },
  });
  writeJson(path.join(dir, "packages/core/package.json"), { name: CORE_DEP, version: from });
  writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version: from });
  writeFileSync(path.join(dir, ".claude/agents/x.md"), `Run \`npx dev-loops@${from} loop startup\`.\n`);
  writeFileSync(path.join(dir, "bun.lock"), lockfile(from));
  writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    `# Changelog\n\n## Unreleased\n\n### Added\n\n- A documented change awaiting release.\n\n## ${from} - 2026-01-01\n\n- Prior release.\n`,
  );
  return dir;
}

test("writeManifestSurfaces sets root version, core version, and the ^-pinned core range", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeManifestSurfaces(dir, PRERELEASE);
    const root = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const core = JSON.parse(readFileSync(path.join(dir, "packages/core/package.json"), "utf8"));
    assert.equal(root.version, PRERELEASE);
    assert.equal(root.dependencies[CORE_DEP], `^${PRERELEASE}`);
    assert.equal(core.version, PRERELEASE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectSurfaces confirms all five surfaces when in lockstep and flags each drift", () => {
  const dir = makeFixture(PRERELEASE); // fixture already fully at the token
  try {
    const clean = inspectSurfaces(dir, PRERELEASE);
    assert.ok(clean.every((s) => s.ok), `expected all surfaces ok, got ${JSON.stringify(clean)}`);
    assert.equal(clean.length, 6); // 5 surfaces; the .claude surface reports plugin + pins separately

    // Drift one surface (the plugin manifest) and confirm exactly it fails closed.
    writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version: "9.9.9" });
    const drifted = inspectSurfaces(dir, PRERELEASE);
    const failed = drifted.filter((s) => !s.ok).map((s) => s.name);
    assert.deepEqual(failed, ["plugin.json version"]);

    // The pinned-npx-call-site surface is the exact drift class this PR targets:
    // confirm a stale pin is caught too.
    writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version: PRERELEASE });
    writeFileSync(path.join(dir, ".claude/agents/x.md"), `Run \`npx dev-loops@1.0.0-pre.0 loop startup\`.\n`);
    const pinDrift = inspectSurfaces(dir, PRERELEASE);
    assert.deepEqual(pinDrift.filter((s) => !s.ok).map((s) => s.name), ["pinned npx call-sites"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumpVersion rejects a non-bare target token (range operator or partial semver)", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    assert.throws(() => bumpVersion({ repoRoot: dir, version: "^1.0.0", stage: false }), /bare full version/);
    assert.throws(() => bumpVersion({ repoRoot: dir, version: "1.0", stage: false }), /parse|bare full version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A runner that stands in for the regen subprocesses: it records every call and
// simulates the two that mutate surfaces (lockfile + .claude regen), so the
// fixture reaches full lockstep exactly as the real tools would.
function makeRegenRunner(dir, version, { regenPlugin = true } = {}) {
  const calls = [];
  const silents = [];
  const run = (command, args, cwd, silent) => {
    calls.push([command, ...args].join(" "));
    silents.push(silent);
    if (command === "bun" && args.includes("--lockfile-only")) {
      writeFileSync(path.join(dir, "bun.lock"), lockfile(version));
    }
    if (command === "node" && args.some((a) => a.endsWith("generate-claude-assets.mjs")) && !args.includes("--check")) {
      if (regenPlugin) {
        writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version });
        writeFileSync(path.join(dir, ".claude/agents/x.md"), `Run \`npx dev-loops@${version} loop startup\`.\n`);
      }
    }
  };
  return { run, calls, silents };
}

test("bumpVersion drives surfaces → guards → staging in order and stages only the enumerated release paths", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    const { run, calls } = makeRegenRunner(dir, PRERELEASE);
    const result = bumpVersion({ repoRoot: dir, version: PRERELEASE, run });

    assert.ok(result.ok);
    assert.equal(result.version, PRERELEASE);
    assert.ok(result.surfaces.every((s) => s.ok), `surface drift: ${JSON.stringify(result.surfaces.filter((s) => !s.ok))}`);

    // Guard sequence: lockfile regen → .claude regen → frozen-lockfile proof →
    // core-dep lockstep guard → reproducibility --check → staging, in order.
    const seq = calls.map((c) => {
      if (c.includes("--lockfile-only")) return "lockfile";
      if (c.includes("generate-claude-assets.mjs --check")) return "check";
      if (c.includes("generate-claude-assets.mjs")) return "generate";
      if (c.includes("--frozen-lockfile")) return "frozen";
      if (c.includes("assert-core-dependency-version.mjs")) return "assert";
      if (c.startsWith("git add")) return "stage";
      return c;
    });
    assert.deepEqual(seq, ["lockfile", "generate", "frozen", "assert", "check", "stage"]);

    // Staging is an explicit enumerated pathspec — never a broad add.
    const stageCall = calls.find((c) => c.startsWith("git add"));
    assert.ok(stageCall.startsWith("git add -- "), stageCall);
    assert.ok(!/git add (-A|\.)/.test(stageCall), `broad add used: ${stageCall}`);
    for (const p of ["package.json", "packages/core/package.json", "CHANGELOG.md", "bun.lock", ".claude"]) {
      assert.ok(stageCall.includes(path.join(dir, p)), `missing staged path ${p}`);
    }

    // Sixth surface: the CHANGELOG's Unreleased heading is now stamped and the
    // release section is extractable end-to-end (the release-time guard's input).
    const changelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    assert.ok(!/^##\s+Unreleased\b/im.test(changelog), "Unreleased heading must be stamped away");
    assert.match(extractChangelogSection(changelog, PRERELEASE), /documented change awaiting release/);

    // Idempotent: a same-target re-run over the already-bumped tree is a no-op —
    // surfaces stay in lockstep, no residual-drift throw, same staged set.
    const rerun = makeRegenRunner(dir, PRERELEASE);
    const again = bumpVersion({ repoRoot: dir, version: PRERELEASE, run: rerun.run });
    assert.ok(again.ok && again.surfaces.every((s) => s.ok), "same-target re-run must be a clean no-op");
    assert.deepEqual(again.staged, result.staged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumpVersion fails closed when a surface still drifts after regen", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    // Runner regenerates the lockfile but NOT the .claude tree — a residual drift.
    const { run } = makeRegenRunner(dir, PRERELEASE, { regenPlugin: false });
    assert.throws(() => bumpVersion({ repoRoot: dir, version: PRERELEASE, run }), /residual drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The real fail-closed lockstep guard the bump runs, driven directly (node:-pure,
// no node_modules needed): exit 0 in lockstep, non-zero on a stale bun.lock field.
const ASSERT_CLI = path.join(REPO_ROOT, "scripts/release/assert-core-dependency-version.mjs");

test("the real lockstep guard accepts a prerelease-token bump and fails closed on residual drift", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeManifestSurfaces(dir, PRERELEASE);
    writeFileSync(path.join(dir, "bun.lock"), lockfile(PRERELEASE));

    const pass = spawnSync(
      "node",
      [ASSERT_CLI, "--release-version", PRERELEASE, "--manifest", path.join(dir, "package.json"), "--lockfile", path.join(dir, "bun.lock")],
      { encoding: "utf8" },
    );
    assert.equal(pass.status, 0, `guard should pass in lockstep: ${pass.stderr || pass.stdout}`);

    // Drift the bun.lock workspace entry back and confirm the guard fails closed.
    writeFileSync(
      path.join(dir, "bun.lock"),
      `{\n  "workspaces": {\n    "": { "dependencies": { "${CORE_DEP}": "^${PRERELEASE}" } },\n    "packages/core": { "name": "${CORE_DEP}", "version": "1.0.0-pre.0" }\n  }\n}\n`,
    );
    const fail = spawnSync(
      "node",
      [ASSERT_CLI, "--release-version", PRERELEASE, "--manifest", path.join(dir, "package.json"), "--lockfile", path.join(dir, "bun.lock")],
      { encoding: "utf8" },
    );
    assert.equal(fail.status, 1, "guard must fail closed on a stale bun.lock workspace version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stampChangelog rewrites the Unreleased heading to the version and extract-changelog-section then finds it", () => {
  const changelog = "# Changelog\n\n## Unreleased\n\n### Added\n\n- New thing.\n\n## 1.0.0 - 2026-01-01\n\n- Old.\n";
  const { changelog: stamped, changed } = stampChangelog(changelog, PRERELEASE);
  assert.equal(changed, true);
  assert.ok(!/^##\s+Unreleased\b/im.test(stamped), "Unreleased heading must be gone");
  assert.match(stamped, new RegExp(`^## ${PRERELEASE.replace(/[.]/g, "\\.")}$`, "m"));
  // Entries are left intact and the section is extractable end-to-end.
  assert.equal(extractChangelogSection(stamped, PRERELEASE), "### Added\n\n- New thing.");
});

test("stampChangelog fails closed when there is no Unreleased content to stamp", () => {
  // Missing Unreleased section entirely, version not yet stamped.
  assert.throws(
    () => stampChangelog("# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- Old.\n", PRERELEASE),
    /no "## Unreleased" section to stamp/,
  );
  // Present-but-empty Unreleased section.
  assert.throws(
    () => stampChangelog("# Changelog\n\n## Unreleased\n\n## 1.0.0 - 2026-01-01\n\n- Old.\n", PRERELEASE),
    /"## Unreleased" section is empty/,
  );
});

test("stampChangelog is an idempotent no-op on an already-stamped changelog", () => {
  const stamped = `# Changelog\n\n## ${PRERELEASE}\n\n### Added\n\n- New thing.\n\n## 1.0.0 - 2026-01-01\n\n- Old.\n`;
  const result = stampChangelog(stamped, PRERELEASE);
  assert.equal(result.changed, false);
  assert.equal(result.changelog, stamped);
});

// --silent contract for the shared spawn path: a cheap real child (`sh`) proves
// the quiet-on-success / replay-on-failure behavior spawnSync stdio mocking
// can't (it would just assert the mock was called correctly, not the real
// stdio wiring).
function spyStreams() {
  const stdoutChunks = [];
  const stderrChunks = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => {
    stdoutChunks.push(chunk);
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(chunk);
    return true;
  };
  return {
    stdoutChunks,
    stderrChunks,
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

test("run(..., silent=true) suppresses a successful child's stdout and stderr entirely", () => {
  // A JS-level spy on process.stdout/stderr.write can't see this: a child
  // spawned with fd-inherit stdio (the original bug, `["ignore", 2, 2]`)
  // writes straight to the parent's OS file descriptors, bypassing those
  // wrappers. Spawn a real worker subprocess instead and assert on the
  // fd-level buffers `spawnSync` captures for it — those DO catch a
  // fd-inherit leak.
  const dir = mkdtempSync(path.join(tmpdir(), "bump-version-run-"));
  const bumpVersionUrl = new URL("../../scripts/release/bump-version.mjs", import.meta.url).href;
  const workerPath = path.join(dir, "worker.mjs");
  writeFileSync(
    workerPath,
    `import { run } from ${JSON.stringify(bumpVersionUrl)};\nrun("sh", ["-c", "echo out; echo err 1>&2"], process.cwd(), true);\n`,
  );
  try {
    const res = spawnSync(process.execPath, [workerPath], { encoding: "utf8" });
    assert.equal(res.status, 0, `worker should exit 0: ${res.stderr}`);
    assert.equal(res.stdout, "");
    assert.equal(res.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run(..., silent=true) replays a failing child's diagnostics to stderr and still throws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bump-version-run-"));
  const spy = spyStreams();
  try {
    assert.throws(() => run("sh", ["-c", "echo boom 1>&2; exit 3"], dir, true), /exited 3/);
    assert.match(spy.stderrChunks.join(""), /boom/);
    assert.equal(spy.stdoutChunks.join(""), "");
  } finally {
    spy.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumpVersion threads silent to every injected runChild call", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    const { run: recordingRun, calls, silents } = makeRegenRunner(dir, PRERELEASE);
    const result = bumpVersion({ repoRoot: dir, version: PRERELEASE, silent: true, run: recordingRun });

    assert.ok(result.ok);
    assert.ok(calls.length > 0);
    assert.ok(silents.every((s) => s === true), `expected every call silent, got ${JSON.stringify(silents)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumpVersion leaves silent falsy on injected runChild calls by default (routing preserved)", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    const { run: recordingRun, calls, silents } = makeRegenRunner(dir, PRERELEASE);
    const result = bumpVersion({ repoRoot: dir, version: PRERELEASE, run: recordingRun });

    assert.ok(result.ok);
    assert.ok(calls.length > 0);
    assert.ok(silents.every((s) => !s), `expected every call non-silent, got ${JSON.stringify(silents)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
