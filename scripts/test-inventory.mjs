import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const BUN_TEST_SUITES = Object.freeze({
  assets: Object.freeze([
    "test/dev-loop-init-phase-smoke.test.mjs",
    "test/core-runtime-boundary.test.mjs",
    "test/contracts/*.test.mjs",
    "test/benchmarks/*.test.mjs",
    "test/workflow-handoff-contract.test.mjs",
  ]),
  extension: Object.freeze([
    "test/extension-checks.test.mjs",
    "test/extension-post-merge-update.test.mjs",
    "test/extension-command-contract.test.mjs",
    "test/extension-package-contract.test.mjs",
    "test/extension-pi-adapter.test.mjs",
    "test/dev-loops-core.test.mjs",
    "test/dev-loops-cli.test.mjs",
    "test/cli-deps-less-checkout-preflight.test.mjs",
    "test/extension-pi-agent-tools.test.mjs",
  ]),
  scripts: Object.freeze([
    "test/github/*.test.mjs",
    "test/loop/*.test.mjs",
    "test/docs/*.test.mjs",
    "test/projects/*.test.mjs",
    "test/pages/*.test.mjs",
    "test/security/*.test.mjs",
  ]),
  core: Object.freeze(["packages/core/test/*.test.mjs"]),
  pack: Object.freeze(["test/packaged-install-smoke.test.mjs"]),
  "dev-loop": Object.freeze([
    "skills/dev-loop/scripts/dev-mode-context.test.mjs",
    "skills/dev-loop/scripts/render-template.test.mjs",
    "skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs",
  ]),
});

export const BUN_TEST_SUITE_NAMES = Object.freeze(Object.keys(BUN_TEST_SUITES));

const REPOSITORY_TEST_PATTERNS = Object.freeze([
  "test/**/*.test.mjs",
  "packages/core/test/*.test.mjs",
  "skills/dev-loop/scripts/*.test.mjs",
]);

async function expandPattern(pattern, repoRoot) {
  if (!pattern.includes("*")) {
    await access(path.join(repoRoot, pattern));
    return [pattern];
  }
  return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: repoRoot, onlyFiles: true }));
}

async function expandPatterns(patterns, repoRoot) {
  const files = (await Promise.all(patterns.map((pattern) => expandPattern(pattern, repoRoot)))).flat().sort();
  const duplicate = files.find((file, index) => index > 0 && file === files[index - 1]);
  if (duplicate) throw new Error(`Duplicate Bun test inventory entry: ${duplicate}`);
  return files;
}

export async function resolveTestInventory({
  repoRoot = DEFAULT_REPO_ROOT,
  suites = BUN_TEST_SUITE_NAMES,
} = {}) {
  const patterns = [];
  for (const suite of suites) {
    if (!Object.hasOwn(BUN_TEST_SUITES, suite)) {
      throw new Error(`Unknown Bun test suite: ${suite}`);
    }
    patterns.push(...BUN_TEST_SUITES[suite]);
  }
  return expandPatterns(patterns, repoRoot);
}

export async function discoverRepositoryTests({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return expandPatterns(REPOSITORY_TEST_PATTERNS, repoRoot);
}
