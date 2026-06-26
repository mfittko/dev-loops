import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// #774 (rescoped): the public `npx dev-loops` CLI must be harness-agnostic — it must run with
// no `@earendil-works/pi-*` present, and must not show Pi-only install strings unconditionally.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PI_IMPORT_RE = /\b(?:from|import)\s+['"]@earendil-works\/pi-[^'"]+['"]|\bimport\(\s*['"]@earendil-works\/pi-/;

async function collectSourceFiles(dir) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSourceFiles(rel)));
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("the CLI/lib source imports no @earendil-works/pi-* (Pi SDK not required)", async () => {
  const files = (await Promise.all(["cli", "lib"].map(collectSourceFiles))).flat();
  assert.ok(files.length > 0, "expected to scan CLI/lib sources");
  const offenders = [];
  for (const rel of files) {
    if (PI_IMPORT_RE.test(await readFile(path.join(repoRoot, rel), "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `CLI/lib must not import the Pi SDK: ${offenders.join(", ")}`);
});

function runCli(args) {
  return spawnSync("node", [path.join(repoRoot, "cli", "index.mjs"), ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

test("`dev-loops --help` runs standalone and is harness-agnostic", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  // Names both harness entrypoints (neutral), not Pi-only.
  assert.match(out, /\/dev-loop` \(Claude Code\)/);
  assert.match(out, /\/skill:dev-loop` \(Pi\)/);
  // No unconditional Pi install/update push on the neutral CLI surface.
  assert.doesNotMatch(out, /pi install git:/);
  assert.doesNotMatch(out, /pi update git:/);
});

test("`dev-loops status` runs standalone and exits 0", () => {
  const res = runCli(["status"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dev-loops status:/);
});

test("Pi packaging is preserved in package.json (dual-harness)", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./extension/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["skills"]);
  assert.deepEqual(pkg.pi.agents, ["agents"]);
});

// ---------------------------------------------------------------------------
// #905: harness-agnostic env-var guard.
//
// dev-loops core owns NO harness-prefixed operational env var: every var it
// defines is `DEVLOOPS_*`, with no `PI_*` alias/fallback (a deliberate 0.x
// breaking change; migration in #769). Harness-specific env coupling is
// confined to the harness-adapter boundary: the ONLY `PI_*` reads permitted in
// code are vars the Pi *runtime* injects (harness detection + Pi session/
// run-artifact discovery), and only inside the adapter modules that integrate
// with Pi. A `PI_*` env token in any other code file is a harness-coupling
// leak and fails here.
//
// Scope is CODE only (.mjs/.js/.cjs/.ts). Documentation may freely name `PI_*`
// vars — the #769 migration guide must list the renamed names, and integration
// docs describe the Pi-runtime contract — so prose is intentionally not scanned
// (harness-agnosticism is a property of the code, not the docs).
// ---------------------------------------------------------------------------

const PI_ADAPTER = path.join("packages", "core", "src", "harness", "pi-adapter.mjs");
const PI_ADAPTER_TEST = path.join("packages", "core", "test", "harness.test.mjs");
const CONDUCTOR = path.join("scripts", "loop", "conductor-monitor.mjs");
const CONDUCTOR_TEST = path.join("test", "loop", "conductor-monitor.test.mjs");

/**
 * `PI_*` vars the Pi runtime injects, mapped to the adapter-boundary files
 * allowed to read them. dev-loops does not own/define these; renaming them
 * would break Pi integration since the Pi runtime sets the `PI_*` names. A read
 * outside the listed files couples core to a specific harness and is rejected.
 */
const HARNESS_RUNTIME_ENV = new Map([
  ["PI_SESSION", [PI_ADAPTER, PI_ADAPTER_TEST]], // inside-Pi detection
  ["PI_INTERACTIVE", [PI_ADAPTER, PI_ADAPTER_TEST]], // interactivity override
  ["PI_AGENT_SESSIONS_DIR", [CONDUCTOR, CONDUCTOR_TEST]], // Pi session dir
  ["PI_SUBAGENT_SESSIONS_DIR", [CONDUCTOR, CONDUCTOR_TEST]], // Pi session dir
  ["PI_SUBAGENT_ASYNC_RUNS_DIR", [CONDUCTOR, CONDUCTOR_TEST]], // Pi async-run dir
  ["PI_SUBAGENT_ASYNC_RESULTS_DIR", [CONDUCTOR, CONDUCTOR_TEST]], // Pi async-result dir
]);

/** Match any `PI_<UPPER_SNAKE>` token (candidate env-var name). */
const PI_ENV_NAME_RE = /\bPI_[A-Z][A-Z0-9_]*\b/g;

/** Recursively collect code files (.mjs/.js/.cjs/.ts) under a dir. */
async function collectCodeFiles(dir) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...(await collectCodeFiles(rel)));
    } else if (/\.(mjs|js|cjs|ts)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("dev-loops code is harness-agnostic: no owned PI_* env var, harness-runtime reads confined to the adapter", async () => {
  // Scan canonical code + the generated .claude tree. Exclude this guard file
  // (its allowlist literals would self-match).
  const files = (
    await Promise.all(
      ["cli", "lib", "scripts", "packages", "agents", "skills", "extension", "test", ".claude"].map(
        collectCodeFiles,
      ),
    )
  ).flat();
  assert.ok(files.length > 0, "expected to scan sources");

  const selfRel = path.relative(repoRoot, fileURLToPath(import.meta.url));
  const offenders = [];
  for (const rel of files) {
    if (rel === selfRel) continue;
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    const names = new Set(content.match(PI_ENV_NAME_RE) ?? []);
    for (const name of names) {
      // Ignore non-env JS identifiers used by the Pi *import* detector tests
      // (regex/token constants like PI_IMPORT_RE, PI_DYNAMIC_RE, PI_TOKEN).
      if (name.endsWith("_RE") || name === "PI_TOKEN") continue;
      const adapterPaths = HARNESS_RUNTIME_ENV.get(name);
      if (adapterPaths) {
        // Pi-runtime-injected var: permitted only at the adapter boundary.
        if (adapterPaths.includes(rel)) continue;
        offenders.push(`${rel}: ${name} (harness-runtime var read outside the adapter boundary)`);
        continue;
      }
      // Not a Pi-runtime var → a dev-loops-owned var that must be DEVLOOPS_*.
      offenders.push(`${rel}: ${name} (dev-loops-owned PI_* var must be DEVLOOPS_*)`);
    }
  }
  assert.deepEqual(offenders, [], `harness-agnostic env-var violations:\n${offenders.join("\n")}`);
});
