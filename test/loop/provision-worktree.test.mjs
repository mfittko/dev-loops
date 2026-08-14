import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: config/app.yml\n      mode: copy\n");
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: data/big\n      mode: link\n");
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: 'config/*.yml'\n      mode: copy\n");
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: config/absent.yml\n      mode: copy\n");
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: 'config/*.nope'\n      mode: copy\n");
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: ../outside/secret\n      mode: copy\n");
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
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: config/leak\n      mode: copy\n");
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
// Fail-closed: a config with load/validation errors yields zero CONFIG-DRIVEN
// actions. The workspace self-link (#1144) is unconditional — a structural
// need, not a config-driven copy/link entry — so it still runs.
// ---------------------------------------------------------------------------

test("provision: config with errors yields zero config-driven actions (fail-closed)", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: config/app.yml\n      mode: copy\n");
  try {
    // A real, present source — proves the EMPTY treatment is driven by the
    // config errors, not by a missing file.
    mkdirSync(path.join(fx.repoRoot, "config"));
    writeFileSync(path.join(fx.repoRoot, "config/app.yml"), "key: value\n");

    const loadConfig = async () => ({
      config: { version: 1, worktree: { entries: [{ path: "config/app.yml", mode: "copy" }] } },
      errors: [{ field: "worktree.entries", reason: "invalid" }],
    });

    const res = await provisionWorktree(
      { worktreePath: fx.worktreePath, repoRoot: fx.repoRoot },
      { loadConfig },
    );
    assert.equal(res.ok, true);
    // Only the unconditional self-link action remains (this fixture has no
    // packages/core in the worktree, so it's a source-missing skip).
    assert.equal(res.actions.length, 1);
    assert.equal(res.actions[0].entry, "node_modules/@dev-loops/core");
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
    "version: 1\nworktree:\n  entries:\n    - path: blocked/file.yml\n      mode: copy\n    - path: ok.yml\n      mode: copy\n",
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

// ---------------------------------------------------------------------------
// Workspace self-link: node_modules/@dev-loops/core -> worktree's OWN
// packages/core (#1144) — unconditional, independent of .devloops entries.
// ---------------------------------------------------------------------------

test("provision: links node_modules/@dev-loops/core to the worktree's OWN packages/core", async () => {
  const fx = makeFixture("version: 1\n");
  try {
    mkdirSync(path.join(fx.worktreePath, "packages/core"), { recursive: true });
    writeFileSync(path.join(fx.worktreePath, "packages/core/index.mjs"), "export const x = 1;\n");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const action = res.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.ok(action, `expected a self-link action, got ${JSON.stringify(res.actions)}`);
    assert.equal(action.mode, "link");

    const dest = path.join(fx.worktreePath, "node_modules/@dev-loops/core");
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.ok(!path.isAbsolute(readlinkSync(dest)), "expected a relative symlink target");
    // Resolves to the worktree's OWN packages/core, not the main checkout's.
    assert.equal(realpathSync(dest), realpathSync(path.join(fx.worktreePath, "packages/core")));
  } finally {
    fx.cleanup();
  }
});

test("provision: workspace self-link is idempotent on re-provision", async () => {
  const fx = makeFixture("version: 1\n");
  try {
    mkdirSync(path.join(fx.worktreePath, "packages/core"), { recursive: true });

    const first = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const firstAction = first.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.equal(firstAction.mode, "link");

    const second = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const secondAction = second.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.equal(secondAction.mode, "skip");
    assert.equal(secondAction.reason, "exists");
    // skip/exists is only granted for the exact relative target form.
    assert.equal(
      readlinkSync(path.join(fx.worktreePath, "node_modules/@dev-loops/core")),
      path.join("..", "..", "packages", "core"),
    );
  } finally {
    fx.cleanup();
  }
});

test("provision: normalizes an absolute-but-correct pre-existing link to relative", async () => {
  const fx = makeFixture("version: 1\n");
  try {
    mkdirSync(path.join(fx.worktreePath, "packages/core"), { recursive: true });
    // Absolute link that resolves to the CORRECT dir — still not the required
    // relative form, so it must be replaced (reported as link, not skip/exists).
    const scopeDir = path.join(fx.worktreePath, "node_modules/@dev-loops");
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(path.join(fx.worktreePath, "packages/core"), path.join(scopeDir, "core"));

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const action = res.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.equal(action.mode, "link");

    const dest = path.join(fx.worktreePath, "node_modules/@dev-loops/core");
    assert.equal(readlinkSync(dest), path.join("..", "..", "packages", "core"));
    assert.equal(realpathSync(dest), realpathSync(path.join(fx.worktreePath, "packages/core")));
  } finally {
    fx.cleanup();
  }
});

test("provision: workspace self-link replaces a stale/broken symlink", async () => {
  const fx = makeFixture("version: 1\n");
  try {
    mkdirSync(path.join(fx.worktreePath, "packages/core"), { recursive: true });
    // Simulate the up-tree bug: an existing link pointing at some OTHER core
    // (e.g. the main checkout's), which must be replaced, not left in place.
    const scopeDir = path.join(fx.worktreePath, "node_modules/@dev-loops");
    mkdirSync(scopeDir, { recursive: true });
    const staleTarget = path.join(fx.repoRoot, "packages/core"); // does not even exist — broken too
    symlinkSync(staleTarget, path.join(scopeDir, "core"));

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const action = res.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.equal(action.mode, "link");

    const dest = path.join(fx.worktreePath, "node_modules/@dev-loops/core");
    assert.equal(realpathSync(dest), realpathSync(path.join(fx.worktreePath, "packages/core")));
  } finally {
    fx.cleanup();
  }
});

test("provision: workspace self-link never clobbers a real dir/file at the dest", async () => {
  const fx = makeFixture("version: 1\n");
  try {
    mkdirSync(path.join(fx.worktreePath, "packages/core"), { recursive: true });
    const scopeDir = path.join(fx.worktreePath, "node_modules/@dev-loops");
    mkdirSync(path.join(scopeDir, "core"), { recursive: true });
    writeFileSync(path.join(scopeDir, "core/marker.txt"), "not a symlink");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const action = res.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.equal(action.mode, "skip");
    assert.equal(action.reason, "dest-conflict");
    assert.ok(existsSync(path.join(scopeDir, "core/marker.txt")), "real dest left untouched");
  } finally {
    fx.cleanup();
  }
});

test("provision: workspace self-link fails soft when the worktree has no packages/core", async () => {
  const fx = makeFixture("version: 1\n");
  try {
    // No packages/core created in the worktree at all.
    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });
    const action = res.actions.find((a) => a.entry === "node_modules/@dev-loops/core");
    assert.equal(action.mode, "skip");
    assert.equal(action.reason, "source-missing");
    assert.ok(!existsSync(path.join(fx.worktreePath, "node_modules")));
  } finally {
    fx.cleanup();
  }
});

test("provision: idempotent on reuse (second run skips)", async () => {
  const fx = makeFixture("version: 1\nworktree:\n  entries:\n    - path: config/app.yml\n      mode: copy\n    - path: data/big\n      mode: link\n");
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
    // 2 config-driven entries (exists) + the workspace self-link (this fixture
    // has no packages/core, so it's a source-missing skip on both runs).
    assert.equal(second.summary.skipped, 3);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// node_modules source rejection (#1627)
// ---------------------------------------------------------------------------

test("provision: rejects an entry whose source resolves under node_modules", async () => {
  const fx = makeFixture(
    "version: 1\nworktree:\n  entries:\n    - path: node_modules/some-pkg\n      mode: link\n",
  );
  try {
    const srcDir = path.join(fx.repoRoot, "node_modules", "some-pkg");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, "index.js"), "x\n");

    const res = await provisionWorktree({ worktreePath: fx.worktreePath, repoRoot: fx.repoRoot });

    assert.equal(res.summary.rejected, 1);
    const reject = res.actions.find((a) => a.mode === "reject");
    assert.ok(reject, "expected a reject action");
    assert.equal(reject.reason, "node_modules");
    // The forbidden dependency tree must not be linked into the worktree.
    assert.equal(existsSync(path.join(fx.worktreePath, "node_modules", "some-pkg")), false);
  } finally {
    fx.cleanup();
  }
});
