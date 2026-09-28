import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitFrontmatter } from "@dev-loops/core/claude/asset-generation";

// Only the long-waiting dev-loop coordinator pays for a 1-hour prompt-cache write.
// Short-lived roles keep the cheaper 5-minute default.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const agentsDir = path.join(repoRoot, "agents");

test("only the dev-loop agent sets experimental.cacheTtl, and it is 1h", () => {
  const withTtl = {};
  for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md")).sort()) {
    const { frontmatter } = splitFrontmatter(fs.readFileSync(path.join(agentsDir, file), "utf8"), file);
    if (frontmatter.experimental?.cacheTtl != null) {
      withTtl[file] = frontmatter.experimental.cacheTtl;
    }
  }
  assert.deepEqual(withTtl, { "dev-loop.agent.md": "1h" });
});

test("the generated Claude dev-loop agent carries experimental.cacheTtl: 1h", () => {
  const generated = fs.readFileSync(path.join(repoRoot, ".claude/agents/dev-loop.md"), "utf8");
  assert.equal(splitFrontmatter(generated, ".claude/agents/dev-loop.md").frontmatter.experimental?.cacheTtl, "1h");
});
