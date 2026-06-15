import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { writeGhStub as writeGhStubHelper } from "../_helpers.mjs";
import { parseCliArgs, findRepoRoot, loadInternalPathPatterns, buildPatternMatchers, tryLoadFromFile, SHIPPED_DEFAULT_PATTERNS } from "../../scripts/loop/detect-internal-only-pr.mjs";

const scriptPath = path.resolve("scripts/loop/detect-internal-only-pr.mjs");

async function runNode(args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return env;
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

test("detect-internal-only-pr --help prints usage", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert(result.stdout.includes("detect-internal-only-pr.mjs"));
  assert(result.stdout.includes("--repo"));
  assert(result.stdout.includes("--pr"));
  assert(result.stdout.includes("--config"));
});

test("detect-internal-only-pr rejects missing arguments", async () => {
  const result = await runNode(["--repo", "owner/repo"]);
  assert.equal(result.code, 1);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert(err.error.includes("--pr"));
});

test("detect-internal-only-pr rejects unknown flags", async () => {
  const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--unknown"]);
  assert.equal(result.code, 1);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert(err.error.includes("Unknown argument"));
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

test("parseCliArgs parses valid arguments", () => {
  const parsed = parseCliArgs(["--repo", "owner/repo", "--pr", "17"]);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.pr, 17);
  assert.equal(parsed.labelCheck, false);
  assert.equal(parsed.config, undefined);
});

test("parseCliArgs parses --label-check", () => {
  const parsed = parseCliArgs(["--repo", "owner/repo", "--pr", "17", "--label-check"]);
  assert.equal(parsed.labelCheck, true);
});

test("parseCliArgs parses --config", () => {
  const parsed = parseCliArgs(["--repo", "owner/repo", "--pr", "17", "--config", "/path/to/settings.yaml"]);
  assert.equal(parsed.config, "/path/to/settings.yaml");
});

// ---------------------------------------------------------------------------
// findRepoRoot
// ---------------------------------------------------------------------------

test("findRepoRoot returns null when no .git found", () => {
  assert.equal(findRepoRoot("/tmp/nonexistent-repo-xyz"), null);
});

// ---------------------------------------------------------------------------
// Pattern loading
// ---------------------------------------------------------------------------

test("loadInternalPathPatterns returns shipped defaults when no config found", () => {
  const patterns = loadInternalPathPatterns(undefined);
  assert.deepEqual(patterns, SHIPPED_DEFAULT_PATTERNS);
});

test("loadInternalPathPatterns loads flat array from --config path (settings.yaml)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns:\n  - \"^src/\"\n  - \"^lib/\"\n");
    const patterns = loadInternalPathPatterns(configPath);
    assert.deepEqual(patterns, ["^src/", "^lib/"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadInternalPathPatterns falls back to defaults on invalid config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "garbage: [[[");
    const patterns = loadInternalPathPatterns(configPath);
    assert.deepEqual(patterns, SHIPPED_DEFAULT_PATTERNS);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadInternalPathPatterns falls back to defaults on empty patterns array", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns: []\n");
    const patterns = loadInternalPathPatterns(configPath);
    assert.deepEqual(patterns, SHIPPED_DEFAULT_PATTERNS);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadInternalPathPatterns falls back to defaults on whitespace-only patterns", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns:\n  - \"   \"\n  - \"\"\n");
    const patterns = loadInternalPathPatterns(configPath);
    assert.deepEqual(patterns, SHIPPED_DEFAULT_PATTERNS);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadInternalPathPatterns skips missing internalPathPatterns key", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "gates:\n  draft:\n    requireCi: false\n");
    const patterns = loadInternalPathPatterns(configPath);
    assert.deepEqual(patterns, SHIPPED_DEFAULT_PATTERNS);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Auto-detect via spawned process (cwd = temp repo)
// ---------------------------------------------------------------------------

test("loadInternalPathPatterns auto-detects overrides.yaml via spawned process", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    await mkdir(path.join(tempDir, ".git"));
    const piDir = path.join(tempDir, ".pi", "dev-loop");
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(piDir, "overrides.yaml"), "internalPathPatterns:\n  - \"^custom/\"\n  - \"^internal/\"\n");
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "custom/foo.mjs\ninternal/bar.sh\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadInternalPathPatterns prefers settings.yaml over overrides.yaml via spawned process", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    await mkdir(path.join(tempDir, ".git"));
    const piDir = path.join(tempDir, ".pi", "dev-loop");
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(piDir, "overrides.yaml"), "internalPathPatterns:\n  - \"^bad/\"\n");
    await writeFile(path.join(piDir, "settings.yaml"), "internalPathPatterns:\n  - \"^good/\"\n");
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "good/foo.mjs\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// tryLoadFromFile unit
// ---------------------------------------------------------------------------

test("tryLoadFromFile returns patterns from valid config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns:\n  - \"^a/\"\n  - \"^b/\"\n");
    const patterns = tryLoadFromFile(configPath);
    assert.deepEqual(patterns, ["^a/", "^b/"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tryLoadFromFile returns null for invalid YAML", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "invalid.yaml");
    await writeFile(configPath, "::: bad yaml");
    assert.equal(tryLoadFromFile(configPath), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tryLoadFromFile returns null for empty patterns array", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns: []\n");
    assert.equal(tryLoadFromFile(configPath), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tryLoadFromFile trims whitespace from patterns", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns:\n  - \"  ^src/  \"\n  - \"^lib/\"\n");
    const patterns = tryLoadFromFile(configPath);
    assert.deepEqual(patterns, ["^src/", "^lib/"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

test("buildPatternMatchers converts strings to RegExp", () => {
  const matchers = buildPatternMatchers(["^scripts/", "^test/"]);
  assert.equal(matchers.length, 2);
  assert(matchers[0].test("scripts/foo.mjs"));
  assert(matchers[1].test("test/bar.test.mjs"));
  assert(!matchers[0].test("packages/foo.mjs"));
});

test("buildPatternMatchers skips invalid regex", () => {
  const matchers = buildPatternMatchers(["^valid/", "[invalid"]);
  assert.equal(matchers.length, 1);
});

// ---------------------------------------------------------------------------
// Integration: internal-only detection via gh stub
// ---------------------------------------------------------------------------

test("detect-internal-only-pr returns internalOnly=true for scripts+test changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "scripts/foo.mjs\ntest/foo.test.mjs\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, true);
    assert.deepEqual(output.files, ["scripts/foo.mjs", "test/foo.test.mjs"]);
    assert(output.reason.includes("internal tooling"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr returns internalOnly=false for consumer-facing changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "packages/core/src/index.mjs\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, false);
    assert(output.reason.includes("Consumer-facing"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr returns internalOnly=false for mixed changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "scripts/foo.mjs\npackages/core/src/index.mjs\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr returns internalOnly=false for empty file list", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, false);
    assert(output.reason.includes("No files"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr returns internalOnly=true for docs-only changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "docs/readme.md\nskills/docs/contract.md\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr returns internalOnly=true for .pi config changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: ".pi/dev-loop/settings.yaml\n.pi/dev-loop/defaults.yaml\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr detects non-matching unknown paths as consumer-facing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "scripts/foo.mjs\nunknown/custom-file.ts\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, false);
    assert(output.reason.includes("Consumer-facing"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr respects --config with custom patterns (flat array)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns:\n  - \"^custom/\"\n  - \"^tools/\"\n");
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "custom/foo.mjs\ntools/bar.sh\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--config", configPath], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-internal-only-pr with --config detects non-matching file as consumer-facing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-internal-"));
  try {
    const configPath = path.join(tempDir, "settings.yaml");
    await writeFile(configPath, "internalPathPatterns:\n  - \"^custom/\"\n");
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"],
        stdout: "custom/foo.mjs\npackages/core/src/bar.mjs\n",
      },
    ]);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--config", configPath], { env });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.internalOnly, false);
    assert(output.reason.includes("Consumer-facing"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
