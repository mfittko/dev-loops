// Prose drift guards for issue 2438: runner rules learned in the v1.0.4 drain
// and the 1.0.4-pre.3 consumer soak live in the canonical contracts, cite
// rules by ID, and match ADR 0089 and the request tool.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectContractMarkdownFiles, extractRuleDefinitions, findEmbeddedRuleBodies } from "../../scripts/docs/validate-rule-ownership.mjs";
import { assert, fromRepoRoot, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

const GATE_DOC = "skills/docs/gate-review-sub-loop-contract.md";
const COPILOT_SKILL = "skills/copilot-pr-followup/SKILL.md";

// From a rule marker to the next `### ` heading.
function sectionFrom(content, marker, endMarker = "\n### ") {
  const start = content.indexOf(marker);
  assert.ok(start !== -1, `expected ${marker}`);
  const end = content.indexOf(endMarker, start + marker.length);
  return content.slice(start, end === -1 ? content.length : end);
}

// One paragraph, bullet, or table row that contains `needle`.
function passageWith(content, needle) {
  const idx = content.indexOf(needle);
  assert.ok(idx !== -1, `expected passage containing ${needle}`);
  const before = content.lastIndexOf("\n\n", idx);
  const after = content.indexOf("\n\n", idx);
  return content.slice(before === -1 ? 0 : before, after === -1 ? content.length : after);
}

test("GATE-EXEC-BASE-REFRESH is registered and owned by the gate-review sub-loop contract", async () => {
  assertRulePresent("GATE-EXEC-BASE-REFRESH");
  assertRuleOwned("GATE-EXEC-BASE-REFRESH", GATE_DOC);
  const manifest = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  assert.ok(manifest.requiredRules.some((rule) => rule.id === "GATE-EXEC-BASE-REFRESH"));
});

test("GATE-EXEC-BASE-REFRESH integrates the base through the sanctioned tool before the round", async () => {
  const section = sectionFrom(await readRepo(GATE_DOC), "<!-- rule: GATE-EXEC-BASE-REFRESH -->");
  assert.match(section, /resolve-pr-conflicts\.mjs/);
  assert.match(section, /`origin\/<base>` is not an ancestor\s+of the PR head/);
  assert.match(section, /git merge --no-edit origin\/<base>/);
  assert.match(section, /git's default merge\s+subject/);
  assert.match(section, /MUST push the merge before it dispatches the round/);
  assert.match(section, /re-runs on the new head per\s+`GATE-EXEC-REGATE-MANDATORY`/);
});

test("ADR 0096 records GATE-EXEC-BASE-REFRESH and amends ADR 0066", async () => {
  const dir = fromRepoRoot("docs/decisions");
  const matches = fs.readdirSync(dir).filter((name) => name.startsWith("0096-"));
  assert.equal(matches.length, 1, "expected exactly one ADR 0096");
  const adr = await readRepo(path.posix.join("docs/decisions", matches[0]));
  assert.match(adr, /## Status\s+Accepted — \d{4}-\d{2}-\d{2} \(/);
  assert.match(adr, /Amends \[ADR 0066\]/);
  assert.match(adr, /`GATE-EXEC-BASE-REFRESH`/);
});

test("COPILOT-FOLLOWUP-REQUEST-BRANCHING stops on an unchanged head and names no bypass", async () => {
  const section = sectionFrom(await readRepo(COPILOT_SKILL), "<!-- rule: COPILOT-FOLLOWUP-REQUEST-BRANCHING -->", "\n\n");
  const branch = (status) => {
    const line = section.split("\n").find((l) => l.startsWith(`- \`${status}\`:`));
    assert.ok(line, `expected a ${status} branch`);
    return line;
  };
  assert.match(branch("no_changes_since_last_review"), /stop/i);
  assert.match(branch("no_changes_since_last_review"), /Report/);
  const sameHead = branch("suppressed_same_head_clean");
  assert.match(sameHead, /stop/);
  assert.doesNotMatch(sameHead, /--force-rerequest-review/);
});

test("no clean definition in the gate contract is severity-only (ADR 0089)", async () => {
  const content = await readRepo(GATE_DOC);
  const named = [
    "- determine the overall gate verdict",
    "Two layers\n  govern this",
    "- a clean pass means",
    "| Posted review verdict is `clean`",
  ];
  for (const needle of named) {
    assert.match(passageWith(content, needle), /act list/, `expected the act-list composition near: ${needle}`);
  }
  // Every chunk that defines `clean` through the blocking severity set also names the act list.
  const chunks = content.split(/\n(?=\s*- |\| )|\n\n/);
  const offenders = chunks.filter((chunk) => /`clean`:|clean pass means|verdict is `clean` whenever|verdict is `clean` \(/.test(chunk)
    && /blockCleanOnFindingSeverities|blocking severity/.test(chunk)
    && !/act list/.test(chunk));
  assert.deepEqual(offenders, []);
});

test("copilot-pr-followup Phase 5 composes the medium fix window with the judge act list", async () => {
  const skill = await readRepo(COPILOT_SKILL);
  assert.doesNotMatch(skill, /the medium fix window is unchanged/);
  assert.match(passageWith(skill, "**Retry / fixer triage (Phase 5):**"), /A judge `act` overrides the medium fix window/);
});

test("GATE-EXEC-VALIDATION-RESOLUTION names the verdict writer as its enforcement point", async () => {
  const section = passageWith(await readRepo(GATE_DOC), "<!-- rule: GATE-EXEC-VALIDATION-RESOLUTION -->");
  assert.match(section, /`upsert-checkpoint-verdict\.mjs` refuses a `fanout_fanin` verdict post/);
  assert.match(section, /`run-gate-validation\.mjs`/);
});

test("GATE-EXEC-NO-CWD-DEPENDENCE cites WORKTREE-SCRIPT-LAUNCHER-CWD by ID", async () => {
  const section = passageWith(await readRepo(GATE_DOC), "<!-- rule: GATE-EXEC-NO-CWD-DEPENDENCE -->");
  assert.match(section, /`WORKTREE-SCRIPT-LAUNCHER-CWD`/);
});

function dispatchGuidance(content) {
  return sectionFrom(content, "Dispatch guidance.", "\nThe standalone `review` gate");
}

test("GATE-EXEC-GATE-COORDINATOR dispatch guidance points to the issue body and cites rules by role", async () => {
  const content = await readRepo(GATE_DOC);
  assert.ok(sectionFrom(content, "<!-- rule: GATE-EXEC-GATE-COORDINATOR -->").includes("Dispatch guidance."));
  const guidance = dispatchGuidance(content);
  assert.match(guidance, /worker, reviewer, judge or fixer dispatch/);
  assert.match(guidance, /"The issue body is the spec; read it\."/);
  assert.match(guidance, /`pr_body` path the PR body is the\s+spec/);
  assert.match(guidance, /never restates issue-specific spec/);
  assert.match(guidance, /cites rules by rule ID, never by copied text/);
  const bullet = (label) => {
    const idx = guidance.indexOf(`- ${label}`);
    assert.ok(idx !== -1, `expected a role bullet for ${label}`);
    const next = guidance.indexOf("\n- ", idx + 1);
    return guidance.slice(idx, next === -1 ? guidance.indexOf("\n\n", idx) : next);
  };
  assert.match(bullet("agents that dispatch children"), /`GATE-EXEC-HARNESS-JOIN`/);
  const editing = bullet("editing workers");
  assert.match(editing, /`WORKTREE-NONINTERACTIVE-FILE-OPS`/);
  assert.match(editing, /`OPS-NO-INLINE-INTERPRETER`/);
  assert.doesNotMatch(editing, /HARNESS-JOIN/);
  const runners = bullet("script runners");
  assert.match(runners, /`WORKTREE-SCRIPT-LAUNCHER-CWD`/);
  assert.doesNotMatch(runners, /HARNESS-JOIN/);
  assert.match(guidance, /dispatches no children and receives no join rule/);
});

test("GATE-EXEC-GATE-COORDINATOR dispatch guidance embeds no rule body defined in another doc", async () => {
  const guidance = dispatchGuidance(await readRepo(GATE_DOC));
  const gateDocAbs = fileURLToPath(fromRepoRoot(GATE_DOC));
  const sources = (await collectContractMarkdownFiles())
    .filter((file) => path.resolve(file) !== gateDocAbs)
    .map((file) => ({ file, content: fs.readFileSync(file, "utf8") }));
  assert.ok(sources.length > 0);
  assert.deepEqual(findEmbeddedRuleBodies(guidance, sources).map((def) => def.id), []);
  // Negative fixture: pasting one cited rule's body into the guidance is detected.
  const [inlineRule] = extractRuleDefinitions(
    sources.find(({ content }) => content.includes("<!-- rule: OPS-NO-INLINE-INTERPRETER -->")).content,
    "copilot-loop-operations.md",
  ).filter((def) => def.id === "OPS-NO-INLINE-INTERPRETER");
  const pasted = findEmbeddedRuleBodies(`${guidance}\n${inlineRule.body}`, sources).map((def) => def.id);
  assert.ok(pasted.includes("OPS-NO-INLINE-INTERPRETER"));
});
