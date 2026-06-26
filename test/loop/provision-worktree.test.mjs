import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, readlinkSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  provisionWorktree,
  parseProvisionWorktreeCliArgs,
} from "../../scripts/loop/provision-worktree.mjs";

// ---------------------------------------------------------------------------
// Fixture: a main checkout with a .devloops and a worktree dir.
// ---------------------------------------------------------------------------

function makeFixture(devloops) {
  const base = mkdtempSync(path.join(tmpdir(), "wt-prov-"));
  const repoRoot = path.join(base, "main");
  const worktreePath = path.join(base, "wt");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(repoRoot, ".devloops"), devloops);
  return { base, repoRoot, worktreePath, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseProvisionWorktreeCliArgs: requires --worktree-path and --repo-root", () => {
  assert.throws(() => parseProvisionWorktreeCliArgs(["--repo-root", "/r"]), /worktree-path/);
  assert.throws(() => parseProvisionWorktreeCliArgs(["--worktree-path", "/w"]), /repo-root/);
});

test("parseProvisionWorktreeCliArgs: --help short-circuits", () => {
  assert.equal(parseProvisionWorktreeCliArgs(["--help"]).help, true);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test("provision: copies a literal file", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - config/app.yml\n");
  try {
    mkdirSync(path.join(fx.repoRoot, "config"));
    writeFileSync(path.join(fx.repoRoot, "config/app.yml"), "key: value\n");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.ok, true);
    assert.equal(res.summary.copied, 1);
    const dest = path.join(fx.worktreePath, "config/app.yml");
    assert.equal(readFileSync(dest, "utf8"), "key: value\n");
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Symlink a directory (absolute)
// ---------------------------------------------------------------------------

test("provision: symlinks a directory with an absolute target", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  linkOnInit:\n    - data/big\n");
  try {
    mkdirSync(path.join(fx.repoRoot, "data/big"), { recursive: true });
    writeFileSync(path.join(fx.repoRoot, "data/big/blob.bin"), "x");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.summary.linked, 1);
    const dest = path.join(fx.worktreePath, "data/big");
    assert.ok(lstatSync(dest).isSymbolicLink());
    const target = readlinkSync(dest);
    assert.ok(path.isAbsolute(target), `expected absolute symlink, got ${target}`);
    assert.equal(target, path.join(fx.repoRoot, "data/big"));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Glob expansion
// ---------------------------------------------------------------------------

test("provision: expands a glob pattern", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - 'config/*.yml'\n");
  try {
    mkdirSync(path.join(fx.repoRoot, "config"));
    writeFileSync(path.join(fx.repoRoot, "config/a.yml"), "a");
    writeFileSync(path.join(fx.repoRoot, "config/b.yml"), "b");
    writeFileSync(path.join(fx.repoRoot, "config/c.txt"), "c");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.summary.copied, 2);
    assert.ok(existsSync(path.join(fx.worktreePath, "config/a.yml")));
    assert.ok(existsSync(path.join(fx.worktreePath, "config/b.yml")));
    assert.ok(!existsSync(path.join(fx.worktreePath, "config/c.txt")));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fail-soft on missing source
// ---------------------------------------------------------------------------

test("provision: missing source fails soft (warns, continues, ok)", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - config/absent.yml\n");
  try {
    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.ok, true);
    assert.equal(res.summary.copied, 0);
    assert.ok(res.summary.warnings >= 1);
    // literal missing path → skip with source-missing reason
    assert.ok(res.actions.some((a) => a.mode === "skip" && a.reason === "source-missing"));
  } finally {
    fx.cleanup();
  }
});

test("provision: empty glob fails soft", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - 'config/*.nope'\n");
  try {
    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.ok, true);
    assert.ok(res.actions.some((a) => a.mode === "skip" && a.reason === "no-match"));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Path traversal rejection
// ---------------------------------------------------------------------------

test("provision: rejects a path-traversal source", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - ../outside/secret\n");
  try {
    // create the outside file to prove it is rejected on path, not existence
    mkdirSync(path.join(fx.base, "outside"), { recursive: true });
    writeFileSync(path.join(fx.base, "outside/secret"), "leak");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.ok, true);
    assert.equal(res.summary.rejected, 1);
    assert.equal(res.summary.copied, 0);
    assert.ok(!existsSync(path.join(fx.worktreePath, "secret")));
  } finally {
    fx.cleanup();
  }
});

test("provision: rejects a source that is a symlink escaping the main checkout", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - config/leak\n");
  try {
    // outside the repo: a real secret
    mkdirSync(path.join(fx.base, "outside"), { recursive: true });
    writeFileSync(path.join(fx.base, "outside/secret"), "leak");
    // lexically-inside source path, but it's a symlink pointing outside repoRoot
    mkdirSync(path.join(fx.repoRoot, "config"));
    symlinkSync(path.join(fx.base, "outside/secret"), path.join(fx.repoRoot, "config/leak"));

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.ok, true);
    assert.equal(res.summary.rejected, 1);
    assert.equal(res.summary.copied, 0);
    assert.ok(!existsSync(path.join(fx.worktreePath, "config/leak")));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Idempotent reuse
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fail-closed: a config with load/validation errors yields zero actions
// ---------------------------------------------------------------------------

test("provision: config with errors yields zero provisioning actions (fail-closed)", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - config/app.yml\n");
  try {
    // A real, present source — proves the EMPTY treatment is driven by the
    // config errors, not by a missing file.
    mkdirSync(path.join(fx.repoRoot, "config"));
    writeFileSync(path.join(fx.repoRoot, "config/app.yml"), "key: value\n");

    const loadConfig = async () => ({
      config: { version: 1, worktree: { copyOnInit: ["config/app.yml"] } },
      errors: [{ field: "worktree.copyOnInit", reason: "invalid" }],
    });

    const res = await provisionWorktree(
      { worktreePath: fx.worktreePath, repoRoot: fx.repoRoot },
      { loadConfig },
    );
    assert.equal(res.ok, true);
    assert.equal(res.actions.length, 0);
    assert.equal(res.summary.copied, 0);
    assert.equal(res.summary.linked, 0);
    assert.ok(res.summary.warnings >= 1, "one WARN about the invalid config");
    assert.ok(!existsSync(path.join(fx.worktreePath, "config/app.yml")));
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fail-soft on a per-entry copy/link error (e.g. EACCES / ENOTDIR): one entry
// fails but is recorded as a skip and the run does NOT throw; others process.
// ---------------------------------------------------------------------------

test("provision: a per-entry copy failure is recorded as skip and does not throw", async () => {
  const fx = makeFixture(
    "version: 1\nworktree:\n  copyOnInit:\n    - blocked/file.yml\n    - ok.yml\n",
  );
  try {
    mkdirSync(path.join(fx.repoRoot, "blocked"));
    writeFileSync(path.join(fx.repoRoot, "blocked/file.yml"), "x");
    writeFileSync(path.join(fx.repoRoot, "ok.yml"), "y");
    // Make the failing entry's dest parent (worktree/blocked) a FILE so
    // mkdir(recursive) for blocked/file.yml throws ENOTDIR — a genuine
    // per-entry fs failure. The "ok.yml" entry is independent and must still copy.
    writeFileSync(path.join(fx.worktreePath, "blocked"), "not a dir");

    // Must not throw despite the per-entry failure.
    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(res.ok, true);
    // The failed entry is recorded as a skip carrying the failure reason.
    const failed = res.actions.find((a) => a.mode === "skip" && /copy-failed:/.test(a.reason || ""));
    assert.ok(failed, `expected a copy-failed skip action, got ${JSON.stringify(res.actions)}`);
    assert.ok(res.summary.warnings >= 1);
    // The independent entry still processed — the loop continued past the failure.
    assert.equal(res.summary.copied, 1);
    assert.equal(readFileSync(path.join(fx.worktreePath, "ok.yml"), "utf8"), "y");
  } finally {
    fx.cleanup();
  }
});

test("provision: idempotent on reuse (second run skips)", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  copyOnInit:\n    - config/app.yml\n  linkOnInit:\n    - data/big\n");
  try {
    mkdirSync(path.join(fx.repoRoot, "config"));
    writeFileSync(path.join(fx.repoRoot, "config/app.yml"), "v");
    mkdirSync(path.join(fx.repoRoot, "data/big"), { recursive: true });

    const first = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(first.summary.copied, 1);
    assert.equal(first.summary.linked, 1);

    const second = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    assert.equal(second.summary.copied, 0);
    assert.equal(second.summary.linked, 0);
    assert.equal(second.summary.skipped, 2);
  } finally {
    fx.cleanup();
  }
});
