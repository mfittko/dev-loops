import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONLINT_LINUX_AMD64_SHA256, ACTIONLINT_VERSION, runActionlint } from "../../scripts/github/lint-workflows.mjs";

const FIXTURE_PATH = "test/fixtures/workflows/invalid-on-trigger.yml";
const FIXTURE_ABS_PATH = fileURLToPath(new URL(`../../${FIXTURE_PATH}`, import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/github/lint-workflows.mjs", import.meta.url));
const CI_YML_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

// Negative test for #1409 (root cause #1385): proves the actionlint wiring
// actually catches a server-side-invalid workflow (unknown `on:` event), the
// exact defect class that `gate-evidence-workflow.test.mjs`'s YAML-only parse
// can't see. Skips cleanly when actionlint isn't installed — the missing-
// binary path is a local-tooling gap, never a stand-in for a real lint pass;
// CI always has the pinned binary, so the enforcement itself never no-ops.
test("actionlint flags the deliberately-invalid on: trigger fixture", (t) => {
  const probe = runActionlint(["-version"]);
  if (probe.error?.code === "ENOENT") {
    t.skip("actionlint not installed locally — enforced in CI");
    return;
  }

  const result = runActionlint([FIXTURE_PATH]);

  assert.notEqual(result.status, 0, "actionlint should fail on the invalid on: trigger fixture");
  assert.match(result.stdout, /pull_request_review_thread/);
});

// Covers the actual enforcement seam: main()'s skip-vs-fail exit codes. Runs
// the script as a real child process (main() calls process.exit(), so it
// can't be asserted in-process) with a controlled PATH so the binary-absent
// branch is exercised deterministically regardless of what's installed on the
// machine running this test.
test("main() exits 0 with an install-hint warning when actionlint is absent from PATH", () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    // No actionlint on this PATH — only node itself, so `git` also 404s
    // (resolveRepoRoot falls back to cwd, which is fine either way).
    env: { PATH: path.dirname(process.execPath) },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, /actionlint not installed/);
});

test("main() exits non-zero when actionlint runs against the invalid-on-trigger fixture", (t) => {
  const probe = runActionlint(["-version"]);
  if (probe.error?.code === "ENOENT") {
    t.skip("actionlint not installed locally — enforced in CI");
    return;
  }

  // main() lints whatever .github/workflows/ actionlint auto-detects from cwd
  // (no file args), so give it a throwaway repo root whose only workflow is
  // the deliberately-broken fixture.
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "lint-workflows-main-"));
  try {
    const workflowsDir = path.join(tmpRoot, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    copyFileSync(FIXTURE_ABS_PATH, path.join(workflowsDir, "invalid.yml"));

    const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: tmpRoot, encoding: "utf8" });

    assert.notEqual(result.status, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// Cheap defer: keeps ci.yml's "Install actionlint" step from silently
// desyncing from the version/checksum this script warns about and the
// negative test above proves works.
test("ci.yml's pinned actionlint version + checksum match lint-workflows.mjs", () => {
  const ciYml = readFileSync(CI_YML_PATH, "utf8");

  assert.match(ciYml, new RegExp(`ACTIONLINT_VERSION: "${ACTIONLINT_VERSION}"`));
  assert.match(ciYml, new RegExp(`ACTIONLINT_SHA256: "${ACTIONLINT_LINUX_AMD64_SHA256}"`));
});
