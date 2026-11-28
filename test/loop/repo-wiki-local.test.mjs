import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";

import {
  REPO_WIKI_GIT_URL,
  REPO_WIKI_LOCAL_MIN_NODE_MAJOR,
  REPO_WIKI_REF,
  assertSupportedNodeVersion,
  parseCliArgs,
  resolveRepoWikiPaths,
} from "../../scripts/repo-wiki.mjs";

test("parseCliArgs defaults to help passthrough when no args are given", () => {
  assert.deepEqual(parseCliArgs([]), {
    source: "npm",
    prepareOnly: false,
    passthroughArgs: ["--help"],
  });
});

test("parseCliArgs recognizes prepare as a helper-only command", () => {
  assert.deepEqual(parseCliArgs(["prepare"]), {
    source: "npm",
    prepareOnly: true,
    passthroughArgs: [],
  });
});

test("parseCliArgs preserves repo-wiki passthrough arguments", () => {
  assert.deepEqual(parseCliArgs(["run", "--mode", "bootstrap", "--repo", "."]), {
    source: "npm",
    prepareOnly: false,
    passthroughArgs: ["run", "--mode", "bootstrap", "--repo", "."],
  });
});

test("parseCliArgs detects --source local", () => {
  assert.deepEqual(parseCliArgs(["--source", "local", "prepare"]), {
    source: "local",
    prepareOnly: true,
    passthroughArgs: [],
  });
});

test("resolveRepoWikiPaths returns deterministic helper paths under .tmp", () => {
  const paths = resolveRepoWikiPaths("/repo");
  assert.equal(paths.projectRoot, "/repo");
  assert.equal(paths.baseDir, path.join("/repo", ".tmp", "repo-wiki", REPO_WIKI_REF));
  assert.equal(paths.sourceDir, path.join("/repo", ".tmp", "repo-wiki", REPO_WIKI_REF, "source"));
  assert.equal(
    paths.cliPath,
    path.join("/repo", ".tmp", "repo-wiki", REPO_WIKI_REF, "source", "dist", "bin", "repo-wiki.js"),
  );
  assert.equal(
    paths.buildStampPath,
    path.join("/repo", ".tmp", "repo-wiki", REPO_WIKI_REF, "build-stamp.json"),
  );
});

test("assertSupportedNodeVersion enforces the repo-wiki local runtime floor", () => {
  const floor = REPO_WIKI_LOCAL_MIN_NODE_MAJOR;
  assert.doesNotThrow(() => assertSupportedNodeVersion(`${floor}.0.0`, floor, "requires Node.js"));
  assert.throws(
    () => assertSupportedNodeVersion(`${floor - 1}.9.9`, floor, "requires Node.js"),
    /requires Node\.js/i,
  );
});

test("repo-wiki git URL and pinned ref are well-formed", () => {
  assert.equal(REPO_WIKI_GIT_URL, "https://github.com/mfittko/repo-wiki.git");
  assert.match(REPO_WIKI_REF, /^[0-9a-f]{40}$/);
});
