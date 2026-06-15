import {
  assert,
  fromRepoRoot,
  parseFrontmatter,
  readRepo,
  readdir,
  stat,
  test,
  USER_FACING_AGENT_SURFACE,
} from "../imported-assets-helpers.mjs";

async function readCopilotFollowupSurface() {
  const [skill, operationsDoc, intakeDoc] = await Promise.all([
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("skills/docs/copilot-loop-operations.md"),
    readRepo("skills/docs/issue-intake-procedure.md"),
  ]);
  return [skill, operationsDoc, intakeDoc].join("\n\n");
}

test("installed skill guidance owns packaging guarantees and contract docs stay contract-focused", async () => {
  const [devLoopSkill, copilotFollowupSkill, publicContract, retrospectiveContract] = await Promise.all([
    readRepo("skills/dev-loop/SKILL.md"),
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("skills/docs/retrospective-checkpoint-contract.md"),
  ]);

  assert.match(devLoopSkill, /Required installed runtime contract docs/i);
  assert.match(devLoopSkill, /shared bundled copies under `\.\.\/docs\/` from this skill directory/i);
  assert.match(devLoopSkill, /read those bundled `\.\.\/docs\/` files from the installed skill layout/i);
  assert.match(devLoopSkill, /packaging\/installer bug/i);

  assert.match(copilotFollowupSkill, /Required bundled runtime contract docs for installed copies of this skill/i);
  assert.match(copilotFollowupSkill, /required bundled contract docs live under the shared `\.\.\/docs\/` directory next to the installed skill directories/i);
  assert.match(copilotFollowupSkill, /do not assume helper scripts are bundled unless that installed layout actually contains them/i);
  assert.match(copilotFollowupSkill, /Read those bundled `\.\.\/docs\/` files from the installed skill layout/i);
  assert.match(copilotFollowupSkill, /packaging\/installer bug/i);
  assert.match(publicContract, /canonical owner lives in the shipped `skills\/docs\/` surface/i);
  assert.match(publicContract, /installed skill\/runtime consumers reliably own the skills subtree/i);
  assert.match(publicContract, /read the same contract via \[Public Dev Loop Contract\]\(\.\.\/docs\/public-dev-loop-contract\.md\) from the installed skill directory/i);

  for (const [label, content] of [
    ["skills/docs/public-dev-loop-contract.md", publicContract],
    ["skills/docs/retrospective-checkpoint-contract.md", retrospectiveContract],
  ]) {
    assert.doesNotMatch(content, /Packaged \/ installed skill use|Packaged \/ installed agent use/i, `${label} should not restate the shared install contract block`);
    assert.doesNotMatch(content, /required runtime contract doc for installed/i, `${label} should not duplicate install-contract ownership prose`);
    assert.doesNotMatch(content, /source-tree canonical ownership/i, `${label} should not duplicate install-contract ownership prose`);
    assert.doesNotMatch(content, /shared installed copy resolved as `\.\.\/docs\//i, `${label} should not duplicate install-contract ownership prose`);
    assert.doesNotMatch(content, /packaging\/installer bug/i, `${label} should not duplicate install-contract ownership prose`);
  }
});

test("root docs path does not become a second semantic owner for the public dev-loop contract", async () => {
  const rootContractPath = fromRepoRoot("docs/public-dev-loop-contract.md");
  const rootContractExists = await stat(rootContractPath).then(() => true).catch(() => false);

  if (!rootContractExists) {
    return;
  }

  const rootContract = await readRepo("docs/public-dev-loop-contract.md");
  assert.match(rootContract, /skills\/docs\/public-dev-loop-contract\.md/i);
  assert.doesNotMatch(rootContract, /canonical authority/i);
  assert.doesNotMatch(rootContract, /canonical public-contract owner/i);
  assert.match(rootContract, /pointer|summary|summarize|summarise/i);
  assert.match(rootContract, /must not redefine/i);
});

test("workflow docs keep helper/runtime authority code-owned and dev-loop scope procedure-owned", async () => {
  const [workflowDoc, scriptsReadme, localImplementationSkill] = await Promise.all([
    readRepo("docs/IMPLEMENTATION_WORKFLOW.md"),
    readRepo("scripts/README.md"),
    readRepo("skills/local-implementation/SKILL.md"),
  ]);

  assert.match(workflowDoc, /shipped helper\/runtime semantics stay owned by code, tests, and the relevant contract docs/i);
  assert.match(workflowDoc, /\[Scripts Documentation\]\(\.\.\/scripts\/README\.md\) summarizes those semantics/i);
  assert.match(workflowDoc, /state-graph\/contract docs under `docs\/` remain part of the authoritative shipped contract surface/i);
  assert.match(workflowDoc, /skills and phase docs explain workflow procedure and durable planning intent; they must not silently redefine shipped helper behavior/i);

  assert.match(scriptsReadme, /code, tests, and the helper entrypoints themselves are authoritative for shipped runtime behavior/i);
  assert.match(scriptsReadme, /this README summarizes those contracts for operators and maintainers; if behavior changes, update the code\/tests and then sync this document/i);

  assert.match(localImplementationSkill, /this skill owns the local phase procedure and artifact discipline/i);
  assert.match(localImplementationSkill, /it does not redefine the shipped runtime semantics of helper CLIs, shared loop logic, or extension commands/i);
});

test("README stays a landing page and lets docs/index own deeper doc navigation", async () => {
  const readme = await readRepo("README.md");

  assert.doesNotMatch(readme, /^## Current status$/im, "README should not become a second owner for the live execution snapshot");
  assert.match(readme, /docs\/index\.md/i, "README should point readers to the docs index");
  assert.doesNotMatch(readme, /docs\/IMPLEMENTATION_STATE\.md/i, "README should not duplicate docs/index deep links for the implementation snapshot");
  assert.doesNotMatch(readme, /docs\/IMPLEMENTATION_WORKFLOW\.md/i, "README should not duplicate docs/index deep links for workflow docs");
  assert.match(readme, /shared Pi workflow infrastructure/i, "README should describe the repo as shared Pi workflow infrastructure");
});

test("repo docs define dev-loop as the public façade and keep internal routed logic behind it", async () => {
  const [readme, plan, agents, workflowDoc, publicContract, extensionReadme, devLoopSkill, copilotFollowupSkill] = await Promise.all([
    readRepo("README.md"),
    readRepo("PLAN.md"),
    readRepo("AGENTS.md"),
    readRepo("docs/IMPLEMENTATION_WORKFLOW.md"),
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("extension/README.md"),
    readRepo("skills/dev-loop/SKILL.md"),
    readCopilotFollowupSurface(),
  ]);

  assert.match(publicContract, /single public entrypoint/i);
  assert.match(publicContract, /subagent dev-loop/i);
  assert.match(publicContract, /\/skill:dev-loop/i);
  assert.match(publicContract, /canonical current state/i);
  assert.match(publicContract, /issue_intake/i);
  assert.match(publicContract, /copilot_pr_followup/i);
  assert.match(publicContract, /external_pr_followup/i);
  assert.match(publicContract, /Single-entrypoint convergence posture/i);
  assert.match(publicContract, /Surfaced-UX deprecation readiness bar/i);

  for (const [label, content] of [
    ["README.md", readme],
    ["PLAN.md", plan],
    ["AGENTS.md", agents],
    ["docs/IMPLEMENTATION_WORKFLOW.md", workflowDoc],
  ]) {
    assert.match(content, /`dev-loop`/i, `${label} should mention the public dev-loop entrypoint`);
    assert.match(content, /public/i, `${label} should preserve public-entrypoint framing`);
    assert.match(content, /internal|canonical/i, `${label} should preserve internal/canonical framing`);
  }

  assert.match(readme, /single public façade/i, "README should lead with dev-loop as the public façade");
  assert.doesNotMatch(readme, /`copilot-dev-loop` as the/i, "README should not present internal seams as workflow-surface choices");
  assert.doesNotMatch(readme, /`copilot-autopilot` as the/i, "README should not present internal seams as workflow-surface choices");
  assert.match(extensionReadme, /single public workflow entrypoint/i, "extension README should lead with the public entrypoint");
  assert.doesNotMatch(extensionReadme, /\/skill:copilot-dev-loop|\/skill:copilot-autopilot/i, "extension README should not surface internal seam names as readiness choices");

  assert.match(devLoopSkill, /authoritative contract is \[Public Dev Loop Contract\]\(\.\.\/docs\/public-dev-loop-contract\.md\)/i);
  assert.match(devLoopSkill, /@dev-loops\/core\/loop\/public-dev-loop-routing/i);
  assert.match(devLoopSkill, /summary/i);

  assert.match(copilotFollowupSkill, /canonical internal/i, "skills/copilot-pr-followup/SKILL.md should preserve canonical-internal framing");
  assert.match(copilotFollowupSkill, /public `dev-loop`/i, "skills/copilot-pr-followup/SKILL.md should point back to the public dev-loop façade");
});

test("workflow-surface taxonomy stays explicit and guards the entrypoint asset surface", async () => {
  const [publicContract, devLoopAgent] = await Promise.all([
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("agents/dev-loop.agent.md"),
  ]);

  assert.match(publicContract, /Workflow-surface taxonomy and guardrails/i);
  assert.match(publicContract, /Public workflow entrypoint/i);
  assert.match(publicContract, /Internal routed strategy modules/i);
  assert.match(publicContract, /Reusable role agents/i);
  assert.match(publicContract, /specialized Copilot behavior stays internal-only behind `dev-loop`/i);
  assert.match(publicContract, /Regression tests must fail if this taxonomy drifts/i);

  assert.match(devLoopAgent, /single public workflow entrypoint/i);

  const agentFiles = (await readdir(fromRepoRoot("agents")))
    .filter((name) => name.endsWith(".agent.md"))
    .sort();
  const agentEntries = await Promise.all(agentFiles.map(async (file) => {
    const content = await readRepo(`agents/${file}`);
    const frontmatter = parseFrontmatter(content);
    return {
      file,
      content,
      name: frontmatter.name,
      userInvocable: frontmatter["user-invocable"] === true,
    };
  }));
  const userFacingAgents = agentEntries
    .filter(({ userInvocable }) => userInvocable)
    .sort((a, b) => a.name.localeCompare(b.name));
  const allowedUserFacingAgentNames = Object.keys(USER_FACING_AGENT_SURFACE).sort();

  assert.deepEqual(
    userFacingAgents.map(({ name }) => name).sort(),
    allowedUserFacingAgentNames,
    "user-facing agent surface should stay explicitly allow-listed by frontmatter name",
  );

  const workflowEntrypointAgents = userFacingAgents
    .filter(({ name }) => USER_FACING_AGENT_SURFACE[name]?.kind === "workflow-entrypoint")
    .map(({ name }) => name)
    .sort();
  const roleAgentFiles = agentEntries
    .filter(({ name }) => USER_FACING_AGENT_SURFACE[name]?.kind !== "workflow-entrypoint")
    .map(({ file }) => file)
    .sort();

  assert.deepEqual(workflowEntrypointAgents, ["dev-loop"]);
  assert.equal(agentFiles.includes("copilot-dev-loop.agent.md"), false);
  assert.equal(agentFiles.includes("copilot-autopilot.agent.md"), false);

  for (const roleAgentFile of roleAgentFiles) {
    const content = await readRepo(`agents/${roleAgentFile}`);
    assert.doesNotMatch(content, /public workflow entrypoint/i, `${roleAgentFile} should stay a reusable role agent`);
  }

  const userInvocableSkillEntrypoints = [];
  for (const skillDir of (await readdir(fromRepoRoot("skills"))).sort().filter((name) => !name.startsWith("."))) {
    if (skillDir === "docs") {
      continue;
    }
    const content = await readRepo(`skills/${skillDir}/SKILL.md`);
    if (/^user-invocable:\s*true\s*$/m.test(content)) {
      userInvocableSkillEntrypoints.push(skillDir);
    }
  }
  assert.deepEqual(userInvocableSkillEntrypoints, ["dev-loop"]);
  for (const internalSkillPath of ["skills/copilot-pr-followup/SKILL.md", "skills/local-implementation/SKILL.md", "skills/final-approval/SKILL.md"]) {
    assert.match(await readRepo(internalSkillPath), /^user-invocable:\s*false\s*$/m);
  }
  assert.equal((await readdir(fromRepoRoot("skills"))).includes("copilot-autopilot"), false);
});

test("status reporting contract requires authoritative state-first resolution and fail-closed reconcile behavior", async () => {
  const [publicContract, devLoopSkill, copilotFollowupSkill] = await Promise.all([
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("skills/dev-loop/SKILL.md"),
    readCopilotFollowupSurface(),
  ]);

  assert.match(publicContract, /Authoritative-state-first status reporting contract/i);
  assert.match(publicContract, /fail closed to reconcile\/unknown instead of guessing/i);
  assert.match(publicContract, /resolveAuthoritativeDevLoopStatus/i);
  assert.match(publicContract, /issue↔PR linkage resolution/i);
  assert.match(publicContract, /detect-linked-issue-pr\.mjs/i);

  assert.match(devLoopSkill, /status\/progress\/readiness\/merge-state\/next-step/i);
  assert.match(devLoopSkill, /fail closed to reconcile\/unknown/i);
  assert.match(devLoopSkill, /identity resolution is handled by the startup resolver/i);
  // detect-linked-issue-pr.mjs reference removed — main agent no longer runs startup resolver

  assert.match(copilotFollowupSkill, /status\/progress\/readiness\/merge-state\/next-step/i);
  assert.match(copilotFollowupSkill, /reconcile\/unknown instead of guessing from chat context/i);
  assert.match(copilotFollowupSkill, /do not assert "no open PR" until authoritative issue↔PR linkage is resolved/i);
  assert.match(publicContract, /only canonical active artifact for the issue during follow-up/i);
  assert.match(devLoopSkill, /single canonical artifact for the issue and reuse it instead of opening another PR/i);
  assert.match(copilotFollowupSkill, /do not open another PR unless the prior PR was explicitly superseded and reconciled first/i);
  assert.match(copilotFollowupSkill, /reuse\/update that canonical PR instead of opening another one/i);
});

test("copilot-pr-followup mandates upsert helper command for gate comments", async () => {
  const copilotFollowupSkill = await readRepo("skills/copilot-pr-followup/SKILL.md");

  assert.match(copilotFollowupSkill, /For every `draft_gate` or `pre_approval_gate` comment, you MUST run:/);
  assert.match(copilotFollowupSkill, /node\s+<resolved-skill-scripts>\/github\/upsert-checkpoint-verdict\.mjs/i);
  assert.match(copilotFollowupSkill, /--head-sha\s+<current_head_sha>/);
  assert.match(copilotFollowupSkill, /--verdict\s+<clean\|findings_present\|blocked>/);
  assert.match(copilotFollowupSkill, /--gate\s+<draft_gate\|pre_approval_gate>/);
  assert.match(copilotFollowupSkill, /Do NOT use `gh pr comment`, `gh api`, or `gh pr review` for gate comments\./);
  assert.match(copilotFollowupSkill, /Do NOT use.*gh pr comment.*gh pr review.*gate comments.*upsert-checkpoint-verdict/i);
});

test("public dev-loop contract keeps conflict reconciliation local and context-first", async () => {
  const publicContract = await readRepo("skills/docs/public-dev-loop-contract.md");

  assert.match(publicContract, /Conflict reconciliation path \(`CONFLICTING` \/ `DIRTY`\)/i);
  assert.match(publicContract, /bounded local-agent reconciliation path/i);
  assert.match(publicContract, /retrieve authoritative context at minimum:/i);
  assert.match(publicContract, /latest `origin\/main`/i);
  assert.match(publicContract, /current PR head SHA and effective PR diff/i);
  assert.match(publicContract, /issue\/PR scope and acceptance criteria/i);
  assert.match(publicContract, /current-head gate evidence and relevant unresolved review feedback/i);
  assert.match(publicContract, /if required authoritative context is missing, stale for the current head, or contradictory, fail closed to reconcile/i);
  assert.match(publicContract, /resolve the conflict locally on the PR branch/i);
  assert.match(publicContract, /rerun required local validation, gate checks, and required CI checks for the new head before approval\/merge evaluation/i);
  assert.doesNotMatch(publicContract, /resolve the conflict .*blind merge\/update step/i);
});

test("public dev-loop contract keeps tracker-backed local work inside local_implementation", async () => {
  const [publicContract, localImplSkill] = await Promise.all([
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("skills/local-implementation/SKILL.md"),
  ]);

  assert.match(publicContract, /Tracker-backed local implementation input-source contract/i);
  assert.match(publicContract, /input-source addition to the existing `local_implementation` strategy/i);
  assert.match(publicContract, /does \*\*not\*\* create a new routing mode/i);
  assert.match(publicContract, /tracker issue is canonical/i);
  assert.match(publicContract, /`docs\/phases\/phase-<n>\.md` must not exist for that same session/i);
  assert.match(publicContract, /resolve-tracker-local-spec\.mjs/i);

  assert.match(localImplSkill, /Tracker-backed local implementation/i);
  assert.match(localImplSkill, /stays inside the existing `local_implementation` path/i);
  assert.match(localImplSkill, /do not create or read \[Phase Plan\]\(\.\.\/\.\.\/docs\/phases\/phase-x\.md\) for that same tracker-backed session/i);
  assert.match(localImplSkill, /sync durable scope \/ acceptance \/ status changes back to the tracker issue/i);
  assert.match(localImplSkill, /for tracker-backed sessions, the handoff path is always.*push.*branch.*open.*PR.*merge via GitHub/i);
  assert.match(localImplSkill, /do not suggest a direct local-main merge/i);
  assert.match(localImplSkill, /do not merge the working branch into local `main` at phase completion/i);
});

test("checkpoint review chain contract exists and is referenced by both gates", async () => {
  const [subLoopContract, copilotFollowupSkill] = await Promise.all([
    readRepo("docs/gate-review-sub-loop-contract.md"),
    readRepo("skills/copilot-pr-followup/SKILL.md"),
  ]);

  // Contract doc prescribes the 5 sub-loop phases
  assert.match(subLoopContract, /context-builder/i);
  assert.match(subLoopContract, /fork fan-out/i);
  assert.match(subLoopContract, /fan-in.*synthesis/i);
  assert.match(subLoopContract, /fix/i);
  assert.match(subLoopContract, /repeat until clean/i);

  // References pi-subagents parallel context-build technique
  assert.match(subLoopContract, /parallel context-build/i);

  // Worktree prescribed but not hard-required
  assert.match(subLoopContract, /worktree.*recommended/i);
  assert.match(subLoopContract, /do not fail closed if worktrees are unavailable/i);

  // Machine-parseable fields
  assert.match(subLoopContract, /subLoopPhases/i);
  assert.match(subLoopContract, /contextBuilderRequired/i);
  assert.match(subLoopContract, /worktreeRecommended/i);
  assert.match(subLoopContract, /fixRetryUntilClean/i);

  // Draft gate references the sub-loop contract
  assert.match(copilotFollowupSkill, /gate-review-sub-loop-contract\.md.*draft gate/i);

  // Pre-approval gate references the sub-loop contract
  assert.match(copilotFollowupSkill, /gate-review-sub-loop-contract\.md.*pre-approval/i);

  // Contract owns execution shape, not review angles
  assert.match(subLoopContract, /execution shape/i);
  assert.match(subLoopContract, /does not own/i);

  // Non-substitution rule between gates
  assert.match(subLoopContract, /does not satisfy the other gate/i);
});

test("skill docs enforce self-assignment and draft-first rules for create commands", async () => {
  const [copilotFollowupSkill, localImplementationSkill, finalApprovalSkill, agents, workflowHandoffTemplate, trackerStoryPrContract] = await Promise.all([
    readCopilotFollowupSurface(),
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("skills/final-approval/SKILL.md"),
    readRepo("AGENTS.md"),
    readRepo("skills/docs/workflow-handoff-contract.md"),
    readRepo("docs/tracker-story-pr-contract.md"),
  ]);

  // copilot-pr-followup routes PR creation through the draft wrapper
  assert.match(copilotFollowupSkill, /MUST use `node <resolved-skill-scripts>\/github\/create-draft-pr\.mjs/i);
  assert.match(copilotFollowupSkill, /gh issue create --repo <resolved-repo> --assignee @me/i);
  assert.match(copilotFollowupSkill, /node <resolved-skill-scripts>\/github\/create-draft-pr\.mjs --repo <owner\/name> --assignee @me --base <base> --head <head> --title/i);
  assert.doesNotMatch(copilotFollowupSkill, /gh pr create --draft --repo <owner\/name> --assignee @me --base <base> --head <head> --title/i);
  assert.match(copilotFollowupSkill, /New PRs in this workflow must be opened as \*\*draft\*\* PRs first/i);
  assert.match(copilotFollowupSkill, /Do not create a fresh PR directly in ready-for-review state/i);
  assert.match(copilotFollowupSkill, /draft gate inspection is a real workflow boundary/i);

  // local-implementation keeps self-assignment unconditional and draft-first config-driven via the wrapper
  assert.match(localImplementationSkill, /PR creation must always include `--assignee @me`/i);
  assert.match(localImplementationSkill, /workflow\.requireDraftFirst[\s\S]{0,160}dev-loops pr create-draft --assignee @me/i);
  assert.doesNotMatch(localImplementationSkill, /workflow\.requireDraftFirst[\s\S]{0,160}gh pr create --draft --assignee @me/i);
  assert.match(localImplementationSkill, /Do not create a fresh PR directly in ready-for-review state/i);
  assert.match(localImplementationSkill, /draft gate inspection is a real workflow boundary/i);

  assert.match(finalApprovalSkill, /redirect/i);
  assert.match(finalApprovalSkill, /Human approval checkpoint/i);
  assert.match(finalApprovalSkill, /Do not restate merge-ready preconditions/i);
  assert.match(agents, /When creating GitHub issues via `gh issue create`, always include `--assignee @me`/i);
  assert.match(agents, /dev-loops pr create-draft --assignee @me/i);
  assert.doesNotMatch(agents, /gh issue create` or `gh pr create`/i);
  // Workflow handoff template is now a derivation contract, not a prose dispatch template.
  // Draft-first enforcement lives in AGENTS.md and individual skill docs.
  assert.match(workflowHandoffTemplate, /derivation contract/i);
  assert.match(workflowHandoffTemplate, /buildDevLoopHandoffEnvelope/);
  // tracker-story-pr-contract.md is now a thin pointer; verify pointer, content in copilot-review-doc-contracts
  assert.match(trackerStoryPrContract, /Canonical location:/i);
  assert.match(trackerStoryPrContract, /tracker-first-loop-state\.md/i);
  assert.doesNotMatch(trackerStoryPrContract, /gh pr create --draft --assignee @me/i);
});
