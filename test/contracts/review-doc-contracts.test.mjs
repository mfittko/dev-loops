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
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGhMock, resolverTestEnv, runNode, writeGhStub, initGitFixture } from "../_helpers.mjs";

// Behavioral pin for the standalone review ownership exemption (issue #1893,
// fixing the AC over-claim PR 1851 shipped: its "tests pin review on a
// foreign-owned PR proceeds (no gate block); a fix/merge route on the same
// foreign PR is still blocked" AC was backed only by the doc-grep test
// "standalone review route stays structurally decoupled..." below). This test
// drives the REAL routing/exemption logic with one foreign-owned PR fixture,
// both halves in one test so the DIFFERENTIAL itself is the pinned contract:
//
//   half A — the review pipeline's Phase-1 entrypoint (write-gate-context.mjs
//   --gate review, the first stage every /loop-review run executes) PROCEEDS
//   on a foreign-owned PR and never resolves a viewer identity: makeGhMock
//   answers the spec-of-record PR read (plus any legitimate closing-issue
//   reads) and fails closed (exit 97) on any extra unstubbed gh call, so
//   wiring `gh api user` (or any viewer-identity read) into write-gate-context
//   fails this test loudly. (Phase 3 of the review pipeline — the verdict
//   poster — DOES read `gh api user` for marker provenance; that is a
//   different, exempt mechanism, NOT the ownership gate's.)
//
//   half B — the write/merge startup route (resolve-dev-loop-startup.mjs
//   --pr, the single-contributor ownership gate) on the SAME foreign-owned
//   fixture fails closed naming the foreign assignee.
test("behavioral pin: review proceeds on a foreign-owned PR while the write/merge startup route is blocked (issue #1893, AC for PR 1851)", async () => {
  const REPO = "mfittko/dev-loops";
  const PR = 740;
  const HEAD_SHA = "e0f1c2d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9";
  const FOREIGN_ASSIGNEE = "foreign-dev";

  // ---- Half A: the review pipeline proceeds on the foreign-owned PR ----
  const { main, readGateContext } = await import("../../scripts/github/write-gate-context.mjs");
  const reviewHalfRoot = mkdtempSync(path.join(os.tmpdir(), "review-pin-1893-a-"));
  try {
    const gh = makeGhMock([
      {
        assertArgs: ["pr", "view", String(PR), "--json", "body,closingIssuesReferences"],
        stdout: JSON.stringify({
          body: "Foreign-owned fixture PR (assigned to foreign-dev, not the current viewer).",
          closingIssuesReferences: [],
        }),
      },
    ]);

    const savedExitCode = process.exitCode;
    try {
      await main([
        "--repo", REPO,
        "--pr", String(PR),
        "--gate", "review",
        "--head-sha", HEAD_SHA,
        "--silent",
      ], { repoRoot: reviewHalfRoot, run: gh.runChild });
    } finally {
      process.exitCode = savedExitCode;
    }

    // The review gate-context artifact exists: the review route proceeded all
    // the way through Phase 1 on a PR the viewer does not own.
    const artifact = await readGateContext(
      { repo: REPO, pr: PR, gate: "review", headSha: HEAD_SHA, tmpRoot: "tmp" },
      { repoRoot: reviewHalfRoot },
    );
    assert.ok(artifact, "review gate-context artifact written for the foreign-owned PR (the review route proceeded past ownership)");

    // No viewer-identity resolution ever happened in the pinned Phase-1
    // surface: write-gate-context --gate review never calls `gh api user` —
    // the ownership gate's mechanism — regardless of the PR's spec shape (a
    // closing-issue fixture legitimately makes additional stubbed gh calls,
    // e.g. viewIssue in resolvePrSpecContext, so the pin is on the
    // viewer-identity read specifically, never on an exact call count; the
    // coverage angle's round-3 finding). makeGhMock still fails closed on any
    // UNSTUBBED gh call, so a wired-in ownership read would fail loudly even
    // before this assertion. (Phase 3's marker-provenance `api user` read in
    // the verdict poster is a different, exempt mechanism, not pinned here.)
    assert.ok(
      gh.calls.every((call) => !(call.args[0] === "api" && call.args[1] === "user")),
      `no gh api user (viewer-identity) call may occur in write-gate-context --gate review, got: ${JSON.stringify(gh.calls.map((c) => c.args.join(" ")))}`,
    );
  } finally {
    rmSync(reviewHalfRoot, { recursive: true, force: true });
  }

  // ---- Half B: the write/merge startup route blocks on the SAME fixture ----
  const resolverHalfRoot = mkdtempSync(path.join(os.tmpdir(), "review-pin-1893-b-"));
  try {
    // initGitFixture (not a bare execFileSync git init): it hardens the git
    // calls against an ambient GIT_DIR/GIT_WORK_TREE redirect (the hazard its
    // own JSDoc documents) and persists a repo-local identity — the
    // determinism angle's finding (draft_gate round 2).
    initGitFixture(resolverHalfRoot, { remote: `git@github.com:${REPO}.git`, commit: null });
    const ghStub = await writeGhStub(resolverHalfRoot, [
      {
        assertArgs: ["pr", "view", String(PR)],
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null, assignees: [{ login: FOREIGN_ASSIGNEE }], closingIssuesReferences: [], body: "" }),
      },
      { assertArgs: ["api", "user"], stdout: JSON.stringify({ login: "test-viewer" }) },
    ], { matchMode: "claims" });

    const result = await runNode(path.resolve("scripts/loop/resolve-dev-loop-startup.mjs"), ["--pr", String(PR)], {
      cwd: resolverHalfRoot,
      env: { ...ghStub.env, ...resolverTestEnv({ DEVLOOPS_OWNERSHIP_BYPASS: undefined }) },
    });

    assert.equal(result.code, 1, `the write/merge startup route must exit 1 on the foreign-owned PR (got exit ${result.code}; stdout: ${result.stdout})`);
    assert.equal(result.stdout, "", "no readiness bundle may be emitted for a foreign-owned PR");
    assert.match(result.stderr, new RegExp(`PR #${PR} is assigned to ${FOREIGN_ASSIGNEE}, not the current viewer`));
    assert.match(result.stderr, /fail closed/);
  } finally {
    rmSync(resolverHalfRoot, { recursive: true, force: true });
  }
});

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
    readRepo("skills/docs/gate-review-sub-loop-contract.md"),
    readRepo("agents/review.agent.md"),
    readRepo("skills/dev-loop/templates/review.md"),
    readRepo("skills/docs/reviewer-loop-state-graph.md"),
  ]);

  const gateDocuments = [
    ["skills/local-implementation/SKILL.md", localImplementationSkill, /default pre-approval gate[\s\S]{0,200}resolveGateAngles/i],
    ["skills/copilot-pr-followup/SKILL.md", copilotFollowupSkill, /default pre-approval gate/i],
    ["agents/review.agent.md", reviewAgent, /default pre-approval gate contract:[\s\S]{0,200}resolveGateAngles/i],
    ["skills/dev-loop/templates/review.md", reviewTemplate, /Default pre-approval gate/i],
    ["skills/docs/reviewer-loop-state-graph.md", reviewerGraph, /default pre-approval gate[\s\S]{0,200}resolveGateAngles/i],
  ];

  for (const [label, content, gatePhraseWithLenses] of gateDocuments) {
    assert.match(content, gatePhraseWithLenses, `${label} should keep the gate phrasing and lens names aligned`);
  }

  for (const [label, content] of [
    ["skills/local-implementation/SKILL.md", localImplementationSkill],
    ["skills/copilot-pr-followup/SKILL.md", copilotFollowupSkill],
    ["agents/review.agent.md", reviewAgent],
    ["skills/docs/reviewer-loop-state-graph.md", reviewerGraph],
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
  assertRuleOwned("GATE-EXEC-BUILD-ONCE-SEED", "skills/docs/gate-review-sub-loop-contract.md");
  assertRuleOwned("GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK", "skills/docs/gate-review-sub-loop-contract.md");
  assert.match(copilotFollowupSkill, /GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK/);
  // The review agent's fresh-context + sequential-fallback sentences point at
  // GATE-EXEC-BUILD-ONCE-SEED / GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK (owned
  // above); loose token checks on the agent surface, not exact sentences (#1159).
  assert.match(reviewAgent, /fresh context/i);
  assert.match(reviewAgent, /record the limitation/i);
  assertRuleOwned("REVIEWER-STATE-GATE-ANGLE-MAPPING", "skills/docs/reviewer-loop-state-graph.md");
  assert.match(reviewerGraph, /REVIEWER-STATE-GATE-ANGLE-MAPPING/);
});

test("reviewer-loop contract documents submitted-review handoff and explicit external waits", async () => {
  const [reviewerGraph, scriptsReadme] = await Promise.all([
    readRepo("skills/docs/reviewer-loop-state-graph.md"),
    readRepo("scripts/README.md"),
  ]);

  assertRuleOwned("REVIEWER-BOUNDARY-CONTRACT", "skills/docs/reviewer-loop-state-graph.md");
  assert.match(reviewerGraph, /REVIEWER-BOUNDARY-CONTRACT/);
  assert.match(reviewerGraph, /\.\/pr-lifecycle-contract\.md/i);
  assert.match(scriptsReadme, /reviewer `submitted_review`\s+as outer-loop-owned `continue_wait` states at explicit external\/handoff boundaries/i);
  assert.match(scriptsReadme, /preserves compatibility for reviewer `waiting_for_author_followup` and `waiting_for_re_request`\s+as legacy named external-wait boundaries/i);
});

test("consolidated PR lifecycle contract freezes the family-local lifecycle boundary", async () => {
  const [lifecycleContract, docsIndex, copilotGraph, gateContract, conductorRouting] = await Promise.all([
    readRepo("skills/docs/pr-lifecycle-contract.md"),
    readRepo("docs/index.md"),
    readRepo("skills/docs/copilot-loop-state-graph.md"),
    readRepo("skills/docs/gate-review-comment-contract.md"),
    readRepo("skills/docs/conductor-routing-contract.md"),
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

  assert.match(copilotGraph, /\.\/pr-lifecycle-contract\.md/i);
  assert.match(gateContract, /\.\/pr-lifecycle-contract\.md/i);
  assert.match(conductorRouting, /\.\/pr-lifecycle-contract\.md/i);
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
  assert.match(ciWorkflow, /name:\s*viewer-smoke \(shard \$\{\{\s*matrix\.shard\s*\}\}\)/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*shard:\s*\[1\/2,\s*2\/2\]/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*uses:\s*\.\/\.github\/actions\/playwright-webkit/i);
  assert.match(ciWorkflow, /viewer-smoke:[\s\S]*bun run test:playwright:viewer --shard=\$\{\{\s*matrix\.shard\s*\}\}/i);

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
  assert.match(playwrightWebkitAction, /key:\s*\$\{\{\s*runner\.os\s*\}\}-playwright-webkit-\$\{\{\s*hashFiles\('bun\.lock'\)\s*\}\}/i);
});

test("standalone review route stays structurally decoupled from the single-contributor ownership gate (issue #1850)", async () => {
  // Prose/structure companion to the behavioral pin above ("behavioral pin:
  // review proceeds on a foreign-owned PR...", issue #1893): that test drives
  // the actual routing/exemption logic on a foreign-owned PR fixture — the
  // differential AC PR 1851 originally claimed — while THIS test pins the
  // decoupling's doc/structure surface so the exemption's mechanism stays
  // documented and structurally unreachable from the review pipeline.
  const [devLoopSkill, reviewSkill, publicContract, writeGateContextSrc, consolidateFaninSrc, upsertVerdictSrc] = await Promise.all([
    readRepo("skills/dev-loop/SKILL.md"),
    readRepo("skills/review/SKILL.md"),
    readRepo("skills/docs/public-dev-loop-contract.md"),
    readRepo("scripts/github/write-gate-context.mjs"),
    readRepo("scripts/loop/consolidate-fanin.mjs"),
    readRepo("scripts/github/upsert-checkpoint-verdict.mjs"),
  ]);

  // The public router recognizes review intent and short-circuits to the
  // review skill BEFORE the startup resolver (and its ownership gate) ever
  // runs — a foreign-owned PR never blocks the review route.
  assert.match(devLoopSkill, /Review intent short-circuit/i);
  assert.match(devLoopSkill, /never run `loop startup`\/`resolve-dev-loop-startup\.mjs` for this route/i);
  assert.match(devLoopSkill, /ownership-exempt by construction/i);

  // review's own doc states the exemption and why (read-only).
  assert.match(reviewSkill, /Ownership-exempt \(issue #1850\)/i);
  assert.match(reviewSkill, /never needs the single-contributor ownership gate/i);

  // The authoritative ownership-gate contract documents review's exemption
  // (distinct mechanism from the ui_review/wait_watch STRATEGY_OWNERSHIP_GATE
  // entries) alongside the write-capable routes that stay gated.
  assert.match(publicContract, /standalone `review` route is ownership-exempt too/i);
  assert.match(publicContract, /Every write-capable route[\s\S]{0,200}stays gated exactly as before/i);

  // No review-pipeline script imports or otherwise references the ownership
  // gate — the exemption holds structurally, not just by doc convention: a
  // future edit wiring ownership into the review path would fail this
  // assertion, not just go undocumented.
  for (const [label, src] of [
    ["scripts/github/write-gate-context.mjs", writeGateContextSrc],
    ["scripts/loop/consolidate-fanin.mjs", consolidateFaninSrc],
    ["scripts/github/upsert-checkpoint-verdict.mjs", upsertVerdictSrc],
  ]) {
    assert.doesNotMatch(src, /resolve-dev-loop-startup/, `${label} must not depend on the single-contributor ownership gate`);
  }
});

test("CI runs verify as a parallel suite matrix gated by a fail-closed aggregation job", async () => {
  const ciWorkflow = await readRepo(".github/workflows/ci.yml");

  // verify runs as a parallel matrix (one leg per suite) gated by an
  // aggregation job named `verify` so the required-status-check name is
  // preserved. Assert every suite is a matrix leg and the gate fails closed.
  assert.match(ciWorkflow, /^\s{2}verify-suite:\s*$/m);
  assert.match(ciWorkflow, /name:\s*verify-suite \(\$\{\{\s*matrix\.suite\s*\}\}\$\{\{\s*matrix\.shard[\s\S]*shard \{0\}[\s\S]*\}\}\)/);
  assert.match(ciWorkflow, /verify-suite:[\s\S]*fail-fast:\s*false/i);
  assert.match(ciWorkflow, /verify-suite:[\s\S]*bun run \$\{\{\s*matrix\.suite\s*\}\}/i);

  // Scope leg-membership to the verify-suite job's matrix list (up to the next
  // job header) so a suite name appearing elsewhere can't satisfy the check.
  const verifySuiteHeaderIndex = ciWorkflow.search(/^\s{2}verify-suite:\s*$/m);
  assert.ok(verifySuiteHeaderIndex !== -1, "ci.yml must define a verify-suite: job");
  const nextSuiteJobRelative = ciWorkflow
    .slice(verifySuiteHeaderIndex + 1)
    .search(/^\s{2}\S/m);
  const verifySuiteSection = ciWorkflow.slice(
    verifySuiteHeaderIndex,
    nextSuiteJobRelative === -1
      ? ciWorkflow.length
      : verifySuiteHeaderIndex + 1 + nextSuiteJobRelative,
  );
  for (const suite of [
    "test:assets",
    "test:extension",
    "test:scripts",
    "test:core",
    "test:docs",
    "test:pack",
    "test:dev-loop",
  ]) {
    assert.match(
      verifySuiteSection,
      new RegExp(`^\\s*-\\s*(?:suite:\\s*)?${suite}\\s*$`, "m"),
      `verify-suite matrix must include ${suite}`,
    );
  }
  for (const shard of ["1/2", "2/2"]) {
    assert.match(verifySuiteSection, new RegExp(`shard: ${shard.replace("/", "\\/")}`));
  }
  assert.match(verifySuiteSection, /bun run \$\{\{\s*matrix\.suite\s*\}\} --shard=\$\{\{\s*matrix\.shard\s*\}\}/);

  // Fail-closed aggregation: the gate must run on `if: always()` (else a failed
  // leg SKIPS the gate under the default `if: success()`), depend on the whole
  // matrix, and `exit 1` when any leg is non-success. Scope to the verify job's
  // own section (header to the next top-level job header) so a future job added
  // below `verify` carrying either token can't silently satisfy the check.
  const verifyHeaderIndex = ciWorkflow.search(/^\s{2}verify:\s*$/m);
  assert.ok(verifyHeaderIndex !== -1, "ci.yml must define a verify: aggregation job");
  const nextJobRelative = ciWorkflow
    .slice(verifyHeaderIndex + 1)
    .search(/^\s{2}\S/m);
  const verifySection = ciWorkflow.slice(
    verifyHeaderIndex,
    nextJobRelative === -1 ? ciWorkflow.length : verifyHeaderIndex + 1 + nextJobRelative,
  );
  assert.match(verifySection, /needs:\s*\[verify-suite,\s*viewer-smoke\][\s\S]*needs\.verify-suite\.result[\s\S]*success/i);
  assert.match(verifySection, /needs\.viewer-smoke\.result[\s\S]*success[\s\S]*skipped/i);
  assert.match(verifySection, /if:\s*always\(\)/i);
  assert.match(verifySection, /exit 1/i);
});
