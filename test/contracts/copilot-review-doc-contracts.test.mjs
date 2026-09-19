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
import { assertRuleOwned, assertRulePresent, extractOwnedText } from "./_rule-helpers.mjs";
import { extractRelativeMarkdownLinks } from "../../scripts/docs/validate-links.mjs";
import { extractRuleReferences } from "../../scripts/docs/validate-rule-ownership.mjs";
import { parseMarkdownSections } from "../../packages/core/src/loop/issue-refinement-artifact.mjs";

function assertReference(content, target) {
  const targets = extractRelativeMarkdownLinks(content).map(({ rawTarget }) => rawTarget.split("#")[0]);
  assert.ok(targets.includes(target), `missing required reference: ${target}`);
}

function extractStep(content, number) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## Step ${number}:`));
  assert.ok(start >= 0, `copilot-pr-followup Step ${number} section not found`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const ASYNC_DISPATCH_CLAUSE = "Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA. Do not stop or report completion without this evidence.";

function assertDispatchClause(step) {
  assert.ok(step.includes(ASYNC_DISPATCH_CLAUSE), "Step 6 must embed the pre-approval dispatch clause verbatim");
}

test("step extraction accepts renamed headings and wrapped prose without borrowing a sibling's payload", () => {
  for (const title of ["Async watch behavior", "Watch and resume"]) {
    const content = `## Step 6: ${title}\nRead the\nfollowing requirement.\n\n### Dispatch\n> ${ASYNC_DISPATCH_CLAUSE}\n\n## Step 7: Review feedback\nSibling.\n`;
    assertDispatchClause(extractStep(content, 6));
    assert.equal(extractStep(content, 7), "## Step 7: Review feedback\nSibling.\n");
  }
  assert.throws(() => extractStep("## Step 7: Review feedback\nMention ## Step 6: Watch", 6), /Step 6 section not found/);
  for (const boundary of ["## Step 7: Review feedback", "## Validation policy"]) {
    assert.throws(() => assertDispatchClause(extractStep(`## Step 6: Watch\nNo payload.\n${boundary}\n${ASYNC_DISPATCH_CLAUSE}`, 6)));
  }
  for (const changed of [
    ASYNC_DISPATCH_CLAUSE.replace("must complete", "may skip"),
    ASYNC_DISPATCH_CLAUSE.replace("current head SHA", "any head SHA"),
    ASYNC_DISPATCH_CLAUSE.toLowerCase(),
  ]) assert.throws(() => assertDispatchClause(changed));
});

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
  const devLoopStep7 = extractStep(copilotPrFollowupSkill, 7);
  const devLoopDraftGateMatch = devLoopStep7.match(/### Draft gate contract[\s\S]*?(?=\n### |$)/);
  const devLoopDraftGate = devLoopDraftGateMatch ? devLoopDraftGateMatch[0] : "";
  assert.ok(devLoopDraftGate.length > 0, "copilot-pr-followup draft-gate section not found inside Step 7");
  const devLoopPreApprovalMatch = devLoopStep7.match(/### Pre-approval gate contract[\s\S]*?(?=\n## |\n### |$)/);
  const devLoopPreApproval = devLoopPreApprovalMatch ? devLoopPreApprovalMatch[0] : "";
  assert.ok(devLoopPreApproval.length > 0, "copilot-pr-followup pre-approval gate section not found inside Step 7");
  assert.match(copilotPrFollowupSkill, /Canonical owner for the internal `copilot_pr_followup` route behind the public `dev-loop` façade/i);
  assert.match(copilotPrFollowupSkill, /canonical internal owner of the shared post-PR mechanics/i);
  assertRuleOwned("GATE-COMMENT-SCOPE-ONLY", "skills/docs/gate-review-comment-contract.md");
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

function assertValidationPolicyReference(template) {
  const section = parseMarkdownSections(template).find(({ level, name }) => level === 2 && name.toLowerCase() === "validation");
  assert.ok(section, "PR template must contain a Validation section");
  const references = extractRuleReferences(section.bodyLines.join("\n"), ".github/pull_request_template.md");
  assert.ok(references.some(({ id }) => id === "OPS-PR-VALIDATION-STABLE-EVIDENCE"), "Validation must reference its reporting-policy owner");
}

test("tracker-backed PR validation references its canonical policy and keeps the mirror in parity", async () => {
  const [operationsDoc, claudeMirror, template] = await Promise.all([
    readRepo("skills/docs/copilot-loop-operations.md"),
    readRepo(".claude/skills/docs/copilot-loop-operations.md"),
    readRepo(".github/pull_request_template.md"),
  ]);
  const ruleId = "OPS-PR-VALIDATION-STABLE-EVIDENCE";
  assertRuleOwned(ruleId, "skills/docs/copilot-loop-operations.md");
  assert.equal(claudeMirror, operationsDoc, "generated Claude contract mirror must remain byte-identical");
  assertValidationPolicyReference(template);
  // Reporting semantics have no executable policy validator. This checks owner
  // discovery/projection, not compliance; quantity exceptions and head-bound
  // details need scenario review recorded in the cleanup coverage artifact.
});

test("validation-policy reference accepts rewritten guidance but cannot be borrowed from another section", () => {
  const reference = "<!-- rule-ref: OPS-PR-VALIDATION-STABLE-EVIDENCE -->";
  for (const guidance of ["Record each check and its result.", "Give the command\nand stable outcome."]) {
    assertValidationPolicyReference(`## Validation\n${reference}\n${guidance}\n## Notes\nOther text.`);
  }
  for (const content of [
    "## Validation\nNo reference.",
    "## Validation\n<!-- rule-ref: OPS-DRAFT-FIRST-PR -->",
    `${reference}\n## Validation\nNo local reference.`,
    `## Validation\nNo local reference.\n## Notes\n${reference}`,
    `## Validation\n\x60\x60\x60text\n${reference}\n\x60\x60\x60`,
    `\x60\x60\x60markdown\n## Validation\n${reference}\n\x60\x60\x60`,
  ]) assert.throws(() => assertValidationPolicyReference(content));
});
test("copilot-pr-followup skill routes review requests and wait seams through deterministic helpers", async () => {
  const skillContent = await readRepo("skills/copilot-pr-followup/SKILL.md");
  const requestSectionMatch = skillContent.match(/<!-- rule: COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY -->[\s\S]*?(?=\n## Step 6:)/);
  const requestSection = requestSectionMatch ? requestSectionMatch[0] : "";
  assert.ok(requestSection.length > 0, "request/wait section not found");
  assert.match(requestSection, /request-copilot-review\.mjs/i);
  assert.match(requestSection, /--force-rerequest-review/i);
  assertRuleOwned("COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY", "skills/copilot-pr-followup/SKILL.md");
  assert.match(requestSection, /MUST NOT request Copilot by posting literal/i);
  assert.match(requestSection, /`requested`:/i);
  assert.match(requestSection, /`already-requested`:/i);
  assert.match(requestSection, /`suppressed_same_head_clean`:/i);
  assert.match(requestSection, /`unavailable`:/i);
  const step6 = extractStep(skillContent, 6);
  assert.match(step6, /detect-copilot-loop-state\.mjs/i);
  assert.match(step6, /dev-loops loop watch-cycle/i);
  assert.match(step6, /gh run watch <run-id> --repo <owner\/name>/i);
  assert.match(step6, /helper-owned sleep inside `dev-loops loop watch-cycle`, `dev-loops gate probe-copilot`, or `dev-loops loop watch-initial` is allowed/i);
  assert.match(step6, /agent-authored shell polling is forbidden/i);
  assert.match(step6, /for i in \$\(seq \.\.\.\)/i);
  assert.match(step6, /while true/i);
  assert.match(step6, /until \.\.\.; do sleep \.\.\.; done/i);
  // The manual-polling prohibition is elaboration of COPILOT-FOLLOWUP-WAIT-TOOLS
  // (the deterministic-wait-tools rule owned in this same skill file); loose
  // token instead of the full enumerated CLI-list sentence (#1205).
  assertRuleOwned("COPILOT-FOLLOWUP-WAIT-TOOLS", "skills/copilot-pr-followup/SKILL.md");
  assert.match(step6, /do not wrap repeated/i);
});
test("watch policy references make the persistence owner available, without proving agent continuation", async () => {
  const [skillContent, operationsDoc] = await Promise.all([
    readRepo("skills/copilot-pr-followup/SKILL.md"),
    readRepo("skills/docs/copilot-loop-operations.md"),
  ]);
  assertReference(skillContent, "../docs/copilot-loop-operations.md");
  assertReference(skillContent, "../docs/wait-watch-procedure.md");
  assertReference(operationsDoc, "./copilot-loop-state-graph.md");
  assert.ok((await stat(fromRepoRoot("skills/docs/wait-watch-procedure.md"))).isFile());
  assertRuleOwned("COPILOT-STATE-WATCH-PERSISTENCE", "skills/docs/copilot-loop-state-graph.md");
  // run-watch-cycle/outer-loop tests cover executable pending/continue-wait results.
  // Agent continuation, handoff authorization and cumulative budgets require
  // semantic scenario review; these references cannot detect inverted prose.
});

test("watch policy references tolerate renamed labels and reflow, but require each target", () => {
  for (const target of ["../docs/copilot-loop-operations.md", "../docs/wait-watch-procedure.md", "./copilot-loop-state-graph.md"]) {
    for (const content of [
      `Read [Policy](${target}).`,
      `For this case, follow\nthe [operating contract](${target}#details).`,
    ]) assertReference(content, target);
    assert.throws(() => assertReference(`The policy is at \`${target}\`.`, target), /missing required reference/);
    assert.throws(() => assertReference("[Other policy](./unrelated.md)", target), /missing required reference/);
  }
});
test("copilot-pr-followup skill hardens reply-resolve, gate sequencing, and merge-ready checks", async () => {
  const skillContent = await readRepo("skills/copilot-pr-followup/SKILL.md");
  const step6 = extractStep(skillContent, 6);
  assert.match(
    step6,
    /Every async dev-loop dispatch task body must include this clause verbatim/i,
    "Step 6 should define canonical async dispatch wording",
  );
  // Intentional verbatim-contract pin, not a stray phrase pin: SKILL.md itself
  // mandates ("must include this clause verbatim") that this exact quoted
  // clause be reproduced unchanged in every async dispatch task body, so the
  // test asserts it byte-for-byte.
  assertDispatchClause(step6);
  const step7 = extractStep(skillContent, 7);
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
  assertRuleOwned("COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE", "skills/copilot-pr-followup/SKILL.md");
  // The four checks below are intentional behavioral coverage of the verification
  // checkpoint's specific sub-requirements (owned by COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE
  // above), not standalone exact-sentence contract pins.
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
  // Structural ordering check: the verification-checkpoint marker must appear
  // before the resolve-step phrase, content-anchored rather than by ordinal
  // list position (which is tautological for any numbered list).
  const verifyIndex = step7.indexOf("COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE");
  const resolveIndex = step7.indexOf("COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY");
  assert.ok(verifyIndex >= 0 && resolveIndex >= 0 && verifyIndex < resolveIndex, "verification checkpoint must appear before the resolve step");
  assertRuleOwned("COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY", "skills/copilot-pr-followup/SKILL.md");
  // Owned-text check — marker survival alone must not mask dropping the resolve-after-reply clause.
  assert.match(
    extractOwnedText(step7, "COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY"),
    /only after the reply is attached successfully/i,
  );
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
  // The "must be entered and completed before merge-ready" requirement is owned by
  // GATE-COMMENT-FAIL-CLOSED (rule-ID reference asserted below) rather than pinned as
  // prose here; "not recoverable by asserting convergence" is now GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE (#1159).
  assertRuleOwned("GATE-COMMENT-FAIL-CLOSED", "skills/docs/gate-review-comment-contract.md");
  assert.match(step7, /GATE-COMMENT-FAIL-CLOSED/, "pre-approval gate sequencing should reference the fail-closed rule ID");
  assertRuleOwned("GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE", "skills/copilot-pr-followup/SKILL.md");
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
    /merge-pr\.mjs/i,
    "mechanical pre-merge check should name the sanctioned merge wrapper as the canonical merge path",
  );
  assert.match(
    step7,
    /raw `gh pr merge` is forbidden/i,
    "the skill should forbid a raw gh pr merge in favor of the wrapper",
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

  const step7 = extractStep(skillContent, 7);

  assert.match(step7, /resolveRefinementConfig\(config, "maxCopilotRounds"\)/i);
  assert.match(step7, /default config ships `maxCopilotRounds: 5`/i);
  assert.match(step7, /completed Copilot review-round count/i);
  assert.match(step7, /if completed review rounds have reached the resolved round cap/i);
  assert.match(step7, /`deferred to follow-up` note/i);
  assert.match(step7, /stop and report that the Copilot round limit was reached/i);
  assertRuleOwned("COPILOT-FOLLOWUP-ROUND-CAP", "skills/copilot-pr-followup/SKILL.md");
});

test("copilot-pr-followup skill owns its procedural mechanics by rule ID (#1154)", async () => {
  // These are the loop procedure/round-cap/wait-semantics/re-request mechanics this
  // skill genuinely owns (per #1154); everything else routes to the state-graph,
  // gate-comment, or gate-exec owner docs by ID instead of restating.
  for (const id of [
    "COPILOT-FOLLOWUP-WAIT-TOOLS",
    "COPILOT-FOLLOWUP-REQUEST-BRANCHING",
    "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
    "COPILOT-FOLLOWUP-ROUND-CAP",
    "COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING",
  ]) {
    assertRulePresent(id);
    assertRuleOwned(id, "skills/copilot-pr-followup/SKILL.md");
  }
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
  // Entrypoint-thinness is agent-surface routing guidance (agents own no rules);
  // the loose /must stay thin/i token is the structural check (#1159).
  assert.match(agentContent, /must stay thin/i);
  assert.match(agentContent, /deterministic public routing contract/i);
  assert.doesNotMatch(agentContent, /compatibility\/internal entrypoints during migration/i);
  // Disagreeing-facts fail-closed semantics are owned by STOP-RECONCILE-001;
  // the agent surface keeps a loose stop-and-ask token, not the exact sentence (#1159).
  assertRuleOwned("STOP-RECONCILE-001", "skills/docs/stop-conditions.md");
  assert.match(agentContent, /stop and ask for human direction rather than guessing/i);
  assert.match(skillContent, /public `dev-loop` façade/i);
});
test("canonical contract docs carry their expected contract content", async () => {
  const [trackerCanonical, conductorContent, ciContent, operationsContent] = await Promise.all([
    readRepo("skills/docs/tracker-first-loop-state.md"),
    readRepo("skills/docs/conductor-routing-contract.md"),
    readRepo("skills/docs/copilot-ci-status-contract.md"),
    readRepo("skills/docs/copilot-loop-operations.md"),
  ]);
  assert.match(trackerCanonical, /Tracker-First Story-to-PR Contract/i);
  assert.match(trackerCanonical, /MVP invariant: one tracker work item → one GitHub PR/i);
  assert.match(conductorContent, /Conductor Routing Contract/i);
  assert.match(conductorContent, /conductor routing contract/i);
  assert.match(ciContent, /Copilot PR CI\/check normalization contract/i);
  assert.match(ciContent, /canonical bundled contract/i);
  // The operational boundary must load the authoritative tracker contract;
  // copying its ownership/link/reverse-sync prose is not another authority.
  const authority = parseMarkdownSections(operationsContent).find(({ name }) => name === "Deterministic orchestration authority");
  assert.ok(authority);
  assertReference(authority.bodyLines.join("\n"), "./tracker-first-loop-state.md");
  assertRuleOwned("TRACKER-ONE-ACTIVE-PR", "skills/docs/tracker-first-loop-state.md");
  assertRuleOwned("TRACKER-BLOCKED-FAIL-CLOSED", "skills/docs/tracker-first-loop-state.md");
});
test("new See Also markdown links resolve from docs files", async () => {
  const linkTargetsByDoc = {
    "skills/docs/gate-review-comment-contract.md": [
      "../copilot-pr-followup/SKILL.md",
      "../final-approval/SKILL.md",
      "./pr-lifecycle-contract.md",
      "./gate-review-sub-loop-contract.md",
    ],
    "skills/docs/gate-review-sub-loop-contract.md": [
      "gate-review-comment-contract.md",
      "./pr-lifecycle-contract.md",
      "../copilot-pr-followup/SKILL.md",
      "../local-implementation/SKILL.md",
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
  const ownerPath = "skills/docs/gate-review-comment-contract.md";
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
  assertRuleOwned("GATE-COMMENT-NON-SUBSTITUTION", "skills/docs/gate-review-comment-contract.md");
  assert.match(devLoopDraftGate, /GATE-COMMENT-NON-SUBSTITUTION/);
  // Comment field content, the draft-boundary requirement, and fail-closed behavior are
  // single-owner rules in the checkpoint verdict comment contract; this skill references
  // them by ID rather than restating the phrase-pinned prose (#1154).
  assertRuleOwned("GATE-COMMENT-VALIDATION-REPORTING", "skills/docs/gate-review-comment-contract.md");
  assertRuleOwned("GATE-COMMENT-DRAFT-REQUIREMENTS", "skills/docs/gate-review-comment-contract.md");
  assertRuleOwned("GATE-COMMENT-FAIL-CLOSED", "skills/docs/gate-review-comment-contract.md");
  assert.match(devLoopDraftGate, /GATE-COMMENT-VALIDATION-REPORTING/);
  assert.match(devLoopDraftGate, /GATE-COMMENT-DRAFT-REQUIREMENTS/);
  assert.match(devLoopDraftGate, /GATE-COMMENT-FAIL-CLOSED/);

  const devLoopPreApprovalGateMatch = copilotPrFollowupSkill.match(/### Pre-approval gate contract[\s\S]*?(?=\n### |\n## |$)/);
  const devLoopPreApprovalGate = devLoopPreApprovalGateMatch ? devLoopPreApprovalGateMatch[0] : "";
  assert.ok(devLoopPreApprovalGate.length > 0, "copilot-pr-followup pre-approval gate section not found");
  assert.match(devLoopPreApprovalGate, /Required PR comment/i);
  assert.match(devLoopPreApprovalGate, /`pre_approval_gate`/);
  assert.match(devLoopPreApprovalGate, /head SHA/i);
  assert.match(devLoopPreApprovalGate, /GATE-COMMENT-NON-SUBSTITUTION/);
  // The "must be entered and completed before merge-ready" gate-boundary requirement is
  // owned by GATE-COMMENT-FAIL-CLOSED (asserted below); the "not recoverable by asserting
  // convergence" caution is now GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE (#1159).
  assertRuleOwned("GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE", "skills/copilot-pr-followup/SKILL.md");
  assertRuleOwned("GATE-COMMENT-PREAPPROVAL-REQUIREMENTS", "skills/docs/gate-review-comment-contract.md");
  assert.match(devLoopPreApprovalGate, /GATE-COMMENT-VALIDATION-REPORTING/);
  assert.match(devLoopPreApprovalGate, /GATE-COMMENT-PREAPPROVAL-REQUIREMENTS/);
  assert.match(devLoopPreApprovalGate, /GATE-COMMENT-FAIL-CLOSED/);
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
  assertRuleOwned("SUBISSUE-NO-ADHOC-BYPASS", "skills/docs/sub-issue-tree-contract.md");
  assertRuleOwned("SUBISSUE-LEAN-BODY-NO-DUPLICATE", "skills/docs/sub-issue-tree-contract.md");
  assert.match(skillContent, /SUBISSUE-NO-ADHOC-BYPASS/);
  assert.match(skillContent, /SUBISSUE-LEAN-BODY-NO-DUPLICATE/);
  assert.match(skillContent, /sub-issue-tree-contract\.md/i);
  assert.match(skillContent, /\.\/sub-issue-tree-contract\.md/i);
});
test("sub-issue tree contract documents the workflow, helper commands, and lean-body rule", async () => {
  const contractContent = await readRepo("skills/docs/sub-issue-tree-contract.md");
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
// #1993: the sanctioned close-gate-findings disposition-pass invocation MUST carry
// --allowed-refs <governing-issue> so a deferred finding that cites the PR's own
// governing issue is not fail-closed by close-gate-findings.mjs's bare-#N comment-id
// guard (shipped in #1992). The flag was plumbed through the script but the SKILL
// invocation was never updated, leaving #1992 inert. This pins the wire across every
// sanctioned invocation (source + .claude mirror) and guards against regressing to a
// bare `--ledger`-only call.
function assertGoverningIssueArgument(content, label) {
  // Match executable examples, not bare mentions of the script in prose.
  const matches = [...content.matchAll(/close-gate-findings\.mjs --ledger <[^>]+>([^\n`]*)/g)];
  assert.ok(matches.length > 0, `${label} must contain a close-gate-findings invocation`);
  for (const match of matches) {
    const values = [...match[1].matchAll(/(?:^|\s)--allowed-refs\s+(\S+)/g)].map((entry) => entry[1]);
    assert.deepEqual(values, ["<governing-issue>"], `${label}: each invocation must use --allowed-refs <governing-issue>, never a hardcoded issue`);
  }
}

test("sanctioned close-gate-findings invocations pass --allowed-refs <governing-issue> (source + mirror)", async () => {
  const invocationDocs = [
    "skills/copilot-pr-followup/SKILL.md",
    ".claude/skills/copilot-pr-followup/SKILL.md",
    "skills/docs/gate-review-sub-loop-contract.md",
    ".claude/skills/docs/gate-review-sub-loop-contract.md",
  ];
  for (const relPath of invocationDocs) {
    assertGoverningIssueArgument(await readRepo(relPath), relPath);
  }
});
test("governing-issue argument checks tolerate prose edits and reject missing or wrong values", () => {
  // This checks the documented argument, not whether an agent selects the real
  // closing issues. Closing-reference/umbrella/no-issue decisions need semantic
  // review; close-gate-findings runtime tests cover unrelated-reference refusal.
  const command = "close-gate-findings.mjs --ledger <ledger>";
  for (const prose of ["Resolve the closing issues.", "Use the governing\nissue references."]) {
    assertGoverningIssueArgument(`${prose}\n\`${command} --allowed-refs <governing-issue>\``, "fixture");
  }
  assert.throws(() => assertGoverningIssueArgument("No invocation.", "fixture"));
  for (const suffix of ["", " --allowed-refs", " --allowed-refs 2236", " --allowed-refs <unrelated-issue>", " --allowed-refs <governing-issue> --allowed-refs 2236"]) {
    assert.throws(() => assertGoverningIssueArgument(`\`${command}${suffix}\``, "fixture"));
  }
});
