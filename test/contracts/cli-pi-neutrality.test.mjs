import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// #774 (rescoped): the public `npx dev-loops` CLI must be harness-neutral — it must run with
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

test("`dev-loops --help` runs standalone and is harness-neutral", () => {
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
// #905: full env-var neutralization guard.
//
// Every dev-loops-OWNED operational env var must be `DEVLOOPS_*` — there is NO
// `PI_*` alias/fallback (a deliberate 0.x breaking change; migration in #769).
// This guard scans all source for `PI_*` env-var references and fails if any
// appear outside the explicit allowlist below. The only legitimate `PI_*` reads
// left are vars the Pi *runtime* injects, which dev-loops reads purely to
// integrate with the Pi harness (it does not own/define them). Renaming those
// would break Pi integration since the Pi runtime sets the `PI_*` names.
// ---------------------------------------------------------------------------

/**
 * `PI_*` env-var names dev-loops legitimately READS because the Pi runtime
 * injects them (harness detection + Pi session/run-artifact discovery). These
 * are external Pi-platform contract vars, not dev-loops configuration.
 */
const PI_PLATFORM_ENV_ALLOWLIST = new Set([
  "PI_SESSION", // pi-adapter: inside-Pi detection
  "PI_INTERACTIVE", // pi-adapter: interactivity override
  "PI_AGENT_SESSIONS_DIR", // conductor-monitor: Pi session dir
  "PI_SUBAGENT_SESSIONS_DIR", // conductor-monitor: Pi session dir
  "PI_SUBAGENT_ASYNC_RUNS_DIR", // conductor-monitor: Pi async-run dir
  "PI_SUBAGENT_ASYNC_RESULTS_DIR", // conductor-monitor: Pi async-result dir
]);

/** Match any `PI_<UPPER_SNAKE>` token (candidate env-var name). */
const PI_ENV_NAME_RE = /\bPI_[A-Z][A-Z0-9_]*\b/g;

/** Recursively collect code + prose files (.mjs/.js/.cjs/.ts/.md) under a dir. */
async function collectTextFiles(dir) {
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
      out.push(...(await collectTextFiles(rel)));
    } else if (/\.(mjs|js|cjs|ts|md)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("no dev-loops-owned PI_* env var remains: all renamed to DEVLOOPS_* (no alias)", async () => {
  // Scan canonical sources, prose, and the generated .claude tree. Exclude this
  // guard file (its allowlist literals would self-match).
  const files = (
    await Promise.all(
      ["cli", "lib", "scripts", "packages", "agents", "skills", "extension", "test", "docs", ".claude"].map(
        collectTextFiles,
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
      // (regex/token constants like PI_IMPORT_RE, PI_DYNAMIC_RE, PI_TOKEN) and
      // any name on the Pi-platform allowlist.
      if (name.endsWith("_RE") || name === "PI_TOKEN") continue;
      if (PI_PLATFORM_ENV_ALLOWLIST.has(name)) continue;
      offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `dev-loops-owned PI_* env vars must be renamed to DEVLOOPS_* (no alias):\n${offenders.join("\n")}`,
  );
});
