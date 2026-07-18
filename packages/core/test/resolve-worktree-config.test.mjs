import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveWorktreeConfig,
  loadDevLoopConfig,
  FileConfigSchema,
} from "../src/config/config.mjs";

test("resolveWorktreeConfig: defaults to empty arrays when absent", () => {
  assert.deepEqual(resolveWorktreeConfig({}), { copyOnInit: [], linkOnInit: [] });
  assert.deepEqual(resolveWorktreeConfig(null), { copyOnInit: [], linkOnInit: [] });
});

test("resolveWorktreeConfig: trims and drops empty entries, splitting by mode", () => {
  const out = resolveWorktreeConfig({
    worktree: {
      entries: [
        { path: " config/app.yml ", mode: "copy" },
        { path: "", mode: "copy" },
        { path: "data/big", mode: "link" },
      ],
    },
  });
  assert.deepEqual(out, { copyOnInit: ["config/app.yml"], linkOnInit: ["data/big"] });
});

test("FileConfigSchema: worktree section parses", () => {
  const r = FileConfigSchema.safeParse({
    version: 1,
    worktree: { entries: [{ path: "config/app.yml", mode: "copy" }, { path: "data/big", mode: "link" }] },
  });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
});

test("FileConfigSchema: empty worktree is valid", () => {
  assert.ok(FileConfigSchema.safeParse({ version: 1, worktree: {} }).success);
});

test("FileConfigSchema: rejects unknown worktree keys", () => {
  assert.ok(!FileConfigSchema.safeParse({ version: 1, worktree: { nope: [] } }).success);
});

test("FileConfigSchema: rejects an unknown mode on a worktree entry", () => {
  assert.ok(!FileConfigSchema.safeParse({
    version: 1,
    worktree: { entries: [{ path: "config/app.yml", mode: "sync" }] },
  }).success);
});

test("loadDevLoopConfig: absent worktree section is a valid no-op", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-cfg-"));
  try {
    writeFileSync(path.join(dir, ".devloops"), "version: 1\n");
    const { config, errors } = await loadDevLoopConfig({ repoRoot: dir });
    assert.deepEqual(errors, []);
    assert.deepEqual(resolveWorktreeConfig(config), { copyOnInit: [], linkOnInit: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDevLoopConfig: worktree section loads from .devloops", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-cfg-"));
  try {
    writeFileSync(
      path.join(dir, ".devloops"),
      "version: 1\nworktree:\n  entries:\n    - path: config/app.yml\n      mode: copy\n    - path: data/big\n      mode: link\n",
    );
    const { config, errors } = await loadDevLoopConfig({ repoRoot: dir });
    assert.deepEqual(errors, []);
    assert.deepEqual(resolveWorktreeConfig(config), {
      copyOnInit: ["config/app.yml"],
      linkOnInit: ["data/big"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
