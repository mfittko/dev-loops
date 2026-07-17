import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";

// #1361: the installed Claude plugin ships only the `.claude/` tree (the plugin manifest's
// `source`); repo-root `docs/` is never installed. `validate-links` resolves links against the
// SOURCE tree, where repo-root `docs/` still exists, so a generated `.claude/commands/**` or
// `.claude/agents/**` link that escapes the plugin root (e.g. `../../docs/x.md`, which resolves
// to source-tree `docs/x.md` and looks fine there) passes that guard but 404s once installed —
// that blind spot is exactly what let the original bug through. This guard instead resolves every
// relative link emitted into the generated command/agent wrappers against the `.claude/` root
// itself: it must stay inside `.claude/` and land on a file that is actually bundled there.

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

// Pre-existing sibling escape this guard surfaces but #1361 does not fix (its non-goals
// explicitly exclude auditing/fixing every other `../../docs/…` link): `agents/review.md`
// still links `../../docs/gate-review-sub-loop-contract.md`, escaping `.claude/` the same way
// the fixed `loop-review-ui` link did. Allowlisted so this guard still gates regressions
// elsewhere; a follow-up should either bundle that doc under `skills/docs/` or fix the link.
const KNOWN_ESCAPE_ALLOWLIST = new Set([".claude/agents/review.md::../../docs/gate-review-sub-loop-contract.md"]);

test("generated .claude/commands and .claude/agents links resolve inside the installed plugin root (#1361)", () => {
  const scanDirs = [path.join(claudeRoot, "commands"), path.join(claudeRoot, "agents")];
  const files = scanDirs.flatMap(collectMarkdownFilesRecursive);
  assert.ok(files.length > 0, "expected generated command/agent files to scan");

  const violations = [];
  const matchedAllowlistEntries = new Set();
  for (const absFile of files) {
    const content = fs.readFileSync(absFile, "utf8");
    for (const { line, rawTarget } of extractRelativeMarkdownLinks(content)) {
      const strippedTarget = stripFragment(rawTarget);
      if (strippedTarget.length === 0) continue;

      const resolvedAbs = path.resolve(path.dirname(absFile), strippedTarget);
      const relativeToClaudeRoot = path.relative(claudeRoot, resolvedAbs);
      const escapesPluginRoot = relativeToClaudeRoot.startsWith("..") || path.isAbsolute(relativeToClaudeRoot);
      const sourceRel = path.relative(repoRoot, absFile);
      const allowlistKey = `${sourceRel}::${rawTarget}`;
      if (KNOWN_ESCAPE_ALLOWLIST.has(allowlistKey)) {
        matchedAllowlistEntries.add(allowlistKey);
        continue;
      }

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
  // Guard the allowlist itself: a stale entry (the source link moved/was fixed) would silently
  // stop covering anything, so require every entry to have actually matched a scanned link.
  assert.deepEqual(
    [...matchedAllowlistEntries].sort(),
    [...KNOWN_ESCAPE_ALLOWLIST].sort(),
    "KNOWN_ESCAPE_ALLOWLIST has a stale entry that no longer matches a scanned link",
  );
});
