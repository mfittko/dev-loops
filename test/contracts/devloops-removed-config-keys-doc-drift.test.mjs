// Doc-drift guard for the #1404 config-schema redesign: these keys were
// REMOVED/renamed off `.devloops` input and are never legitimately referenced
// as a resolved-OUTPUT field name in doc/skill/command PROSE (unlike
// mandatoryAngles, copyOnInit, dynamicAngles, stopOnLowSignal, or
// workflow-handoff-contract.md's excludeAngles, which ARE retained resolver-
// output shapes some docs still correctly name — those are deliberately
// excluded from the list below to avoid false positives). A match under
// docs/, skills/, or commands/ is therefore unambiguously stale `.devloops`
// INPUT teaching and must be fixed at the source, not tolerated.
//
// Scoped to the unambiguous subset only; see CHANGELOG.md's "upgrading your
// .devloops" table for the full renamed/removed key list (some of those,
// e.g. excludeAngles, DO have a legitimate retained output meaning and are
// intentionally not guarded here).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const REMOVED_INPUT_ONLY_KEYS = [
  "projectNumber",
  "boardTitle",
  "localPlanning",
  // Removed NESTED forms — the parent key (`strategy`/`inputSource`) is retained
  // as a flat scalar, so only the dotted `.default` form is stale. Safe to guard
  // as a literal string (the dots are escaped below).
  "strategy.default",
  "inputSource.default",
  // NOTE: copyOnInit/linkOnInit/dynamicAngles/additiveAngles are intentionally
  // NOT guarded — they were removed as `.devloops` INPUT keys but survive as
  // legitimate RESOLVED-OUTPUT field names (worktree resolver / resolveGateConfig),
  // so a bare match can't be disambiguated from a correct output reference. Their
  // input-side migration is enforced by review, not this guard (per the header).
];

async function markdownAndHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".html")))
    .map((e) => path.join(e.parentPath, e.name));
}

test("docs/, skills/, and commands/ never reference a removed .devloops-input-only config key (#1404)", async () => {
  const files = [
    ...(await markdownAndHtmlFiles(path.join(repoRoot, "docs"))),
    ...(await markdownAndHtmlFiles(path.join(repoRoot, "skills"))),
    ...(await markdownAndHtmlFiles(path.join(repoRoot, "commands"))),
  ];
  // Word-boundary match on the trailing edge only: `localPlanning` must not
  // false-positive on `localPlanningStatus` (an unrelated reviewer-loop-state
  // field name that happens to share the prefix).
  const patterns = REMOVED_INPUT_ONLY_KEYS.map((key) => ({ key, re: new RegExp(`${key.replace(/\./g, "\\.")}(?![A-Za-z])`) }));

  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const { key, re } of patterns) {
        if (re.test(line)) offenders.push(`${path.relative(repoRoot, file)}:${i + 1}: ${key}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `removed .devloops config key(s) still referenced (fix the doc, don't relax this guard):\n${offenders.join("\n")}`
  );
});
