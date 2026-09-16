// #2123 DoD gap: `claude-plugin-manifest-lockfile.test.mjs` asserts the committed
// `.claude/package.json` + `.claude/package-lock.json` shape (first-party entries carry
// `resolved` with NO `integrity`), but no test actually RUNS `npm ci` against them — the
// load-bearing AC1 assumption ("npm ci accepts `resolved` without `integrity`, recomputing it on
// download") was asserted only by inspection, never exercised. This closes that gap: it copies the
// committed manifest + lock into a throwaway dir, runs `npm ci --ignore-scripts` there (the exact
// install Claude Code's native plugin dependency auto-install performs), and asserts a
// representative wrapper resolves on disk afterward.
//
// Network-gated: a registry outage skips this locally (mirrors packaged-install-smoke.test.mjs's
// `shouldSkipForRegistryOutage` probe) but still fails closed in CI.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const claudeDir = path.join(repoRoot, ".claude");

const NETWORK_FAILURE_RE = /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|network|ERR_SOCKET|registry\.npmjs\.org.*(unreachable|timeout)/i;
const npmRegistryProbe = spawnSync("npm", ["view", "yaml", "version"], { encoding: "utf8", timeout: 15_000 });
const npmRegistryProbeDetail = `${npmRegistryProbe.stderr ?? ""}${npmRegistryProbe.stdout ?? ""}${npmRegistryProbe.error?.message ?? ""}`;
const NPM_REGISTRY_TRANSIENTLY_UNAVAILABLE =
  !process.env.CI && npmRegistryProbe.status !== 0 && NETWORK_FAILURE_RE.test(npmRegistryProbeDetail);

// A release bump pins .claude's lockfile to the NEW first-party version (dev-loops,
// @dev-loops/core) BEFORE it is published. The publish workflow runs `verify` as a
// pre-publish gate, so this `npm ci` smoke would 404 on the not-yet-published tarball and
// make the release unpublishable — a hen-and-egg where the gate needs the version the gate
// is about to create. Skip ONLY when the pinned first-party version is genuinely absent from
// the registry (an exact-version E404, distinct from a network failure), which is precisely
// the pre-publish window; once published the probe resolves and full coverage is restored.
// Real install breakage on an already-published version still fails closed. This skip is NOT
// CI-gated (unlike the transient-outage skip): the publish gate runs in CI, which is exactly
// where the hen-and-egg bites.
const firstPartyPinnedVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(claudeDir, "package.json"), "utf8"));
    const spec = pkg?.dependencies?.["dev-loops"];
    return typeof spec === "string" && spec.length > 0 ? spec : null;
  } catch {
    return null;
  }
})();
const firstPartyProbe = firstPartyPinnedVersion
  ? spawnSync("npm", ["view", `dev-loops@${firstPartyPinnedVersion}`, "version"], { encoding: "utf8", timeout: 15_000 })
  : null;
const firstPartyProbeDetail = firstPartyProbe
  ? `${firstPartyProbe.stderr ?? ""}${firstPartyProbe.stdout ?? ""}${firstPartyProbe.error?.message ?? ""}`
  : "";
const FIRST_PARTY_VERSION_UNPUBLISHED =
  firstPartyProbe != null &&
  firstPartyProbe.status !== 0 &&
  /E404|No match found for version/i.test(firstPartyProbeDetail) &&
  !NETWORK_FAILURE_RE.test(firstPartyProbeDetail);

test.skipIf(NPM_REGISTRY_TRANSIENTLY_UNAVAILABLE || FIRST_PARTY_VERSION_UNPUBLISHED)(
  "npm ci against the committed .claude manifest + lockfile installs cleanly and a representative wrapper resolves",
  { timeout: 120_000 },
  () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "dev-loops-claude-npm-ci-"));
    try {
      mkdirSync(tmpRoot, { recursive: true });
      copyFileSync(path.join(claudeDir, "package.json"), path.join(tmpRoot, "package.json"));
      copyFileSync(path.join(claudeDir, "package-lock.json"), path.join(tmpRoot, "package-lock.json"));

      const result = spawnSync("npm", ["ci", "--ignore-scripts", "--loglevel=error", "--no-audit", "--no-fund"], {
        cwd: tmpRoot,
        encoding: "utf8",
        timeout: 100_000,
      });
      const detail = `${result.stderr ?? ""}${result.stdout ?? ""}${result.error?.message ?? ""}`;
      if (result.status !== 0 && NETWORK_FAILURE_RE.test(detail)) {
        throw new Error(`npm registry became unreachable during .claude npm ci smoke: ${detail.split("\n")[0]}`);
      }
      assert.equal(result.status, 0, detail);

      // Representative wrapper (the one #2123's fix routes `dev-loops issue edit` to) resolves
      // under the installed tree, proving the whole toolchain — not just the top-level package —
      // landed on disk.
      const wrapper = path.join(tmpRoot, "node_modules/dev-loops/scripts/github/edit-issue.mjs");
      assert.ok(existsSync(wrapper), `expected ${wrapper} to exist after npm ci`);
      assert.ok(existsSync(path.join(tmpRoot, "node_modules/@dev-loops/core/package.json")), "expected @dev-loops/core to install");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  },
);
