// Doc-drift guard for the #1404 config-schema redesign: these keys were
// REMOVED/renamed off `.devloops` input and NEVER reappear as a resolved-
// output field name anywhere in this codebase (unlike mandatoryAngles,
// copyOnInit, stopOnLowSignal, or workflow-handoff-contract.md's
// excludeAngles, which are legitimate resolver-OUTPUT shapes some docs still
// correctly name — those are deliberately excluded here to avoid false
// positives). A match under docs/ or skills/ is unambiguously stale
// `.devloops` INPUT teaching and must be fixed at the source, not tolerated.
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
  "copyOnInit",
  "linkOnInit",
  "dynamicAngles",
  "additiveAngles",
  "localPlanning",
];

async function markdownAndHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".html")))
    .map((e) => path.join(e.parentPath, e.name));
}

test("docs/ and skills/ never reference a removed .devloops-input-only config key (#1404)", async () => {
  const files = [
    ...(await markdownAndHtmlFiles(path.join(repoRoot, "docs"))),
    ...(await markdownAndHtmlFiles(path.join(repoRoot, "skills"))),
  ];
  // Word-boundary match on the trailing edge only: `localPlanning` must not
  // false-positive on `localPlanningStatus` (an unrelated reviewer-loop-state
  // field name that happens to share the prefix).
  const patterns = REMOVED_INPUT_ONLY_KEYS.map((key) => ({ key, re: new RegExp(`${key}(?![A-Za-z])`) }));

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
