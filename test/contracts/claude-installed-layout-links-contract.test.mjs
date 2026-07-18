import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";

// #1361/#1381: the installed Claude plugin ships only the `.claude/` tree (the plugin manifest's
// `source`); repo-root `docs/` is never installed. `validate-links` resolves links against the
// SOURCE tree, where repo-root `docs/` still exists, so a generated `.claude/commands/**`,
// `.claude/agents/**`, or `.claude/skills/**` link that escapes the plugin root (e.g.
// `../../docs/x.md`, which resolves to source-tree `docs/x.md` and looks fine there) passes that
// guard but 404s once installed — that blind spot is exactly what let the original bug through.
// This guard instead resolves every relative link emitted into the generated command/agent/skill
// tree against the `.claude/` root itself: it must stay inside `.claude/` and land on a file that
// is actually bundled there. `extractRelativeMarkdownLinks` already drops `scheme:` targets
// (http(s)://, mailto:, etc.) as external, so those never reach this resolution logic.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const claudeRoot = path.join(repoRoot, ".claude");

function collectMarkdownFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFilesRecursive(abs));
    } else if (entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

function stripFragment(target) {
  const hashIndex = target.indexOf("#");
  return hashIndex === -1 ? target : target.slice(0, hashIndex);
}

// A handful of `../../`-style links in the local-implementation skill and its bootstrap templates
// intentionally point at the CONSUMER project's own tree (its `PLAN.md`, `AGENTS.md`, durable
// phase docs, and the `docs/phases/` directory), not at a dev-loops-bundled contract doc — those
// files are never part of this plugin's bundle by design. Keyed on basename (not full path) since
// several distinct source files reference the same consumer artifact. Every dev-loops contract doc
// (the shared `skills/docs/**` + `skills/dev-loop/templates/**` bundle) resolves inside `.claude/`
// after #1381's bundling; this is the only exempt class.
const CONSUMER_ARTIFACT_BASENAMES = new Set([
  "PLAN.md",
  "AGENTS.md",
  "IMPLEMENTATION_STATE.md",
  "IMPLEMENTATION_WORKFLOW.md",
  "phase-x.md",
  "phases",
]);

test("generated .claude/commands, .claude/agents, and .claude/skills links resolve inside the installed plugin root (#1361/#1381)", () => {
  const scanDirs = [path.join(claudeRoot, "commands"), path.join(claudeRoot, "agents"), path.join(claudeRoot, "skills")];
  const files = scanDirs.flatMap(collectMarkdownFilesRecursive);
  assert.ok(files.length > 0, "expected generated command/agent/skill files to scan");

  const violations = [];
  const matchedConsumerArtifactBasenames = new Set();
  for (const absFile of files) {
    const content = fs.readFileSync(absFile, "utf8");
    for (const { line, rawTarget } of extractRelativeMarkdownLinks(content)) {
      const strippedTarget = stripFragment(rawTarget);
      if (strippedTarget.length === 0) continue;

      const resolvedAbs = path.resolve(path.dirname(absFile), strippedTarget);
      const sourceRel = path.relative(repoRoot, absFile);

      const basename = path.basename(resolvedAbs);
      if (CONSUMER_ARTIFACT_BASENAMES.has(basename)) {
        matchedConsumerArtifactBasenames.add(basename);
        continue;
      }

      const relativeToClaudeRoot = path.relative(claudeRoot, resolvedAbs);
      const escapesPluginRoot = relativeToClaudeRoot.startsWith("..") || path.isAbsolute(relativeToClaudeRoot);
      if (escapesPluginRoot) {
        violations.push(`${sourceRel}:${line} -> ${rawTarget} escapes the plugin root (.claude/)`);
        continue;
      }
      if (!fs.existsSync(resolvedAbs)) {
        violations.push(`${sourceRel}:${line} -> ${rawTarget} does not resolve to a bundled file`);
      }
    }
  }

  assert.deepEqual(violations, [], `installed-layout link(s) unresolved:\n${violations.join("\n")}`);
  // Guard the exemption list itself, per entry: a stale basename (the source link moved/was fixed,
  // or was never a real link to begin with) would silently stop covering anything. Checking each
  // entry individually (not an aggregate `size > 0`) means a single stale entry is caught even when
  // every other entry still matches.
  for (const basename of CONSUMER_ARTIFACT_BASENAMES) {
    assert.ok(
      matchedConsumerArtifactBasenames.has(basename),
      `CONSUMER_ARTIFACT_BASENAMES has a stale entry ${JSON.stringify(basename)} that no longer matches a scanned link`,
    );
  }
});
