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

test("copilot skill does not contain known imported blocker phrases", async () => {
  const content = await readRepo("skills/copilot-pr-followup/SKILL.md");

  assert.doesNotMatch(content, /repo-wiki/);
  assert.doesNotMatch(content, /copilot-review-followup/);
  assert.doesNotMatch(content, /async-review-fix-push/);
});

test("review agent does not hardcode reviewer identity or stale plan path", async () => {
  const content = await readRepo("agents/review.agent.md");

  assert.doesNotMatch(content, /mfittko/);
  assert.doesNotMatch(content, /docs\/plans\//);
});


test("docs agent supports docs-correctness review posture without becoming a public workflow entrypoint", async () => {
  const content = await readRepo("agents/docs.agent.md");
  const frontmatter = parseFrontmatter(content);

  assert.equal(frontmatter.name, "docs");
  assert.equal(frontmatter["user-invocable"], false);
  assert.match(content, /resolved angle prompt as the primary review lens/i);
  assert.match(content, /do not silently edit files when acting as reviewer/i);
});

test("review workflow resolves pre-approval gate angles from config with explicit fallback requirement", async () => {
  const [localImplementationSkill, copilotFollowupSkill, subLoopContract, reviewAgent, reviewTemplate, reviewerGraph] = await Promise.all([
    readRepo("skills/local-implementation/SKILL.md"),
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("docs/gate-review-sub-loop-contract.md"),
    readRepo("agents/review.agent.md"),
    readRepo("skills/dev-loop/templates/review.md"),
    readRepo("docs/reviewer-loop-state-graph.md"),
  ]);

  const gateDocuments = [
    ["skills/local-implementation/SKILL.md", localImplementationSkill, /default pre-approval gate[\s\S]{0,200}resolveGateAngles/i],
    ["skills/copilot-pr-followup/SKILL.md", copilotFollowupSkill, /default pre-approval gate/i],
    ["agents/review.agent.md", reviewAgent, /default pre-approval gate contract:[\s\S]{0,200}resolveGateAngles/i],
    ["skills/dev-loop/templates/review.md", reviewTemplate, /Default pre-approval gate/i],
    ["docs/reviewer-loop-state-graph.md", reviewerGraph, /default pre-approval gate[\s\S]{0,200}resolveGateAngles/i],
  ];

  for (const [label, content, gatePhraseWithLenses] of gateDocuments) {
    assert.match(content, gatePhraseWithLenses, `${label} should keep the gate phrasing and lens names aligned`);
  }

  for (const [label, content] of [
    ["skills/local-implementation/SKILL.md", localImplementationSkill],
    ["skills/copilot-pr-followup/SKILL.md", copilotFollowupSkill],
    ["agents/review.agent.md", reviewAgent],
    ["docs/reviewer-loop-state-graph.md", reviewerGraph],
  ]) {
    assert.match(
      content,
      /review-complete, approval-ready, merge-ready, or ready for final handoff/i,
      `${label} should keep the gate boundary wording aligned`,
    );
  }

  assert.match(reviewTemplate, /resolveGateAngles/i);
  assert.match(copilotFollowupSkill, /resolveGateAngles/i);
  assert.match(reviewTemplate, /configured angle checks/i);
  assert.match(localImplementationSkill, /if parallel execution is impractical[\s\S]*run all angles sequentially and explicitly record why parallel execution was impractical/i);
  assert.match(copilotFollowupSkill, /gate-review-sub-loop-contract\.md.*pre-approval/i);
  assert.match(subLoopContract, /fresh context/i);
  assert.match(subLoopContract, /in parallel when practical/i);
  assert.match(copilotFollowupSkill, /if parallel execution is impractical[\s\S]*still run all configured lenses and explicitly record the limitation/i);
  assert.match(reviewAgent, /if parallel execution is impractical[\s\S]*still cover all configured angles and explicitly record the limitation/i);
  assert.match(reviewAgent, /run those configured angle-focused passes in fresh context and in parallel when practical/i);
  assert.match(reviewerGraph, /workflow lenses that reviewer\s+runs must cover for the change/i);
  assert.match(reviewerGraph, /do not replace the state machine's supported\s+review-angle taxonomy/i);
});

test("reviewer-loop contract documents submitted-review handoff and explicit external waits", async () => {
  const [reviewerGraph, scriptsReadme] = await Promise.all([
    readRepo("docs/reviewer-loop-state-graph.md"),
    readRepo("scripts/README.md"),
  ]);

  assert.match(reviewerGraph, /A pure internal reviewer pass must end in a concrete review result boundary \(`submitted_review`\)/i);
  assert.match(reviewerGraph, /If a wait state is used, it must be an explicit named external-participant boundary/i);
  assert.match(reviewerGraph, /A new review request after fixes starts a new reviewer-pass context \(`review_requested`\)/i);
  assert.match(reviewerGraph, /skills\/docs\/pr-lifecycle-contract\.md/i);
  assert.match(scriptsReadme, /reviewer `submitted_review`\s+as outer-loop-owned `continue_wait` states at explicit external\/handoff boundaries/i);
  assert.match(scriptsReadme, /preserves compatibility for reviewer `waiting_for_author_followup` and `waiting_for_re_request`\s+as legacy named external-wait boundaries/i);
});

test("consolidated PR lifecycle contract freezes the family-local lifecycle boundary", async () => {
  const [lifecycleContract, docsIndex, copilotGraph, gateContract, conductorRouting] = await Promise.all([
    readRepo("skills/docs/pr-lifecycle-contract.md"),
    readRepo("docs/index.md"),
    readRepo("docs/copilot-loop-state-graph.md"),
    readRepo("docs/gate-review-comment-contract.md"),
    readRepo("docs/conductor-routing-contract.md"),
  ]);

  assert.match(docsIndex, /skills\/docs\/pr-lifecycle-contract\.md/i);
  assert.match(lifecycleContract, /^# PR lifecycle contract$/m);
  assert.match(lifecycleContract, /## Lifecycle states/i);
  assert.match(lifecycleContract, /## Required transitions/i);
  assert.match(lifecycleContract, /## Fail-closed rules/i);
  assert.match(lifecycleContract, /draft_local_review_gate/i);
  assert.match(lifecycleContract, /copilot_reply_resolve_pending/i);
  assert.match(lifecycleContract, /final_gate_remediation/i);
  assert.match(lifecycleContract, /merge_conflict_resolution/i);
  assert.match(lifecycleContract, /waiting_for_human_pr_approval/i);
  assert.match(lifecycleContract, /must not be treated as `waiting_for_human_pr_approval`, `waiting_for_merge`, or merge-ready/i);

  assert.match(copilotGraph, /skills\/docs\/pr-lifecycle-contract\.md/i);
  assert.match(gateContract, /skills\/docs\/pr-lifecycle-contract\.md/i);
  assert.match(conductorRouting, /skills\/docs\/pr-lifecycle-contract\.md/i);
});

test("dev-loop skill documents the auto-scoped rendered-artifact UI e2e requirement", async () => {
  const localImplementationSkill = await readRepo("skills/local-implementation/SKILL.md");

  assert.match(localImplementationSkill, /required and auto-scoped/i);
  assert.match(localImplementationSkill, /Playwright WebKit plus screenshot capture/i);
  assert.match(localImplementationSkill, /ui-e2e-scoping-step\.md/i);
});


test("CI gates the Playwright WebKit smoke behind inspect-run viewer change detection and uses Node24-ready first-party actions", async () => {
  const [ciWorkflow, readme] = await Promise.all([
    readRepo(".github/workflows/ci.yml"),
    readRepo("README.md"),
  ]);

  assert.match(ciWorkflow, /^\s{2}changes:\s*$/m);
  assert.match(ciWorkflow, /^\s{2}verify:\s*$/m);
  assert.match(ciWorkflow, /^\s{2}viewer-smoke:\s*$/m);
  assert.match(ciWorkflow, /fetch-depth:\s*0/i);
  assert.match(ciWorkflow, /actions\/checkout@v5/i);
  assert.match(ciWorkflow, /actions\/setup-node@v5/i);
  assert.match(ciWorkflow, /actions\/cache@v5/i);
  assert.match(ciWorkflow, /changes:[\s\S]*Set up Node\.js[\s\S]*node-version:\s*24/i);
  assert.match(ciWorkflow, /GITHUB_OUTPUT="\$GITHUB_OUTPUT" node scripts\/loop\/inspect-run-viewer-ci-changes\.mjs \.inspect-run-viewer-changed-files\.txt/i);
  assert.doesNotMatch(ciWorkflow, /inspect_run_viewer_relevant_paths_json/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*needs:[\s\S]*- changes/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*if:\s*needs\.changes\.outputs\.inspect_run_viewer\s*==\s*'true'/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*path:\s*\$\{\{\s*env\.PLAYWRIGHT_BROWSERS_PATH\s*\}\}/i);
  assert.match(ciWorkflow, /PLAYWRIGHT_BROWSERS_PATH:\s*\$\{\{\s*github\.workspace\s*\}\}\/\.cache\/ms-playwright/i);
  assert.match(ciWorkflow, /key:\s*\$\{\{\s*runner\.os\s*\}\}-playwright-webkit-\$\{\{\s*hashFiles\('package-lock\.json'\)\s*\}\}/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*npm run test:playwright:viewer/i);
  assert.match(ciWorkflow, /verify:[\s\S]*npm run verify/i);

  assert.match(readme, /workspace-local Playwright WebKit/i);
  assert.match(readme, /small changed-files gate plus parallel `verify` and conditional `viewer-smoke` jobs/i);
  assert.match(readme, /run only when files in the bounded inspect-run viewer surface or its smoke-path dependencies change/i);
});
