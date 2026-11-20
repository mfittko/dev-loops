import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { isGateToolingPath } from "@dev-loops/core/loop/base-merge-verdict-carry";

// ADR 0296: a file that a gate-tooling file imports can change a gate outcome too. Starting at the fan-in,
// judge and fan-out entry scripts, the walk follows relative and @dev-loops/core imports through gate-tooling
// files. Every file it reaches under scripts/ or packages/core/src/ must be gate tooling or allowlisted.
// shortcut: the walk reports a non-tooling file and does not expand it, because a full transitive closure
// reaches the whole repo through generic hubs. Only the direct imports of tooling files are checked.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entries = ["scripts/loop/consolidate-fanin.mjs", "scripts/loop/judge-pass.mjs", "scripts/github/emit-fanout-dispatch.mjs"];

// Generic utilities and coordinator procedure that cannot change a review outcome stay out of the rule.
// One reason per group. An entry ending in "/" covers a directory.
const ALLOWLIST = [
  ["GitHub API, comment-trust, marker and diff-classification helpers: they read and write PR data and report facts, they do not decide a verdict", [
    "packages/core/src/github/", "packages/core/src/analysis/", "packages/core/src/harness/", "packages/core/src/claude/", "packages/core/src/cli/",
  ]],
  ["generic script helpers (git, jq, head SHA, base ref, rule-id lookup, CLI primitives) and doc validators", ["scripts/lib/", "scripts/docs/", "scripts/_cli-primitives.mjs", "scripts/_core-helpers.mjs"]],
  ["GitHub read and write wrappers (view, edit, tick, pull, REST fallback): transport, not review logic", [
    "scripts/github/view-issue.mjs", "scripts/github/view-pr.mjs", "scripts/github/edit-issue.mjs", "scripts/github/edit-pr.mjs",
    "scripts/github/tick-verified-checkboxes.mjs", "scripts/github/pull-work-order.mjs", "scripts/github/_gh-rest-fallback.mjs",
    "scripts/github/_comment-trust-config.mjs", "scripts/github/_untrusted-skip-note.mjs",
  ]],
  ["coordinator and fixer procedure (work orders, runner coordination, draft transition, freshness guards, slice linkage): not review outcome, and they change on most merges", [
    "scripts/loop/emit-fixer-work-order.mjs", "scripts/loop/_operator-focus.mjs", "scripts/loop/_pr-runner-coordination.mjs",
    "scripts/loop/_repo-root-resolver.mjs", "scripts/loop/_slice-linkage.mjs", "scripts/loop/_stale-runner-detection.mjs",
    "scripts/loop/standing-authorization.mjs", "scripts/loop/pre-write-remote-freshness-guard.mjs", "scripts/github/_work-order-protocol.mjs",
    "scripts/github/_draft-transition.mjs", "scripts/github/_fixer-act-thread-bindings.mjs", "scripts/github/_legacy-fixer-revalidation.mjs",
    "scripts/github/observe-head-ci.mjs", "scripts/github/_commit-containment.mjs", "scripts/github/_patch-id.mjs",
    "scripts/github/head-declared-keys-schema.mjs", "scripts/github/verify-briefing-prefixes.mjs",
    "packages/core/src/loop/cli-command.mjs", "packages/core/src/loop/copilot-ci-status.mjs", "packages/core/src/loop/copilot-loop-state.mjs",
    "packages/core/src/loop/fix-push-authority.mjs", "packages/core/src/loop/merge-approval.mjs", "packages/core/src/loop/queue-parallel.mjs",
    "packages/core/src/loop/run-context.mjs", "packages/core/src/loop/work-order-digest.mjs", "packages/core/src/loop/worktree-guard.mjs",
  ]],
  ["scope, size and early-surface detection that feeds the pre-push checks, not the reviewer verdict", [
    "scripts/loop/check-size-budget.mjs", "scripts/loop/detect-change-scope.mjs", "scripts/loop/detect-internal-only-pr.mjs",
    "scripts/loop/early-surface-checks.mjs", "packages/core/src/loop/stale-surface-hits.mjs", "packages/core/src/loop/ui-e2e-scoping.mjs",
  ]],
  ["issue, spec and PR-title parsing and plan intake: input data for the reviewer, not a rule", [
    "scripts/loop/detect-issue-refinement-artifact.mjs", "packages/core/src/loop/issue-refinement-artifact.mjs",
    "packages/core/src/loop/plan-file-promote-contract.mjs", "packages/core/src/loop/pr-title-markers.mjs",
    "packages/core/src/loop/normalize.mjs",
  ]],
];
const allowlisted = (f) => ALLOWLIST.some(([, paths]) => paths.some((k) => f === k || (k.endsWith("/") && f.startsWith(k))));

const coreExports = JSON.parse(readFileSync(path.join(repoRoot, "packages/core/package.json"), "utf8")).exports;
const IMPORT_RE = /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith(".")) return path.relative(repoRoot, path.resolve(repoRoot, path.dirname(fromFile), spec)).split(path.sep).join("/");
  if (spec.startsWith("@dev-loops/core/")) {
    const target = coreExports[`./${spec.slice("@dev-loops/core/".length)}`];
    return typeof target === "string" ? `packages/core/${target.replace(/^\.\//, "")}` : null;
  }
  return null; // node: builtins and third-party packages
}

function reachedFiles() {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(path.join(repoRoot, file))) continue;
    seen.add(file);
    if (!isGateToolingPath(file)) continue;
    for (const m of readFileSync(path.join(repoRoot, file), "utf8").matchAll(IMPORT_RE)) {
      const next = resolveSpecifier(file, m[1] ?? m[2] ?? m[3]);
      if (next && /\.(?:mjs|js)$/.test(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

test("every file a gate-tooling file imports is gate tooling or allowlisted (ADR 0296)", () => {
  const reached = reachedFiles();
  assert.ok(reached.length > entries.length, "the import walk reached more than the entry files");
  for (const e of entries) assert.equal(isGateToolingPath(e), true, e);
  const missed = reached
    .filter((f) => /^(?:scripts|packages\/core\/src)\//.test(f))
    .filter((f) => !isGateToolingPath(f) && !allowlisted(f));
  assert.deepEqual(missed, []);
});

test("name tokens match whole words only", () => {
  for (const f of ["scripts/github/navigate-pr.mjs", "scripts/github/delegate-task.mjs", "scripts/github/aggregate-stats.mjs", "scripts/github/preview-body.mjs", "packages/core/src/loop/spec-authority-notes.mjs", "skills/docs/copilot-loop-operations-notes.md"]) {
    assert.equal(isGateToolingPath(f), false, f);
  }
  for (const f of ["scripts/loop/consolidate-fanin.mjs", "scripts/github/_findings-x.mjs", "packages/core/src/loop/spec-authority.mjs", "skills/docs/copilot-loop-operations.md", ".claude/skills/docs/copilot-loop-operations.md", "scripts/github/_dispatch-units.mjs", "packages/core/src/loop/reviewer-unit-bound.mjs", "skills/review/SKILL.md", ".claude/skills/dev-loop/SKILL.md"]) {
    assert.equal(isGateToolingPath(f), true, f);
  }
});
