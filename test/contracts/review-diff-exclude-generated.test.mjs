import assert from "node:assert/strict";
import { test } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GENERATED_MIRROR_GLOBS, loadDevLoopConfig } from "../../packages/core/src/config/config.mjs";
import { matchesDiffExcludeGlob } from "../../packages/core/src/loop/review-dispatch-plan.mjs";
import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";

// This repo drops the generated .claude mirror trees from the required
// reviewer diff. That is safe only while every file under a configured glob is
// generator-owned, so a hand-written file there would hide source from review.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("gates.reviewDiff.excludeGlobs covers only generator-owned files", async () => {
  const { config, errors } = await loadDevLoopConfig({ repoRoot });
  assert.deepEqual(errors, []);
  const globs = config.gates?.reviewDiff?.excludeGlobs;
  assert.deepEqual(globs, [...GENERATED_MIRROR_GLOBS]);

  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split("\0").filter(Boolean);
  const matched = files.filter((f) => globs.some((g) => matchesDiffExcludeGlob(f, g)));
  assert.ok(matched.length > 0, "at least one committed file matches a configured glob");

  const targets = new Set(collectGeneratedAssets({ repoRoot }).map((a) => a.target));
  const handWritten = matched.filter((f) => !targets.has(f));
  assert.deepEqual(handWritten, [], "every excluded file is a generated asset target");

  const hooks = files.filter((f) => f.startsWith(".claude/hooks/"));
  assert.ok(hooks.length > 0, "the repo commits hand-written .claude/hooks files");
  assert.deepEqual(hooks.filter((f) => globs.some((g) => matchesDiffExcludeGlob(f, g))), []);
});
