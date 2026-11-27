import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SUBCOMMAND_ROUTES } from "../../cli/index.mjs";
import { CONTRACT_FILE, CONTRACT_PINS, RUNBOOK_COMMAND, buildGateRunbook, runbookRuleIds } from "../../scripts/loop/gate-runbook.mjs";
import { gitEnvNoDirOverrides } from "../../scripts/loop/_repo-root-resolver.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = path.join(ROOT, "skills/docs");
const contract = readFileSync(path.join(DOCS, CONTRACT_FILE), "utf8");
const built = buildGateRunbook();
const runbook = built.runbook;
test("Codex retains a final tool recheck after the pre-claim capability check", () => {
  assert.match(runbook, /Recheck tools after preflight:.*collaboration\.spawn_agent/);
  assert.match(runbook, /Head or route may have changed/);
  for (const skill of ["dev-loop", "copilot-pr-followup"]) {
    const text = readFileSync(path.join(ROOT, "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, /actual tools for `collaboration\.spawn_agent`/);
    assert.match(text, /--codex-reviewer-spawn-unavailable/);
    assert.match(text, /coordinator work-order pull/);
  }
});
const RULE_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}\b/g;
const LAUNCHER = 'dev-loops-run --repo-root "$W" ';
// judge-pass prints its usage on --help but exits 1 (it reports the missing required arguments first).
const HELP_EXITS_ONE = new Set(["scripts/loop/judge-pass.mjs"]);

function run(args, options = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts/loop/gate-runbook.mjs"), ...args], { encoding: "utf8", ...options });
}

// Every backticked command in the runbook (launcher form and prefixless `gate <sub>` form), in text order.
function runbookCommands(text = runbook) {
  const commands = [];
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    const body = span.startsWith(LAUNCHER) ? span.slice(LAUNCHER.length) : span;
    const gate = body.match(/^(?:cli\/index\.mjs )?gate (\S+)/);
    const direct = body.match(/^(scripts\/\S+\.mjs)/);
    if (!gate && !direct) continue;
    const script = gate ? SUBCOMMAND_ROUTES.gate[gate[1]] : direct[1];
    commands.push({ span, script, name: gate ? gate[1] : path.basename(script, ".mjs"), flags: [...body.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]) });
  }
  return commands;
}

const commandOf = (name, predicate = () => true) => runbookCommands().find((c) => c.name === name && c.span.startsWith(LAUNCHER) && predicate(c.span));
const usageOf = (script) => {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), "--help"], { encoding: "utf8" });
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
};
// Whether a shell line leaves an expansion outside double quotes, where a spaced path or a JSON array would split.
const hasUnquotedExpansion = (span) => /\$[A-Za-z{(]/.test(span.replace(/"[^"]*"/g, '""'));
const shellArgs = (snippet, env) => spawnSync("sh", ["-c", `printf '%s\\n' ${snippet}`], { encoding: "utf8", env }).stdout.split("\n").slice(0, -1);

// The AC2 scan: a contract link is a procedure link unless it cites a rule or section and names no round procedure or the coordinator rule.
const CONTRACT_LINK = /\]\([^)]*gate-review-sub-loop-contract/;
const CITED_RULE = /`[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}`|\brules?\b|\bsections?\b/;
const PROCEDURE = /GATE-EXEC-GATE-COORDINATOR|gate[- ]coordinator.{0,80}(?:procedure|steps|round)|(?:procedure|steps|round).{0,80}gate[- ]coordinator|round procedure|\b(?:run|runs|running|execute|follows?)\b[^`]{0,40}\bround\b/i;
const linksAsProcedure = (line) => CONTRACT_LINK.test(line) && (!CITED_RULE.test(line) || PROCEDURE.test(line));

test("AC1: the runbook pins the exact command sequence and each contract-owned input binding", () => {
  assert.equal(built.ok, true);
  assert.equal(SUBCOMMAND_ROUTES.gate.runbook, "scripts/loop/gate-runbook.mjs");
  const names = runbookCommands().map((c) => c.name);
  assert.deepEqual(names, [
    "resolve-validation", "resolve-gate-dispatch", "write-findings-log", "write-gate-context", "spec-context", "resolve-angle-carry-forward",
    "wait-pr-checks", "emit-fanout-dispatch", "resolve-role", "resolve-role", "wait-for-units", "consolidate-fanin",
    "emit-judge-work-order", "resolve-role", "wait-for-units", "spec-context", "judge-pass", "write-findings-log",
  ]);
  for (const { name, script } of runbookCommands()) assert.ok(existsSync(path.join(ROOT, script)), `${name} runs no script: ${script}`);
  for (const [contractText, runbookText] of CONTRACT_PINS) {
    assert.ok(contract.includes(contractText), `the contract no longer holds: ${contractText}`);
    assert.ok(runbook.includes(runbookText), `the runbook no longer projects: ${runbookText}`);
  }
  // Inputs the contract owns: the fan-in ledger feeds the judge emit and the judge pass, and the enriched ledger feeds the log.
  assert.match(commandOf("consolidate-fanin").span, /--ledger-out "\$F\/ledger\.json"/);
  assert.match(commandOf("emit-judge-work-order").span, /--findings-file "\$F\/ledger\.json"/);
  const pass = commandOf("judge-pass").span;
  assert.match(pass, /--findings-file "\$F\/ledger\.json"/);
  assert.match(pass, /--out "\$A\/act-list\.json" --ledger-out "\$F\/enriched-ledger\.json" --approvals-out "\$A\/approvals\.json"/);
  const log = commandOf("write-findings-log", (s) => s.includes("--judge-verdict")).span;
  assert.match(log, /--findings-file "\$F\/enriched-ledger\.json" --judge-verdict "\$J\/judge-verdict\.json"/);
  assert.doesNotMatch(log, /--verdict /);
  assert.doesNotMatch(runbook, /findings-array|jq '\.findings'/);
  assert.match(runbook, /On a `judgeSkipped` round or on `review` pass `--findings-file "\$F\/ledger\.json"` and no `--judge-verdict`/);
  assert.match(runbook, /actList: \$A\/act-list\.json/);
  assert.match(runbook, /verdict: <persisted verdict from the log in step 14>/);
  assert.match(runbook, /`jq -r \.verdict <path>` and return that persisted verdict, not the fan-in verdict/);
  // Keyed round state: gate and head key the fan-in and act-list directories.
  assert.match(runbook, /F="\$W\/tmp\/gate-fanin\/\$SLUG\/pr-\$N\/\$GATE-\$H"/);
  assert.match(runbook, /A="\$W\/tmp\/gate-judge\/\$SLUG\/pr-\$N\/\$GATE-\$H"/);
  assert.doesNotMatch(runbook, /gate-fanin-\$N/);
  // The round is derived by the emitter, never passed.
  assert.doesNotMatch(commandOf("emit-judge-work-order").span, /--round/);
  assert.match(runbook, /Pass no `--round`: the emitter derives it/);
  // The PR base is a variable, never a literal.
  assert.doesNotMatch(runbook, /--base main/);
  assert.match(commandOf("resolve-gate-dispatch").span, /--base "origin\/\$BASE"/);
  assert.match(commandOf("write-gate-context").span, /--base "\$BASE"/);
  // Spec identity precedes the resolver, which stamps it on the carry-forward plan.
  assert.ok(names.indexOf("spec-context") < names.indexOf("resolve-angle-carry-forward"));
  assert.match(commandOf("resolve-angle-carry-forward").span, /--spec-authority "\$G\/\$GATE-\$H\.spec-identity\.json"/);
  assert.match(runbook, /Spec identity, before the resolver and dispatch/);
  // Validation: the targeted profile with repeated suites, the full profile as the fallback.
  assert.match(commandOf("resolve-validation").span, /--profile targeted --suite <gateSuite>/);
  assert.match(runbook, /use `--profile full-repository` with no `--suite`/);
  // Dispatch in waves and join with --timeout.
  assert.match(runbook, /Waves \(GATE-EXEC-FANOUT-CAPACITY[^)]*\)\. Split the emitted units into waves of at most `maxConcurrent`/);
  assert.match(runbook, /gate wait-for-units --emit-plan "\$G\/\$GATE-\$H\.emit-plan\.json" --unit <scope> --timeout 540`/);
  assert.match(runbook, /gate wait-for-units --judge-plan <planPath> --timeout 540`/);
  assert.ok(contract.includes("wait-for-units --emit-plan <path> [--unit <scope>]"), "contract no longer shows the --emit-plan/--unit join");
  assert.match(contract, /maxConcurrent/);
  const agent = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  assert.match(agent, /gate runbook/);
  assert.match(agent, /only required read/);
});

test("AC1: the review route skips the lifecycle steps and omits the CI, spec and judge flags", () => {
  assert.match(runbook, /skip steps 2b, 4, 5, 6 and 11 to 13, omit `--ci-file` \(step 7\), `--spec-authority` \(steps 10 and 14\) and every judge flag/);
  for (const step of ["2b", "4", "5", "6"]) assert.match(runbook, new RegExp(`^${step}\\. [^\\n]*(?:Skip on \`review\`|Skip on \`review\` and)`, "m"), `step ${step} lacks its review skip`);
  assert.match(runbook, /`review` also passes no `--spec-authority`/);
  assert.match(runbook, /Pass `--ci-file` on `draft_gate` and `pre_approval_gate`/);
  assert.match(runbook, /The gate token is `draft` for `draft_gate` and `preApproval` for `pre_approval_gate`/);
});

test("AC1: the inline path prints its prerequisites, escalation check and a writer-valid write without --inline-reason", () => {
  const step = runbook.split(/^2b\. /m)[1].split(/^3\. /m)[0];
  const write = commandOf("write-findings-log", (s) => s.includes("inline_single_agent")).span;
  for (const flag of ["--verdict", "--execution-mode inline_single_agent", '--findings-file "$F/inline-findings.json"', "--spec-authority"]) assert.ok(write.includes(flag), `inline write lacks ${flag}`);
  assert.doesNotMatch(write, /--inline-reason/);
  assert.doesNotMatch(runbook, /--inline-reason/);
  assert.ok(step.indexOf("do steps 3 and 4") < step.indexOf("inline-findings.json") && step.indexOf("--inline-severities") < step.indexOf(write), "the inline prerequisites and escalation check precede the write");
  assert.match(step, /the resolver's `reason` and the findings summary \(the writer takes no reason flag\)/);
});

test("AC1: a resolver fallback continues with full dispatch, CI opt-out continues, and the zero count omits the flag", () => {
  assert.match(runbook, /jq -e --arg p "\$PREV" '\.fallback == true and \.prevHead == \$p' "\$G\/\$GATE-\$H\.carry-forward-plan\.json"/);
  assert.match(runbook, /carry nothing and continue with the full dispatch\. On any other non-zero exit stop and hand back the refusal/);
  assert.match(runbook, /unless the gate's `requireCi` is false \(`gates\.draft` or `gates\.preApproval`\): stop on that refusal, and continue when `requireCi` is false/);
  assert.match(runbook, /At a `count` of 0 omit `--expected-dispatch-units`/);
  assert.match(runbook, /A `count` of 0 means every angle is carried: dispatch no reviewer, skip steps 8 and 9, and continue at step 10/);
});

test("AC1: spec source is routed, never defaulted to the PR body", () => {
  const step = runbook.split(/^4\. /m)[1].split(/^5\. /m)[0];
  assert.match(step, /`--issue <n>` for the single issue the gate context links, `--pr "\$N"` only for `pr_body` authority/);
  assert.match(step, /With no source or several issues, stop and hand back the ambiguity/);
  assert.doesNotMatch(commandOf("spec-context").span, /--pr /);
});

test("AC1: shell values are quoted, so a spaced path and a JSON array reach the CLI as one argument", () => {
  for (const { span } of runbookCommands().filter((c) => c.span.startsWith(LAUNCHER))) assert.equal(hasUnquotedExpansion(span), false, `unquoted expansion: ${span}`);
  assert.equal(hasUnquotedExpansion("--carried-angles $CARRIED"), true, "the probe detects an unquoted expansion");
  for (const assignment of ['W="<review-target root>"', 'R="<owner/name>"', 'SLUG="$(echo "$R" | tr / -)"', 'G="$W/tmp/gate-context/$SLUG/pr-$N"']) assert.ok(runbook.includes(assignment), `unquoted assignment: ${assignment}`);
  const env = { PATH: process.env.PATH, W: "/tmp/a b", F: "/tmp/a b/f", G: "/tmp/a b/g", SLUG: "o-r", N: "7", GATE: "draft_gate", H: "abc", CARRIED: '["x y","z"]', PLAN: "/tmp/a b/plan.json" };
  const [carried] = shellArgs('--carried-angles "$CARRIED"', env).slice(1);
  assert.equal(carried, '["x y","z"]');
  const consolidate = commandOf("consolidate-fanin").span.split(" > ")[0].replace(`${LAUNCHER}cli/index.mjs gate consolidate-fanin`, "").replace("<n>", "3");
  const args = shellArgs(consolidate, env);
  assert.equal(args[args.indexOf("--findings-dir") + 1], "/tmp/a b/tmp/gate-reviews/o-r/pr-7/draft_gate-abc");
  assert.equal(args[args.indexOf("--ledger-out") + 1], "/tmp/a b/f/ledger.json");
});

test("AC2: the gate coordinator never references the contract, and no agent links it as the round procedure", () => {
  const coordinator = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  assert.doesNotMatch(coordinator, /gate-review-sub-loop-contract/);
  for (const file of readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".agent.md"))) {
    for (const line of readFileSync(path.join(ROOT, "agents", file), "utf8").split("\n")) {
      assert.equal(linksAsProcedure(line), false, `${file}: contract link as the round procedure: ${line.slice(0, 120)}`);
    }
  }
});

test("AC2: the link scan accepts a rule citation and rejects each procedure link", () => {
  const link = "[Gate Review Sub-Loop Contract](../skills/docs/gate-review-sub-loop-contract.md)";
  assert.equal(linksAsProcedure(`Cite \`GATE-EXEC-HARNESS-JOIN\` in ${link}.`), false);
  assert.equal(linksAsProcedure(`Run the round as ${link} defines it.`), true);
  assert.equal(linksAsProcedure(`Run the round as \`GATE-EXEC-GATE-COORDINATOR\` in ${link} defines it.`), true);
  assert.equal(linksAsProcedure("Run the round with no contract link."), false);
});

// Obligations the contract assigns to the coordinator that the runbook deliberately omits (none today).
const OUT_OF_SCOPE = new Map();

test("AC3: every rule ID in the runbook resolves to a rule marker, and every coordinator-owned GATE-EXEC rule is named", () => {
  const marked = new Set();
  for (const f of readdirSync(DOCS).filter((n) => n.endsWith(".md"))) {
    for (const m of readFileSync(path.join(DOCS, f), "utf8").matchAll(/<!--\s*rule:\s*([A-Z0-9-]+)\s*-->/g)) marked.add(m[1]);
  }
  for (const id of runbookRuleIds(runbook)) assert.ok(marked.has(id), `${id} has no rule marker`);
  // Owned by the coordinator: named in its own rule body, in its agent definition, or listed here.
  const body = contract.split("<!-- rule: GATE-EXEC-GATE-COORDINATOR -->")[1].split(/<!-- rule: /)[0];
  const agent = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  const listed = ["GATE-EXEC-OPERATOR-FOCUS", "GATE-EXEC-REVIEWER-BUDGET-PREFLIGHT", "GATE-EXEC-BUILD-ONCE-SEED", "GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK", "GATE-EXEC-COLLECTABLE-DISPATCH", "GATE-EXEC-EXECUTION-RECORD", "GATE-EXEC-FANOUT-CAPACITY", "GATE-EXEC-FIRST-WAVE-RELEASE", "GATE-EXEC-FANOUT-DISPATCH-EMIT", "GATE-EXEC-VALIDATION-RESOLUTION", "GATE-EXEC-ANGLE-CARRY-FORWARD", "GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED", "GATE-EXEC-ARTIFACT-HEAD-STAMP", "GATE-EXEC-DISPOSITION-LEDGER", "GATE-EXEC-PROPORTIONALITY", "GATE-EXEC-LIGHT-ESCALATION", "GATE-EXEC-ROUND-RETIREMENT", "GATE-EXEC-NO-DEAD-END", "GATE-EXEC-DISPATCH-RETRY-BACKOFF", "RECOVERY-COMMAND-REQUIRED"];
  const owned = new Set([...`${body}\n${agent}`.match(RULE_ID), ...listed].filter((id) => id.startsWith("GATE-EXEC-") || id === "RECOVERY-COMMAND-REQUIRED"));
  for (const id of owned) {
    if (OUT_OF_SCOPE.has(id)) continue;
    assert.ok(marked.has(id), `${id} has no rule marker`);
    assert.ok(runbook.includes(id), `${id} is a coordinator obligation but dropped from the runbook`);
  }
  for (const word of ["units_stalled", "round_retired", "ci_not_green", "head_changed", "FANOUT_UNAVAILABLE", "judgeSkipped", "escalationsSkipped", "budget_shortfall", "inline_single_agent", "--available-reviewers", "--operator-focus-file"]) assert.ok(runbook.includes(word), `${word} dropped from the runbook`);
});

test("AC3: the runbook states the retry schedule, hard-4xx escalation, judge-pass rerun and approvals obligations", () => {
  assert.match(runbook, /Retry the same unit on a transient 429 or 5xx after 30s, 60s and 120s \(`planDispatchRetry`\)/);
  assert.match(runbook, /Never abort the round on a transient failure\. When `planDispatchRetry` returns `reduceConcurrency: true`, halve the concurrency through `backoffMaxConcurrent`, recompute the waves, then fall back to foreground one-at-a-time dispatch\. On a hard 4xx \(for example 402\) retry nothing and escalate to the supervisor at once/);
  assert.doesNotMatch(runbook, /retry it once|fails after one retry|dispatch fails after/i);
  assert.match(runbook, /a dispatch fails with a hard 4xx/);
  assert.match(runbook, /On any other failure rerun steps 11 to 13 once at the same head[^.]*; stop on a second failure/);
  assert.match(runbook, /When it fails with `humanDecisionRequired` \(exit 1\), stop at once at the human spec decision/);
  assert.match(usageOf("scripts/loop/judge-pass.mjs").text, /humanDecisionRequired/);
  assert.match(runbook, /PREV=<latest of the prior heads the dev-loop coordinator passes in the dispatch arguments; none on round 1>; PRIORS=<all of those prior heads>/);
  assert.match(runbook, /--prior-approvals "\$W\/tmp\/gate-judge\/\$SLUG\/pr-\$N\/\$GATE-<head>\/approvals\.json"` for the latest head in `\$PRIORS` whose file exists\. When none exists \(fresh approval chain\) omit it and the `--changed-paths`\/`--coverage-map` pair/);
  assert.match(runbook, /`--changed-paths <file> --coverage-map <file>` together/);
  assert.match(runbook, /changed-paths --base <approvals head> --head "\$H"`/);
});

test("AC3: a contract that loses a pinned phrase fails closed as contract_drift", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-runbook-"));
  try {
    cpSync(DOCS, dir, { recursive: true });
    writeFileSync(path.join(dir, CONTRACT_FILE), contract.replaceAll("30s/60s/120s", "a backoff schedule"));
    const result = run(["--docs-dir", dir]);
    assert.equal(result.status, 1);
    const body = JSON.parse(result.stderr);
    assert.equal(body.reason, "contract_drift");
    assert.match(body.error, /30s\/60s\/120s/);
    assert.match(body.recovery, /^operator: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC4: every runbook command and prose flag appears in its CLI usage, every --help exits 0, and the runbook stays within 16,000 characters", () => {
  // The CONTRACT= line embeds the install path, so measure with a fixed 200-character path budget.
  const contractPath = path.join(DOCS, CONTRACT_FILE);
  const budgeted = runbook.length - contractPath.length + 200;
  assert.ok(budgeted <= 16000, `runbook is ${budgeted} characters with a 200-character path budget`);
  const commands = runbookCommands();
  assert.ok(commands.every((c) => c.script && c.script !== "..."), "the launcher placeholder is not a command");
  const usage = new Map();
  for (const { script, flags } of commands) {
    if (!usage.has(script)) {
      const { status, text } = usageOf(script);
      if (!HELP_EXITS_ONE.has(script)) assert.equal(status, 0, `${script} --help exited ${status}`);
      assert.match(text, /Usage:/, `${script} printed no usage`);
      usage.set(script, text);
    }
    // A flag counts only as a whole token, not as the prefix of a longer flag.
    for (const flag of flags) assert.match(usage.get(script), new RegExp(`${flag}(?![\\w-])`), `${script} usage lacks ${flag}`);
  }
  assert.equal(usage.size, new Set(commands.map((c) => c.script)).size);
  assert.ok(usage.size >= 13, `only ${usage.size} distinct scripts`);
  // Flags named in prose must exist in some script the runbook runs (`--review` is the dev-loop route name, not a script flag).
  const everyUsage = [...usage.values()].join("\n");
  for (const flag of new Set(runbook.match(/--[a-z][a-z-]*/g))) {
    if (flag === "--review" || flag === "--arg") continue; // `--arg` is a jq flag
    assert.match(everyUsage, new RegExp(`${flag}(?![\\w-])`), `no script usage lists the prose flag ${flag}`);
  }
});

test("AC4: the command extractor reads prefixless and repeated forms and skips the launcher placeholder", () => {
  const sample = [
    "`dev-loops-run --repo-root \"$W\" ...`",
    "`dev-loops-run --repo-root \"$W\" cli/index.mjs gate resolve-role --role review --harness \"$HARNESS\"`",
    "`gate resolve-role --role judge --harness \"$HARNESS\"`",
    "`dev-loops-run --repo-root \"$W\" scripts/loop/spec-context.mjs --repo \"$R\"`",
  ].join("\n");
  const found = runbookCommands(sample);
  assert.deepEqual(found.map((c) => c.name), ["resolve-role", "resolve-role", "spec-context"]);
  assert.deepEqual(found[1].flags, ["--role", "--harness"]);
});

test("AC5: a missing contract or an unresolved rule marker fails closed with an operator recovery that names the absolute file or rule ID", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-runbook-"));
  try {
    const missing = run(["--docs-dir", dir]);
    assert.notEqual(missing.status, 0);
    const missingBody = JSON.parse(missing.stderr);
    assert.equal(missingBody.reason, "contract_missing");
    assert.match(missingBody.recovery, /^operator: /);
    assert.ok(missingBody.recovery.includes(path.join(dir, CONTRACT_FILE)), "the recovery names the absolute contract file");
    assert.ok(missingBody.recovery.endsWith(`rerun ${RUNBOOK_COMMAND}.`));

    cpSync(DOCS, dir, { recursive: true });
    const stripped = readFileSync(path.join(dir, CONTRACT_FILE), "utf8").replace("<!-- rule: GATE-EXEC-HARNESS-JOIN -->", "");
    writeFileSync(path.join(dir, CONTRACT_FILE), stripped);
    const unresolved = run(["--docs-dir", dir]);
    assert.notEqual(unresolved.status, 0);
    const body = JSON.parse(unresolved.stderr);
    assert.equal(body.reason, "rule_unresolved");
    assert.match(body.recovery, /^operator: .*GATE-EXEC-HARNESS-JOIN/);
    assert.ok(body.recovery.endsWith(`rerun ${RUNBOOK_COMMAND}.`));
    for (const recovery of [missingBody.recovery, body.recovery]) {
      assert.doesNotMatch(recovery, /git checkout/);
      assert.doesNotMatch(recovery, /dev-loops gate runbook/);
      assert.match(recovery, /dev-loops-run --repo-root <checkout> cli\/index\.mjs gate runbook/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC5: an uppercase hyphenated docs directory name is not read as a rule ID and the real path is printed", () => {
  const base = mkdtempSync(path.join(tmpdir(), "gate-runbook-"));
  const dir = path.join(base, "MY-DOCS-DIR");
  try {
    cpSync(DOCS, dir, { recursive: true });
    const result = run(["--docs-dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(dir, CONTRACT_FILE)), "the runbook prints the real contract path");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AC5: an unknown flag prints the message and usage as text, exits 1 and writes no stdout", () => {
  const result = run(["--bogus"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage: gate-runbook\.mjs/);
});

test("AC5: --docs-dir accepts a real directory", () => {
  const accepted = run(["--docs-dir", "skills/docs"], { cwd: ROOT });
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout, runbook);
});

test("AC6: Pi, Claude Code and Codex read the same runbook through the agent definition and its generated asset", () => {
  const source = readFileSync(path.join(ROOT, "agents/gate-coordinator.agent.md"), "utf8");
  const claude = readFileSync(path.join(ROOT, ".claude/agents/gate-coordinator.md"), "utf8");
  // Pi and Codex read agents/gate-coordinator.agent.md directly; no generated Pi or Codex asset is tracked. Claude Code reads the generated copy.
  for (const text of [source, claude]) {
    assert.match(text, /cli\/index\.mjs gate runbook/);
    assert.match(text, /On any runbook failure \(a refusal, an error with no `recovery` field, or a checkout without the `gate runbook` subcommand\), stop and return the error as the round result, and run no recovery\./);
    assert.doesNotMatch(text, /follow its `recovery` field/);
  }
  assert.match(source, /^tools: .*\bsubagent\b/m, "Pi dispatches through the subagent tool");
  const probe = spawnSync("git", ["-C", ROOT, "ls-files", ".codex", ".pi/agents", "codex"], { encoding: "utf8", env: gitEnvNoDirOverrides() });
  assert.equal(probe.status, 0, `git ls-files failed: ${probe.stderr}`);
  assert.doesNotMatch(probe.stdout, /gate-coordinator/, "a generated Pi or Codex gate-coordinator asset is now tracked: assert it here");
  assert.doesNotMatch(runbook, /--harness claude/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "cli/index.mjs"), "gate", "runbook"], { encoding: "utf8", cwd: ROOT, env: { ...process.env, DEVLOOPS_CHECKOUT_DELEGATED: undefined } });
  assert.equal(cli.stdout, runbook);
  // The Pi step on the same runbook keeps the blocking join, and the harness-neutral dispatch rules stay named.
  assert.match(runbook, /On Pi send the wave as ONE `subagent` call/);
  assert.match(runbook, /GATE-EXEC-HARNESS-JOIN/);
});

test("AC6: the USAGE, CLI description and changelog call the output a pinned projection, never compiled or generated", () => {
  const surfaces = [
    run(["--help"]).stdout,
    readFileSync(path.join(ROOT, "cli/index.mjs"), "utf8").match(/"runbook": "[^"]*"/)[0],
    readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").split("\n").find((line) => line.includes("(#3096)")),
  ];
  for (const text of surfaces) {
    assert.match(text, /pinned projection/);
    assert.doesNotMatch(text, /compiled|generated gate/i);
  }
});

test("issue 3590: one FOCUS file feeds steps 3, 7 and 11", () => {
  for (const [from, to] of [["\n3. Context", "\n4. Spec identity"], ["\n7. Emit", "\n8. Waves"], ["\n11. Judge work order", "\n12. Dispatch the judge"]]) {
    assert.match(runbook.slice(runbook.indexOf(from), runbook.indexOf(to)), /--operator-focus-file "\$FOCUS"/, from);
  }
  assert.match(runbook, /named file whose `round` is absent or differs: stop, hand back the conflict/);
  assert.equal(runbook.split("No `FOCUS`: omit it.").length - 1, 3);
  assert.doesNotMatch(runbook, /decision file/);
  assert.match(runbook, /`\$F\/focus.json` holding `\{ "round": "<text>" \}`/);
});
