import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRepoRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { loadDevLoopConfig, resolveRefinementConfig } from "@dev-loops/core/config";
import { initGitFixture } from "../_helpers.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

// #1019: .devloops (and thus maxCopilotRounds) must resolve from the checkout's
// git-toplevel, not the ambient cwd. A non-default value at the repo root must
// be picked up even when the process cwd is a subdirectory.
test("maxCopilotRounds resolves from worktree root via resolveRepoRoot, not cwd (#1019)", async () => {
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-1019-")));
  try {
    initGitFixture(repo, { commit: null });
    // Non-default maxCopilotRounds (built-in default is 5).
    await writeFile(path.join(repo, ".devloops"), "version: 1\nrefinement:\n  maxCopilotRounds: 2\n", "utf8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const sub = path.join(repo, "packages", "x");
    await mkdir(sub, { recursive: true });

    // Reading cwd-relative from a subdir misses .devloops -> defaults to 5.
    const cwdRelative = await loadDevLoopConfig({ repoRoot: sub });
    assert.equal(resolveRefinementConfig(cwdRelative.config, "maxCopilotRounds"), 5, "cwd-relative misses .devloops");

    // Worktree-relative via resolveRepoRoot finds .devloops -> 2.
    const worktreeRelative = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(sub) });
    assert.equal(resolveRefinementConfig(worktreeRelative.config, "maxCopilotRounds"), 2, "resolveRepoRoot finds .devloops");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
