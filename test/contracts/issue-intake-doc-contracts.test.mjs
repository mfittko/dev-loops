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
import { assertRuleOwned, extractOwnedText } from "./_rule-helpers.mjs";

const PUBLIC_CONTRACT_PATH = "skills/docs/public-dev-loop-contract.md";

async function readIssueIntakeSurface() {
  const [skill, intakeDoc, operationsDoc] = await Promise.all([
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("skills/docs/issue-intake-procedure.md"),
    readRepo("skills/docs/copilot-loop-operations.md"),
  ]);
  return [skill, intakeDoc, operationsDoc].join("\n\n");
}

test("issue-intake surface still contains its core workflow guidance", async () => {
  const content = await readIssueIntakeSurface();

  // Required startup reads now references entrypoint briefing first
  assert.match(content, /entrypoint briefing/i);
  assert.match(content, /Read.*contract docs needed for the current step/i);
  assert.match(content, /Skill asset path resolution/);
  assertRuleOwned("ASSET-PATH-SOURCE-NO-REPO-LOCAL", "skills/copilot-pr-followup/SKILL.md");
  assert.match(content, /ASSET-PATH-SOURCE-NO-REPO-LOCAL/);
  assert.match(content, /source-repo helper scripts live two levels up at `\.\.\/\.\.\/scripts\/`/i);
  assert.match(content, /Before any GitHub mutation/);
  assert.match(content, /Preferred defaults for this repo:/);
  // Validation policy now in canonical doc; skill references it
  assert.match(content, /Validation Policy|validation policy/i);
  // Reviewer context rules now owned by gate-review-sub-loop-contract.md; skill references it
  assert.match(content, /Gate Review Sub-Loop Contract/i);
  assert.match(content, /checkpoint review chain/i);
});

test("issue-intake surface requires github reply/resolve follow-up and gates waiting on confirmed review-request state", async () => {
  const content = await readIssueIntakeSurface();

  assert.match(content, /reply\/resolve work is done for the addressed threads/);
  assert.match(content, /if that local validation is still known red, continue remediation instead of re-requesting Copilot/);
  assert.match(content, /if GitHub CI\/checks for the updated head are known red for a fixable issue, continue remediation instead of re-requesting Copilot/);
  // The green/credibly-green re-request gating is its own normative rule
  // (owned in the same skill file); loose token instead of the full sentence.
  assertRuleOwned("COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE", "skills/copilot-pr-followup/SKILL.md");
  assert.match(content, /COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE/);
  // Owned-text check — marker survival alone must not mask dropping the CI-gating clause.
  assert.match(
    extractOwnedText(await readRepo("skills/copilot-pr-followup/SKILL.md"), "COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE"),
    /green or credibly green/i,
  );
  assert.match(content, /explicitly re-request Copilot review for the new head/i);
  assert.match(content, /wait\/watch loop if the request result is confirmed as `requested` or `already-requested`/);
  assert.match(content, /`requested`: if another Copilot pass is actually desired, immediately re-baseline/i);
  assert.match(content, /`already-requested`: apply the same detector-first rebasing and wait branching as `requested`/i);
  assert.match(content, /`unavailable`: report the limitation and stop/);
  assert.match(content, /stop and report the error rather than (?:entering a sleep\/watch loop|sleeping and hoping for a new review)/);
  // GitHub-autolink backtick formatting is elaboration of the reply-resolve
  // mechanism owned by COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER in this same
  // skill file; loose tokens instead of the full formatting sentences (#1205).
  assertRuleOwned("COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER", "skills/copilot-pr-followup/SKILL.md");
  assert.match(content, /keep commit SHAs and issue\/PR refs as plain text/i);
  assert.match(content, /do not wrap them in backticks/i);
});

test("fixer agent documentation includes GitHub autolink guidance", async () => {
  const content = await readRepo("agents/fixer.agent.md");

  assert.match(content, /keep commit SHAs and issue\/PR refs unwrapped/i);
  assert.match(content, /intent is GitHub autolinks/i);
  assert.match(content, /reserve backticks for actual code\/path\/CLI literals/i);
});

test("issue-intake surface forbids detached bash watcher loops for async follow-up", async () => {
  const content = await readIssueIntakeSurface();

  assert.match(content, /Pi async subagent|designated async follow-up skill/);
  // The detached-watcher prohibition is elaboration of COPILOT-FOLLOWUP-WAIT-TOOLS
  // (owned in the same skill file); loose token instead of the full enumerated
  // CLI-list sentence (#1205).
  assertRuleOwned("COPILOT-FOLLOWUP-WAIT-TOOLS", "skills/copilot-pr-followup/SKILL.md");
  assert.match(content, /agent-authored shell polling is forbidden/i);
  assert.match(content, /stop and report rather than improvising a shell watcher/);
});

test("issue-intake surface requires unattended resume-from-state behavior when authorized", async () => {
  const content = await readIssueIntakeSurface();

  assert.match(content, /unattended execution/i);
  assert.match(content, /automatically detect the current lifecycle entrypoint/i);
  assert.match(content, /deterministic helper\/state-machine surface/i);
  assert.match(content, /If a PR already exists, classify the post-assignment seam before follow-up/i);
  assert.match(content, /waiting_for_initial_copilot_implementation.*keep waiting/i);
  assert.match(content, /linked_pr_ready_for_followup.*route to the existing PR follow-up path immediately/i);
  assertRuleOwned("FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION", PUBLIC_CONTRACT_PATH);
  assert.match(content, /linked_pr_ready_for_followup[\s\S]*FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION/i);
  assert.match(content, /safe isolated checkout\/worktree/i);
  assert.match(content, /When the draft PR appears, classify whether it is still the bootstrap-only Copilot draft/i);
  assert.match(content, /child async run exits[\s\S]*non-terminal[\s\S]*waiting_for_copilot_review/i);
  assert.match(content, /automatically resume\/restart follow-up when continuation is feasible/i);
  assertRuleOwned("OPS-DRAFT-FIRST-PR", "skills/docs/copilot-loop-operations.md");
  assert.match(content, /OPS-DRAFT-FIRST-PR/);
  assert.match(content, /node <resolved-skill-scripts>\/github\/create-pr\.mjs --repo <owner\/name> --assignee @me --base <base> --head <head> --title/i);
  assert.doesNotMatch(content, /gh pr create --draft --repo <owner\/name> --assignee @me --base <base> --head <head> --title/i);
  assert.match(content, /pre-existing PR.*not.*stop-by-default condition/is);
  assert.match(content, /continue unattended until the human approval checkpoint/i);
  assert.match(content, /stop for a human approval decision by default/i);
  assert.match(content, /waiting_for_merge_authorization/i);
  assert.match(content, /does \*\*not\*\* imply unattended merge by default/i);
  assert.match(content, /materially unclear, contradictory, off-trail/i);
  assert.match(content, /stop and ask for human direction rather than guessing/i);
  assert.match(content, /local facts, GitHub facts, and helper\/state-machine output do not agree/i);
});

test("issue-intake behavior remains internal and resumable behind dev-loop", async () => {
  const content = await readIssueIntakeSurface();
  const agentFiles = (await readdir(fromRepoRoot("agents")))
    .filter((name) => name.endsWith(".agent.md"))
    .sort();

  assert.equal(agentFiles.includes("copilot-autopilot.agent.md"), false);
  assert.match(content, /unattended execution/i);
  assert.match(content, /automatically detect the current lifecycle entrypoint/i);
  assert.match(content, /deterministic helper\/state-machine surface/i);
  assert.match(content, /stop for a human approval decision by default/i);
  assert.match(content, /waiting_for_merge_authorization/i);
  assert.match(content, /materially unclear, contradictory, off-trail/i);
  assert.match(content, /stop and ask for human direction rather than guessing/i);
  assert.match(content, /local facts, GitHub facts, and helper\/state-machine output do not agree/i);
});

test("issue-based shorthand auto dev-loop trigger is documented as one public intent through the human approval checkpoint", async () => {
  const [publicContract, devLoopSkill, issueIntakeSkill, devLoopAgent] = await Promise.all([
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("skills/dev-loop/SKILL.md"),
    readIssueIntakeSurface(),
    readRepo("agents/dev-loop.agent.md"),
  ]);

  for (const content of [publicContract, devLoopSkill, issueIntakeSkill, devLoopAgent]) {
    assert.match(content, /auto dev loop on issue/i);
  }

  assert.match(publicContract, /Issue-based shorthand auto trigger contract/i);
  assert.match(publicContract, /resolves to the same bounded public `dev-loop` intent/i);
  assert.match(publicContract, /`dev-loop --intent auto_continue_current`/i);
  assert.match(publicContract, /stop at the final human approval decision by default/i);
  assert.match(publicContract, /waiting_for_merge_authorization/i);
  assertRuleOwned("FACADE-BOOTSTRAP-WATCH-ROUTE", PUBLIC_CONTRACT_PATH);
  assertRuleOwned("FACADE-BOOTSTRAP-QUIET-NO-EJECT", PUBLIC_CONTRACT_PATH);
  assertRuleOwned("FACADE-BOOTSTRAP-FOLLOWUP-REENTRY", PUBLIC_CONTRACT_PATH);
  assertRuleOwned("FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION", PUBLIC_CONTRACT_PATH);
  assert.match(publicContract, /non-terminal follow-up\/wait states[\s\S]*waiting_for_copilot_review[\s\S]*continuation boundaries/i);
  assert.match(publicContract, /async child exits before the requested stop boundary[\s\S]*re-dispatch via the main session driver/i);
  assert.match(publicContract, /R --> A\[Human approval checkpoint\]/i);
  assert.match(publicContract, /R --> M\[Wait for merge authorization\]/i);

  assert.match(devLoopSkill, /Shorthand issue-based auto trigger contract/i);
  assert.match(devLoopSkill, /public `dev-loop` intent `auto_continue_current`/i);
  assert.match(devLoopSkill, /stop at the human approval checkpoint by default/i);

  assert.match(issueIntakeSkill, /Issue-first shorthand such as `auto dev loop on issue <n>`/i);
  assert.match(issueIntakeSkill, /preserve this same stop boundary and human approval checkpoint default/i);
  assert.match(issueIntakeSkill, /waiting_for_merge_authorization/i);
  assert.match(issueIntakeSkill, /after approval, report `waiting_for_merge_authorization` and stop again/i);
  assert.doesNotMatch(issueIntakeSkill, /Only when merge has been explicitly authorized for this issue\/PR scope:/i);

  assert.match(devLoopAgent, /Interpret issue-based shorthand triggers/i);
  assert.match(devLoopAgent, /not a second public workflow entrypoint/i);
});



test("issue-intake surface requires persistent copilot follow-up loop and capped watch timeout", async () => {
  const content = await readIssueIntakeSurface();

  assert.match(
    content,
    /PERSISTENCE MODEL: Subagents do bounded implementation tasks and exit on external wait. The main session drives the loop and re-dispatches when continuation is feasible./i,
  );
  assert.match(
    content,
    /watch → detect → if threads found, fix \+ reply \+ resolve → re-request → watch again/i,
  );
  assert.match(content, /30 minutes[\s\S]*COPILOT_REVIEW_WAIT_TIMEOUT_MS/i);
  assert.match(
    content,
    /watch timeout\s+[—-]\s+PR #<number> needs manual attention/i,
  );
});

test("issue-intake surface keeps issue refinement separate from the phase-scoped refiner and explains thin entrypoint agents", async () => {
  const skillContent = await readIssueIntakeSurface();
  const planContent = await readRepo("PLAN.md");
  const agentFiles = (await readdir(fromRepoRoot("agents")))
    .filter((name) => name.endsWith(".agent.md"))
    .sort();

  assert.doesNotMatch(skillContent, /ask the refiner to emit/i);
  assert.equal(agentFiles.includes("copilot-autopilot.agent.md"), false);
  assert.match(skillContent, /issue-refinement specialist/i);
  assert.match(planContent, /Thin workflow entrypoint agents are still allowed/i);
  assert.match(planContent, /must stay thin, defer sequencing and workflow policy to the skill/i);
});

test("issue-intake normalization docs require issue state checks and avoid the stale top-level-workflow roadmap question", async () => {
  const skillContent = await readIssueIntakeSurface();
  const planContent = await readRepo("PLAN.md");

  assert.match(skillContent, /node scripts\/github\/view-issue\.mjs --repo <(?:owner\/name|resolved-repo)> --issue <number> --json number,title,body,state,labels,assignees,milestone/);
  assert.match(skillContent, /If a matching issue exists:[\s\S]*if the matching issue is closed, stop for a user decision[\s\S]*if a PR already exists, classify bootstrap-wait versus follow-up/i);
  assert.doesNotMatch(planContent, /remain a mode of `copilot-dev-loop`, or become a separate top-level workflow/i);
});

test("issue-intake docs cover issue URLs, state-all issue search, and abstract ideas without plan docs", async () => {
  const skillContent = await readIssueIntakeSurface();

  assert.match(skillContent, /if the input is a full GitHub issue URL, parse `<owner\/name>` and `<number>`/i);
  assert.match(skillContent, /node scripts\/github\/view-issue\.mjs --repo <owner\/name> --issue <number> --json number,title,body,state,labels,assignees,milestone/);
  assert.match(skillContent, /gh issue list --repo <resolved-repo> --state all --search/);
  assert.match(skillContent, /if a governing plan doc or roadmap section actually applies, follow the plan-doc normalization path above/i);
  assert.match(skillContent, /otherwise search existing issues directly/i);
  assert.match(skillContent, /if a matching issue exists, follow the issue-number\/URL normalization path/i);
});

test("issue-intake flow carries the resolved repo slug through later GitHub issue and PR commands", async () => {
  const skillContent = await readIssueIntakeSurface();

  assert.match(skillContent, /Carry that resolved repo slug through every later GitHub issue\/PR command/i);
  assert.match(skillContent, /gh issue create --repo <resolved-repo> --assignee @me/);
  assert.match(skillContent, /dev-loops issue edit --repo <resolved-repo> --issue <number> --body-file <updated-body-file>/);
  assert.match(skillContent, /dev-loops issue edit --repo <resolved-repo> --issue <number> --add-assignee copilot-swe-agent/);
  assert.match(skillContent, /gh pr edit <pr-number> --repo <resolved-repo> --title/);
  assert.match(skillContent, /gh pr ready <pr-number> --repo <resolved-repo>/);
  assert.match(skillContent, /gh pr review <pr-number> --repo <resolved-repo> --approve/);
  assert.match(skillContent, /detect-checkpoint-evidence\.mjs --repo <resolved-repo> --pr <pr-number>/);
  assert.doesNotMatch(skillContent, /--require-before-merge/, "the removed opt-in flag must not appear in the docs");
  assert.match(skillContent, /gh pr merge <pr-number> --repo <resolved-repo> --squash --delete-branch/);
});

test("residual raw-script refs are migrated to dev-loops subcommands (subcommand named first, raw kept only as fallback)", async () => {
  // Every consumer-facing doc that used to instruct a raw `node scripts/*.mjs`
  // call as the ONLY path must now name the routed `dev-loops <sub>` first. This
  // pins the migration so a future revert to raw-only ships red (the generator
  // --check only guarantees .claude mirror parity, not the source wording).
  const [localImpl, grill, epic] = await Promise.all([
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("skills/loop-grill/SKILL.md"),
    readRepo("skills/docs/epic-tree-refinement-procedure.md"),
  ]);
  // pre-flight-gate + ensure-worktree routed under the `loop` category.
  assert.match(localImpl, /dev-loops loop pre-flight-gate /);
  assert.match(localImpl, /dev-loops loop ensure-worktree /);
  // edit-issue routed under the new `issue` category.
  assert.match(grill, /dev-loops issue edit /);
  assert.match(epic, /dev-loops issue edit /);
});

test("issue-intake docs define closed-match handling and keep the handoff helper on the resolved repo", async () => {
  const skillContent = await readIssueIntakeSurface();

  assert.match(skillContent, /if the matching issue is closed, stop for a user decision before proceeding/i);
  assert.match(skillContent, /if that matching issue turns out to be closed, stop for a user decision/i);
  assert.match(skillContent, /copilot-pr-handoff\.mjs --repo <resolved-repo> --pr <number>/);
});

test("issue-intake docs define the closed direct-issue branch and keep searches/discovery scoped to the target issue repo", async () => {
  const skillContent = await readIssueIntakeSurface();

  assert.match(skillContent, /If the issue is closed, stop for a user decision before proceeding/i);
  assert.match(skillContent, /gh issue list --repo <resolved-repo> --state all --search/);
  assert.match(skillContent, /detect-linked-issue-pr\.mjs --repo <resolved-repo> --issue <number>/);
  assert.match(skillContent, /treat the helper output as authoritative for linked-PR detection\/selection/i);
  assert.match(skillContent, /detect-initial-copilot-pr-state\.mjs --repo <resolved-repo> --issue <number>/i);
  assert.match(skillContent, /waiting_for_initial_copilot_implementation.*keep waiting/i);
  assert.match(skillContent, /linked_pr_ready_for_followup.*resume from that PR/i);
  assert.doesNotMatch(skillContent, /gh pr list --repo <resolved-repo> --state open --search "copilot\/ <issue-number>"/);
});

test("issue-intake overlay wires waiting_for_initial_copilot_implementation to durable watch seam", async () => {
  const skillContent = await readIssueIntakeSurface();

  assert.match(skillContent, /watch-initial-copilot-pr\.mjs --repo <resolved-repo> --issue <number>/i);
  assertRuleOwned("FACADE-BOOTSTRAP-WATCH-ROUTE", PUBLIC_CONTRACT_PATH);
  assert.match(skillContent, /FACADE-BOOTSTRAP-WATCH-ROUTE/);
  assert.match(skillContent, /ready_for_followup.*linked PR has.*substantive/i);
  assert.match(skillContent, /timed_out.*observational first; refresh authoritative state/i);
  assert.match(skillContent, /if refreshed state is still `waiting_for_initial_copilot_implementation`, remain attached/i);
  // Owned-text check — marker survival alone must not mask dropping the seam-exit routing clause.
  assertRuleOwned("INTAKE-TIMEOUT-ROUTE-ON-SEAM-EXIT", "skills/docs/issue-intake-procedure.md");
  assert.match(skillContent, /INTAKE-TIMEOUT-ROUTE-ON-SEAM-EXIT/);
  assert.match(
    extractOwnedText(await readRepo("skills/docs/issue-intake-procedure.md"), "INTAKE-TIMEOUT-ROUTE-ON-SEAM-EXIT"),
    /route based on that refreshed state instead of surfacing timeout attention/i,
  );
  assert.match(skillContent, /when the refreshed state is `linked_pr_ready_for_followup`, re-enter normal PR follow-up/i);
  assert.match(skillContent, /follow-up handoff carries `conductorRouting\.handoffEnvelope\.requiresLocalIsolation=true`[\s\S]*isolated-checkout\/worktree handoff and continue/i);
  // Owned-text check — marker survival alone must not mask dropping the budget-exhausted gating clause.
  assertRuleOwned("INTAKE-TIMEOUT-SURFACE-BUDGET-EXHAUSTED", "skills/docs/issue-intake-procedure.md");
  assert.match(skillContent, /INTAKE-TIMEOUT-SURFACE-BUDGET-EXHAUSTED/);
  assert.match(
    extractOwnedText(await readRepo("skills/docs/issue-intake-procedure.md"), "INTAKE-TIMEOUT-SURFACE-BUDGET-EXHAUSTED"),
    /durable watch budget is actually exhausted/i,
  );
  assert.match(skillContent, /quiet\/no-activity watch observations alone are non-terminal/i);
  assert.match(skillContent, /inspect\/status requests.*still-waiting state and exit normally/i);
  assert.doesNotMatch(skillContent, /timed_out.*still-waiting timeout outcome.*implementation failure/i);
  assert.match(skillContent, /Phase 4 — Copilot handoff[\s\S]*timed_out.*observational first; refresh authoritative state/i);
  assert.match(skillContent, /From a plan-doc path[\s\S]*timed_out.*observational first; refresh authoritative state/i);
  assert.match(skillContent, /1.hour.*watch budget|1-hour.*Copilot-first wait/i);
});

test("issue-intake overlay delegates linked-PR detection mechanics to deterministic helper tooling", async () => {
  const skillContent = await readIssueIntakeSurface();

  assert.match(skillContent, /deterministic linked-PR helper/i);
  assertRuleOwned("INTAKE-LINKED-PR-HELPER-DELEGATION", "skills/docs/issue-intake-procedure.md");
  assert.match(skillContent, /INTAKE-LINKED-PR-HELPER-DELEGATION/);
  assert.match(skillContent, /<resolved-skill-scripts>\/github\/detect-linked-issue-pr\.mjs/i);
  assert.match(skillContent, /treat an open linked PR(?: reported by the helper)? as the active implementation for this issue/i);
});

test("issue-intake overlay resolves the target repo for non-issue inputs", async () => {
  const skillContent = await readIssueIntakeSurface();

  assertRuleOwned("INTAKE-REPO-SLUG-RESOLVE-FIRST", "skills/docs/issue-intake-procedure.md");
  assert.match(skillContent, /INTAKE-REPO-SLUG-RESOLVE-FIRST/);
  // Owned-text check — marker survival alone must not mask dropping the resolve-before-mutation clause.
  assert.match(
    extractOwnedText(await readRepo("skills/docs/issue-intake-procedure.md"), "INTAKE-REPO-SLUG-RESOLVE-FIRST"),
    /before any GitHub search or mutation/i,
  );
  assert.match(skillContent, /default to the current repository slug/i);
  assert.match(skillContent, /if the plan-doc reference explicitly points at another GitHub repository/i);
  assert.match(skillContent, /resolve `<resolved-repo>` for this work item using the same rule as the plan-doc path/i);
});

test("issue-intake safety layer contract is documented", async () => {
  const skillContent = await readIssueIntakeSurface();
  const planContent = await readRepo("PLAN.md");

  assert.match(skillContent, /New-idea safety layer \(default contract in this repo\)/);
  assertRuleOwned("INTAKE-NEW-IDEA-SAFETY", "skills/docs/issue-intake-procedure.md");
  assert.match(skillContent, /procedure owns classification; human operator gates all mutations/i);
  assert.match(skillContent, /run classification in fresh context by default/i);
  assert.match(skillContent, /emit a proposal artifact before any GitHub state-changing mutation, including create\/edit\/retitle\/collapse\/link operations/i);
  assert.match(skillContent, /async fan-out \/ fan-in proposal generation by default when practical/i);
  assert.match(skillContent, /default to create-new over overwrite\/update/i);
  assert.match(skillContent, /Deterministic intake \+ mutation-gate state machine/i);

  const stopStatesMarkdownBlock = skillContent.match(/stop states:\s*\n((?:-\s+.+\n)+)/i)?.[1] ?? "";
  const stopStates = stopStatesMarkdownBlock
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^-\s+/, "").trim())
    .sort();
  assert.deepEqual(stopStates, [
    "stopped_explicit_reject",
    "stopped_low_confidence",
    "stopped_overlap_needs_decision",
  ]);

  // Stop-state behavior is rule-owned (INTAKE-STOP-STATES) rather than phrase-pinned;
  // structural check: the rule covers all three stop states plus the preflight verdict.
  assertRuleOwned("INTAKE-STOP-STATES", "skills/docs/issue-intake-procedure.md");
  const intakeDoc = await readRepo("skills/docs/issue-intake-procedure.md");
  const stopStatesRuleBlock = intakeDoc.split("<!-- rule: INTAKE-STOP-STATES -->")[1]?.split(/\r?\n\r?\n/)[0] ?? "";
  for (const token of ["pause_for_clarification", "stopped_overlap_needs_decision", "stopped_low_confidence", "stopped_explicit_reject", "MUST stop", "MUST NOT mutate GitHub"]) {
    assert.ok(stopStatesRuleBlock.includes(token), `INTAKE-STOP-STATES rule block must cover ${token}`);
  }
  assert.match(skillContent, /start a separate async mutation pass \(dispatched via the procedure\) that consumes the approved proposal and emits a post-mutation verification artifact/i);
  assert.match(skillContent, /record what the mutation pass actually changed and verify the resulting issue\/artifact state/i);
  assert.match(skillContent, /tmp\/new-idea-intake\/<run-id>\/proposal\.md/i);
  assert.match(skillContent, /tmp\/new-idea-intake\/<run-id>\/proposal\.json/i);
  assert.match(skillContent, /human-readable Markdown proposal/i);
  assert.match(skillContent, /machine-readable JSON snapshot/i);
  assert.match(skillContent, /run a second async mutation pass \(dispatched via the procedure\)/i);
  assert.match(skillContent, /emit a concise post-mutation verification artifact/i);
  assert.match(planContent, /Proposal-first new-idea safety layer/i);
  assert.match(planContent, /stopped_overlap_needs_decision`, `stopped_low_confidence`, `stopped_explicit_reject`/i);
});
