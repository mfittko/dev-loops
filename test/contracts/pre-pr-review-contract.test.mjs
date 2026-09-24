import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { loadDevLoopConfig, resolveRoleModel } from "@dev-loops/core/config";

import { assertRulePresent, assertRuleOwned } from "./_rule-helpers.mjs";

// Behavioral/contract pins for the pre-PR review phase (issue #2305): a
// developer-briefed, fresh-context, general-purpose review pass that runs
// before the first push, fixes findings in-tree, is ephemeral (no
// PR/thread/Copilot), bounded to one reviewer / two rounds, and leaves the
// fan-out gate as the authority. The model is config-resolved (never hardcoded).

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const CONTRACT = "skills/docs/pre-pr-review-contract.md";
const SKILL = "skills/local-implementation/SKILL.md";

const CONTRACT_RULES = [
  "PRE-PR-BEFORE-FIRST-PUSH",
  "PRE-PR-ONE-FRESH-REVIEWER",
  "PRE-PR-BOUNDED-TWO-ROUNDS",
  "PRE-PR-EPHEMERAL-NO-ARTIFACTS",
  "PRE-PR-MODEL-CONFIG-RESOLVED",
  "PRE-PR-GATE-STILL-AUTHORITY",
  "PRE-PR-NOT-GATE-EVIDENCE",
];

// The prose paragraph owned by a rule: from its marker to the next rule marker,
// heading, or blank line. Keyword checks run inside this slice so a pin cannot
// pass on text that belongs to a different rule, and stays robust to rewording.
function ruleParagraph(doc, id) {
  const marker = new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`);
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((l) => marker.test(l));
  assert.ok(start !== -1, `rule ${id} marker must be present in ${CONTRACT}`);
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && (/^<!--\s*rule:/.test(line) || /^#{1,6}\s/.test(line) || line.trim() === "")) break;
    out.push(line);
  }
  return out.join("\n");
}

test("pre-PR contract rules are present and owned by the contract doc", () => {
  for (const id of CONTRACT_RULES) {
    assertRulePresent(id);
    assertRuleOwned(id, CONTRACT);
  }
});

test("the local-implementation SKILL wires the phase before first push and references the contract", () => {
  assertRulePresent("LOCAL-PRE-PR-REVIEW-BEFORE-PUSH");
  assertRuleOwned("LOCAL-PRE-PR-REVIEW-BEFORE-PUSH", SKILL);
  const skill = readRepo(SKILL);
  assert.ok(skill.includes("pre-pr-review-contract.md"), "SKILL must link the pre-PR review contract");
  // The phase step (anchored on its rule marker, not a bold title) sits before
  // PR creation (step 12, the create-PR line).
  const stepIdx = skill.indexOf("<!-- rule: LOCAL-PRE-PR-REVIEW-BEFORE-PUSH -->");
  const prCreateIdx = skill.indexOf("create the PR from the working branch");
  assert.ok(stepIdx !== -1 && prCreateIdx !== -1 && stepIdx < prCreateIdx, "pre-PR review step must precede PR creation");
});

test("each pre-PR rule states its invariant with RFC-2119 modality and the right keywords", () => {
  const doc = readRepo(CONTRACT);
  // [rule, /modal/, [required keywords...]]
  const checks = [
    ["PRE-PR-BEFORE-FIRST-PUSH", /MUST/, ["before the first push", "committed"]],
    ["PRE-PR-ONE-FRESH-REVIEWER", /MUST/, ["exactly ONE", "fresh-context", "general-purpose", "brief"]],
    ["PRE-PR-BOUNDED-TWO-ROUNDS", /MUST NOT/, ["one general-purpose reviewer per round", "two", "reviewer"]],
    ["PRE-PR-EPHEMERAL-NO-ARTIFACTS", /MUST NOT/, ["pull request", "comment", "review thread", "copilot"]],
    ["PRE-PR-MODEL-CONFIG-RESOLVED", /MUST/, ["resolveRoleModel", "pre-push-reviewer", "non-null"]],
    ["PRE-PR-GATE-STILL-AUTHORITY", /MUST/, ["pre-filter", "draft_gate", "pre_approval_gate", "authority"]],
    ["PRE-PR-NOT-GATE-EVIDENCE", /MUST NOT/, ["gate evidence", "ledger"]],
  ];
  for (const [id, modal, keywords] of checks) {
    const para = ruleParagraph(doc, id);
    assert.match(para, modal, `${id} must carry RFC-2119 modality`);
    for (const kw of keywords) {
      assert.ok(para.toLowerCase().includes(kw.toLowerCase()), `${id} paragraph must mention "${kw}"`);
    }
  }
  // Adversarial-enumeration checklist floor.
  assert.match(doc, /adversarial-enumeration checklist/i);
  for (const item of ["errno", "symlink", "rename", "empty", "malformed", "path normalization"]) {
    assert.ok(doc.toLowerCase().includes(item), `checklist must name "${item}"`);
  }
});

test("no concrete model token is hardcoded in the phase prose or SKILL step (config-resolved only)", async () => {
  // The concrete model is a per-repo .devloops opt-in resolved via
  // resolveRoleModel; it must never be baked into the harness-agnostic phase
  // contract or its lifecycle wiring. The contract MAY name the accepted-token
  // vocabulary in the model-resolution paragraph (documenting the harness enum),
  // so scan every OTHER paragraph for a stray model literal.
  const bareModel = /\b(fable|opus|sonnet|haiku)\b/i;
  const fullId = /claude-[a-z0-9]+-\d/i;

  // A harness opt-in may resolve to a provider-qualified model id
  // (`provider/model`). Assert against the model ids THIS repo actually resolves
  // rather than a guessed id shape: a shape pattern cannot tell a model id from
  // an ordinary `dir/name-with-digit` path reference, so it would both over-match
  // real prose and miss a future id that does not fit the guess.
  const { config, errors } = await loadDevLoopConfig({ repoRoot });
  assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);
  // Non-vacuity: the token set must come from THIS repo's opt-in, not the
  // built-in fallback (`pre-push-reviewer` -> high -> `opus`/null), which would
  // satisfy the floor below while leaving the opted-in Pi token unguarded.
  assert.ok(
    config?.models?.tiers?.["pre-pr-strong"]?.pi,
    "the guard must resolve this repo's .devloops opt-in, not a built-in fallback",
  );
  const resolvedModels = ["claude", "pi"]
    .map((harness) => resolveRoleModel(config, { role: "pre-push-reviewer", harness }))
    .filter((model) => typeof model === "string" && model.length > 0);
  assert.ok(
    resolvedModels.length > 0,
    "this repo must resolve at least one pre-PR reviewer model for this guard to be meaningful",
  );
  const namesResolvedModel = (text) => {
    const haystack = text.toLowerCase();
    return resolvedModels.some((model) => haystack.includes(model.toLowerCase()));
  };

  // Positive control: the predicate must DETECT a hardcoded resolved model id, so
  // a future edit that neuters it cannot pass this pin silently.
  for (const model of resolvedModels) {
    assert.ok(
      namesResolvedModel(`the pre-PR phase runs on ${model}`),
      `predicate must detect the resolved model id ${model}`,
    );
  }

  const contract = readRepo(CONTRACT);
  const modelPara = ruleParagraph(contract, "PRE-PR-MODEL-CONFIG-RESOLVED");
  const contractRest = contract.replace(modelPara, "");
  // The model-resolution paragraph may document the Claude token enum, so it is
  // excluded from the bare-token scan above. Any resolved token OUTSIDE that
  // enum is a hardcode, not documentation, and must not appear there.
  for (const model of resolvedModels.filter((m) => !/^(sonnet|opus|haiku|fable)$/i.test(m))) {
    assert.ok(
      !modelPara.toLowerCase().includes(model.toLowerCase()),
      `model-resolution rule must not name the resolved non-Claude model id ${model}`,
    );
  }
  assert.ok(contractRest.length > 0, "the contract scan surface must be non-empty");
  assert.ok(!bareModel.test(contractRest), "contract must not name a concrete model outside the model-resolution rule");
  assert.ok(!fullId.test(contractRest), "contract must not embed a full model id outside the model-resolution rule");
  assert.ok(!namesResolvedModel(contractRest), "contract must not name a resolved harness model id outside the model-resolution rule");

  // The SKILL's pre-PR step must not name any concrete model at all.
  const skill = readRepo(SKILL);
  const stepStart = skill.indexOf("<!-- rule: LOCAL-PRE-PR-REVIEW-BEFORE-PUSH -->");
  const stepEnd = skill.indexOf("\n12.", stepStart);
  const step = skill.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);
  assert.ok(step.length > 0, "the SKILL pre-PR step scan surface must be non-empty");
  assert.ok(!bareModel.test(step), "SKILL pre-PR step must not name a concrete model");
  assert.ok(!fullId.test(step), "SKILL pre-PR step must not embed a full model id");
  assert.ok(!namesResolvedModel(step), "SKILL pre-PR step must not name a resolved harness model id");
});

// The pre-PR trigger is a session property (pushes and opens a
// PR), not a route property. GitHub-first routes reach the same step at
// OPS-DRAFT-FIRST-PR; the local route keeps step 11b.
const OPS = "skills/docs/copilot-loop-operations.md";

test("PRE-PR-BEFORE-FIRST-PUSH is route-neutral and names the GitHub-first placement", () => {
  const para = ruleParagraph(readRepo(CONTRACT), "PRE-PR-BEFORE-FIRST-PUSH");
  const flat = para.replace(/\s+/g, " ");
  assert.ok(!flat.includes("local-implementation session that pushes"), "scope must not be limited to local-implementation sessions");
  assert.ok(flat.includes("whichever route the startup resolver selected"), "rule must state the scope is route-neutral");
  assert.ok(para.includes("OPS-DRAFT-FIRST-PR"), "rule must name the GitHub-first placement");
  assert.ok(para.includes("copilot-loop-operations.md"), "rule must link Copilot Loop Operations");
  assert.ok(/opens no PR has no pre-PR step/.test(flat), "rule must state that a session opening no PR has no pre-PR step");
});

test("OPS-DRAFT-FIRST-PR references the pre-PR review before the create-pr.mjs MUST-use line", () => {
  const ops = readRepo(OPS);
  const start = ops.indexOf("<!-- rule: OPS-DRAFT-FIRST-PR -->");
  const createIdx = ops.indexOf("MUST use `node <resolved-skill-scripts>/github/create-pr.mjs --repo", start);
  assert.ok(start !== -1 && createIdx !== -1, "OPS-DRAFT-FIRST-PR block and its create-pr.mjs line must exist");
  const block = ops.slice(start, createIdx);
  assert.ok(block.includes("PRE-PR-BEFORE-FIRST-PUSH"), "block must cite PRE-PR-BEFORE-FIRST-PUSH before create-pr.mjs");
  assert.ok(block.includes("pre-pr-review-contract.md"), "block must link the pre-PR review contract before create-pr.mjs");
});

test("every PR-creating route loads Copilot Loop Operations or the local SKILL", () => {
  const skill = readRepo("skills/dev-loop/SKILL.md");
  const row = (route) => {
    const line = skill.split("\n").find((l) => l.startsWith(`| \`${route}\` |`));
    assert.ok(line, `route table must have a ${route} row`);
    return line;
  };
  assert.ok(row("local_implementation").includes("../local-implementation/SKILL.md"));
  assert.ok(readRepo(SKILL).includes("<!-- rule: LOCAL-PRE-PR-REVIEW-BEFORE-PUSH -->"));
  for (const route of ["issue_intake", "copilot_pr_followup"]) {
    assert.ok(row(route).includes("copilot-loop-operations.md"), `${route} must load Copilot Loop Operations`);
  }
  for (const route of ["external_pr_followup", "reviewer_fixer", "final_approval"]) {
    assert.ok(row(route).includes("same as `copilot_pr_followup`"), `${route} must inherit the copilot_pr_followup pack`);
  }
  // Runtime requiredReads: STRATEGY_REQUIRED_READS is not exported, so slice
  // each strategy entry from the resolver source text.
  const resolver = readRepo("scripts/loop/resolve-dev-loop-startup.mjs");
  for (const route of ["issue_intake", "copilot_pr_followup", "external_pr_followup", "reviewer_fixer", "final_approval"]) {
    const start = resolver.indexOf(`  ${route}: [`);
    const end = start === -1 ? -1 : resolver.indexOf("],", start);
    assert.ok(start !== -1 && end !== -1, `STRATEGY_REQUIRED_READS entry for ${route} must exist in the startup resolver`);
    assert.ok(
      resolver.slice(start, end).includes('"skills/docs/copilot-loop-operations.md"'),
      `${route} runtime requiredReads must include skills/docs/copilot-loop-operations.md`,
    );
  }
  // issue_intake is the GitHub-first route that starts with no PR, so it loads the contract.
  const intakeStart = resolver.indexOf("  issue_intake: [");
  assert.ok(
    resolver.slice(intakeStart, resolver.indexOf("],", intakeStart)).includes('"skills/docs/pre-pr-review-contract.md"'),
    "issue_intake runtime requiredReads must include skills/docs/pre-pr-review-contract.md",
  );
});

// Delta mode: one fresh reviewer between the gate act-list fix commit and its
// push. The contract owns the rules; the SKILL and fixer only cross-reference.
const DELTA_RULES = [
  ["PRE-PUSH-DELTA-TRIGGER", /MUST NOT/, ["act list", "before that fix is pushed", "no act-list fix"]],
  ["PRE-PUSH-DELTA-PINNED-BASELINE", /MUST/, ["reviewBaselineHead..candidateHead", "A..C", "B..C", "new gate round"]],
  ["PRE-PUSH-DELTA-INPUT", /MUST NOT/, ["judge dispositions", "spec identity", "surface hints", "checklist", "diff bytes", "sibling reviewer verdicts", "widenedReads[]"]],
  ["PRE-PUSH-DELTA-RESULT", /MUST/, ["resolved", "not_resolved", "cannot_verify", "widenedReads[]", "missing or unknown status"]],
  ["PRE-PUSH-DELTA-EXIT-BOUND", /MUST NOT/, ["locally_clear", "medium or higher", "three", "bounded_out", "no fourth review", "normal gate path"]],
  ["PRE-PUSH-DELTA-FRESHNESS", /MUST NOT/, ["candidateHead", "current worktree head", "authorize the push"]],
  ["PRE-PUSH-DELTA-NOT-GATE-EVIDENCE", /MUST NOT/, ["gate verdict", "ledger", "thread", "fan-out", "authorize merge"]],
];

test("delta-mode rules are registered, owned by the contract, and state their invariant", () => {
  const doc = readRepo(CONTRACT);
  for (const [id, modal, keywords] of DELTA_RULES) {
    assertRulePresent(id);
    assertRuleOwned(id, CONTRACT);
    const para = ruleParagraph(doc, id);
    assert.match(para, modal, `${id} must carry RFC-2119 modality`);
    for (const kw of keywords) {
      assert.ok(para.toLowerCase().includes(kw.toLowerCase()), `${id} paragraph must mention "${kw}"`);
    }
  }
  assert.ok(doc.includes("Full mode is unchanged by delta mode."), "contract must state full mode is unchanged");
  assert.ok(doc.includes("`pre-push-reviewer` role and its two bounded modes"), "contract must name the one role with two modes");
});

test("the gate fix pass and the fixer cross-reference delta mode between the fix commit and the push", () => {
  const skill = readRepo("skills/dev-loop/SKILL.md");
  const actListIdx = skill.indexOf("The fix pass consumes ONLY `--out`'s act list");
  const deltaIdx = skill.indexOf("`PRE-PUSH-DELTA-TRIGGER`");
  assert.ok(actListIdx !== -1 && deltaIdx > actListIdx, "dev-loop SKILL must wire delta mode after the act-list fix pass");
  assert.ok(skill.slice(deltaIdx - 400, deltaIdx + 400).includes("pre-pr-review-contract.md#delta-mode"));

  const fixer = readRepo("agents/fixer.agent.md");
  const commitIdx = fixer.indexOf("7. Create a focused commit");
  const fixerDeltaIdx = fixer.indexOf("PRE-PUSH-DELTA-TRIGGER");
  const pushIdx = fixer.indexOf("8. Push the commit");
  assert.ok(commitIdx < fixerDeltaIdx && fixerDeltaIdx < pushIdx, "fixer must run delta mode after the commit and before the push");
  assert.match(fixer.slice(commitIdx, pushIdx), /hand back the commit SHA unpushed/);
});

test("no pre-PR-reviewer role key remains in config, code or contract prose (no alias)", () => {
  const oldRole = ["pre", "PR", "reviewer"].join("-");
  const out = spawnSync(
    "git",
    // config.mjs names the old key only in its rename diagnostic.
    ["grep", "-l", oldRole, "--", ".devloops", "packages", "scripts", "cli", "skills", "agents", ".claude", ":(exclude,glob)packages/*/test/**", ":!packages/core/src/config/config.mjs"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(out.stdout.trim(), "", `old role key found in: ${out.stdout}`);
});

test("main-agent contract cites the route-neutral PRE-PR-BEFORE-FIRST-PUSH scope", () => {
  const doc = readRepo("skills/docs/main-agent-contract.md").replace(/\s+/g, " ");
  assert.ok(/that pushes and opens a PR \(the scope `PRE-PR-BEFORE-FIRST-PUSH`/.test(doc), "sub-delegate sentence must cite PRE-PR-BEFORE-FIRST-PUSH");
});
