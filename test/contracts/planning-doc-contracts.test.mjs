import {
  assert,
  assertMatchesAll,
  parseFrontmatter,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";
import { assertRuleOwned, extractOwnedText } from "./_rule-helpers.mjs";

const SUB_ISSUE_TREE_GUIDANCE = [
  /prefer real GitHub sub-issue trees as the durable execution structure/i,
  /keep parent issue bodies lean/i,
];

test("refiner agent frontmatter keeps the refinement role explicit", async () => {
  const content = await readRepo("agents/refiner.agent.md");
  const frontmatter = parseFrontmatter(content);

  assert.equal(frontmatter.name, "refiner");
  assert.equal(frontmatter["user-invocable"], false);
  assert.match(frontmatter.description ?? "", /phase refinement/i);
  assert.match(frontmatter.description ?? "", /acceptance criteria/i);
  assert.match(frontmatter.description ?? "", /definition of done/i);
  assert.match(frontmatter.description ?? "", /RFC escalation/i);
});

test("refiner agent defines the approved phase-refinement contract", async () => {
  const content = await readRepo("agents/refiner.agent.md");

  assertMatchesAll(content, [
    /## Purpose/i,
    /## Scope boundaries/i,
    /## Refinement contract/i,
    /## RFC escalation boundary/i,
    /complete acceptance criteria/i,
    /complete definition of done/i,
    /coverage matrix/i,
    /Type \(AC\/DoD\/Non-goal\)/i,
    /Status \(Met\/Partial\/Unmet\/Unverified\)/i,
    /use exact wording from the source issue\(s\)/i,
    /include every explicit acceptance criterion, definition-of-done item, and non-goal/i,
    /Proposed DoD/i,
    /explicit non-goals/i,
    /explicit risks, watchpoints, and unresolved questions/i,
    /validation steps and tests to write first/i,
    /parallel fresh-context fan-out\/fan-in/i,
    /variant-a.+variant-b|variant-b.+variant-a/is,
    /one persona or refinement angle/i,
    /different persona or angle/i,
    /to the parent session \/ human operator/i,
    /lead dev/i,
    /specialized dev/i,
    /systems architect/i,
    /A refinement is complete only when no item.+Partial.+Unmet.+Unverified/is,
  ], "agents/refiner.agent.md");
  assert.doesNotMatch(content, /execute RFC work itself|run the RFC team|implement the RFC team/i);
});


test("refiner agent defines the AC/DoD/Non-goal coverage-matrix contract", async () => {
  // Pre-1.0 config-schema redesign (#1404): the top-level `personas` map
  // (including the unwired `refiner`/`audit` entries that only ever mirrored
  // this agent's own owned text — no code path ever read
  // config.personas.refiner/.audit) is removed; gate-review angle
  // persona/prompt overrides now live on the gate's own angle entry
  // (gates.<gate>.angles[].persona/.prompt), which has no equivalent for
  // "refiner"/"audit" since neither is a gate angle. The coverage-matrix
  // contract itself is owned here, not mirrored in shipped config.
  const content = await readRepo("agents/refiner.agent.md");

  assertMatchesAll(content, [
    /AC\/DoD\/Non-goal coverage matrix/i,
    /\| Item \| Type \(AC\/DoD\/Non-goal\) \| Status \(Met\/Partial\/Unmet\/Unverified\) \| Evidence \| Notes \|/i,
    /Use exact wording from the source issue\(s\); when the governing input is a phase doc or other spec instead of an issue, use that source wording exactly for every explicit item/i,
    /Include every explicit acceptance criterion, definition-of-done item, and non-goal; do not skip items/i,
  ], "agents/refiner.agent.md");
  assertRuleOwned("REFINER-DOD-PROPOSED-SUBSECTION", "agents/refiner.agent.md");
  // Owned-text check — marker survival alone must not mask dropping the Proposed-DoD clause.
  assert.match(
    extractOwnedText(content, "REFINER-DOD-PROPOSED-SUBSECTION"),
    /Proposed DoD/,
  );
});

test("local-implementation skill uses the refiner for phase planning and delegates RFC decisions to the parent session", async () => {
  const content = await readRepo("skills/local-implementation/SKILL.md");

  assertMatchesAll(content, [
    /refiner/i,
    /parallel fresh-context subagents/i,
    /concise written briefing summary|concise briefing summary/i,
    /do not fork the parent session/i,
    /stable inner fan-out shape|anchored to one persona or refinement angle/i,
    /different persona or angle/i,
    /Definition of done/i,
    /RFC-worthy technical decisions/i,
    /to the parent session \/ human operator/i,
    /escalate RFC-worthy technical decisions to the parent session/i,
  ], "skills/local-implementation/SKILL.md");
});



test("planning guidance keeps sub-issue trees as the durable decomposition owner", async () => {
  const [localImplementationSkill, subIssueTreeContract, docsIndex] = await Promise.all([
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("skills/docs/sub-issue-tree-contract.md"),
    readRepo("docs/index.md"),
  ]);

  // Sub-issue tree guidance canonical in sub-issue-tree-contract.md; SKILL.md references it
  assert.match(localImplementationSkill, /sub-issue-tree-contract\.md/i);
  assertMatchesAll(subIssueTreeContract, [
    /real GitHub[\s\S]*?sub-issue tree[\s\S]*?default durable/i,
    /keep.*parent.*lean/i,
    /plain related-issue references/i,
    /manage-sub-issues\.mjs/i,
    /When to use sub-issues vs plain related-issue references/i,
    /do not maintain.*checklist.*duplicates|not.*maintain.*ordered checklist.*duplicates/i,
  ], "skills/docs/sub-issue-tree-contract.md");
  assert.match(docsIndex, /sub-issue-tree-contract\.md/i);
});

// Structural: find the durable and non-durable lists by heading line and
// bullet membership, tolerant of heading markup, blank lines and wording.
// Exact only for the API literal `canonicalSpecSource: pr_body`.
function listItemsUnder(lines, headingRe) {
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return null;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*[-*]\s+/.test(line)) items.push(line.trim());
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else if (line.trim() !== "") break;
  }
  return items;
}

function assertLightweightIsNonDurable(content) {
  const lines = content.split(/\r?\n/);
  // A heading is a markdown heading or a lead-in line that ends with a colon.
  const durable = listItemsUnder(lines, /^\s*(?:#+\s*durable\b.*|durable\b.*:)\s*$/i);
  const nonDurable = listItemsUnder(lines, /^\s*(?:#+\s*non-durable\b.*|non-durable\b.*:)\s*$/i);
  assert.ok(durable && nonDurable, "missing durable / non-durable spec-of-record lists");
  assert.ok(!durable.some((item) => /lightweight/i.test(item)), "lightweight must not be listed as durable");
  assert.ok(nonDurable.length > 0, "missing non-durable spec-of-record list");
  const entry = nonDurable.find((item) => /lightweight/i.test(item));
  assert.ok(entry, "non-durable list must name lightweight sessions");
  assert.match(entry, /canonicalSpecSource: pr_body/, "lightweight entry must name its pr_body spec source");
  // Invariant: the entry negates a phase or plan doc within one clause, in any wording.
  assert.match(
    entry,
    /\bno\b[^.;]*\b(?:phase|plan)\b[^.;]*\bdoc(?:ument)?s?\b|\b(?:phase|plan)\b[^.;]*\bdoc(?:ument)?s?\b[^.;]*\b(?:is|are)\s+(?:not|never)\b/i,
    "lightweight entry must state it has no plan doc",
  );
}

test("lightweight non-durable check accepts a valid fixture and fails each broken fixture for its own reason", () => {
  const valid = [
    "Durable/committed spec artifacts:",
    "",
    "- phase-doc-backed local sessions",
    "",
    "Non-durable spec-of-record (no committed plan artifact):",
    "",
    "- lightweight PR-body-as-spec sessions (`canonicalSpecSource: pr_body`); no phase/plan doc",
    "",
  ].join("\n");
  assert.doesNotThrow(() => assertLightweightIsNonDurable(valid));
  assert.doesNotThrow(() => assertLightweightIsNonDurable(`${valid}\n- trailing section\n`));

  // Reformatted headings: single newline, extra whitespace, markdown heading form.
  const reformatted = valid
    .replace("Durable/committed spec artifacts:\n\n", "### Durable / committed spec artifacts\n")
    .replace("Non-durable spec-of-record (no committed plan artifact):\n\n", "Non-durable  spec-of-record   (no committed plan artifact):  \n");
  assert.doesNotThrow(() => assertLightweightIsNonDurable(reformatted));

  // Reworded prose with a wrapped continuation line.
  const reworded = valid.replace(
    "- lightweight PR-body-as-spec sessions (`canonicalSpecSource: pr_body`); no phase/plan doc",
    "- sessions run with the lightweight flag use `canonicalSpecSource: pr_body`;\n  no plan or phase document is created or committed",
  );
  assert.doesNotThrow(() => assertLightweightIsNonDurable(reworded));
  const rewordedPassive = valid.replace("; no phase/plan doc", ". A phase or plan doc is never committed");
  assert.doesNotThrow(() => assertLightweightIsNonDurable(rewordedPassive));

  const moved = valid.replace("- phase-doc-backed local sessions", "- lightweight PR-body-as-spec sessions");
  assert.throws(() => assertLightweightIsNonDurable(moved), /lightweight must not be listed as durable/);

  const noLists = valid.replace("Non-durable spec-of-record (no committed plan artifact):", "Other sessions:");
  assert.throws(() => assertLightweightIsNonDurable(noLists), /missing durable \/ non-durable spec-of-record lists/);

  const noListBody = valid.replace(
    "- lightweight PR-body-as-spec sessions (`canonicalSpecSource: pr_body`); no phase/plan doc",
    "See the artifact authority contract.",
  );
  assert.throws(() => assertLightweightIsNonDurable(noListBody), /missing non-durable spec-of-record list/);

  const noLightweight = valid.replace("lightweight PR-body-as-spec sessions", "other sessions");
  assert.throws(() => assertLightweightIsNonDurable(noLightweight), /non-durable list must name lightweight sessions/);

  const noSpecSource = valid.replace(" (`canonicalSpecSource: pr_body`)", "");
  assert.throws(() => assertLightweightIsNonDurable(noSpecSource), /lightweight entry must name its pr_body spec source/);

  const noPlanDoc = valid.replace("; no phase/plan doc", "");
  assert.throws(() => assertLightweightIsNonDurable(noPlanDoc), /lightweight entry must state it has no plan doc/);

  const planDocCommitted = valid.replace("; no phase/plan doc", "; a phase/plan doc is committed");
  assert.throws(() => assertLightweightIsNonDurable(planDocCommitted), /lightweight entry must state it has no plan doc/);
});

test("local workflow docs define tracker-backed local canonicality and no-dup rules", async () => {
  const [workflowDoc, localImplSkill, scriptsReadme] = await Promise.all([
    readRepo("docs/IMPLEMENTATION_WORKFLOW.md"),
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("scripts/README.md"),
  ]);

  assertMatchesAll(workflowDoc, [
    /Tracker-backed local issue spec/i,
    /tracker issue is the durable canonical spec/i,
    /resolve-tracker-local-spec\.mjs/i,
    /do \*\*not\*\* also maintain.*Phase Plan.*for that same tracker-backed session/i,
  ], "docs/IMPLEMENTATION_WORKFLOW.md");

  assertMatchesAll(localImplSkill, [
    /Local implementation supports these spec-of-record inputs/i,
    /Durable\/committed spec artifacts/i,
    /phase-doc-backed local sessions/i,
    /tracker-backed local sessions/i,
    /Non-durable spec-of-record \(no committed plan artifact\)/i,
    /ARTIFACT-TRACKER-FIRST-NO-DUP/,
    /do not read \[Phase Plan\]\(\.\.\/\.\.\/docs\/phases\/phase-x\.md\) for that same tracker-backed session/i,
    /keep `tmp\/` as temporary local execution state only/i,
  ], "skills/local-implementation/SKILL.md");
  assertLightweightIsNonDurable(localImplSkill);

  assertMatchesAll(scriptsReadme, [
    /resolve-tracker-local-spec\.mjs/i,
    /bounded GitHub-backed path/i,
    /localPhaseDocAllowed: false/i,
  ], "scripts/README.md");
});

test("worktree guidance docs define the canonical checkout-isolation contract", async () => {
  const [worktreeGuidance, agentsDoc, docsIndex] = await Promise.all([
    readRepo("skills/docs/worktree-guidance.md"),
    readRepo("AGENTS.md"),
    readRepo("docs/index.md"),
  ]);

  assertMatchesAll(worktreeGuidance, [
    /## Purpose and scope/i,
    /## Canonical location and naming/i,
    /## Default rule: use a worktree for mutating local work/i,
    /## Create or reuse flow/i,
    /## Dependency and install expectations/i,
    /## Coordination and collision checks/i,
    /## Cleanup and prune flow/i,
    /## Fallback when worktrees are unavailable/i,
    /## Non-goals/i,
    /tmp\/worktrees\//i,
    /git worktree list/i,
    /origin\/main/i,
    /bun install --frozen-lockfile/i,
    /git worktree remove --force/i,
    /git worktree prune/i,
    /worktrees are unavailable/i,
  ], "skills/docs/worktree-guidance.md");

  assert.match(agentsDoc, /docs\/worktree-guidance\.md/i);
  assert.match(docsIndex, /worktree-guidance\.md/i);

  });


test("phase-truth docs agree that Phase 8 is active and Phase 7 is deferred", async () => {
  const [plan, docsIndex, implementationState, phase7, phase8, agents] = await Promise.all([
    readRepo("PLAN.md"),
    readRepo("docs/index.md"),
    readRepo("docs/IMPLEMENTATION_STATE.md"),
    readRepo("docs/phases/phase-7.md"),
    readRepo("docs/phases/phase-8.md"),
    readRepo("AGENTS.md"),
  ]);

  assert.match(plan, /Current active phase[\s\S]*Phase 8/i);
  assert.match(plan, /Phase 7[\s\S]*deferred/i);

  assert.match(docsIndex, /Active local phase doc[\s\S]*phase-8\.md/i);

  assert.match(agents, /Implement one phase at a time/i);
  assert.match(agents, /reprioritization exception/i);
  assert.match(agents, /Implementation State\]\(docs\/IMPLEMENTATION_STATE\.md\)/i);

  assert.match(implementationState, /Phase 7 second-repo pilot is deferred, not completed/i);
  assert.match(implementationState, /Phase 8 is the active durable phase/i);
  assert.match(implementationState, /explicit deviation from the repo's normal one-phase-at-a-time guidance/i);
  assert.match(implementationState, /Active phase: `phase-8`/i);
  assert.match(implementationState, /Status: `active \(slice-1-implemented; additional Phase 8 closure work pending\)`/i);
  assert.doesNotMatch(implementationState, /Active phase: `phase-7`/i);

  assert.match(phase7, /## Status[\s\S]*deferred/i);
  assert.match(phase7, /Phase 8 was pulled forward ahead of this pilot/i);

  assert.match(phase8, /## Status[\s\S]*active \(slice-1-implemented; additional Phase 8 closure work pending\)/i);
  assert.match(phase8, /Phase 8 was pulled forward ahead of the deferred Phase 7 pilot/i);
  assert.match(phase8, /\.pi\/dev-loop\/defaults\.yaml/i);
  assert.match(phase8, /\.pi\/dev-loop\/settings\.yaml/i);
  assert.match(phase8, /settings\.\*`?[^\n]*overrides\.\*`?[^\n]*defaults\.\*`?[^\n]*built-in defaults/i);
  assert.match(phase8, /shipped-defaults vs repo-local-settings ownership/i);
  assert.doesNotMatch(phase8, /durable-vs-session split/i);
  assert.doesNotMatch(phase8, /session \(gitignored\) config/i);
  assert.doesNotMatch(phase8, /defaults\.json|overrides\.json/i);
});

test("AGENTS stays compact and resolver-first", async () => {
  const agents = await readRepo("AGENTS.md");
  const lineCount = agents.trimEnd().split(/\r?\n/).length;

  assert.ok(lineCount <= 30, `AGENTS.md should stay at or under 30 lines, got ${lineCount}`);
  assert.match(agents, /dev-loop[\s\S]*single public workflow entrypoint/i);
  assert.match(agents, /dev-loops loop startup/i);
  assert.match(agents, /load only the returned[\s\S]*requiredReads/i);
  assert.match(agents, /skills\/docs\//i);
  assert.doesNotMatch(agents, /Standard refinement chain pattern/i);
  assert.doesNotMatch(agents, /Conductor monitor pattern/i);
  assert.doesNotMatch(agents, /Dev loop defaults/i);
  assert.doesNotMatch(agents, /Formal dev mode vs required post-run retrospective/i);
});
test("refinement docs and prompts wire the optional audit handoff into the refiner chain", async () => {
  // Pre-1.0 config-schema redesign (#1404): the shipped extension-defaults.yaml
  // no longer mirrors this contract under a top-level `personas.audit` entry
  // (removed along with the whole top-level `personas` map — see the
  // coverage-matrix test above); the agent doc is the sole owner of this text.
  const [refinerAgent, localImplementationSkill, issueIntakeDoc] = await Promise.all([
    readRepo("agents/refiner.agent.md"),
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("skills/docs/issue-intake-procedure.md"),
  ]);

  assertMatchesAll(refinerAgent, [
    /When an audit artifact is provided/i,
    /highest-value follow-up candidates/i,
    /scope\/AC/i,
    /DoD/i,
    /explicit non-goal \/ defer|non-goal\/defer/i,
    /risk\/watchpoint/i,
    /not.+rewrite or broaden/i,
  ], "agents/refiner.agent.md");
  assertRuleOwned("REFINER-NO-INVENT-AUDIT-FINDINGS", "agents/refiner.agent.md");
  // Owned-text check — marker survival alone must not mask dropping the no-invent clause.
  assert.match(extractOwnedText(refinerAgent, "REFINER-NO-INVENT-AUDIT-FINDINGS"), /invent audit findings/i);

  assertMatchesAll(localImplementationSkill, [
    /run one bounded audit before variant fan-out/i,
    /tmp\/phases\/phase-x\/audit\/refinement-audit-summary\.json/i,
    /pass a concise audit summary into every refiner briefing/i,
    /highest-value follow-up candidates/i,
    /not.+rewrite or broaden/i,
  ], "skills/local-implementation/SKILL.md");

  assertMatchesAll(issueIntakeDoc, [
    /run the bounded audit first/i,
    /same audit artifact shape/i,
    /tmp\/issues\/issue-<number>\/audit\/refinement-audit-summary\.json/i,
    /translate audit findings into scope, AC\/DoD, risks, and explicit non-goals/i,
    /without silently broadening the issue/i,
  ], "skills/docs/issue-intake-procedure.md");
});

test("coordinator.agent.md does NOT exist as a file", async () => {
  await assert.rejects(
    () => readRepo("agents/coordinator.agent.md"),
    undefined,
    "coordinator.agent.md should not exist"
  );
});
