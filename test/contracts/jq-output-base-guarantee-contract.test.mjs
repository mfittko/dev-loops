// #1071: --jq/--silent is a BASE-CLI GUARANTEE for every JSON-emitting
// dev-loops command, enforced via the single shared emit path in
// scripts/lib/jq-output.mjs (emitResult).
//
// This contract has two layers:
//
//   1. Structural, fully automatic discovery (fails closed on omission): glob
//      every script under scripts/ for the shape of a JSON-emitting direct-CLI
//      command (a direct-run guard + a JSON.stringify usage) and assert each
//      discovered file routes its output through the shared jq-output module —
//      directly, or transitively through scripts/refine/_refine-helpers.mjs's
//      shared writeCheckerOutput/parseCheckerCliArgs (used by the six refine
//      checker scripts). A file that is neither wired nor in the reasoned
//      EXCLUDED allowlist below fails the test — the omission is loud, not
//      silent. This is what would have caught the original gap
//      (sync-item-status.mjs rejecting --jq).
//
//   2. Behavioral spot-check: a handful of scripts that need no gh/network
//      access are actually invoked with `--jq .`, an invalid filter, and
//      `--silent`, asserting the exact exit-code contract documented in
//      scripts/lib/jq-output.mjs. This proves the wiring works end to end,
//      not just that the import is present.
//
// The jq-subset's own behavior (evaluateJqFilter, emitResult) is exhaustively
// unit-tested in test/loop/jq-output.test.mjs; this file only enforces that
// every command *uses* that shared contract.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runNode } from "../_helpers.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptsRoot = path.join(repoRoot, "scripts");

// A file is a "direct-CLI-run" script if it either guards its top-level side
// effect behind a direct-run-detection idiom (the shared isDirectCliRun
// helper, or an equivalent inline `process.argv[1] === ...` / `.includes(...)`
// check for older scripts) OR invokes an entrypoint UNCONDITIONALLY at the top
// level (`process.exit(main(...))`, `main().catch(...)`, `await main(...)`).
// The unconditional forms have no guard to key on, so an earlier guard-only
// heuristic silently missed them (#1071 draft-gate coverage finding: three
// JSON-to-stdout CLIs — headless-dev-loop, headless-info-smoke, run-queue —
// evaded discovery entirely). Under-inclusion is the real risk here (a
// regression sailing through), so we match both shapes.
const DIRECT_RUN_GUARD_RE =
  /isDirectCliRun\(import\.meta\.url\)|process\.argv\[1\][^\n]*fileURLToPath\(import\.meta\.url\)|process\.argv\[1\][^\n]*\.includes\(|process\.exit\(\s*main\(|^\s*(?:await\s+)?main\([^\n]*\)\s*\.\s*catch\(|^\s*(?:await\s+)?main\(process\.argv/m;

// A file is "JSON-emitting" if it constructs a JSON.stringify payload
// anywhere — broad and deliberately over-inclusive (a few false positives are
// fine; they just need a reasoned EXCLUDED entry below). Under-inclusion is
// the real risk (a regression sailing through silently), so this stays loose.
const JSON_STRINGIFY_RE = /JSON\.stringify/;

// Accepted "routes through the shared emit path" evidence: a direct import of
// jq-output.mjs (emitResult), or the refine checkers' shared
// _refine-helpers.mjs wrapper (which itself imports jq-output.mjs — verified
// below as its own assertion so that indirection can't silently rot).
const JQ_OUTPUT_REFERENCE_RE = /jq-output\.mjs/;
const REFINE_HELPERS_REFERENCE_RE = /_refine-helpers\.mjs/;

// Reasoned exclusions: JSON-emitting direct-CLI scripts that are
// intentionally NOT wired to the shared --jq/--silent contract. Every entry
// must name a concrete reason a maintainer can evaluate on sight — an empty
// or vague reason defeats the point of an explicit allowlist.
const EXCLUDED = new Map([
  [
    "claude/generate-claude-assets.mjs",
    "Build tool for the Claude asset pipeline (npm run build:claude), not a dev-loop operator-facing command surfaced via the SKILL/agent verb set.",
  ],
  [
    "loop/inspect-run-viewer.mjs",
    "Long-running read-only dashboard server; its one startup JSON line is informational for a human opening a browser URL, not a \"read tool output\" result consumed by the loop/skill.",
  ],
  [
    "repo-wiki.mjs",
    "Writes its JSON to a local stamp file (fs write), never to stdout — nothing for a caller to filter with --jq.",
  ],
  [
    "claude/headless-dev-loop.mjs",
    "Build/smoke harness for the Claude asset pipeline (dry-run command echo / spawn wrapper), not a dev-loop operator-facing command in the SKILL/agent verb set — same class as generate-claude-assets.mjs.",
  ],
  [
    "claude/headless-info-smoke.mjs",
    "CI smoke test that emits a single pass/fail status line for `dev-loops status`/`loop info`; not a loop-consumed 'read tool output' result surfaced via the skill.",
  ],
  [
    "loop/run-queue.mjs",
    "Dormant no-op queue adapter: its runQueue() driver is not on any live pickup path (the active path is `scripts/projects/resolve-active-board-item.mjs`, wired into `loop-continue`), and its pretty-printed JSON is a human-readable dump, not a --jq-consumed tool result. Wire to emitResult if it is ever reactivated.",
  ],
]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files;
}

async function discoverJsonEmittingCliScripts() {
  const files = await walk(scriptsRoot);
  const candidates = [];
  for (const absPath of files) {
    const source = await readFile(absPath, "utf8");
    if (DIRECT_RUN_GUARD_RE.test(source) && JSON_STRINGIFY_RE.test(source)) {
      candidates.push({ absPath, relPath: path.relative(scriptsRoot, absPath), source });
    }
  }
  return candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function routesThroughSharedEmitPath(source) {
  return JQ_OUTPUT_REFERENCE_RE.test(source) || REFINE_HELPERS_REFERENCE_RE.test(source);
}

test("discovery recognizes UNCONDITIONAL entrypoint idioms, not just guarded ones (#1071 coverage finding)", () => {
  // Guarded idioms (already covered) must still match.
  assert.match("if (isDirectCliRun(import.meta.url)) main();", DIRECT_RUN_GUARD_RE);
  // Unconditional idioms: these have no guard to key on and were the blind spot.
  assert.match("process.exit(main(process.argv.slice(2)));", DIRECT_RUN_GUARD_RE); // headless-*
  assert.match("main().catch((err) => { process.exit(1); });", DIRECT_RUN_GUARD_RE); // run-queue
  assert.match("await main(process.argv.slice(2));", DIRECT_RUN_GUARD_RE);
  // A pure library (function defs, no top-level entrypoint) must NOT match, so
  // the heuristic doesn't over-discover non-CLI modules.
  assert.doesNotMatch("export function main(argv) { return 0; }\n", DIRECT_RUN_GUARD_RE);
});

test("_refine-helpers.mjs (the refine checkers' shared output wrapper) itself routes through jq-output.mjs", async () => {
  const helperSource = await readFile(
    path.join(scriptsRoot, "refine/_refine-helpers.mjs"),
    "utf8",
  );
  assert.match(
    helperSource,
    JQ_OUTPUT_REFERENCE_RE,
    "_refine-helpers.mjs must import the shared jq-output module so every checker built on writeCheckerOutput inherits --jq/--silent",
  );
});

test("every JSON-emitting direct-CLI script routes through the shared jq-output emit path (or is a reasoned exclusion)", async () => {
  const candidates = await discoverJsonEmittingCliScripts();
  assert.ok(candidates.length > 20, `expected a substantial discovered set, got ${candidates.length} — discovery heuristic may be broken`);

  const missing = [];
  for (const { relPath, source } of candidates) {
    if (EXCLUDED.has(relPath)) continue;
    if (!routesThroughSharedEmitPath(source)) {
      missing.push(relPath);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `JSON-emitting direct-CLI script(s) do not route through scripts/lib/jq-output.mjs and are not in the` +
      ` EXCLUDED allowlist (with a reason) in this test:\n  ${missing.join("\n  ")}\n` +
      `Fix: wire --jq/--silent via emitResult (see scripts/projects/list-queue-items.mjs), or add a` +
      ` reasoned EXCLUDED entry if this script is genuinely out of scope.`,
  );
});

test("every EXCLUDED entry is still a real, currently-discovered file (no stale allowlist entries)", async () => {
  const candidates = await discoverJsonEmittingCliScripts();
  const discovered = new Set(candidates.map((c) => c.relPath));
  const stale = [...EXCLUDED.keys()].filter((rel) => !discovered.has(rel));
  assert.deepEqual(stale, [], `stale EXCLUDED entries (no longer discovered as JSON-emitting direct-CLI scripts): ${stale.join(", ")}`);
});

// --- Behavioral spot-check: real subprocess invocations, no gh/network needed ---

test("sync-item-status.mjs (the originally observed gap): --jq/--silent/invalid-filter map to the documented exit codes", async (t) => {
  const scriptPath = path.join(scriptsRoot, "projects/sync-item-status.mjs");
  const argv = ["--repo", "owner/repo", "--item", "5", "--to-column", "Done"];
  // No .devloops in repoRoot's cwd for this invocation -> syncBoardStatus
  // fail-opens to a skipped result (best-effort contract), independent of gh.

  await t.test("--help documents the shared flags (closes the observed gap)", async () => {
    const { code, stdout } = await runNode(scriptPath, ["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /--jq <filter>/);
    assert.match(stdout, /--silent, -s/);
  });

  await t.test("--jq filters the result and exits 0", async () => {
    const { code, stdout, stderr } = await runNode(scriptPath, [...argv, "--jq", ".ok"]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "true");
  });

  await t.test("--silent suppresses stdout and maps to exit code only", async () => {
    const { code, stdout } = await runNode(scriptPath, [...argv, "--silent"]);
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });

  await t.test("an invalid --jq filter fails closed: stderr + exit 2", async () => {
    const { code, stdout, stderr } = await runNode(scriptPath, [...argv, "--jq", "bogus!!"]);
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /--jq/);
  });
});

// A broader (but shallower) spot-check: --help documents the shared flags for
// a handful of scripts spanning different subsystems and argv styles
// (single-flag file input, git-backed, multi-subcommand). Deeper behavioral
// coverage (actual --jq/--silent invocation) lives in the dedicated tests
// below for a representative subset of these.
const HELP_DOCUMENTS_JQ_FLAGS_SCRIPTS = [
  "loop/checkpoint-contract.mjs",
  "loop/detect-tracker-first-loop-state.mjs",
  "loop/detect-tracker-pr-state.mjs",
  "loop/cleanup-worktree.mjs",
  "loop/inspect-run-viewer-ci-changes.mjs",
  "refine/validate-plan-file.mjs",
];

for (const scriptRelPath of HELP_DOCUMENTS_JQ_FLAGS_SCRIPTS) {
  test(`${scriptRelPath}: --help documents the shared --jq/--silent flags`, async () => {
    const scriptPath = path.join(scriptsRoot, scriptRelPath);
    const { code, stdout } = await runNode(scriptPath, ["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /--jq <filter>/);
    assert.match(stdout, /--silent, -s/);
  });
}

test("loop/checkpoint-contract.mjs: --jq filters the result and --silent maps to exit code, in a scratch cwd", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const scriptPath = path.join(scriptsRoot, "loop/checkpoint-contract.mjs");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-jq-"));
  try {
    const { code, stdout, stderr } = await runNode(scriptPath, ["--state", "none", "--jq", ".ok"], { cwd: tempDir });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "true");

    const silentResult = await runNode(scriptPath, ["--state", "none", "--silent"], { cwd: tempDir });
    assert.equal(silentResult.code, 0);
    assert.equal(silentResult.stdout, "");

    const invalidResult = await runNode(scriptPath, ["--state", "none", "--jq", "bogus!!"], { cwd: tempDir });
    assert.equal(invalidResult.code, 2);
    assert.match(invalidResult.stderr, /--jq/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refine/validate-plan-file.mjs (a shared _refine-helpers.mjs checker): --json + --jq/--silent compose per the documented contract", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const scriptPath = path.join(scriptsRoot, "refine/validate-plan-file.mjs");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "validate-plan-file-jq-"));
  try {
    const planPath = path.join(tempDir, "bad-plan.md");
    await writeFile(planPath, "# incomplete plan\n", "utf8");

    // Documented contract: --json alone always exits 0 (the verdict lives in
    // the payload), even though this plan is invalid.
    const jsonOnly = await runNode(scriptPath, ["--input", planPath, "--json"]);
    assert.equal(jsonOnly.code, 0);
    assert.equal(JSON.parse(jsonOnly.stdout.trim()).ok, false);

    // --jq .ok + --silent turns the real verdict into the exit code (1 = false).
    const jqSilent = await runNode(scriptPath, ["--input", planPath, "--json", "--jq", ".ok", "--silent"]);
    assert.equal(jqSilent.code, 1);
    assert.equal(jqSilent.stdout, "");

    const invalid = await runNode(scriptPath, ["--input", planPath, "--json", "--jq", "bogus!!"]);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /--jq/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
