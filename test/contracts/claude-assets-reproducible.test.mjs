import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedAssets, checkAssets, writeAssets } from "../../scripts/claude/generate-claude-assets.mjs";
import { stripPiOnlyBlocks } from "../../packages/core/src/claude/asset-generation.mjs";

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

  // EVERY bundled file must equal its source with `<!-- pi-only -->` blocks stripped (#837).
  // For marker-free docs this is a verbatim copy (stripPiOnlyBlocks is a no-op); docs that scope
  // Pi-runtime prose (e.g. main-agent-contract.md) bundle their Claude-applicable subset. Bundled
  // targets map back to source by dropping the `.claude/skills/` prefix → `skills/<...>`.
  const bundlePrefixes = [".claude/skills/docs/", ".claude/skills/dev-loop/templates/"];
  const bundled = assets.filter((a) => bundlePrefixes.some((p) => a.target.startsWith(p)));
  assert.ok(bundled.length >= 30, `expected the full bundled set, got ${bundled.length}`);
  for (const asset of bundled) {
    const source = asset.target.replace(/^\.claude\/skills\//, "skills/");
    assert.equal(
      asset.content,
      stripPiOnlyBlocks(fs.readFileSync(path.join(repoRoot, source), "utf8")),
      `${asset.target} must be its source with pi-only blocks stripped (${source})`,
    );
  }

  // The Claude bundle of main-agent-contract.md must drop the Pi read-only/dispatch contract
  // (collapsed umbrella, #837) while the source retains it.
  const contract = bundled.find((a) => a.target.endsWith("docs/main-agent-contract.md"));
  assert.ok(contract, "main-agent-contract.md must be bundled");
  assert.equal(contract.content.includes("Main agent must NEVER"), false, "Claude bundle must drop the Pi read-only contract");
  assert.match(contract.content, /the dev-loop runs as a single agent/i, "Claude bundle must state the single-agent model");
  assert.ok(
    fs.readFileSync(path.join(repoRoot, "skills/docs/main-agent-contract.md"), "utf8").includes("Main agent must NEVER"),
    "source must retain the Pi read-only contract",
  );

  // The Claude copilot-pr-followup skill must drop the Pi "subagent exits → main session
  // re-dispatches" persistence model (#838) and state the single-agent inline-loop model,
  // while the source retains the Pi persistence prose.
  const followup = assets.find((a) => a.target === ".claude/skills/copilot-pr-followup/SKILL.md");
  assert.ok(followup, "copilot-pr-followup skill must be generated");
  assert.equal(
    followup.content.includes("the subagent exits on the wait boundary; the main session re-dispatches"),
    false,
    "Claude copilot-pr-followup must drop the Pi exit/redispatch persistence model",
  );
  assert.match(followup.content, /run this loop \*\*inline in a single agent\*\*/i, "Claude bundle must state the inline single-agent loop");
  assert.ok(
    fs.readFileSync(path.join(repoRoot, "skills/copilot-pr-followup/SKILL.md"), "utf8")
      .includes("the subagent exits on the wait boundary; the main session re-dispatches"),
    "source must retain the Pi persistence model",
  );
});

test("Pi-runtime-only prose is stripped from generated assets but retained in source (#817)", () => {
  const generated = fs.readFileSync(path.join(repoRoot, ".claude/agents/dev-loop.md"), "utf8");
  const source = fs.readFileSync(path.join(repoRoot, "agents/dev-loop.agent.md"), "utf8");
  for (const term of ["maxSubagentDepth", "contact_supervisor", "pi-intercom", "<!-- pi-only -->"]) {
    assert.equal(generated.includes(term), false, `generated dev-loop.md must not contain Pi-runtime prose: ${term}`);
    assert.ok(source.includes(term), `source dev-loop.agent.md must retain Pi-complete prose: ${term}`);
  }
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

test("checkAssets flags a stale generated hook-bundle module but not hand-authored hooks (#843)", () => {
  // The hooks dir mixes generated bundle modules (banner-stamped) with hand-authored scripts.
  // Orphan detection must catch a generated module no longer produced (e.g. a dropped HOOK_BUNDLE
  // entry) while leaving hand-authored hooks (no banner) alone.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-hooks-orphan-"));
  try {
    const hooksDir = path.join(tmpRoot, ".claude", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    // A stale generated module: carries the generator banner, but no source produces it.
    fs.writeFileSync(
      path.join(hooksDir, "_stale-removed.mjs"),
      "// GENERATED from packages/core/src/loop/gone.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.\nexport const x = 1;\n",
      "utf8",
    );
    // Hand-authored files (no banner) must never be flagged.
    fs.writeFileSync(path.join(hooksDir, "_hook-io.mjs"), "export function readHookInput() {}\n", "utf8");
    fs.writeFileSync(path.join(hooksDir, "hooks.json"), "{}\n", "utf8");

    // No sources present in tmpRoot → collectGeneratedAssets yields nothing; the only orphan is
    // the banner-stamped stale module.
    const drifted = checkAssets([], { repoRoot: tmpRoot });
    assert.deepEqual(drifted, [{ target: ".claude/hooks/_stale-removed.mjs", reason: "orphaned" }]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("direct slash commands are generated and map to the public dev-loop entrypoints (#972)", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const byTarget = new Map(assets.map((a) => [a.target, a.content]));
  // Each public entrypoint has a generated `.claude/commands/<name>.md`.
  for (const name of ["start", "auto", "continue", "info", "status"]) {
    assert.ok(byTarget.has(`.claude/commands/${name}.md`), `expected generated command ${name}.md`);
  }
  // Each wraps the matching public intent / read-only shortcut — no internal strategy names.
  assert.match(byTarget.get(".claude/commands/start.md"), /start dev loop on issue \$ARGUMENTS/);
  assert.match(byTarget.get(".claude/commands/auto.md"), /auto dev loop on issue \$ARGUMENTS/);
  // #988: /continue is dual-routed — explicit issue/PR target, or bare (resolve the
  // single in-progress board item). Both forms still hand off to the dev-loop skill.
  assert.match(byTarget.get(".claude/commands/continue.md"), /continue dev loop on \$ARGUMENTS/);
  assert.match(byTarget.get(".claude/commands/continue.md"), /resolve-active-board-item\.mjs/);
  assert.match(byTarget.get(".claude/commands/info.md"), /loop info --issue \$ARGUMENTS/);
  // Commands are thin wrappers: they must not name internal strategies or invent routing.
  // Guard every canonical strategy id, in both underscore (strategy id) and hyphenated
  // (skill-dir) form, so an accidental `copilot-pr-followup` reference also fails.
  const internalStrategy = /copilot[_-]pr[_-]followup|issue[_-]intake|local[_-]implementation|reviewer[_-]fixer|final[_-]approval/;
  for (const name of ["start", "auto", "continue", "info"]) {
    assert.equal(
      internalStrategy.test(byTarget.get(`.claude/commands/${name}.md`)),
      false,
      `${name}.md must not reference internal strategy names`,
    );
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
