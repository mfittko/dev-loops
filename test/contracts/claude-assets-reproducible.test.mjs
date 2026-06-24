import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedAssets, checkAssets, writeAssets } from "../../scripts/claude/generate-claude-assets.mjs";

// #772: the committed .claude tree must be byte-reproducible from the canonical sources.
// If a source agent/skill changes, the generator must be re-run and the result committed.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("shared docs + dev-loop templates are bundled so generated skill links resolve (#816)", () => {
  // The generated skills reference `../docs/<contract>.md` and `../dev-loop/templates/<t>.md`;
  // these resolve only if the shared content is bundled under .claude/skills/.
  const assets = collectGeneratedAssets({ repoRoot });
  const targets = new Set(assets.map((a) => a.target));
  // A representative `../docs/` link target (from .claude/skills/dev-loop/SKILL.md).
  assert.ok(targets.has(".claude/skills/docs/public-dev-loop-contract.md"), "shared contract doc must be bundled");
  // A representative `../dev-loop/templates/` link target.
  assert.ok(targets.has(".claude/skills/dev-loop/templates/phase-doc.md"), "dev-loop template must be bundled");
  // Every bundled doc must be byte-identical to its source (verbatim copy).
  const bundled = assets.find((a) => a.target === ".claude/skills/docs/public-dev-loop-contract.md");
  assert.equal(bundled.content, fs.readFileSync(path.join(repoRoot, "skills/docs/public-dev-loop-contract.md"), "utf8"));
});

test("the committed .claude tree is byte-reproducible from the canonical sources (no drift)", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  assert.ok(assets.length > 0, "expected to generate at least one asset");
  const drifted = checkAssets(assets, { repoRoot });
  assert.deepEqual(
    drifted,
    [],
    `Generated .claude assets drifted from sources. Run \`node scripts/claude/generate-claude-assets.mjs\` and commit:\n${JSON.stringify(drifted, null, 2)}`,
  );
});

test("checkAssets flags an orphaned committed asset with no generating source", () => {
  // Simulate a consumer tree: write the real generated assets, then plant a stale file
  // that no source produces. checkAssets must report it as `orphaned`.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-assets-orphan-"));
  try {
    // Mirror the canonical sources into the temp root so collectGeneratedAssets has inputs.
    for (const dir of ["agents", "skills"]) {
      fs.cpSync(path.join(repoRoot, dir), path.join(tmpRoot, dir), { recursive: true });
    }
    const assets = collectGeneratedAssets({ repoRoot: tmpRoot });
    writeAssets(assets, { repoRoot: tmpRoot });
    assert.deepEqual(checkAssets(assets, { repoRoot: tmpRoot }), [], "freshly written tree must be clean");

    const orphan = path.join(tmpRoot, ".claude", "agents", "stale-removed.md");
    fs.writeFileSync(orphan, "stale\n", "utf8");
    const drifted = checkAssets(assets, { repoRoot: tmpRoot });
    assert.deepEqual(drifted, [{ target: ".claude/agents/stale-removed.md", reason: "orphaned" }]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("every canonical agent and non-doc skill has a generated counterpart", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const targets = assets.map((a) => a.target);
  // Spot-check the known surfaces so an accidentally-skipped source is caught.
  for (const expected of [
    ".claude/agents/dev-loop.md",
    ".claude/agents/review.md",
    ".claude/skills/dev-loop/SKILL.md",
    ".claude/skills/local-implementation/SKILL.md",
  ]) {
    assert.ok(targets.includes(expected), `expected generated asset ${expected}`);
  }
});
