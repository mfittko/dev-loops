// #2123: a plugin-only install ships no `scripts/`, `packages/core`, or `node_modules`, so a bare
// `node scripts/…mjs` or unrouted `dev-loops <ns> <sub>` invocation left in a generated skill,
// command, or agent BODY silently fails to resolve there (the original review-gate
// silent-degradation bug). `rewriteWrapperInvocation` routes every such invocation in generated
// bodies through the resolver launcher (`dev-loops-run`); this contract locks the residual count
// at zero for the generated tree it actually rewrites (SKILL.md/command/agent bodies — the scope
// `rewriteWrapperInvocation` is composed into). Bundled docs (`.claude/skills/docs/**`,
// `.claude/skills/dev-loop/templates/**`) and hand-authored hooks/settings are a documented
// out-of-scope allowlist (not scanned): they hold illustrative prose examples and permission
// patterns, not agent-executed generated instructions.
//
// The two regex sources below are imported from `asset-generation.mjs`, the SAME source
// `rewriteWrapperInvocation` builds its rewrite regexes from — a shared single source of truth so
// this guard and the transform can never drift out of sync (a prior version hand-duplicated a
// stale namespace list here and passed falsely while `issue`/`inspect` invocations stayed bare).
import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BARE_DEV_LOOPS_NS_SOURCE,
  BARE_NODE_SCRIPTS_SOURCE,
  splitFrontmatter,
  WRAPPER_NS,
} from "../../packages/core/src/claude/asset-generation.mjs";
import { SUBCOMMAND_ROUTES } from "../../cli/index.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const BARE_NODE_SCRIPTS_RE = new RegExp(BARE_NODE_SCRIPTS_SOURCE);
const BARE_DEV_LOOPS_NS_RE = new RegExp(BARE_DEV_LOOPS_NS_SOURCE);

function bodiesOf(globDirs) {
  const out = [];
  for (const dir of globDirs) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const file = path.join(abs, entry.name);
      const raw = fs.readFileSync(file, "utf8");
      const { body } = splitFrontmatter(raw, file);
      out.push({ file: path.relative(repoRoot, file), body });
    }
  }
  return out;
}

function skillBodies() {
  const skillsDir = path.join(repoRoot, ".claude/skills");
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue; // e.g. .claude/skills/docs (bundled docs, not a skill)
    const raw = fs.readFileSync(skillFile, "utf8");
    const { body } = splitFrontmatter(raw, skillFile);
    out.push({ file: path.relative(repoRoot, skillFile), body });
  }
  return out;
}

function scanAll() {
  return [...bodiesOf([".claude/agents", ".claude/commands"]), ...skillBodies()];
}

test("no residual bare `node scripts/…mjs` invocation in generated agent/command/skill bodies", () => {
  const violations = [];
  for (const { file, body } of scanAll()) {
    if (BARE_NODE_SCRIPTS_RE.test(body)) violations.push(file);
  }
  assert.deepEqual(violations, [], `bare node scripts/… found in:\n${violations.join("\n")}`);
});

test("no residual unrouted `dev-loops <ns> <sub>` invocation in generated agent/command/skill bodies", () => {
  const violations = [];
  for (const { file, body } of scanAll()) {
    if (BARE_DEV_LOOPS_NS_RE.test(body)) violations.push(file);
  }
  assert.deepEqual(violations, [], `unrouted dev-loops <ns> invocation found in:\n${violations.join("\n")}`);
});

test("scanned tree is non-empty (the guard actually covers files)", () => {
  assert.ok(scanAll().length > 0, "expected at least one generated agent/command/skill file");
});

test("self-check: an injected bare invocation is flagged by both regexes", () => {
  assert.ok(BARE_NODE_SCRIPTS_RE.test("Run `node scripts/loop/watch-cycle.mjs --pr 5`."));
  assert.ok(BARE_DEV_LOOPS_NS_RE.test("Run `dev-loops gate judge-pass --pr 5`."));
  // Confirm the routed form does NOT re-trip either regex (proves the rewrite is what clears it).
  assert.equal(BARE_NODE_SCRIPTS_RE.test("Run `dev-loops-run scripts/loop/watch-cycle.mjs --pr 5`."), false);
  assert.equal(BARE_DEV_LOOPS_NS_RE.test("Run `dev-loops-run cli/index.mjs gate judge-pass --pr 5`."), false);
});

test("both bare-invocation regexes catch a nested (multi-level) scripts/ path", () => {
  assert.ok(BARE_NODE_SCRIPTS_RE.test("Run `node scripts/loop/inspect-run-viewer/foo.mjs --pr 5`."));
  assert.equal(BARE_NODE_SCRIPTS_RE.test("Run `dev-loops-run scripts/loop/inspect-run-viewer/foo.mjs --pr 5`."), false);
});

// Recurrence guard: `WRAPPER_NS` is a hand-maintained string, not derived at runtime from
// `SUBCOMMAND_ROUTES` (asset-generation.mjs cannot import `cli/index.mjs` — the Claude asset
// generator ships in `@dev-loops/core`, which must not depend on the CLI package). This test reads
// the CLI's own route table directly (the same import `referenced-docs-commands-shipped.test.mjs`
// already uses) and fails the instant a future CLI namespace is added/removed without updating
// `WRAPPER_NS` to match — the exact drift that produced #2123's bare `dev-loops issue edit`.
test("WRAPPER_NS matches the real top-level CLI namespaces (SUBCOMMAND_ROUTES keys in cli/index.mjs)", () => {
  const realNamespaces = Object.keys(SUBCOMMAND_ROUTES).sort();
  const wrapperNamespaces = WRAPPER_NS.split("|").sort();
  assert.deepEqual(
    wrapperNamespaces,
    realNamespaces,
    `WRAPPER_NS (${WRAPPER_NS}) must equal cli/index.mjs SUBCOMMAND_ROUTES keys (${Object.keys(SUBCOMMAND_ROUTES).join(", ")})`,
  );
});
