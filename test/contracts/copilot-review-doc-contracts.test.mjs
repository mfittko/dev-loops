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

async function readCopilotSkillSurface() {
  const [skill, operationsDoc, intakeDoc] = await Promise.all([
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("skills/docs/copilot-loop-operations.md"),
    readRepo("skills/docs/issue-intake-procedure.md"),
  ]);
  return [skill, operationsDoc, intakeDoc].join("\n\n");
}
test("copilot review gates keep phase-specific angle ownership in one canonical internal skill", async () => {
  const copilotPrFollowupSkill = await readRepo("skills/copilot-pr-followup/SKILL.md");
  const devLoopStep7Match = copilotPrFollowupSkill.match(/## Step 7: Pi review\/fix follow-up loop[\s\S]*?(?=\n## Step 8|$)/);
  const devLoopStep7 = devLoopStep7Match ? devLoopStep7Match[0] : "";
  assert.ok(devLoopStep7.length > 0, "copilot-pr-followup Step 7 section not found");
  const devLoopDraftGateMatch = devLoopStep7.match(/### Draft gate contract[\s\S]*?(?=\n### |$)/);
  const devLoopDraftGate = devLoopDraftGateMatch ? devLoopDraftGateMatch[0] : "";
  assert.ok(devLoopDraftGate.length > 0, "copilot-pr-followup draft-gate section not found inside Step 7");
  const devLoopPreApprovalMatch = devLoopStep7.match(/### Pre-approval gate contract[\s\S]*?(?=\n## |\n### |$)/);
  const devLoopPreApproval = devLoopPreApprovalMatch ? devLoopPreApprovalMatch[0] : "";
  assert.ok(devLoopPreApproval.length > 0, "copilot-pr-followup pre-approval gate section not found inside Step 7");
  assert.match(copilotPrFollowupSkill, /canonical internal `copilot_pr_followup` route behind the public `dev-loop` façade/i);
  assert.match(copilotPrFollowupSkill, /canonical internal owner of the shared post-PR mechanics/i);
  assertRuleOwned("GATE-COMMENT-SCOPE-ONLY", "docs/gate-review-comment-contract.md");
  const expectedDevLoopShape = [/Gate name:/i, /Trigger \/ boundary:/i, /Review angles:/i, /Pass criteria:/i, /Next step after passing:/i];
  for (const [label, section] of [
    ["copilot-pr-followup draft gate", devLoopDraftGate],
    ["copilot-pr-followup pre-approval gate", devLoopPreApproval],
  ]) {
    for (const shapePart of expectedDevLoopShape) {
      assert.match(section, shapePart, `${label} should include contract field ${shapePart}`);
    }
    assert.doesNotMatch(section, /Gate role:/i, `${label} should not introduce extra template-only fields that drift across gates`);
  }
  const draftAnglePatterns = [/resolveGateAngles\(config, "draft"\)/i, /all configured draft gate angle families/i];
  const preApprovalAnglePatterns = [/resolveGateAngles\(config, "preApproval"\)/];
  const devLoopDraftOwnedAnglesMatch = devLoopDraftGate.match(/Review angles:[\s\S]*?(?=\n- \*\*Pass criteria)/i);
  const devLoopDraftOwnedAngles = devLoopDraftOwnedAnglesMatch ? devLoopDraftOwnedAnglesMatch[0] : "";
  const devLoopPreApprovalOwnedAnglesMatch = devLoopPreApproval.match(/Review angles:[\s\S]*?(?=\n- \*\*Pass criteria)/i);
  const devLoopPreApprovalOwnedAngles = devLoopPreApprovalOwnedAnglesMatch ? devLoopPreApprovalOwnedAnglesMatch[0] : "";
  for (const pattern of draftAnglePatterns) {
    assert.match(devLoopDraftOwnedAngles, pattern);
  }
  for (const pattern of preApprovalAnglePatterns) {
    assert.match(devLoopPreApprovalOwnedAngles, pattern);
  }
  // Pre-approval angles must NOT appear in draft gate section
  for (const pattern of [/\bDRY\b/, /\bKISS\b/, /\bYAGNI\b/]) {
    assert.doesNotMatch(devLoopDraftOwnedAngles, pattern);
  }
  for (const pattern of draftAnglePatterns) {
    assert.doesNotMatch(devLoopPreApprovalOwnedAngles, pattern);
  }
});
test("copilot-pr-followup skill routes review requests and wait seams through deterministic helpers", async () => {
  const skillContent = await readRepo("skills/copilot-pr-followup/SKILL.md");
  const requestSectionMatch = skillContent.match(/When confirming whether Copilot is requested as a reviewer,[\s\S]*?## Step 6: Async watch behavior/);
  const requestSection = requestSectionMatch ? requestSectionMatch[0] : "";
  assert.ok(requestSection.length > 0, "request/wait section not found");
  assert.match(requestSection, /request-copilot-review\.mjs/i);
  assert.match(requestSection, /--force-rerequest-review/i);
  assert.match(requestSection, /Do \*\*not\*\* request Copilot by posting literal `\/copilot` or `\/copilot re-review` PR comments\./i);
  assert.match(requestSection, /`requested`:/i);
  assert.match(requestSection, /`already-requested`:/i);
  assert.match(requestSection, /`suppressed_same_head_clean`:/i);
  assert.match(requestSection, /`unavailable`:/i);
  const step6Match = skillContent.match(/## Step 6: Async watch behavior[\s\S]*?(?=\n## Step 7|$)/);
  const step6 = step6Match ? step6Match[0] : "";
  assert.ok(step6.length > 0, "copilot-pr-followup Step 6 section not found");
  assert.match(step6, /detect-copilot-loop-state\.mjs/i);
  assert.match(step6, /dev-loops loop watch-cycle/i);
  assert.match(step6, /gh run watch <run-id> --repo <owner\/name>/i);
  assert.match(step6, /helper-owned sleep inside `dev-loops loop watch-cycle`, `dev-loops gate probe-copilot`, or `dev-loops loop watch-initial` is allowed/i);
  assert.match(step6, /agent-authored shell polling is forbidden/i);
  assert.match(step6, /for i in \$\(seq \.\.\.\)/i);
  assert.match(step6, /while true/i);
  assert.match(step6, /until \.\.\.; do sleep \.\.\.; done/i);
  assert.match(step6, /do not wrap repeated `gh pr view`, `gh pr checks`, `gh api`, or `detect-copilot-loop-state\.mjs` calls inside shell polling loops/i);
});
test("copilot-pr-followup skill keeps async watch persistence explicit", async () => {
  const [skillContent, scriptsReadme, stateGraph] = await Promise.all([
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("scripts/README.md"),
    readRepo("docs/copilot-loop-state-graph.md"),
  ]);
  assert.match(skillContent, /dev-loops loop watch-cycle/i);
  assert.match(skillContent, /zero-timeout `idle` probes are for explicit one-shot status\/reattach checks only/i);
  assert.match(skillContent, /returning to `waiting_for_copilot_review` is a persistence boundary: resume the watcher instead of reporting completion/i);
  assert.match(skillContent, /persistent async watch\/fix loop, not handoff-only behavior/i);
  assert.match(skillContent, /if `cycleDisposition` is `pending` and `terminal` is `false`, the subagent exits on the wait boundary; the main session re-dispatches another watch boundary/i);
  assert.match(skillContent, /if the user explicitly asks for async handoff-only behavior/i);
  assert.match(skillContent, /child async run exits[\s\S]*waiting_for_copilot_review[\s\S]*main session re-dispatches the same-PR follow-up path when feasible/i);
  assert.match(scriptsReadme, /`cycleDisposition: "pending"` with `terminal: false` means stay attached and run another watch boundary rather than exiting as clean success/i);
  assert.match(scriptsReadme, /handoff-only behavior must be explicitly requested/i);
  assertRuleOwned("COPILOT-STATE-WATCH-PERSISTENCE", "docs/copilot-loop-state-graph.md");
  assert.match(stateGraph, /COPILOT-STATE-WATCH-PERSISTENCE/);
});
test("copilot-pr-followup skill hardens reply-resolve, gate sequencing, and merge-ready checks", async () => {
  const skillContent = await readRepo("skills/copilot-pr-followup/SKILL.md");
  const step6Match = skillContent.match(/## Step 6: Async watch behavior[\s\S]*?(?=\n## Step 7|$)/);
  const step6 = step6Match ? step6Match[0] : "";
  assert.ok(step6.length > 0, "copilot-pr-followup Step 6 section not found");
  assert.match(
    step6,
    /Every async dev-loop dispatch task body must include this clause verbatim/i,
    "Step 6 should define canonical async dispatch wording",
  );
  assert.match(
    step6,
    /Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA\. Do not stop or report completion without this evidence\./i,
    "Step 6 should embed the required pre-approval gate dispatch clause verbatim",
  );
  const step7Match = skillContent.match(/## Step 7: Pi review\/fix follow-up loop[\s\S]*?(?=\n## Validation policy|$)/);
  const step7 = step7Match ? step7Match[0] : "";
  assert.ok(step7.length > 0, "copilot-pr-followup Step 7 section not found");
  assert.match(
    step7,
    /must use the deterministic helper `reply-resolve-review-thread\.mjs`/i,
    "Step 7 should require the reply-resolve helper",
  );
  assert.match(
    step7,
    /reply-resolve-review-threads\.mjs/i,
    "Step 7 should reference the deterministic batch reply-resolve helper for multi-thread follow-up",
  );
  assert.doesNotMatch(
    step7,
    /prefer the deterministic helper `reply-resolve-review-thread\.mjs`/i,
    "Step 7 should not leave the reply-resolve helper optional",
  );
  assert.match(
    step7,
    /before resolving an addressed review thread, run a post-fix verification checkpoint/i,
    "Step 7 should require a post-fix verification checkpoint before thread resolution",
  );
  assert.match(
    step7,
    /confirm the GitHub reply actually exists on the intended thread\/comment/i,
    "verification checkpoint should require confirming the GitHub reply exists",
  );
  assert.match(
    step7,
    /confirm the pushed current-head diff genuinely addresses the reviewer concern/i,
    "verification checkpoint should require confirming the pushed fix addresses the concern",
  );
  assert.match(
    step7,
    /including the unresolved thread count/i,
    "verification checkpoint should require refreshed API-backed unresolved thread count data",
  );
  assert.match(
    step7,
    /if any verification check fails, do \*\*not\*\* resolve the thread; leave it open/i,
    "verification checkpoint should keep threads open when verification fails",
  );
  const verificationIndex = step7.indexOf("before resolving an addressed review thread, run a post-fix verification checkpoint");
  const resolveIndex = step7.indexOf("resolve the addressed review thread only after the reply is attached successfully");
  assert.ok(verificationIndex >= 0 && resolveIndex > verificationIndex, "verification checkpoint must appear before the resolve step");
  assert.match(
    step7,
    /verify zero unresolved threads remain via `dev-loops gate capture-threads` before proceeding/i,
    "Step 7 should require deterministic unresolved-thread verification before advancing",
  );
  assert.match(
    step7,
    /if the refreshed snapshot reports unresolved threads, re-enter the reply\/resolve loop for the missed threads/i,
    "Step 7 should require re-entering the reply-resolve loop when unresolved threads remain",
  );
  assert.match(
    step7,
    /The `pre_approval_gate` procedure must be entered and completed \(visible comment posted\) before any merge-ready or approval-ready declaration/i,
    "pre-approval gate sequencing should forbid skipping the gate",
  );
  assert.match(
    step7,
    /Skipping the gate is not recoverable by asserting convergence/i,
    "pre-approval gate sequencing should reject convergence-only claims",
  );
  assert.match(
    step7,
    /### Merge-ready preconditions/i,
    "Step 7 should include a merge-ready preconditions subsection",
  );
  assert.match(
    step7,
    /zero unresolved threads.*dev-loops gate capture-threads/i,
    "merge-ready preconditions should require deterministic thread-state verification",
  );
  assert.match(
    step7,
    /draft_gate.*clean|clean.*draft_gate/i,
    "merge-ready preconditions should require draft gate evidence",
  );
  assert.match(
    step7,
    /pre_approval_gate.*clean|clean.*pre_approval_gate/i,
    "merge-ready preconditions should require current-head clean gate evidence",
  );
  assert.match(
    step7,
    /green CI/i,
    "merge-ready preconditions should require current-head green CI",
  );
  // Hard-gate rule now in canonical merge-preconditions.md
  assert.match(
    step7,
    /Merge Preconditions/i,
    "merge-ready preconditions should be a hard gate (canonical reference)",
  );
  assert.match(
    step7,
    /### Mechanical pre-merge gate evidence check/i,
    "Step 7 should include a mechanical pre-merge evidence check",
  );
  assert.match(
    step7,
    /detect-checkpoint-evidence\.mjs[\s\S]*always-on/i,
    "mechanical pre-merge check should use the gate evidence helper with always-on enforcement",
  );
  assert.doesNotMatch(
    step7,
    /--require-before-merge/,
    "the removed opt-in flag must not appear in the skill text",
  );
  assert.match(
    step7,
    /Do not run `gh pr merge` if this command exits non-zero/i,
    "mechanical pre-merge check should block merge on missing evidence",
  );
  assert.match(
    step7,
    /### Conflict-resolution gate/i,
    "Step 7 should include a conflict-resolution subsection",
  );
  assert.match(
    step7,
    /`gateBoundary=conflict_resolution`|`mergeStateStatus` is conflicted/i,
    "conflict-resolution subsection should key off the deterministic helper boundary",
  );
  assert.match(
    step7,
    /fetch fresh `origin\/main`/i,
    "conflict-resolution flow should refresh origin/main first",
  );
  assert.match(
    step7,
    /ask for explicit authorization before any merge commit/i,
    "conflict-resolution flow should require explicit reconciliation authorization",
  );
  assert.match(
    step7,
    /default to a merge commit \(`git merge origin\/main`\)/i,
    "conflict-resolution flow should document the default merge commit path",
  );
  assert.match(
    step7,
    /auto-resolve simple conflicts/i,
    "conflict-resolution flow should allow simple auto-resolution",
  );
  assert.match(
    step7,
    /report complex ones|report complex conflicts/i,
    "conflict-resolution flow should surface complex conflicts for manual handling",
  );
  assert.match(
    step7,
    /rerun `detect-pr-gate-coordination-state\.mjs`/i,
    "conflict-resolution flow should require gate re-detection",
  );
  assert.match(
    step7,
    /rerun `pre_approval_gate` for the new head/i,
    "conflict-resolution flow should require a fresh pre-approval gate on the new head",
  );
  assert.match(
    step7,
    /wait for current-head CI again/i,
    "conflict-resolution flow should require fresh CI on the new head",
  );
  const antiPatternsMatch = skillContent.match(/## Anti-patterns[\s\S]*?(?=\n## Recommended companion skills|$)/);
  const antiPatterns = antiPatternsMatch ? antiPatternsMatch[0] : "";
  assert.ok(antiPatterns.length > 0, "copilot-pr-followup anti-patterns section not found");
  assert.match(antiPatterns, /Use.*reply-resolve-review-thread.*instead of ad hoc.*gh api.*thread/i);
  assert.match(antiPatterns, /declare merge-ready without visible.*pre_approval_gate/i);
  assert.match(antiPatterns, /declare merge-ready based solely.*mergeable_state.*clean.*CI green/i);
  assert.match(antiPatterns, /Do not blind-run.*gh pr merge.*gh pr update-branch.*unapproved rebase/i);
  assert.match(antiPatterns, /Do not dispatch async dev-loop.*omit.*pre-approval gate/i);
});

test("copilot-pr-followup skill caps Copilot re-review rounds via config and snapshot state", async () => {
  const skillContent = await readRepo("skills/copilot-pr-followup/SKILL.md");

  const step7Match = skillContent.match(/## Step 7: Pi review\/fix follow-up loop[\s\S]*?(?=\n## Validation policy|$)/);
  const step7 = step7Match ? step7Match[0] : "";
  assert.ok(step7.length > 0, "copilot-pr-followup Step 7 section not found");

  assert.match(step7, /resolveRefinementConfig\(config, "maxCopilotRounds"\)/i);
  assert.match(step7, /default config ships `maxCopilotRounds: 5`/i);
  assert.match(step7, /completed Copilot review-round count/i);
  assert.match(step7, /if completed review rounds have reached the maximum/i);
  assert.match(step7, /`deferred to follow-up` note/i);
  assert.match(step7, /stop and report that the Copilot round limit was reached/i);
});

test("legacy copilot workflow entrypoint agents are removed from normal executable surfaces", async () => {
  const agentFiles = (await readdir(fromRepoRoot("agents")))
    .filter((name) => name.endsWith(".agent.md"))
    .sort();
  assert.equal(agentFiles.includes("copilot-pr-followup.agent.md"), false);
  assert.equal(agentFiles.includes("copilot-autopilot.agent.md"), false);
});
test("public dev-loop agent is a thin executable entrypoint that defers to the public skill router", async () => {
  const [agentContent, skillContent] = await Promise.all([
    readRepo("agents/dev-loop.agent.md"),
    readRepo("skills/dev-loop/SKILL.md"),
  ]);
  assert.match(agentContent, /name:\s*"dev-loop"/);
  assert.match(agentContent, /user-invocable:\s*true/);
  assert.match(agentContent, /skills\/dev-loop\/SKILL\.md/);
  assert.match(agentContent, /must stay thin/i);
  assert.match(agentContent, /do not restate the skill's phase sequencing or workflow policy here/i);
  assert.match(agentContent, /deterministic public routing contract/i);
  assert.doesNotMatch(agentContent, /compatibility\/internal entrypoints during migration/i);
  assert.match(agentContent, /stop and ask for human direction rather than guessing/i);
  assert.match(agentContent, /local facts, GitHub facts, and helper\/state-machine output do not agree/i);
  assert.match(skillContent, /public `dev-loop` façade/i);
});
test("thin pointer docs reference canonical contract content", async () => {
  const [trackerPointer, trackerCanonical, conductorContent, ciContent, skillContent] = await Promise.all([
    readRepo("docs/tracker-story-pr-contract.md"),
    readRepo("skills/docs/tracker-first-loop-state.md"),
    readRepo("docs/outer-loop-state-graph.md"),
    readRepo("skills/docs/copilot-ci-status-contract.md"),
    readCopilotSkillSurface(),
  ]);
  // Pointer file references canonical location; content verified from canonical file.
  assert.match(trackerPointer, /Canonical location:/i);
  assert.match(trackerPointer, /tracker-first-loop-state.md/i);
  assert.match(trackerCanonical, /Tracker-First Story-to-PR Contract/i);
  assert.match(trackerCanonical, /MVP invariant: one tracker work item → one GitHub PR/i);
  assert.match(conductorContent, /Conductor Routing Contract/i);
  assert.match(conductorContent, /conductor routing contract/i);
  assert.match(ciContent, /Copilot PR CI\/check normalization contract/i);
  assert.match(ciContent, /canonical bundled contract/i);
  assert.match(skillContent, /inherits[\s\S]*source-of-truth ownership[\s\S]*work item <-> PR link[\s\S]*reverse-sync semantics from\s*`#21`/i);
});
test("new See Also markdown links resolve from docs files", async () => {
  const linkTargetsByDoc = {
    "docs/gate-review-comment-contract.md": [
      "../skills/copilot-pr-followup/SKILL.md",
      "../skills/final-approval/SKILL.md",
      "../skills/docs/pr-lifecycle-contract.md",
      "./gate-review-sub-loop-contract.md",
    ],
    "docs/gate-review-sub-loop-contract.md": [
      "gate-review-comment-contract.md",
      "../skills/docs/pr-lifecycle-contract.md",
      "../skills/copilot-pr-followup/SKILL.md",
      "../skills/local-implementation/SKILL.md",
    ],
    "docs/index.md": [
      "../README.md",
      "../extension/README.md",
      "../skills/docs/public-dev-loop-contract.md",
      "../AGENTS.md",
    ],
  };
  for (const [docPath, targets] of Object.entries(linkTargetsByDoc)) {
    const doc = await readRepo(docPath);
    for (const target of targets) {
      assert.match(doc, new RegExp(`\\]\\(${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
      const docDir = docPath.slice(0, docPath.lastIndexOf("/") + 1);
      const targetUrl = new URL(target, fromRepoRoot(docDir));
      const targetStat = await stat(targetUrl);
      assert.ok(targetStat.isFile(), `${docPath} should link to existing file ${target}`);
    }
  }
});
test("docs index separates active docs and presentations", async () => {
  const content = await readRepo("docs/index.md");
  assert.match(content, /Start here/i);
  assert.match(content, /phases\/phase-8\.md/i);
  assert.doesNotMatch(content, /archive\/phases\/phase-0\.md/i);
  assert.doesNotMatch(content, /archive\/workflow-remediation-prep\.md/i);
  assert.match(content, /presentations\/applied-dev-loops-presentation\.md/i);
  assert.match(content, /presentations\/style\.css/i);
});
test("checkpoint verdict comment contract owns its comment-field rules by ID (single owner)", () => {
  const ownerPath = "docs/gate-review-comment-contract.md";
  for (const id of [
    "GATE-COMMENT-SCOPE-ONLY",
    "GATE-COMMENT-REQUIRED-FIELDS",
    "GATE-COMMENT-VERDICT-VALUES",
    "GATE-COMMENT-RERUN-RULES",
    "GATE-COMMENT-FAIL-CLOSED",
    "GATE-COMMENT-NON-SUBSTITUTION",
    "GATE-COMMENT-VALIDATION-REPORTING",
    "GATE-COMMENT-DRAFT-REQUIREMENTS",
    "GATE-COMMENT-PREAPPROVAL-REQUIREMENTS",
  ]) {
    assertRuleOwned(id, ownerPath);
  }
});
test("checkpoint verdict comment ownership stays explicit in the canonical internal skill file", async () => {
  const copilotPrFollowupSkill = await readRepo("skills/copilot-pr-followup/SKILL.md");
  const devLoopDraftGateMatch = copilotPrFollowupSkill.match(/### Draft gate contract[\s\S]*?(?=\n### |\n## |$)/);
  const devLoopDraftGate = devLoopDraftGateMatch ? devLoopDraftGateMatch[0] : "";
  assert.ok(devLoopDraftGate.length > 0, "copilot-pr-followup draft gate section not found");
  assert.match(devLoopDraftGate, /Required PR comment/i);
  assert.match(devLoopDraftGate, /`draft_gate`/);
  assert.match(devLoopDraftGate, /head SHA/i);
  assert.match(devLoopDraftGate, /fail.closed|cannot be posted/i);
  assert.match(devLoopDraftGate, /older head SHA does not satisfy/i);
  assert.match(devLoopDraftGate, /stays draft and needs fixes/i);
  assert.match(devLoopDraftGate, /visible `clean` `draft_gate` checkpoint verdict comment exists for the current head SHA/i);
  assert.match(devLoopDraftGate, /post a new checkpoint verdict comment for the new head/i);
  assert.match(devLoopDraftGate, /does \*\*not\*\* satisfy `pre_approval_gate`|does not satisfy `pre_approval_gate`/i);
  assert.match(devLoopDraftGate, /command names with pass.fail status/i);
  assert.match(devLoopDraftGate, /raw passing test output/i);
  assert.match(devLoopDraftGate, /truncate it to a deterministic retained-prefix length/i);
  const devLoopPreApprovalGateMatch = copilotPrFollowupSkill.match(/### Pre-approval gate contract[\s\S]*?(?=\n### |\n## |$)/);
  const devLoopPreApprovalGate = devLoopPreApprovalGateMatch ? devLoopPreApprovalGateMatch[0] : "";
  assert.ok(devLoopPreApprovalGate.length > 0, "copilot-pr-followup pre-approval gate section not found");
  assert.match(devLoopPreApprovalGate, /Required PR comment/i);
  assert.match(devLoopPreApprovalGate, /`pre_approval_gate`/);
  assert.match(devLoopPreApprovalGate, /head SHA/i);
  assert.match(devLoopPreApprovalGate, /fail.closed|cannot be posted/i);
  assert.match(devLoopPreApprovalGate, /older head SHA does not satisfy/i);
  assert.match(devLoopPreApprovalGate, /follow-up fixes are required before final approval/i);
  assert.match(devLoopPreApprovalGate, /visible `clean` `pre_approval_gate` checkpoint verdict comment exists for the current head SHA/i);
  assert.match(devLoopPreApprovalGate, /must not rely only on local or hidden artifacts/i);
  assert.match(devLoopPreApprovalGate, /post a new checkpoint verdict comment for the new head/i);
  assert.match(devLoopPreApprovalGate, /does \*\*not\*\* replace the required `draft_gate` evidence|does not replace the required `draft_gate` evidence/i);
  assert.match(devLoopPreApprovalGate, /command names with pass.fail status/i);
  assert.match(devLoopPreApprovalGate, /raw passing test output/i);
  assert.match(devLoopPreApprovalGate, /truncate it to a deterministic retained-prefix length/i);
});
test("issue-intake skill documents epic decomposition with GitHub sub-issue trees", async () => {
  const skillContent = await readCopilotSkillSurface();
  assert.match(skillContent, /GitHub sub-issue trees/i);
  assert.match(skillContent, /Prefer real sub-issue linkage over parent-body checklists/i);
  assert.match(skillContent, /parent issue body should stay lean/i);
  assert.match(skillContent, /manage-sub-issues\.mjs add/i);
  assert.match(skillContent, /manage-sub-issues\.mjs reorder/i);
  assert.match(skillContent, /manage-sub-issues\.mjs verify/i);
  assert.match(skillContent, /manage-sub-issues\.mjs list/i);
  assert.match(skillContent, /Do \*\*not\*\* re-implement sub-issue management ad hoc or bypass `manage-sub-issues\.mjs`/i);
  assert.match(skillContent, /Do \*\*not\*\* maintain a body checklist that duplicates the sub-issue tree/i);
  assert.match(skillContent, /sub-issue-tree-contract\.md/i);
  assert.match(skillContent, /\.\.\/\.\.\/docs\/sub-issue-tree-contract\.md/i);
});
test("sub-issue tree contract documents the workflow, helper commands, and lean-body rule", async () => {
  const contractContent = await readRepo("docs/sub-issue-tree-contract.md");
  assert.match(contractContent, /manage-sub-issues\.mjs/i);
  assert.match(contractContent, /list/i);
  assert.match(contractContent, /add/i);
  assert.match(contractContent, /reorder/i);
  assert.match(contractContent, /verify/i);
  assert.match(contractContent, /Default decomposition flow[\s\S]*gh issue create --assignee @me[\s\S]*verify/i);
  assert.match(contractContent, /verify.*mismatch-only.*exit 0|exits 0 for mismatch-only results/i);
  assert.match(contractContent, /lean/i);
  assert.match(contractContent, /do not maintain.*checklist.*duplicates|not.*maintain.*ordered checklist.*duplicates/i);
  assert.match(contractContent, /When to use sub-issues vs plain related-issue references/i);
  assert.match(contractContent, /dev-loop/i);
});
test("docs index references sub-issue-tree-contract.md", async () => {
  const indexContent = await readRepo("docs/index.md");
  assert.match(indexContent, /sub-issue-tree-contract\.md/i);
});
