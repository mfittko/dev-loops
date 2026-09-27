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
  const flat = collapse(section);
  assert.match(flat, /An `incomplete` resolution writes a typed incomplete artifact at the same path, stamped with the requested head/);
  assert.match(flat, /It is incomplete evidence, never a pass\./);
  assert.match(flat, /absent, unreadable, incomplete, or stamped with a different head SHA MUST report a gate-evidence finding/);
  assert.match(flat, /A typed incomplete artifact satisfies this check\./);
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

const DEV_LOOP_SKILL = "skills/dev-loop/SKILL.md";
const WORKTREE_DOC = "skills/docs/worktree-guidance.md";

const collapse = (text) => text.replace(/\s+/g, " ");

test("the slice-3 runner rules are registered and have one canonical home", async () => {
  const owners = {
    "DEV-LOOP-PROBE-TIMEOUT-CEILING": DEV_LOOP_SKILL,
    "DEV-LOOP-RUNNER-STOP-CONDITIONS": DEV_LOOP_SKILL,
    "WORKTREE-NONINTERACTIVE-FILE-OPS": WORKTREE_DOC,
    "WORKTREE-SCRIPT-LAUNCHER-CWD": WORKTREE_DOC,
    "LIFECYCLE-NO-PRIVATE-REPO-NAMES": "skills/docs/pr-lifecycle-contract.md",
    "MERGE-POSTMERGE-FULL-SHA-REPORT": "skills/docs/merge-preconditions.md",
  };
  const manifest = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  for (const [id, owner] of Object.entries(owners)) {
    assertRulePresent(id);
    assertRuleOwned(id, owner);
    assert.ok(manifest.requiredRules.some((rule) => rule.id === id), `expected ${id} in required-rules.json`);
  }
});

test("DEV-LOOP-PROBE-TIMEOUT-CEILING pins the 600000 ms ceiling in the bounded watch rule", async () => {
  const skill = await readRepo(DEV_LOOP_SKILL);
  const watch = skill.indexOf("**Bounded Copilot/CI watch");
  const marker = skill.indexOf("<!-- rule: DEV-LOOP-PROBE-TIMEOUT-CEILING -->");
  assert.ok(watch !== -1 && marker > watch && skill.indexOf("\n**", watch + 1) > marker, "expected the rule inside the bounded watch rule");
  const rule = collapse(passageWith(skill, "<!-- rule: DEV-LOOP-PROBE-TIMEOUT-CEILING -->"));
  assert.match(rule, /`--timeout-ms` .*MUST stay below 600000 ms, the harness tool-call limit/);
  assert.match(rule, /a longer wait loops in separate foreground calls/);
  // Every `timeout <seconds>` wrapper in the watch rule stays below the 600 s limit.
  const watchLine = skill.slice(watch, skill.indexOf("\n", watch));
  const seconds = [...watchLine.matchAll(/`timeout (\d+) /g)].map((m) => Number(m[1]));
  assert.ok(seconds.length > 0, "expected a timeout wrapper in the bounded watch rule");
  for (const value of seconds) assert.ok(value < 600, `timeout ${value} must stay below the 600 s tool-call limit`);
});

test("DEV-LOOP-RUNNER-STOP-CONDITIONS names all three conditions and the quote-and-do-not-retry rule", async () => {
  const rule = sectionFrom(await readRepo(DEV_LOOP_SKILL), "<!-- rule: DEV-LOOP-RUNNER-STOP-CONDITIONS -->", "\n## ");
  assert.match(rule, /MUST stop and report, and never self-waives/);
  assert.match(rule, /- a size-budget `escalate` or `block` outcome;/);
  assert.match(rule, /- an ADR tripwire trip \(`check-adr-tripwire\.mjs`\);/);
  assert.match(rule, /- a harness permission or classifier denial, or an interruption\./);
  assert.match(rule, /quotes the denial text verbatim/);
  assert.match(rule, /does not retry the denied call/);
});

test("WORKTREE-NONINTERACTIVE-FILE-OPS names the three non-interactive commands", async () => {
  const rule = sectionFrom(await readRepo(WORKTREE_DOC), "<!-- rule: WORKTREE-NONINTERACTIVE-FILE-OPS -->", "<!-- rule:");
  for (const cmd of ["command cp -f", "command mv -f", "command rm -f"]) assert.ok(rule.includes(`\`${cmd}\``), `expected ${cmd}`);
  assert.match(collapse(rule), /A dispatch to an editing worker cites this rule by ID/);
});

function frontmatterTools(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1].split("\n").find((l) => l.startsWith("tools:"));
  return line ? line.slice("tools:".length).split(",").map((t) => t.trim()) : [];
}

test("every agent definition that grants Bash points to WORKTREE-NONINTERACTIVE-FILE-OPS", async () => {
  const dir = fromRepoRoot("agents");
  const bashAgents = fs.readdirSync(dir).filter((name) => name.endsWith(".agent.md"))
    .filter((name) => frontmatterTools(fs.readFileSync(path.join(fileURLToPath(dir), name), "utf8")).includes("bash"));
  assert.deepEqual(bashAgents.sort(), ["dev-loop", "developer", "docs", "fixer", "quality", "refiner", "review"].map((n) => `${n}.agent.md`));
  for (const name of bashAgents) {
    const content = await readRepo(`agents/${name}`);
    const namesCommands = ["command cp -f", "command mv -f", "command rm -f"].every((cmd) => content.includes(cmd));
    assert.ok(namesCommands || content.includes("`WORKTREE-NONINTERACTIVE-FILE-OPS`"), `expected ${name} to carry the file-ops pointer`);
  }
});

test("WORKTREE-COMMIT-MSG-GUARD lists every merge subject the guard exempts", async () => {
  const guard = await readRepo("packages/core/src/loop/commit-msg-guard.mjs");
  const alternation = guard.match(/\/\^Merge \(([^)]+)\) \/u/);
  assert.ok(alternation, "expected the Merge exemption pattern in the guard");
  const subjects = alternation[1].split("|");
  assert.ok(subjects.includes("remote-tracking branch"));
  const rule = collapse(sectionFrom(await readRepo(WORKTREE_DOC), "<!-- rule: WORKTREE-COMMIT-MSG-GUARD -->"));
  for (const subject of subjects) assert.ok(rule.includes(`\`Merge ${subject} `), `expected Merge ${subject} in the exempt list`);
  assert.match(guard, /\/\^Revert "\/u/);
  assert.ok(rule.includes('`Revert "..."`'));
  assert.match(guard, /\/\^\(fixup\|squash\)! \/u/);
  assert.ok(rule.includes("`fixup! ...`") && rule.includes("`squash! ...`"));
});

test("WORKTREE-COMMIT-MSG-GUARD states the default merge subject and the agent no-waiver rule", async () => {
  const rule = collapse(sectionFrom(await readRepo(WORKTREE_DOC), "<!-- rule: WORKTREE-COMMIT-MSG-GUARD -->"));
  assert.match(rule, /A merge commit uses git's default subject\./);
  assert.match(rule, /The waiver is operator-only: an agent-authored commit never carries the waiver line\./);
});

test("WORKTREE-SCRIPT-LAUNCHER-CWD pins the compound launcher form", async () => {
  const rule = sectionFrom(await readRepo(WORKTREE_DOC), "<!-- rule: WORKTREE-SCRIPT-LAUNCHER-CWD -->", "\n## ");
  assert.ok(rule.includes("`cd <checkout> && dev-loops-run scripts/<path>`"));
  assert.match(collapse(rule), /Each Bash call may start in another checkout/);
  assert.match(rule, /`GATE-EXEC-NO-CWD-DEPENDENCE`/);
});

test("LIFECYCLE-NO-PRIVATE-REPO-NAMES covers every public artifact and the generic wording", async () => {
  const rule = passageWith(await readRepo("skills/docs/pr-lifecycle-contract.md"), "<!-- rule: LIFECYCLE-NO-PRIVATE-REPO-NAMES -->");
  assert.match(rule, /Issues, PRs, comments, commit messages and changelog fragments MUST NOT name a private consumer repo or its PR numbers/);
  assert.match(rule, /"a consumer repo" or "a consumer soak"/);
});

test("MERGE-POSTMERGE-FULL-SHA-REPORT is a post-merge duty naming the full 40-hex SHA", async () => {
  const doc = await readRepo("skills/docs/merge-preconditions.md");
  const postMerge = sectionFrom(doc, "## Post-merge", "\n## ");
  assert.ok(postMerge.includes("<!-- rule: MERGE-POSTMERGE-FULL-SHA-REPORT -->"));
  assert.match(postMerge, /the merge report MUST name the full 40-hex merge commit SHA/);
});

test("README Claude Code plugin section names the permission rule for both verdict-post forms", async () => {
  const section = sectionFrom(await readRepo("README.md"), "### Claude Code plugin", "\n### ");
  assert.match(section, /The gate verdict post is the sanctioned gate path\./);
  assert.ok(section.includes("`Bash(dev-loops gate upsert-verdict:*)`"));
  assert.ok(section.includes("`Bash(node scripts/github/upsert-checkpoint-verdict.mjs:*)`"));
  assert.ok(section.includes("`Bash(node scripts/github/ready-for-review.mjs:*)`"));
  assert.ok(section.includes("`Bash(dev-loops-run:*)`"));
  assert.match(section, /Only an exact command prefix matches\./);
  assert.match(section, /An ask rule on the bare form does not gate the launcher form/);
  assert.ok(section.includes("`Bash(dev-loops-run scripts/github/merge-pr.mjs:*)`"));
});

const DEV_LOOP_AGENT_SURFACES = ["agents/dev-loop.agent.md", ".claude/agents/dev-loop.md"];

function subagentDelegation(content) {
  return sectionFrom(content, "## Subagent delegation", "\n## ");
}

for (const surface of DEV_LOOP_AGENT_SURFACES) {
  test(`${surface} Subagent delegation points to the issue body and cites rules by role`, async () => {
    const section = subagentDelegation(await readRepo(surface));
    assert.match(section, /worker, reviewer, judge or fixer dispatch names the linked issue and states "The issue body is the spec; read it\."/);
    assert.match(section, /`pr_body` path the PR body is the spec/);
    assert.match(section, /never restates issue-specific spec/);
    assert.match(section, /cites rules by rule ID, never by copied text/);
    const bullet = (label) => section.split("\n").find((line) => line.startsWith(`- ${label}`)) ?? assert.fail(`expected a ${label} bullet`);
    assert.match(bullet("agents that dispatch children"), /`GATE-EXEC-HARNESS-JOIN`/);
    const editing = bullet("editing workers");
    assert.match(editing, /`WORKTREE-NONINTERACTIVE-FILE-OPS` and `OPS-NO-INLINE-INTERPRETER`/);
    assert.doesNotMatch(editing, /HARNESS-JOIN/);
    const runners = bullet("script runners");
    assert.match(runners, /`WORKTREE-SCRIPT-LAUNCHER-CWD`/);
    assert.doesNotMatch(runners, /HARNESS-JOIN/);
    assert.match(section, /A worker, reviewer, judge or fixer dispatches no children and receives no join rule\./);
  });

  test(`${surface} Subagent delegation embeds no rule body defined in another doc`, async () => {
    const section = subagentDelegation(await readRepo(surface));
    const sources = (await collectContractMarkdownFiles()).map((file) => ({ file, content: fs.readFileSync(file, "utf8") }));
    assert.deepEqual(findEmbeddedRuleBodies(section, sources).map((def) => def.id), []);
    // Negative fixture: one pasted rule body is detected.
    const [fileOps] = extractRuleDefinitions(await readRepo(WORKTREE_DOC), WORKTREE_DOC)
      .filter((def) => def.id === "WORKTREE-NONINTERACTIVE-FILE-OPS");
    const pasted = findEmbeddedRuleBodies(`${section}\n- ${fileOps.body}`, sources).map((def) => def.id);
    assert.ok(pasted.includes("WORKTREE-NONINTERACTIVE-FILE-OPS"));
  });
}

// Item 16: a follow-up passage must cite the blocker-only filing rule and carry no
// standalone-issue permission for an independent follow-up that outlives the PR.
function followUpFilingViolations(passage) {
  const violations = [];
  if (!passage.includes("`MAIN-AGENT-FILING-BLOCKER-ONLY`")) violations.push("missing MAIN-AGENT-FILING-BLOCKER-ONLY citation");
  const flat = collapse(passage);
  if (/standalone issue only if[^|]*independent[^|]*outlives it/.test(flat)
    || /independent bugs that outlive the PR/.test(flat)) violations.push("standalone-issue permission present");
  return violations;
}

const FOLLOW_UP_PASSAGES = [
  ["skills/docs/issue-intake-procedure.md", (doc) => doc.split("\n").find((line) => line.startsWith("- follow-up-capture rule:"))],
  ["skills/docs/sub-issue-tree-contract.md", (doc) => doc.split("\n").find((line) => line.startsWith("| A follow-up is discovered while working a PR/loop |"))],
  ["skills/docs/sub-issue-tree-contract.md", (doc) => passageWith(doc, "**Conservatism clause:**")],
];

test("the follow-up capture passages defer standalone filing to MAIN-AGENT-FILING-BLOCKER-ONLY", async () => {
  for (const [file, pick] of FOLLOW_UP_PASSAGES) {
    const passage = pick(await readRepo(file));
    assert.ok(passage, `expected the follow-up passage in ${file}`);
    assert.deepEqual(followUpFilingViolations(passage), [], file);
  }
});

test("negative fixture: restoring the old standalone-issue permission fails the follow-up check", () => {
  const restored = "| A follow-up is discovered while working a PR/loop | Note it on the originating issue (or the PR body); file a standalone issue only if the follow-up is genuinely independent of the PR **and** outlives it (a real separate bug/feature that would be lost as a note on a soon-closed issue) |";
  assert.ok(followUpFilingViolations(restored).includes("standalone-issue permission present"));
  const restoredWithCitation = `${restored} See \`MAIN-AGENT-FILING-BLOCKER-ONLY\`.`;
  assert.deepEqual(followUpFilingViolations(restoredWithCitation), ["standalone-issue permission present"]);
  const restoredClause = "**Conservatism clause:** prefer noting PR-scoped follow-ups on the originating artifact. Cross-cutting contract/policy changes and\ngenuinely independent bugs that outlive the PR remain their own issues. See `MAIN-AGENT-FILING-BLOCKER-ONLY`.";
  assert.deepEqual(followUpFilingViolations(restoredClause), ["standalone-issue permission present"]);
});
