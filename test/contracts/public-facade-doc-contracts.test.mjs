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
import { fileURLToPath } from "node:url";
import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";
import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";
import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";
import { assertNotRestated, assertRuleOwned, extractOwnedText } from "./_rule-helpers.mjs";

const PUBLIC_CONTRACT_PATH = "skills/docs/public-dev-loop-contract.md";

async function readCopilotFollowupSurface() {
  const [skill, operationsDoc, intakeDoc] = await Promise.all([
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("skills/docs/copilot-loop-operations.md"),
    readRepo("skills/docs/issue-intake-procedure.md"),
  ]);
  return [skill, operationsDoc, intakeDoc].join("\n\n");
}

function assertBundledContractLinks(content, requiredDocs, targets) {
  const links = new Set(extractRelativeMarkdownLinks(content).map(({ rawTarget }) => rawTarget.split("#")[0]));
  for (const doc of requiredDocs) {
    assert.ok(links.has(`../docs/${doc}`), `missing installed contract link: ${doc}`);
    assert.ok(targets.has(`.claude/skills/docs/${doc}`), `missing bundled contract: ${doc}`);
  }
}

test("installed skills reference bundled contracts and own asset-path rules", async () => {
  const [devLoopSkill, copilotFollowupSkill, packageJson] = await Promise.all([
    readRepo("skills/dev-loop/SKILL.md"),
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("package.json"),
  ]);
  const pkg = JSON.parse(packageJson);
  assert.ok(pkg.files.includes("skills/"), "npm must ship the canonical skills subtree");
  assert.ok(pkg.files.includes(".claude/skills/"), "npm must ship the Claude skills subtree");
  assert.ok(pkg.pi.skills.includes("skills"), "Pi must discover the shipped skills subtree");
  const assets = collectGeneratedAssets({ repoRoot: fileURLToPath(fromRepoRoot("")) });
  const targets = new Set(assets.map(({ target }) => target));
  const requiredDocs = [
    "public-dev-loop-contract.md",
    "retrospective-checkpoint-contract.md",
    "issue-intake-procedure.md",
    "copilot-loop-operations.md",
  ];
  for (const [name, source] of [["dev-loop", devLoopSkill], ["copilot-pr-followup", copilotFollowupSkill]]) {
    const generated = assets.find(({ target }) => target === `.claude/skills/${name}/SKILL.md`);
    assert.ok(generated, `missing generated skill: ${name}`);
    const docs = name === "dev-loop" ? ["public-dev-loop-contract.md"] : requiredDocs;
    for (const content of [source, generated.content]) assertBundledContractLinks(content, docs, targets);
  }
  // Ownership and literal restatement are checkable; natural-language meaning remains review work.
  for (const id of ["ASSET-PATH-INSTALLED-NO-ASSUME", "ASSET-PATH-SOURCE-NO-REPO-LOCAL"]) {
    assertRuleOwned(id, "skills/copilot-pr-followup/SKILL.md");
    assertNotRestated(id, [PUBLIC_CONTRACT_PATH, "skills/docs/retrospective-checkpoint-contract.md"]);
  }
});

test("installed contract link checks accept wording changes and reject missing links or bundles", () => {
  const doc = "public-dev-loop-contract.md";
  const targets = new Set([`.claude/skills/docs/${doc}`]);
  for (const content of [
    `Read [Public Dev Loop Contract](../docs/${doc}).`,
    `The installed copy is available here:\n[Routing contract](../docs/${doc}#startup).`,
  ]) assertBundledContractLinks(content, [doc], targets);
  assert.throws(() => assertBundledContractLinks("No contract link.", [doc], targets), /missing installed contract link/);
  assert.throws(() => assertBundledContractLinks(`[Contract](../docs/${doc})`, [doc], new Set()), /missing bundled contract/);
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
  assertRuleOwned("WORKFLOW-DOCS-NO-REDEFINE-HELPER", "docs/IMPLEMENTATION_WORKFLOW.md");
  assert.match(workflowDoc, /WORKFLOW-DOCS-NO-REDEFINE-HELPER/);

  assert.match(scriptsReadme, /code, tests, and the helper entrypoints themselves are authoritative for shipped runtime behavior/i);
  assert.match(scriptsReadme, /this README summarizes those contracts for operators and maintainers; if behavior changes, update the code\/tests and then sync this document/i);

  assert.match(localImplementationSkill, /this skill owns the local phase procedure and artifact discipline/i);
  assert.match(localImplementationSkill, /it does not redefine the shipped runtime semantics of helper CLIs, shared loop logic, or extension commands/i);
});

test("repo docs define dev-loop as the public façade and keep internal routed logic behind it", async () => {
  const [plan, agents, workflowDoc, publicContract, extensionReadme, devLoopSkill, copilotFollowupSkill] = await Promise.all([
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
    ["PLAN.md", plan],
    ["AGENTS.md", agents],
    ["docs/IMPLEMENTATION_WORKFLOW.md", workflowDoc],
  ]) {
    assert.match(content, /`dev-loop`/i, `${label} should mention the public dev-loop entrypoint`);
    assert.match(content, /public/i, `${label} should preserve public-entrypoint framing`);
    assert.match(content, /internal|canonical/i, `${label} should preserve internal/canonical framing`);
  }

  assert.match(extensionReadme, /single public workflow entrypoint/i, "extension README should lead with the public entrypoint");
  assert.doesNotMatch(extensionReadme, /\/skill:copilot-dev-loop|\/skill:copilot-autopilot/i, "extension README should not surface internal seam names as readiness choices");

  assert.match(devLoopSkill, /authoritative contract is \[Public Dev Loop Contract\]\(\.\.\/docs\/public-dev-loop-contract\.md\)/i);
  assert.match(devLoopSkill, /@dev-loops\/core\/loop\/public-dev-loop-routing/i);
  assert.match(devLoopSkill, /summary/i);

  assert.equal(parseFrontmatter(copilotFollowupSkill)["user-invocable"], false);
  assert.ok(extractRelativeMarkdownLinks(copilotFollowupSkill).some(({ rawTarget }) =>
    rawTarget === "../dev-loop/SKILL.md#guard-rules"));
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
  assertRuleOwned("FACADE-COPILOT-INTERNAL-ONLY", PUBLIC_CONTRACT_PATH);
  // Owned-text check — marker survival alone must not mask dropping the internal-only clause.
  assert.match(extractOwnedText(publicContract, "FACADE-COPILOT-INTERNAL-ONLY"), /internal-only behind `dev-loop`/i);
  assertRuleOwned("FACADE-TAXONOMY-DRIFT-TEST", PUBLIC_CONTRACT_PATH);

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
  for (const internalSkillPath of ["skills/copilot-pr-followup/SKILL.md", "skills/local-implementation/SKILL.md", "skills/final-approval/SKILL.md", "skills/pi-session-audit/SKILL.md"]) {
    assert.match(await readRepo(internalSkillPath), /^user-invocable:\s*false\s*$/m);
  }
  assert.equal((await readdir(fromRepoRoot("skills"))).includes("copilot-autopilot"), false);
});

test("status reporting contract requires authoritative state-first resolution and fail-closed reconcile behavior", async () => {
  const [publicContract, copilotFollowupSkill] = await Promise.all([
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readCopilotFollowupSurface(),
  ]);

  assert.match(publicContract, /Authoritative-state-first status reporting contract/i);
  assertRuleOwned("FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED", PUBLIC_CONTRACT_PATH);
  assert.match(publicContract, /resolveAuthoritativeDevLoopStatus/i);
  assert.match(publicContract, /issue↔PR linkage resolution/i);
  assert.match(publicContract, /detect-linked-issue-pr\.mjs/i);

  // Non-owner skills reference the owner rules rather than re-stating the owner's
  // prose. Only the rule-ID references are pinned here; the repeated status-shape
  // ("status/progress/readiness/merge-state/next-step") and reconcile sentences
  // are owned by FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED /
  // FACADE-LINKED-PR-SINGLE-ARTIFACT (asserted above) and guarded against copied
  // restatement by validate-rule-ownership's duplicate-imperative-sentence scan.
  assert.match(copilotFollowupSkill, /FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED/);
  assertRuleOwned("FACADE-LINKED-PR-SINGLE-ARTIFACT", PUBLIC_CONTRACT_PATH);
  assert.match(copilotFollowupSkill, /FACADE-LINKED-PR-SINGLE-ARTIFACT/);
});

test("copilot-pr-followup mandates upsert helper command for gate comments", async () => {
  const copilotFollowupSkill = await readRepo("skills/copilot-pr-followup/SKILL.md");

  assertRuleOwned("COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL", "skills/copilot-pr-followup/SKILL.md");
  assert.match(copilotFollowupSkill, /COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL/);
  assert.match(copilotFollowupSkill, /node\s+<resolved-skill-scripts>\/github\/upsert-checkpoint-verdict\.mjs/i);
  assert.match(copilotFollowupSkill, /--head-sha\s+<current_head_sha>/);
  assert.match(copilotFollowupSkill, /--verdict\s+<clean\|findings_present\|blocked>/);
  assert.match(copilotFollowupSkill, /--gate\s+<draft_gate\|pre_approval_gate>/);
  // The owner above defines helper-only posting. Command/flag wiring is
  // structural evidence; word order cannot prove the agent obeys the ban.
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
  assertRuleOwned("FACADE-CONFLICT-CONTEXT-FAIL-CLOSED", PUBLIC_CONTRACT_PATH);
  assert.match(publicContract, /resolve the conflict locally on the PR branch/i);
  assertRuleOwned("FACADE-CONFLICT-REVALIDATE-NEW-HEAD", PUBLIC_CONTRACT_PATH);
  assert.match(publicContract, /FACADE-CONFLICT-REVALIDATE-NEW-HEAD/);
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
  assertRuleOwned("ARTIFACT-TRACKER-FIRST-NO-DUP", "skills/docs/artifact-authority-contract.md");
  assert.match(publicContract, /ARTIFACT-TRACKER-FIRST-NO-DUP/);
  assert.match(publicContract, /resolve-tracker-local-spec\.mjs/i);

  assert.match(localImplSkill, /Tracker-backed local implementation/i);
  assert.match(localImplSkill, /stays inside the existing `local_implementation` path/i);
  assert.match(localImplSkill, /ARTIFACT-TRACKER-FIRST-NO-DUP/);
  assert.match(localImplSkill, /do not read \[Phase Plan\]\(\.\.\/\.\.\/docs\/phases\/phase-x\.md\) for that same tracker-backed session/i);
  assert.match(localImplSkill, /sync durable scope \/ acceptance \/ status changes back to the tracker issue/i);
  assert.match(localImplSkill, /for tracker-backed sessions, the handoff path is always.*push.*branch.*open.*PR.*merge via GitHub/i);
  assertRuleOwned("LOCAL-TRACKER-NO-DIRECT-MERGE", "skills/local-implementation/SKILL.md");
  assert.match(localImplSkill, /LOCAL-TRACKER-NO-DIRECT-MERGE/);
});

test("both lifecycle gates route to the owned review chain", async () => {
  const skill = await readRepo("skills/copilot-pr-followup/SKILL.md");
  for (const gate of ["Draft gate", "Pre-approval gate"]) {
    const section = parseMarkdownSections(skill).find(({ bodyLines }) =>
      bodyLines.includes(`- **Gate name:** ${gate}`));
    assert.ok(section);
    assert.ok(extractRelativeMarkdownLinks(section.bodyLines.join("\n")).some(({ rawTarget }) =>
      rawTarget === "../docs/gate-review-sub-loop-contract.md"));
  }
  for (const id of ["GATE-EXEC-BUILD-ONCE-SEED", "GATE-EXEC-SEPARATE-CHAINS", "GATE-EXEC-NON-SUBSTITUTION"]) {
    assertRuleOwned(id, "skills/docs/gate-review-sub-loop-contract.md");
  }
  // Context-builder/locality and cross-gate evidence behavior are exercised
  // by write-gate-context, fresh-review-context and checkpoint-evidence tests.
});

function assertDraftBoundary(content) {
  const section = parseMarkdownSections(content).find(({ bodyLines }) =>
    bodyLines.includes("<!-- rule: OPS-DRAFT-FIRST-PR -->"))?.bodyLines.join("\n");
  assert.ok(section, "draft-first owner section must exist");
  const commands = [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  for (const command of ["create-pr.mjs", "--ready", "ready-for-review.mjs"]) {
    assert.ok(commands.includes(command), `missing draft-boundary API: ${command}`);
  }
  // These are API routes, not proof of natural-language MUST/MUST NOT semantics.
  // create-pr and ready-for-review suites exercise draft creation and missing,
  // stale or blocking gate-evidence refusal; agent permission needs review.
}

test("draft-boundary routes tolerate rewritten guidance but not missing APIs or owner markers", async () => {
  const owner = await readRepo("skills/docs/copilot-loop-operations.md");
  assertDraftBoundary(owner.replace("New PRs MUST open", "Every new PR MUST begin")
    .replace("gated on clean draft-gate evidence", "after a clean draft gate"));
  for (const changed of [
    owner.replace("<!-- rule: OPS-DRAFT-FIRST-PR -->", ""),
    owner.replaceAll("`ready-for-review.mjs`", "`different-helper.mjs`"),
  ]) assert.throws(() => assertDraftBoundary(changed));
});

test("skill docs enforce self-assignment and draft-first rules for create commands", async () => {
  const [copilotFollowupSkill, localImplementationSkill, finalApprovalSkill, agents, workflowHandoffTemplate] = await Promise.all([
    readCopilotFollowupSurface(),
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("skills/final-approval/SKILL.md"),
    readRepo("AGENTS.md"),
    readRepo("skills/docs/workflow-handoff-contract.md"),
  ]);

  // copilot-pr-followup routes PR creation through the canonical create-pr wrapper
  assert.match(copilotFollowupSkill, /`node <resolved-skill-scripts>\/github\/create-pr\.mjs/i);
  assert.match(copilotFollowupSkill, /gh issue create --repo <resolved-repo> --assignee @me/i);
  assert.match(copilotFollowupSkill, /node <resolved-skill-scripts>\/github\/create-pr\.mjs --repo <owner\/name> --assignee @me --base <base> --head <head> --title/i);
  assert.doesNotMatch(copilotFollowupSkill, /gh pr create --draft --repo <owner\/name> --assignee @me --base <base> --head <head> --title/i);
  assertRuleOwned("OPS-DRAFT-FIRST-PR", "skills/docs/copilot-loop-operations.md");
  assert.match(copilotFollowupSkill, /OPS-DRAFT-FIRST-PR/);
  assertDraftBoundary(await readRepo("skills/docs/copilot-loop-operations.md"));

  // local-implementation: PRs are always draft and always assigned — self-assigned
  // by default (`--assignee @me`), honoring an explicit assignee — via the canonical wrapper
  assert.match(localImplementationSkill, /always draft and always assigned — self-assigned by default/i);
  assert.match(localImplementationSkill, /workflow\.requireDraftFirst[\s\S]{0,160}dev-loops pr create --assignee @me/i);
  assert.doesNotMatch(localImplementationSkill, /workflow\.requireDraftFirst[\s\S]{0,160}gh pr create --draft --assignee @me/i);
  assertRuleOwned("OPS-DRAFT-FIRST-PR", "skills/docs/copilot-loop-operations.md");
  assert.match(localImplementationSkill, /OPS-DRAFT-FIRST-PR/);

  assert.match(finalApprovalSkill, /redirect/i);
  assert.match(finalApprovalSkill, /Human approval checkpoint/i);
  assert.match(finalApprovalSkill, /Do not restate merge-ready preconditions/i);
  assert.match(agents, /When creating GitHub issues via `gh issue create`, always include `--assignee @me`/i);
  assert.match(agents, /dev-loops pr create \.\.\./i);
  assert.doesNotMatch(agents, /gh issue create` or `gh pr create`/i);
  // Workflow handoff template is now a derivation contract, not a prose dispatch template.
  // Draft-first enforcement lives in AGENTS.md and individual skill docs.
  assert.match(workflowHandoffTemplate, /derivation contract/i);
  assert.match(workflowHandoffTemplate, /buildDevLoopHandoffEnvelope/);
});
