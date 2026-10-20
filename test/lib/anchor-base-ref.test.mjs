import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "bun:test";
import { anchorBaseRef } from "../../scripts/lib/anchor-base-ref.mjs";

test("anchors only bare branches with an origin commit, isolated to repoRoot", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "anchor-base-"));
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--no-gpg-sign", "-q", "--allow-empty", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    assert.equal(anchorBaseRef("main", { repoRoot }), "origin/main");
    for (const ref of ["origin/main", "a".repeat(40), "HEAD~1", "HEAD", "main^", "main@{0}", "missing", "topic/branch", ""]) {
      assert.equal(anchorBaseRef(ref, { repoRoot }), ref);
    }
    assert.throws(() => anchorBaseRef("main", { repoRoot: path.join(repoRoot, "absent") }));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
