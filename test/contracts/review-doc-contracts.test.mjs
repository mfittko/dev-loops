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
import { assertRuleOwned } from "./_rule-helpers.mjs";

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
  // Read-only-when-reviewing is agent-surface routing guidance (agents own no
  // rules); loose token check instead of the exact sentence (#1159).
  assert.match(content, /acting as reviewer/i);
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
  assert.match(localImplementationSkill, /GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK/);
  assert.match(copilotFollowupSkill, /gate-review-sub-loop-contract\.md.*pre-approval/i);
  assertRuleOwned("GATE-EXEC-BUILD-ONCE-SEED", "docs/gate-review-sub-loop-contract.md");
  assertRuleOwned("GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK", "docs/gate-review-sub-loop-contract.md");
  assert.match(copilotFollowupSkill, /GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK/);
  // The review agent's fresh-context + sequential-fallback sentences point at
  // GATE-EXEC-BUILD-ONCE-SEED / GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK (owned
  // above); loose token checks on the agent surface, not exact sentences (#1159).
  assert.match(reviewAgent, /fresh context/i);
  assert.match(reviewAgent, /record the limitation/i);
  assertRuleOwned("REVIEWER-STATE-GATE-ANGLE-MAPPING", "docs/reviewer-loop-state-graph.md");
  assert.match(reviewerGraph, /REVIEWER-STATE-GATE-ANGLE-MAPPING/);
});

test("reviewer-loop contract documents submitted-review handoff and explicit external waits", async () => {
  const [reviewerGraph, scriptsReadme] = await Promise.all([
    readRepo("docs/reviewer-loop-state-graph.md"),
    readRepo("scripts/README.md"),
  ]);

  assertRuleOwned("REVIEWER-BOUNDARY-CONTRACT", "docs/reviewer-loop-state-graph.md");
  assert.match(reviewerGraph, /REVIEWER-BOUNDARY-CONTRACT/);
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
  assertRuleOwned("LIFECYCLE-CONFLICT-BLOCKS-PROGRESS", "skills/docs/pr-lifecycle-contract.md");

  assert.match(copilotGraph, /skills\/docs\/pr-lifecycle-contract\.md/i);
  assert.match(gateContract, /skills\/docs\/pr-lifecycle-contract\.md/i);
  assert.match(conductorRouting, /skills\/docs\/pr-lifecycle-contract\.md/i);
});

test("local-implementation skill documents the auto-scoped rendered-artifact UI e2e requirement", async () => {
  const localImplementationSkill = await readRepo("skills/local-implementation/SKILL.md");

  assert.match(localImplementationSkill, /required and auto-scoped/i);
  assert.match(localImplementationSkill, /Playwright WebKit plus screenshot capture/i);
  assert.match(localImplementationSkill, /ui-e2e-scoping-step\.md/i);
});


test("CI gates the Playwright WebKit smoke behind inspect-run viewer change detection and uses Node24-ready first-party actions", async () => {
  const [ciWorkflow, playwrightWebkitAction] = await Promise.all([
    readRepo(".github/workflows/ci.yml"),
    readRepo(".github/actions/playwright-webkit/action.yml"),
  ]);

  assert.match(ciWorkflow, /^\s{2}changes:\s*$/m);
  assert.match(ciWorkflow, /^\s{2}verify:\s*$/m);
  assert.match(ciWorkflow, /^\s{2}viewer-smoke:\s*$/m);
  assert.match(ciWorkflow, /fetch-depth:\s*0/i);
  assert.match(ciWorkflow, /actions\/checkout@v5/i);
  assert.match(ciWorkflow, /actions\/setup-node@v5/i);
  assert.match(ciWorkflow, /changes:[\s\S]*Set up Node\.js[\s\S]*node-version:\s*24/i);
  assert.match(ciWorkflow, /GITHUB_OUTPUT="\$GITHUB_OUTPUT" node scripts\/loop\/inspect-run-viewer-ci-changes\.mjs \.inspect-run-viewer-changed-files\.txt/i);
  assert.doesNotMatch(ciWorkflow, /inspect_run_viewer_relevant_paths_json/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*needs:[\s\S]*- changes/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*if:\s*needs\.changes\.outputs\.inspect_run_viewer\s*==\s*'true'/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*uses:\s*\.\/\.github\/actions\/playwright-webkit/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*npm run test:playwright:viewer/i);
  assert.match(ciWorkflow, /verify:[\s\S]*npm run verify/i);

  // All THREE smoke jobs must route through the shared composite action, so a
  // future edit can't silently reintroduce the duplication in any of them
  // (#1058 dedup guard — the whole point is all three share one setup).
  // Count-based, not per-job `job:[\s\S]*uses:` regexes: those are greedy and
  // match across job boundaries (a `deck-smoke:` header is "satisfied" by
  // article-smoke's later `uses:` line), so they'd pass even if deck lost its
  // reference. Asserting exactly 3 occurrences catches any job dropping it.
  assert.equal(
    (ciWorkflow.match(/uses:\s*\.\/\.github\/actions\/playwright-webkit/gi) || []).length,
    3,
    "all three smoke jobs (viewer/deck/article) must reference the composite action exactly once",
  );

  // Shared Playwright WebKit setup lives in the composite action; assert its
  // cache/env wiring AND its Node setup stayed intact after the dedup (#1058).
  // (The ciWorkflow node-version:24 assertion above is satisfied by the
  // changes/verify jobs, so assert the ACTION's own Node setup here or a
  // regression in the shared action's Node would go uncaught.)
  assert.match(playwrightWebkitAction, /actions\/setup-node@v5/i);
  assert.match(playwrightWebkitAction, /node-version:\s*24/i);
  assert.match(playwrightWebkitAction, /actions\/cache@v5/i);
  assert.match(playwrightWebkitAction, /path:\s*\$\{\{\s*env\.PLAYWRIGHT_BROWSERS_PATH\s*\}\}/i);
  assert.match(playwrightWebkitAction, /PLAYWRIGHT_BROWSERS_PATH=\$\{\{\s*github\.workspace\s*\}\}\/\.cache\/ms-playwright/i);
  assert.match(playwrightWebkitAction, /key:\s*\$\{\{\s*runner\.os\s*\}\}-playwright-webkit-\$\{\{\s*hashFiles\('package-lock\.json'\)\s*\}\}/i);

});
