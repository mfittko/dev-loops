import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { resetThrottleCache, ghExecFileSync } from "@dev-loops/core/github/gh-throttle";
import { EventEmitter } from "node:events";
import { runChildWithInput } from "../../scripts/github/_review-thread-mutations.mjs";
import { watchWorkflowRun } from "../../scripts/loop/run-watch-cycle.mjs";
import { unresolveReviewThread } from "../../scripts/github/unresolve-review-thread.mjs";

// Each direct `gh` call site class must take a slot: the shared next-slot file appears under the repo root.
let root;
let saved;
const slotFile = () => path.join(root, "tmp", "gh-throttle", "next-slot");

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "issue-3340-sites-"));
  execFileSync("git", ["init", "-q", root]);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), "#!/bin/sh\necho '{}'\n");
  chmodSync(path.join(bin, "gh"), 0o755);
  await writeFile(path.join(root, ".devloops.json"), JSON.stringify({ version: 1, queue: { ghMinIntervalMs: 50 } }));
  saved = { GIT_DIR: process.env.GIT_DIR, PATH: process.env.PATH, DEV_LOOPS_GH_STUB: process.env.DEV_LOOPS_GH_STUB };
  delete process.env.DEV_LOOPS_GH_STUB;
  process.env.GIT_DIR = path.join(root, ".git");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  resetThrottleCache();
});
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetThrottleCache();
  await rm(root, { recursive: true, force: true });
});

describe("direct gh call sites take a throttle slot", () => {
  test("async spawn site", async () => {
    // A stdin-less child can exit before the write lands (EPIPE), so feed no input here.
    await runChildWithInput("gh", ["api", "x"], process.env);
    assert.ok(existsSync(slotFile()));
  });

  test("async execFile site", async () => {
    await unresolveReviewThread({ repo: "o/r", pr: 1, threadId: "T" }).catch(() => {});
    assert.ok(existsSync(slotFile()));
  });

  test("sync execFileSync site", () => {
    ghExecFileSync("gh", ["api", "x"], { encoding: "utf8" });
    assert.ok(existsSync(slotFile()));
  });

  test("watchWorkflowRun (gh run watch) site", async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit("close", 0));
      return child;
    };
    await watchWorkflowRun({ repo: "o/r", runId: 1 }, { env: process.env, ghCommand: "gh", spawnImpl });
    assert.ok(existsSync(slotFile()));
  });

  test("a call env that attests a gh stub takes no slot at an async site", async () => {
    await runChildWithInput("gh", ["api", "x"], { ...process.env, DEV_LOOPS_GH_STUB: "1" });
    assert.ok(!existsSync(slotFile()));
  });

  test("NODE_ENV=test without the stub is paced at a direct site", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await runChildWithInput("gh", ["api", "x"], process.env);
      assert.ok(existsSync(slotFile()));
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
