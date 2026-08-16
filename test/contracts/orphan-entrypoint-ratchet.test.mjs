import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ── Orphan-verifier ratchet (issue #1620) ────────────────────────────────────
//
// The dominant defect shape in the enforcement audit is the *orphan verifier*: a
// producer computes an answer and no consumer ever checks it. This contract test
// is the ratchet for that class under `scripts/`.
//
// ## Surface
// A candidate **CLI entry point** is a standalone script under `scripts/**/*.mjs`
// that self-declares a CLI run via the repo's canonical `isDirectCliRun` gate.
// Shared library/primitives (`scripts/lib/`, `_*.mjs` helpers, asset/presentational
// generators) are excluded only by having callers: `_*.mjs` helpers re-export
// `isDirectCliRun`, so they are swept like any entry point and surface on the
// orphan set only if nothing wires them.
//
// ## "non-test caller"
// An entry point has a non-test caller when any non-test artifact **executes or
// wires it**:
//   - a non-test `.mjs` source imports the script (relative import resolving to
//     that file), or spawns it (`node <path>`), or references its relative path
//   - a `package.json` `scripts` entry or a `.github/workflows/*.{yml,yaml}`
//     step runs it
// Prose documentation (skills/, agents/, commands/, scripts/README.md,
// CHANGELOG.md) is NOT a caller: it describes command usage but does not execute
// or wire the script, and the orphan-verifier class the audit tracks is a
// code-consumer orphan. Scripts with only doc references but no code/CI wiring are
// therefore reported as orphans and carried with a `standalone` disposition so
// they are acknowledged explicitly rather than hidden.
//
// ## Ratchet
// `ORPHAN_ALLOWLIST` records the current orphan set with a one-line disposition
// each (wire-up / delete / standalone). The detected orphan set must EXACTLY equal
// the allowlist:
//   - a detected orphan not in the allowlist  -> NEW UNACKNOWLEDGED ORPHAN (fail)
//   - an allowlist entry no longer an orphan  -> STALE entry, now wired (fail)
// So the allowlist is a non-increasing ratchet: it can only shrink, and any new
// unwired CLI entry point fails the build unless explicitly acknowledged with a
// disposition. `standalone` marks intentionally-standalone operator/agent tools so
// the test does not force false wiring (AC4).
//
// ## Predicates
// Exported predicate/verifier functions inside an otherwise-wired script are not
// reachable by the whole-script scan, so the few curated ones (the issue's named
// orphans) are ratcheted individually via `PREDICATE_ORPHANS`: each must still
// exist and still have no non-test code importer; wiring one requires removing its
// entry. New predicate orphans inside wired scripts are intentionally not
// auto-scanned (a per-export scan is dominated by CLI plumbing and would be noise);
// the audit already enumerated the current set, and the ratchet's job is to stop
// the set from growing and to force each seeded decision.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "vendor", "site", "tmp", "test"]);

// Explicit current orphan inventory (scripts/): *path* -> one-line disposition.
// Re-sync by running the test with a deliberately-added/removed entry, or by
// wiring/deleting a script and removing its line here.
const ORPHAN_ALLOWLIST = new Map([
  ["scripts/github/audit-gate-evidence.mjs", "standalone — post-drive gate-evidence audit step (issue #1729), agent-invoked to scan both verdict surfaces"],
  ["scripts/github/close-gate-findings.mjs", "standalone — gate fan-in close step, invoked by gate procedure subagents, not code/CI wired"],
  ["scripts/github/create-label.mjs", "standalone — operator tool for one-off label creation"],
  ["scripts/github/manage-sub-issues.mjs", "standalone — agent/operator sub-issue tree command (documented in scripts/README)"],
  ["scripts/github/resolve-angle-carry-forward.mjs", "standalone — gate angle carry-forward step, agent-invoked"],
  ["scripts/github/tick-verified-checkboxes.mjs", "delete or wire — verified-checkbox sync tool with no consumer (issue #1620 orphan; 'never required')"],
  ["scripts/github/withdraw-copilot-review-request.mjs", "standalone — Copilot review withdrawal step, agent-invoked"],
  ["scripts/loop/check-retro-tooling.mjs", "standalone — retrospective-tooling check (whole script); its analyzeTranscript export is separately ratcheted as a predicate orphan"],
  ["scripts/loop/conductor-monitor.mjs", "standalone — agent/operator conductor monitor tool (documented in scripts/README)"],
  ["scripts/loop/detect-refinement-grill-state.mjs", "standalone — refinement-grill state detector, agent-invoked"],
  ["scripts/loop/pr-runner-coordination.mjs", "delete — public duplicate; the wired sibling is scripts/loop/_pr-runner-coordination.mjs"],
  ["scripts/loop/pre-write-remote-freshness-guard.mjs", "standalone — remote-freshness guard step, agent-invoked"],
  ["scripts/loop/run-conductor-cycle.mjs", "standalone — conductor cycle step (documented in scripts/README), agent-invoked"],
  ["scripts/loop/run-gate-validation.mjs", "standalone — CLI gate-suite runner, agent/operator invoked"],
  ["scripts/loop/resolve-verdict-ledger-source.mjs", "standalone — verdict/ledger tooling source resolver (issue #1661), skill-agent-invoked to prefer worktree-source when installed CLI stale"],
  ["scripts/loop/run-refinement-audit.mjs", "standalone — refinement audit step (documented in scripts/README), agent-invoked"],
  ["scripts/loop/validate-pr-body-spec.mjs", "delete or wire — CLI superseded by core validatePrBodySpec; its --expected-issue option has no caller (issue #1620 orphan)"],
  ["scripts/refine/refine-plan-file.mjs", "standalone — refine-flow phase-file step, agent-invoked"],
  ["scripts/refine/scaffold-spike-file.mjs", "standalone — refine-flow spike scaffold step, agent-invoked"],
]);

// Curated predicate orphans: `scripts/...` -> { export, disposition }.
// The predicate ratchet covers named-EXPORT predicate orphans only: an `export
// (async )function <name>` inside an otherwise-wired script that has no non-test
// import. This matches AC1's "exported CLI/predicate entry points" scope.
//
// The issue's other named orphans that are NOT exported predicates are
// intentionally NOT ratcheted here, and are documented as acknowledged
// exclusions rather than silently dropped:
//   - `localPhaseDocAllowed` (scripts/github/resolve-tracker-local-spec.mjs:188) is
//     an output FIELD (`false`), not an exported predicate, so the named-export
//     scan cannot cover it; it is documented-standalone (README + tests) and left
//     as a field-level acknowledged orphan, consistent with the non-goal of not
//     extending this check to packages/core/src in this pass.
//   - `gates.spike` is a config field defined in resolve-dev-loop-startup.mjs and
//     referenced only by config tests; it is likewise a field, not an exported
//     predicate, and is acknowledged rather than export-ratcheted.
// Seeding an exported predicate here requires removing its entry once wired (the
// STALE direction), exactly like the whole-script allowlist.
const PREDICATE_ORPHANS = new Map([
  [
    "scripts/loop/check-retro-tooling.mjs",
    { export: "analyzeTranscript", disposition: "delete — transcript analyzer whose consumer was deliberately removed by ADR 0024; only a test importer remains" },
  ],
]);

// ── Filesystem helpers ──────────────────────────────────────────────────────

async function walkMjs(dir, out = [], ext = [".mjs"]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkMjs(abs, out, ext);
    } else if (entry.isFile() && ext.some((e) => entry.name.endsWith(e))) {
      out.push(abs);
    }
  }
  return out;
}

const fileCache = new Map();
async function read(f) {
  if (!fileCache.has(f)) fileCache.set(f, await readFile(f, "utf8"));
  return fileCache.get(f);
}

// ── Caller detection ────────────────────────────────────────────────────────

// All non-test .mjs sources in the repo (scripts/, packages/, cli/, lib/, etc.).
async function nonTestSources() {
  const all = await walkMjs(REPO_ROOT);
  return all.filter((f) => !f.split(path.sep).includes("test"));
}

// Shared import/export-from statement scraper: returns `{ statement, spec }` for
// every `from` clause, matching both single- and double-quoted specifiers so all
// entry points (and every parser below) normalize quotes identically.
function importFromStatements(code) {
  const out = [];
  const re = /(?:import|export)[^;]*?\bfrom\s*(["'])([^"']+)\1/g;
  let m;
  while ((m = re.exec(code))) out.push({ statement: m[0], spec: m[2] });
  return out;
}

// Relative import targets in `code` originating from `fromFile`, resolved to abs.
function resolveRelativeImportTargets(code, fromFile) {
  const targets = [];
  for (const { spec } of importFromStatements(code)) {
    if (!spec.startsWith(".")) continue;
    const abs = path.resolve(path.dirname(fromFile), spec);
    if (abs.endsWith(".mjs")) targets.push(abs);
  }
  return targets;
}

function hasSpawnOrPathRef(code, rel, base) {
  if (code.includes(rel)) return true;
  return new RegExp(`node\\s+["']?\\S*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(code);
}

// Determine whether a CLI entry-point script has any non-test caller.
async function hasNonTestCaller(scriptAbs, scriptRel, base, sources, workflowTexts, pkgText) {
  for (const source of sources) {
    if (source === scriptAbs) continue;
    const code = await read(source);
    if (resolveRelativeImportTargets(code, source).some((t) => t === scriptAbs)) {
      return true;
    }
    if (hasSpawnOrPathRef(code, scriptRel, base)) return true;
  }
  if (pkgText.includes(base) || pkgText.includes(scriptRel)) return true;
  for (const wf of workflowTexts) if (wf.includes(base) || wf.includes(scriptRel)) return true;
  return false;
}

// ── Surface ──────────────────────────────────────────────────────────────────

// "scripts/<...>/file.mjs" for every CLI entry point (uses isDirectCliRun).
async function cliEntryPoints() {
  const scripts = await walkMjs(SCRIPTS_DIR);
  const entry = [];
  for (const f of scripts) {
    const code = await read(f);
    if (/isDirectCliRun/.test(code)) {
      entry.push({ abs: f, rel: path.relative(REPO_ROOT, f).split(path.sep).join("/"), base: path.basename(f) });
    }
  }
  return entry;
}

async function workflowTexts() {
  const workflowRoot = path.join(REPO_ROOT, ".github");
  const out = [];
  const all = await walkMjs(workflowRoot, [], [".yml", ".yaml"]).catch(() => []);
  for (const f of all) out.push(await read(f));
  return out;
}

test("every CLI entry point under scripts/ either has a non-test caller or is allowlisted (orphan ratchet)", async () => {
  const sources = await nonTestSources();
  const wfTexts = await workflowTexts();
  const pkgText = await read(path.join(REPO_ROOT, "package.json"));
  const entry = await cliEntryPoints();

  const orphans = new Map();
  for (const e of entry) {
    if (!(await hasNonTestCaller(e.abs, e.rel, e.base, sources, wfTexts, pkgText))) {
      orphans.set(e.rel, true);
    }
  }

  const orphanSet = [...orphans.keys()];
  const allowSet = [...ORPHAN_ALLOWLIST.keys()];

  const unexpected = orphanSet.filter((p) => !ORPHAN_ALLOWLIST.has(p));
  assert.deepEqual(
    unexpected,
    [],
    `NEW UNACKNOWLEDGED ORPHAN(S) under scripts/: ${unexpected.join(", ")} — wire the script or add it to ORPHAN_ALLOWLIST in orphan-entrypoint-ratchet.test.mjs with a disposition`,
  );

  const stale = allowSet.filter((p) => !orphans.has(p));
  assert.deepEqual(
    stale,
    [],
    `STALE ALLOWLIST ENTRIES that now have a non-test caller (remove them; the ratchet only shrinks): ${stale.join(", ")}`,
  );

  // Every allowlist entry must carry a non-empty disposition (AC2/AC4).
  for (const [p, disposition] of ORPHAN_ALLOWLIST) {
    assert.ok(disposition && disposition.trim().length > 0, `allowlist entry ${p} needs a one-line disposition`);
  }
});

test("seeded predicate orphans still exist and still have no non-test code importer (predicate ratchet)", async () => {
  const sources = await nonTestSources();

  for (const [rel, { export: exportName, disposition }] of PREDICATE_ORPHANS) {
    assert.ok(disposition && disposition.trim().length > 0, `predicate entry ${rel} needs a one-line disposition`);
    const script = path.join(REPO_ROOT, rel);
    const code = await read(script);
    const exportStillExists = new RegExp(`export\\s+(?:async\\s+)?function\\s+${exportName}\\b`).test(code);
    const namedImportRe = new RegExp(`import\\s*\\{[^}]*\\b${exportName}\\b[^}]*}`);
    let importer = null;
    for (const source of sources) {
      const scode = await read(source);
      const namedStmt = importFromStatements(scode).find((s) => namedImportRe.test(s.statement));
      if (!namedStmt) continue;
      if (resolveRelativeImportTargets(scode, source).includes(script)) {
        importer = path.relative(REPO_ROOT, source);
        break;
      }
    }
    assert.ok(exportStillExists, `predicate orphan ${rel}::${exportName} no longer exists — delete its PREDICATE_ORPHANS entry`);
    assert.equal(
      importer,
      null,
      `predicate orphan ${rel}::${exportName} now has a non-test importer (${importer}) — wire it intentionally or remove the entry`,
    );
  }
});
