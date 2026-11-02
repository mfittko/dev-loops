import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideBashGate } from "@dev-loops/core/claude/hook-decisions";
import { BASH_GATE_RULES, decideBashGateDeny, prReadySegmentsProvenForeign } from "@dev-loops/core/loop/bash-gate-decisions";
import { createPiBashGateFactsResolver } from "../../extension/bash-gate-facts.ts";
import { decidePiToolCall } from "../../extension/readonly-role-gate.ts";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

// Issue #2965 AC2/AC3. One shared deny decision (loop/bash-gate-decisions.mjs) backs both the
// Claude PreToolUse Bash gate and the Pi `tool_call` handler, so the two harnesses must return the
// same verdict for the same command, and every rule must carry an explicit Pi verdict that the
// cross-harness contract states.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SLUG = "mfittko/dev-loops";
const CONTRACT = path.join(repoRoot, "skills/docs/cross-harness-regression-contract.md");
const REQUIRED_RULES = path.join(repoRoot, "skills/docs/required-rules.json");
const DECIDER_SOURCE = path.join(repoRoot, "packages/core/src/loop/bash-gate-decisions.mjs");

const MANAGED = Object.freeze({
  inManagedContext: true,
  managedRepoSlug: SLUG,
  repoSlug: SLUG,
  humanMergeOnly: false,
  enforceCoordinator: false,
  readyGate: Object.freeze({ passed: false, error: null }),
});

/**
 * One command per Bash-gate rule, with the facts that rule needs. `ruleId` is the verdict the
 * shared decision must produce (`null` for the two inline denies that carry no registered rule ID);
 * the AC3 parity loop runs the same fixtures through both adapters.
 */
const FIXTURES = Object.freeze([
  { ruleId: "COORDINATOR-VERIFY-BOUNDARY", command: "bun run verify", role: "dev-loop", facts: { enforceCoordinator: true } },
  { ruleId: "OPS-NO-INLINE-INTERPRETER", command: 'node -e "console.log(1)"' },
  { ruleId: "COPILOT-FOLLOWUP-WAIT-TOOLS", command: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &" },
  { ruleId: null, command: `timeout 300 dev-loops-run scripts/github/merge-pr.mjs --repo ${SLUG} --pr 5` },
  { ruleId: "SUBISSUE-NO-ADHOC-BYPASS", command: `gh api -X POST repos/${SLUG}/issues/5/sub_issues -f child=6` },
  { ruleId: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER", command: `gh api -X POST repos/${SLUG}/pulls/5/comments/10/replies -f body=hi` },
  { ruleId: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY", command: `gh api -X POST repos/${SLUG}/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent` },
  { ruleId: "ADR-TRIPWIRE-STANDING-WAIVER", command: "gh pr edit 5 --body-file pr.md" },
  { ruleId: "WORKTREE-NO-STASH", command: "git stash" },
  { ruleId: null, command: "gh issue create --title x --body y", role: "developer" },
  { ruleId: "STOP-HUMAN-MERGE-001", command: "gh pr merge 5 --squash", facts: { humanMergeOnly: true } },
  { ruleId: "OPS-DRAFT-FIRST-PR", command: "gh pr create --fill" },
  { ruleId: "RAW-GH-PR-MERGE-BYPASS", command: "gh pr merge 5 --squash" },
  { ruleId: "GATE-COMMENT-DRAFT-REQUIREMENTS", command: "gh pr ready 5" },
]);

// Commands both gates must let through, including the proven-foreign and gate-passed escapes.
const ALLOW_FIXTURES = Object.freeze([
  "gh pr view 5",
  "npm test",
  "node scripts/github/comment-issue.mjs 5",
  "gh pr merge --repo other/repo 5",
]);

// Roles for which the Pi read-only role gate adds nothing beyond the shared decision, so the two
// adapters must agree exactly (`judge`/`review` are additionally restricted on Pi by #2509).
const PARITY_ROLES = Object.freeze([null, "developer", "fixer", "quality", "docs", "dev-loop", "gate-coordinator", "refiner"]);

/** The Claude Bash-gate verdict, given the same facts the Pi handler injects. */
function claudeAllows(command, role, facts) {
  return decideBashGate({
    command,
    agentType: role,
    repoSlug: facts.repoSlug,
    managedRepoSlug: facts.managedRepoSlug,
    inManagedContext: facts.inManagedContext,
    humanMergeOnly: facts.humanMergeOnly,
    enforceCoordinator: facts.enforceCoordinator,
    gatePassed: facts.readyGate?.passed === true,
    gateError: facts.readyGate?.error ?? null,
  }).decision === "allow";
}

const piBlocks = (command, role, facts) => decidePiToolCall({ toolName: "bash", input: { command }, agentType: role, facts }).block;

const BASH_HOOK = path.join(repoRoot, ".claude/hooks/pre-tool-use-bash-gate.mjs");
const hookEnv = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });

/**
 * The REAL Claude PreToolUse hook script, driven through its stdin payload — the same harness
 * `test/loop/bash-gate-hook-precheck.test.mjs` uses.
 */
function claudeHookDecision(cwd, command, agentType) {
  const input = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType !== undefined) input.agent_type = agentType;
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: hookEnv() });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { allows: (out?.permissionDecision ?? "allow") === "allow", reason: out?.permissionDecisionReason ?? "" };
}

/**
 * The Pi `exec` seam as a real shell, so `createPiBashGateFactsResolver` performs the REAL reads:
 * real `git` for the identity, the real `.devloops` probe and the real config load.
 */
const shellExec = async (command, options = {}) => {
  try {
    const stdout = execFileSync("/bin/sh", ["-c", command], {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "", killed: false };
  } catch (error) {
    return {
      code: typeof error?.status === "number" ? error.status : 1,
      stdout: `${error?.stdout ?? ""}`,
      stderr: `${error?.stderr ?? ""}`,
      killed: Boolean(error?.signal),
    };
  }
};

/**
 * Every other test in this file hands both "adapters" the SAME hand-built facts object, so it cannot
 * see the place the harnesses actually diverge: fact GATHERING. This one drives the real Claude hook
 * script and the real Pi fact resolver against ONE managed-repo fixture, for the alternative deny
 * shapes the one-command-per-rule fixtures above do not carry (a graphql resolve mutation, the
 * `/copilot` summon comment, and a `gh api` body-field write).
 */
test("the real Claude hook and the real Pi fact resolver agree on the alternative deny shapes (#2965)", async () => {
  await withTempDir(
    async (dir) => {
      const root = path.join(await realpath(dir), "repo");
      await mkdir(root);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: hookEnv() });
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${SLUG}.git`], { cwd: root, env: hookEnv() });
      fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nautonomy:\n  humanMergeOnly: false\n", "utf8");
      const resolveFacts = createPiBashGateFactsResolver({ exec: shellExec, env: {} });
      const piDecision = async (command, role) =>
        decidePiToolCall({ toolName: "bash", input: { command }, agentType: role, facts: await resolveFacts({ cwd: root, command }) });
      // The Pi facts are resolved for real, not handed over: the fixture really is a managed repo.
      const resolved = await resolveFacts({ cwd: root, command: "gh pr view 7" });
      assert.deepEqual(
        { inManagedContext: resolved.inManagedContext, managedRepoSlug: resolved.managedRepoSlug },
        { inManagedContext: true, managedRepoSlug: SLUG },
      );
      // Each shape names the rule that must deny it on BOTH sides, so the agreement cannot come from
      // some other deny masking a harness that let the command through.
      for (const [command, ruleId] of [
        [`gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_x"}) { thread { isResolved } } }'`, "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER"],
        ["gh pr comment 7 --body '/copilot re-review'", "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY"],
        [`gh api -X PATCH repos/${SLUG}/pulls/7 -f body=x`, "ADR-TRIPWIRE-STANDING-WAIVER"],
      ]) {
        for (const role of [undefined, "developer", "review"]) {
          const claude = claudeHookDecision(root, command, role);
          assert.equal(claude.allows, false, `${command} as ${String(role)} on Claude`);
          assert.match(claude.reason, new RegExp(ruleId), `${command} as ${String(role)} on Claude names ${ruleId}`);
          const pi = await piDecision(command, role ?? null);
          assert.equal(pi.block, true, `${command} as ${String(role)} on Pi`);
          assert.match(pi.reason, new RegExp(ruleId), `${command} as ${String(role)} on Pi names ${ruleId}`);
        }
      }
      for (const command of ["gh pr view 7", "grep -n body README.md"]) {
        for (const role of [undefined, "developer"]) {
          assert.equal(claudeHookDecision(root, command, role).allows, true, `${command} as ${String(role)} on Claude`);
          assert.equal((await piDecision(command, role ?? null)).block, false, `${command} as ${String(role)} on Pi`);
        }
      }
    },
    { prefix: "dev-loops-pi-parity-" },
  );
});

// The resolver is the exported seam a parity or third adapter calls with the session's `cwd`, and it
// is the producer of the facts the shared decision reads. A cwd it cannot use must never reach
// `path.resolve` (which throws on a non-string, rejecting the `tool_call` handler so the command
// runs with no decision at all) or `exec` (an empty cwd resolves the HOST process directory, so the
// facts would describe a different repo than the session's). Either way STOP-HUMAN-MERGE-001,
// RAW-GH-PR-MERGE-BYPASS, WORKTREE-NO-STASH and the tripwire waiver deny stop being enforced.
test("the Pi facts resolver fails closed on a cwd it cannot probe (empty, blank or missing)", async () => {
  let execCalls = 0;
  const resolveFacts = createPiBashGateFactsResolver({
    exec: async () => {
      execCalls += 1;
      throw new Error("an unusable cwd must not reach exec");
    },
    env: {},
  });
  for (const cwd of ["", "   ", undefined]) {
    const facts = await resolveFacts({ cwd, command: "gh pr merge 7 --squash" });
    const label = JSON.stringify(cwd);
    assert.equal(facts.inManagedContext, true, `${label}: the managed context must stay on`);
    assert.equal(facts.managedRepoSlug, null, `${label}: the identity stays unresolved`);
    assert.equal(facts.repoSlug, null, `${label}: the identity stays unresolved`);
    // `humanMergeOnly = false` would fail STOP-HUMAN-MERGE-001 open (ADAPTER_FACTS), so the guard
    // records the managed repo's packaged default instead of defaulting the invariant permissively.
    assert.equal(facts.humanMergeOnly, true, `${label}: the human-merge invariant stays armed`);
    for (const [command, reason] of [
      ["gh pr merge 7 --squash", /STOP-HUMAN-MERGE-001/],
      ["gh pr merge --repo other/repo 5", /STOP-HUMAN-MERGE-001/],
      ["git stash", /git stash blocked/],
      ["gh pr create --fill", /gh pr create blocked/],
    ]) {
      const decision = decidePiToolCall({ toolName: "bash", input: { command }, agentType: null, facts });
      assert.equal(decision.block, true, `${label}: ${command} must stay denied`);
      assert.match(decision.reason, reason, `${label}: ${command} deny reason`);
    }
  }
  assert.equal(execCalls, 0, "neither the git probe nor path.resolve may see an unusable cwd");
});

test("every Bash-gate rule is enforced through the shared decision on Pi (AC2)", () => {
  for (const fixture of FIXTURES) {
    const role = fixture.role ?? null;
    const facts = { ...MANAGED, ...fixture.facts };
    const decision = decideBashGateDeny({
      command: fixture.command,
      role,
      repoSlug: facts.repoSlug,
      managedRepoSlug: facts.managedRepoSlug,
      inManagedContext: facts.inManagedContext,
      humanMergeOnly: facts.humanMergeOnly,
      enforceCoordinator: facts.enforceCoordinator,
      readyGate: facts.readyGate,
    });
    assert.equal(decision?.ruleId, fixture.ruleId, fixture.command);
    assert.ok(decision.reason.length > 0, `${fixture.ruleId} must explain the deny`);
    assert.equal(piBlocks(fixture.command, role, facts), true, `${fixture.ruleId} must be blocked on Pi`);
  }
  // One fixture per listed rule, no rule left without a command that trips it, and no fixture
  // claiming a rule ID the shared list does not carry.
  assert.deepEqual(FIXTURES.filter((f) => f.ruleId).map((f) => f.ruleId).sort(), BASH_GATE_RULES.map((r) => r.id).sort());
});

test("the two inline denies without a registered rule ID still block on both harnesses (#2965)", () => {
  for (const fixture of FIXTURES.filter((f) => f.ruleId === null)) {
    const role = fixture.role ?? null;
    const facts = { ...MANAGED, ...fixture.facts };
    assert.equal(piBlocks(fixture.command, role, facts), true, fixture.command);
    assert.equal(claudeAllows(fixture.command, role, facts), false, fixture.command);
  }
});

// The unresolve owner allowlist (issue 2577) is one of those inline denies, and it keys on the ROLE
// name alone — which both harnesses resolve — so it is shared rather than a Claude-edge rule. Pinned
// here because a Claude-only copy let a Pi fixer/developer/quality/gate-coordinator child run the
// script Claude denies.
test("the unresolve owner allowlist holds on both harnesses for every role (issue 2577)", () => {
  const command = `dev-loops-run scripts/github/unresolve-review-thread.mjs --repo ${SLUG} --pr 7 --thread-id T1`;
  for (const role of ["fixer", "developer", "quality", "docs", "review", "gate-coordinator"]) {
    const facts = { ...MANAGED };
    assert.equal(piBlocks(command, role, facts), true, `${role} on Pi`);
    assert.equal(claudeAllows(command, role, facts), false, `${role} on Claude`);
  }
  for (const role of [null, "dev-loop"]) {
    assert.equal(piBlocks(command, role, MANAGED), false, `${String(role)} owns the script`);
    assert.equal(claudeAllows(command, role, MANAGED), true, `${String(role)} owns the script`);
  }
});

// The ONE documented divergence, pinned with an explicit verdict on both sides instead of left to
// chance. The reviewer's shell-inert read/search form is decided BEFORE the shared deny on Pi (a
// quoted search text that spells a gated verb stays a read), while the shared classifiers split
// shell segments without quote awareness — so the Claude edge denies the same command. `PARITY_ROLES`
// excludes the read-only roles for exactly this reason, which is why the divergence needs its own
// assertion here and the matching sentence in the contract.
test("the reviewer's quoted read form is the one documented harness divergence (#2965)", () => {
  const command = "grep '; gh pr merge 42 ;' README.md";
  assert.equal(claudeAllows(command, "review", MANAGED), false, "the quote-blind shared classifier reads it as a merge on Claude");
  assert.equal(piBlocks(command, "review", MANAGED), false, "the Pi read/search decision runs first and keeps it a read");
  const contract = fs.readFileSync(CONTRACT, "utf8");
  assert.ok(contract.includes(command), "the cross-harness contract must name this exact command");
  assert.match(contract, /stays a read/, "the contract must state why the Pi side keeps it a read");
  // Outside that quoted-read escape the read-only roles agree exactly.
  for (const role of ["review", "judge"]) {
    assert.equal(claudeAllows("gh pr merge 42", role, MANAGED), !piBlocks("gh pr merge 42", role, MANAGED), String(role));
  }
});

test("the Claude and Pi adapters agree on every Bash-gate fixture (AC3, #1086)", () => {
  for (const fixture of FIXTURES) {
    const role = fixture.role ?? null;
    const facts = { ...MANAGED, ...fixture.facts };
    assert.equal(claudeAllows(fixture.command, role, facts), !piBlocks(fixture.command, role, facts), fixture.command);
  }
  for (const command of ALLOW_FIXTURES) {
    for (const role of PARITY_ROLES) {
      assert.equal(claudeAllows(command, role, MANAGED), true, `${command} as ${String(role)}`);
      assert.equal(piBlocks(command, role, MANAGED), false, `${command} as ${String(role)}`);
    }
  }
  // The gate-passed escape for `gh pr ready` agrees on both harnesses.
  const passed = { ...MANAGED, readyGate: { passed: true, error: null } };
  assert.equal(claudeAllows("gh pr ready 5", null, passed), !piBlocks("gh pr ready 5", null, passed));
  assert.equal(piBlocks("gh pr ready 5", null, passed), false);
  // The escape is scoped to the ONE PR that evidence describes, on both harnesses: one in-scope
  // target behind a proven-foreign leading segment still follows the probe result ...
  assert.equal(claudeAllows("gh pr ready --repo other/repo 1 && gh pr ready 5", null, passed), true);
  assert.equal(piBlocks("gh pr ready --repo other/repo 1 && gh pr ready 5", null, passed), false);
  // ... while a command naming SEVERAL in-scope PRs is refused before the single fact is read, so
  // one PR's clean draft_gate record can never clear another PR's draft status (#2965 review).
  for (const command of [
    "gh pr ready 5 && gh pr ready 6",
    "gh pr ready 5 && gh pr ready --repo other/repo 1 && gh pr ready 6",
    "gh pr ready --repo other/repo 1 && gh pr ready",
  ]) {
    assert.equal(claudeAllows(command, null, passed), false, `Claude Code must deny: ${command}`);
    assert.equal(piBlocks(command, null, passed), true, `Pi must deny: ${command}`);
  }
});

// The seam is the public surface a third adapter would call next, so a fact it forgets to inject
// must deny, never default. `role: null` and a nullable slug stay legitimate VALUES; an omitted or
// mistyped one does not.
const REQUIRED_ADAPTER_FACTS = Object.freeze(["role", "repoSlug", "managedRepoSlug", "inManagedContext", "humanMergeOnly", "enforceCoordinator"]);

test("the shared seam refuses a call that omits or mistypes an adapter fact (fail closed)", () => {
  for (const fact of REQUIRED_ADAPTER_FACTS) {
    const facts = { ...MANAGED, command: "gh pr merge 5 --squash", role: null };
    delete facts[fact];
    const denied = decideBashGateDeny(facts);
    assert.equal(denied?.ruleId, null, `${fact}: the missing-facts deny carries no registered rule ID`);
    assert.match(denied?.reason ?? "", /Bash gate blocked/, `${fact}: omitting the fact must deny`);
    assert.match(denied?.reason ?? "", new RegExp(fact), `${fact}: the deny names the missing fact`);
  }
  // The three booleans are the ones whose default failed open, so a non-boolean is refused too.
  for (const fact of ["inManagedContext", "humanMergeOnly", "enforceCoordinator"]) {
    assert.match(decideBashGateDeny({ ...MANAGED, command: "gh pr merge 5 --squash", role: null, [fact]: undefined })?.reason ?? "", /Bash gate blocked/, fact);
    assert.match(decideBashGateDeny({ ...MANAGED, command: "gh pr merge 5 --squash", role: null, [fact]: null })?.reason ?? "", /Bash gate blocked/, fact);
  }
  // A complete call still decides: `readyGate: null` means "not probed" and must stay accepted.
  assert.equal(decideBashGateDeny({ ...MANAGED, command: "gh pr view 5", role: null, readyGate: null }), null);
  assert.equal(decideBashGateDeny({ ...MANAGED, command: "gh pr merge 5 --squash", role: null, readyGate: null })?.ruleId, "RAW-GH-PR-MERGE-BYPASS");
  // An omitted readyGate keeps the "not probed" meaning rather than refusing the decision.
  const unprobed = { ...MANAGED, command: "gh pr ready 5", role: null };
  delete unprobed.readyGate;
  assert.equal(decideBashGateDeny(unprobed)?.ruleId, "GATE-COMMENT-DRAFT-REQUIREMENTS");
});

test("every Bash-gate rule ID is a registered rule in required-rules.json (the pin cannot shrink)", () => {
  // Without an independent anchor the list is circular: deleting a rule from BASH_GATE_RULES, the
  // fixtures AND the contract matrix in one commit would still pass every other assertion here.
  const registered = new Set(JSON.parse(fs.readFileSync(REQUIRED_RULES, "utf8")).requiredRules.map((rule) => (typeof rule === "string" ? rule : rule.id)));
  for (const rule of BASH_GATE_RULES) {
    assert.ok(registered.has(rule.id), `${rule.id}: must stay registered in skills/docs/required-rules.json`);
  }
});

test("every rule ID the shared decider returns is a listed rule with a stated Pi verdict (AC2)", () => {
  // BASH_GATE_RULES, FIXTURES and the contract table are three hand-maintained lists that the other
  // assertions compare only to EACH OTHER, so a brand-new deny rule added to the decider alone would
  // pass them all. Read the decider's own source instead: every `ruleId: "<ID>"` literal it can
  // return must appear in BASH_GATE_RULES (and therefore in the contract matrix one test down), so a
  // new rule cannot land without stating its Pi verdict there.
  const returned = new Set();
  for (const line of fs.readFileSync(DECIDER_SOURCE, "utf8").split("\n")) {
    const at = line.indexOf("ruleId:");
    if (at === -1) continue;
    // Only the literals in `ruleId` position: `ruleId: "ID"` and the `ruleId: cond ? "A" : "B"` form.
    for (const [, id] of line.slice(at).matchAll(/"([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)"/g)) returned.add(id);
  }
  assert.ok(returned.size > 0, "the decider source must return at least one registered rule ID");
  assert.deepEqual(
    [...returned].sort(),
    BASH_GATE_RULES.map((rule) => rule.id).sort(),
    "a deny rule returned by packages/core/src/loop/bash-gate-decisions.mjs must be added to BASH_GATE_RULES and state its Pi verdict in the cross-harness contract matrix (skills/docs/cross-harness-regression-contract.md)",
  );
});

// `prReadySegmentsProvenForeign` is the escape the Pi adapter consults BEFORE it spends the
// draft-gate probe, so it must answer exactly what the decider decides for the same facts. The
// normalization rule (trim, lowercase, `null` when empty) lives inside the escape: a caller that
// hands over the fact it just resolved — an empty slug, or a padded one — used to get the OPPOSITE of
// the decider's proven-foreign reading, and the adapter would then skip a probe the decider denies on
// (or spend the full probe timeout on a command the decider allows).
test("the adapter's proven-foreign escape normalizes the managed slug exactly as the decider does", () => {
  const facts = { ...MANAGED, role: null, repoSlug: "acme/widgets", managedRepoSlug: "acme/widgets" };
  const cases = [
    { managedSlug: " ACME/Widgets ", command: "gh pr ready --repo acme/widgets 7" }, // padded, same identity: NOT foreign
    { managedSlug: "", command: "gh pr ready --repo other/repo 7" }, // empty: unresolvable, never foreign
    { managedSlug: " ACME/Widgets ", command: "gh pr ready --repo other/repo 7" }, // genuinely foreign
    { managedSlug: "acme/widgets", command: "gh pr ready 7" }, // no explicit repo
  ];
  for (const { managedSlug, command } of cases) {
    const provenForeign = prReadySegmentsProvenForeign(command, managedSlug);
    // With `readyGate: null` ("not probed") the decider denies a non-foreign ready and passes a
    // proven-foreign one, so its verdict IS the escape's answer.
    const denied = decideBashGateDeny({ ...facts, managedRepoSlug: managedSlug, command, readyGate: null }) !== null;
    assert.equal(
      provenForeign,
      !denied,
      `${command} with managed slug ${JSON.stringify(managedSlug)}: the escape (${provenForeign}) must agree with the decision (denied: ${denied})`,
    );
  }
  assert.equal(
    prReadySegmentsProvenForeign("gh pr ready --repo other/repo 7", ""),
    false,
    "an empty slug is unresolvable and proves nothing foreign, exactly as the decider normalizes it",
  );
  assert.equal(
    prReadySegmentsProvenForeign("gh pr ready --repo acme/widgets 7", " ACME/Widgets "),
    false,
    "a padded slug names the same identity as the explicit repo, so the escape does not apply",
  );
});

test("the Bash-gate rule list pins each rule's Pi verdict against the cross-harness contract (AC2)", () => {
  const contractIds = [];
  const rows = new Map();
  for (const [, id, claude, pi, reason] of fs.readFileSync(CONTRACT, "utf8").matchAll(/^\| `([A-Z0-9-]+)` \| ([^|]*) \| ([a-z-]+) \| ([^|]*) \|$/gm)) {
    contractIds.push(id);
    rows.set(id, { claude: claude.trim(), pi: pi.trim(), reason: reason.trim() });
  }
  // Order-sensitive: the contract states this matrix lists the rules in evaluation order, so the
  // row order must be BASH_GATE_RULES' order, not merely the same set.
  assert.deepEqual(contractIds, BASH_GATE_RULES.map((rule) => rule.id), "the contract matrix must list exactly the Bash-gate rules in BASH_GATE_RULES order");
  for (const rule of BASH_GATE_RULES) {
    const row = rows.get(rule.id);
    assert.equal(row.pi, rule.pi, `${rule.id}: contract Pi verdict must match BASH_GATE_RULES`);
    assert.notEqual(row.claude, "", `${rule.id}: contract Claude verdict must not be empty`);
    if (rule.pi !== "enforced") {
      assert.ok(row.reason.length > 0 && row.reason !== "—", `${rule.id}: a non-enforced Pi verdict states its reason`);
    }
  }
});
