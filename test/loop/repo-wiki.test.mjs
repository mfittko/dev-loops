import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  REPO_WIKI_MIN_NODE_MAJOR,
  REPO_WIKI_NPM_PACKAGE,
  REPO_WIKI_NPM_VERSION,
  assertConsumerConfigPresent,
  assertSupportedNodeVersion,
  buildNpxInvocation,
  parseCliArgs,
} from "../../scripts/repo-wiki.mjs";

test("parseCliArgs defaults to help passthrough when no args are given", () => {
  assert.deepEqual(parseCliArgs([]), { source: "npm",
    prepareOnly: false,
    passthroughArgs: ["--help"]
  });
});

test("parseCliArgs preserves explicit --help and forwards arbitrary repo-wiki args", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { source: "npm",
    prepareOnly: false,
    passthroughArgs: ["--help"]
  });
  assert.deepEqual(parseCliArgs(["scan", "--repo", "."]), {
    source: "npm",
    prepareOnly: false,
    passthroughArgs: ["scan", "--repo", "."],
  });
});

test("buildNpxInvocation pins the npm package and version and forwards passthrough args", () => {
  const invocation = buildNpxInvocation({ passthroughArgs: ["run", "--mode", "bootstrap"] });
  assert.equal(invocation[0], "npx");
  assert.equal(invocation[1], "--yes");
  assert.equal(invocation[2], `${REPO_WIKI_NPM_PACKAGE}@${REPO_WIKI_NPM_VERSION}`);
  assert.deepEqual(invocation.slice(3), ["run", "--mode", "bootstrap"]);
});

test("buildNpxInvocation respects overrides for testing", () => {
  const invocation = buildNpxInvocation({
    packageName: "@example/custom",
    version: "1.2.3",
    passthroughArgs: ["scan"],
  });
  assert.equal(invocation[2], "@example/custom@1.2.3");
});

test("assertSupportedNodeVersion enforces the repo-wiki runtime floor", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion(`${REPO_WIKI_MIN_NODE_MAJOR}.0.0`));
  assert.throws(
    () => assertSupportedNodeVersion(`${REPO_WIKI_MIN_NODE_MAJOR - 1}.9.9`),
    /requires Node\.js/i,
  );
});

test("assertConsumerConfigPresent passes when .llmwiki/config.json exists", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "repo-wiki-config-"));
  const llmwikiDir = path.join(tempDir, ".llmwiki");
  mkdirSync(llmwikiDir, { recursive: true });
  writeFileSync(path.join(llmwikiDir, "config.json"), "{}\n", "utf8");
  try {
    assert.doesNotThrow(() =>
      assertConsumerConfigPresent({ projectRoot: tempDir }),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("assertConsumerConfigPresent throws a helpful error when config is missing", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "repo-wiki-config-"));
  try {
    assert.throws(
      () => assertConsumerConfigPresent({ projectRoot: tempDir }),
      /Missing required repo-wiki config at .*config\.json/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("npm package and version are pinned and non-empty", () => {
  assert.match(REPO_WIKI_NPM_PACKAGE, /^@mfittko\/repo-wiki$/);
  assert.match(REPO_WIKI_NPM_VERSION, /^\d+\.\d+\.\d+$/);
});

test("runRepoWiki returns a structured result without calling process.exit", async () => {
  const { runRepoWiki } = await import("../../scripts/repo-wiki.mjs");
  // Calling --help should succeed (status 0) via the npx path
  const result = await runRepoWiki(["--help"]);
  assert.equal(typeof result, "object");
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.ok(Array.isArray(result.invocation));
});
