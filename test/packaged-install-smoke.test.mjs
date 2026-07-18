// Packaged-install smoke test (issue #1241).
//
// The published @dev-loops/core tarball ships only src/**+bin/** (per its
// "files" field) — NOT the monorepo's node_modules or sibling packages/ dir.
// A package-escaping import (e.g. "../../../../scripts/...") resolves fine in
// the monorepo checkout (the path exists on disk) but ERR_MODULE_NOT_FOUNDs
// the instant the package is packed, published, and installed standalone.
// Unit tests that import monorepo-relative paths can't catch this class of
// bug; this test builds the actual packed artifacts with `npm pack`, installs
// them in a throwaway directory (no monorepo context at all), and exercises
// every export-map entry + the two affected CLIs against that installed tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_DIR = path.join(REPO_ROOT, "packages/core");

// Network failures against the npm registry (offline CI, flaky proxy, DNS
// hiccup) are an environment condition, not a regression in this package —
// skip rather than fail so the suite stays green on a bad connection while
// still catching genuine install breakage (bad tarball, missing dep, etc).
const NETWORK_FAILURE_RE = /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|network|ERR_SOCKET|registry\.npmjs\.org.*(unreachable|timeout)/i;

test("packaged install: every @dev-loops/core export resolves and the queue CLIs run", { timeout: 180000 }, async (t) => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "dev-loops-pack-"));
  try {
    // 1. Pack both packages into the temp dir. `npm pack` prints the packed
    // tarball's filename as its last stdout line — use that directly rather
    // than globbing (a "dev-loops-*.tgz" glob would also match
    // "dev-loops-core-*.tgz").
    const packOne = (dir) => {
      const out = execFileSync("npm", ["pack", "--pack-destination", tmpRoot, dir], { cwd: REPO_ROOT }).toString().trim();
      const lines = out.split("\n");
      return path.join(tmpRoot, lines.at(-1).trim());
    };
    const coreTarball = packOne(CORE_DIR);
    const rootTarball = packOne(REPO_ROOT);

    // 2. Install both tarballs in a fresh subdir with no monorepo context.
    const installDir = path.join(tmpRoot, "install");
    mkdirSync(installDir);
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "packaged-install-smoke", version: "1.0.0", private: true }, null, 2));
    try {
      execFileSync("npm", ["install", "--loglevel=error", "--no-audit", "--no-fund", "--prefer-offline", rootTarball, coreTarball], { cwd: installDir });
    } catch (err) {
      const detail = `${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}${err.message ?? ""}`;
      if (NETWORK_FAILURE_RE.test(detail)) {
        t.skip(`npm registry unreachable — skipping packaged-install smoke: ${detail.split("\n")[0]}`);
        return;
      }
      throw err;
    }

    // 3. Import every @dev-loops/core export-map entry from a probe script run
    // with cwd inside the install dir, so bare-specifier resolution happens
    // against the INSTALLED tree, not the monorepo.
    const corePkgPath = path.join(installDir, "node_modules/@dev-loops/core/package.json");
    const corePkg = JSON.parse(readFileSync(corePkgPath, "utf-8"));
    const subpaths = Object.keys(corePkg.exports);
    assert.ok(subpaths.length > 0, "installed @dev-loops/core package.json has no exports map entries");

    const probePath = path.join(installDir, "probe.mjs");
    const probeSource = [
      "const subpaths = " + JSON.stringify(subpaths) + ";",
      "const failures = [];",
      "for (const sub of subpaths) {",
      '  const specifier = "@dev-loops/core" + sub.slice(1);',
      "  try {",
      "    await import(specifier);",
      "  } catch (err) {",
      "    failures.push({ specifier, message: err.message });",
      "  }",
      "}",
      "if (failures.length) {",
      "  console.error(JSON.stringify(failures, null, 2));",
      "  process.exit(1);",
      "}",
      'console.log("OK " + subpaths.length + " subpaths imported");',
    ].join("\n");
    writeFileSync(probePath, probeSource);
    const probeOutput = execFileSync("node", [probePath], { cwd: installDir }).toString();
    assert.match(probeOutput, /^OK \d+ subpaths imported/);

    // 4. Run the two affected CLIs from the installed tree; both must exit 0.
    for (const cli of ["move-queue-item.mjs", "list-queue-items.mjs"]) {
      const cliPath = path.join(installDir, "node_modules/dev-loops/scripts/projects", cli);
      const helpOutput = execFileSync("node", [cliPath, "--help"], { cwd: installDir }).toString();
      assert.match(helpOutput, /^Usage: dev-loops/);
    }

    // 5. Run the newly-routed `dev-loops` CLI subcommands (issue #1369) from
    // the installed tree — the same deps-less consumer context that broke
    // on raw `node scripts/*.mjs` — and assert exit 0 + `@dev-loops/core`
    // resolves (no ERR_MODULE_NOT_FOUND).
    const devLoopsBin = path.join(installDir, "node_modules/dev-loops/cli/index.mjs");
    for (const args of [
      ["loop", "pre-flight-gate", "--help"],
      ["loop", "ensure-worktree", "--help"],
      ["issue", "edit", "--help"],
      ["issue", "create", "--help"],
    ]) {
      const output = execFileSync("node", [devLoopsBin, ...args], { cwd: installDir }).toString();
      assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND/, `dev-loops ${args.join(" ")} failed to resolve @dev-loops/core`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
