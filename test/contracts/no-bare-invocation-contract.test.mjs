import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";

// Issue #2123: the generated `.claude` skills/commands/agents surface is what a Claude Code
// install actually reads. A bare `node scripts/…` or an unrouted `dev-loops …` invocation there
// cannot resolve on a plugin-only install (no source checkout, no node_modules, no `dev-loops`
// bin) — the degraded fallback is silent (a subagent quietly drops to raw `gh`). Every genuine
// invocation must route through `<resolved-skill-scripts>/…` (the scripts-root resolver, applied
// at generation time by `rewriteBareScriptsInvocation`) or `npx dev-loops@<version> …` (applied at
// generation time by `rewriteCliInvocation` / `rewriteBareDevLoopsInvocation`). Both rewrites are
// generation-time-only — the canonical Pi/source docs stay bare so pre-existing contracts pinning
// their exact wording (e.g. `dev-loop-execution-guardrails-contract.test.mjs`,
// `issue-intake-doc-contracts.test.mjs`) are unaffected.
//
// Scope: the same generated assets `scripts-root-bundle-contract.test.mjs` pins — every
// `.claude/skills/<name>/SKILL.md`, `.claude/commands/*.md`, `.claude/agents/*.md` generated asset.
// OUT of scope by design (allowlisted wholesale, not scanned): `.claude/hooks/**` (self-contained
// hook deciders whose denial-message STRINGS mention `scripts/...` as reader-facing guidance text,
// not an invocation this bundle runs) and `.claude/skills/docs/**` + `.claude/skills/*/templates/**`
// (bundled contract-doc prose — illustrative code fences documented as source-repo fallbacks, not
// the generated skill/command/agent entrypoints themselves).

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function generatedSkillsCommandsAgentsAssets() {
  return collectGeneratedAssets({ repoRoot }).filter(
    (a) =>
      /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(a.target) ||
      /^\.claude\/commands\/[^/]+\.md$/.test(a.target) ||
      /^\.claude\/agents\/[^/]+\.md$/.test(a.target),
  );
}

// Mirrors the exemption `rewriteBareScriptsInvocation` (packages/core/src/claude/asset-generation.mjs)
// itself applies at generation time: a documented "source-repo fallback" note — identified by one
// of these two literal markers immediately before the match — is intentionally left bare. Kept as
// an INDEPENDENT re-implementation here (not a call into the transform) so this test cannot pass
// merely because the transform is a no-op.
const DOCUMENTED_FALLBACK_MARKERS = [/fallback:/i, /missing helper/i];
const LOOKBEHIND_WINDOW = 40;

function isDocumentedFallback(content, matchIndex) {
  const before = content.slice(Math.max(0, matchIndex - LOOKBEHIND_WINDOW), matchIndex);
  return DOCUMENTED_FALLBACK_MARKERS.some((marker) => marker.test(before));
}

test("no bare `node scripts/…` invocation remains in the generated .claude skills/commands/agents surface, except documented source-repo fallback notes (issue #2123)", () => {
  const offenders = [];
  let genuineRewriteCount = 0;
  for (const { target, content } of generatedSkillsCommandsAgentsAssets()) {
    for (const match of content.matchAll(/node\s+scripts\//g)) {
      if (isDocumentedFallback(content, match.index)) continue;
      offenders.push(`${target}@${match.index}: ${content.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\n/g, "\\n")}`);
    }
    genuineRewriteCount += (content.match(/<resolved-skill-scripts>\//g) ?? []).length;
  }
  assert.ok(genuineRewriteCount > 10, "expected a substantial number of rewritten <resolved-skill-scripts>/ references (sanity: the rewrite must have actually run)");
  assert.deepEqual(
    offenders,
    [],
    `bare \`node scripts/…\` invocation(s) found (route through <resolved-skill-scripts>/… instead):\n${offenders.join("\n")}`,
  );
});

// A genuine bare invocation is a FENCED-CODE-BLOCK line starting with `dev-loops <subcommand>` —
// never mid-sentence prose (e.g. a hand-wrapped bullet whose line happens to start with
// `` `dev-loops gate` `` used as a noun, outside any fence) and never the already-routed
// `npx dev-loops@<version>` form. Mirrors `rewriteBareDevLoopsInvocation`'s own fence-scoping.
const BARE_DEV_LOOPS_LINE_PATTERN = /^\s*dev-loops\s+[a-z]/;
const FENCE_PATTERN = /^\s*```/;

function fencedCodeLines(content) {
  const out = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push(line);
  }
  return out;
}

test("no unrouted bare `dev-loops <subcommand>` invocation remains in the generated .claude skills/commands/agents surface (issue #2123)", () => {
  const offenders = [];
  for (const { target, content } of generatedSkillsCommandsAgentsAssets()) {
    for (const line of fencedCodeLines(content)) {
      if (BARE_DEV_LOOPS_LINE_PATTERN.test(line)) offenders.push(`${target}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `unrouted bare \`dev-loops …\` invocation(s) found (route through npx dev-loops@<version> … instead):\n${offenders.join("\n")}`,
  );
});
