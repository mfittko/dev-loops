import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePatchIdWhenIntegrated, defaultComputePatchId } from "../../scripts/github/_patch-id.mjs";

// The detector (CI path, no --patch-id) derives the id with computePatchIdWhenIntegrated (ADR 0279).
test("computePatchIdWhenIntegrated returns the patch-id only when the head contains the base tip", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-id-int-"));
  try {
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
    const commitFile = (name, content, msg) => { writeFileSync(join(dir, name), content); git("add", name); git("commit", "-q", "-m", msg); };
    git("init", "-q", "-b", "main");
    commitFile("a.txt", "x\n", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "-b", "feature");
    commitFile("f.txt", "f\n", "feature");
    const input = { base: "origin/main", head: "HEAD", repoRoot: dir };
    const id = computePatchIdWhenIntegrated(input);
    assert.match(id, /^[0-9a-f]{40}$/);
    assert.equal(id, defaultComputePatchId(input));
    // Base moves ahead: the head no longer contains the base tip, so only a head-pinned approval counts.
    git("checkout", "-q", "main");
    commitFile("o.txt", "o\n", "base-only");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "feature");
    assert.equal(computePatchIdWhenIntegrated(input), null);
    // A refresh keeps the id.
    git("merge", "-q", "--no-edit", "origin/main");
    assert.equal(computePatchIdWhenIntegrated(input), id);
    // An unreadable base fails closed.
    assert.equal(computePatchIdWhenIntegrated({ ...input, base: "origin/missing" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
