#!/usr/bin/env node
/**
 * gate-runbook: print the gate coordinator's round runbook. The runbook is a short, ordered, hand-written
 * projection of `skills/docs/gate-review-sub-loop-contract.md`: every step names the rule IDs that own it.
 * It is not generated from the contract text. The generator fails closed when the contract is missing, when a
 * named rule has no marker in the canonical docs, or when a pinned contract phrase (CONTRACT_PINS) is gone.
 * Drift limit: only the pinned phrases and the named rule markers are tracked. A contract edit that touches
 * no pin does not reach the runbook, so the contract stays canonical and a pin is added with each new
 * load-bearing command argument or stop value.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isDirectCliRun } from "../_core-helpers.mjs";

const USAGE = `Usage: gate-runbook.mjs [--docs-dir <path>]
Print the gate coordinator round runbook, a pinned projection of skills/docs/gate-review-sub-loop-contract.md.
Refusal (stderr, JSON, exit 1): { "ok": false, "refused": true, "reason": "contract_missing" | "rule_unresolved" | "contract_drift", "error": "...", "recovery": "..." }
Argument error (stderr, text, exit 1): the parseArgs message and this usage, with no JSON envelope
  -h, --help         Print this usage
  --docs-dir <path>  Directory that holds the canonical docs (default: the package's skills/docs)`;

export const CONTRACT_FILE = "gate-review-sub-loop-contract.md";
export const RUNBOOK_COMMAND = "dev-loops-run --repo-root <checkout> cli/index.mjs gate runbook";
const DEFAULT_DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/docs");
const RULE_ID_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}\b/g;

/** Each load-bearing runbook value: the contract phrase that owns it and the runbook phrase that projects it. */
export const CONTRACT_PINS = [
  ["30s/60s/120s", "30s, 60s and 120s"],
  ["planDispatchRetry", "planDispatchRetry"],
  ["hard 4xx", "hard 4xx"],
  ["--findings-file <judge-pass --ledger-out>", '--findings-file "$F/enriched-ledger.json"'],
  ["--prior-approvals", "--prior-approvals"],
  ["--approvals-out", "--approvals-out"],
  ["--changed-paths", "--changed-paths"],
  ["tmp/gate-judge/<repo-slug>/pr-<N>/<gate>-<head>/act-list.json", 'A="$W/tmp/gate-judge/$SLUG/pr-$N/$GATE-$H"'],
  ["Omit `--expected-dispatch-units` at zero", "At a `count` of 0 omit `--expected-dispatch-units`"],
  ["wait-for-units --emit-plan <path> [--unit <scope>]", "gate wait-for-units --emit-plan"],
  ["--spec-authority <identity-path>", '--spec-authority "$G/$GATE-$H.spec-identity.json"'],
  ["--timeout 0", "--timeout 0"],
  ["reduceConcurrency: true", "\`planDispatchRetry\` returns \`reduceConcurrency: true\`"],
  ["prior heads the dev-loop coordinator passes in the dispatch arguments", "prior heads the dev-loop coordinator passes in the dispatch arguments"],
  ["re-runs the judge at the current head", "rerun steps 11 to 13 once at the same head"],
  ["foreground one-at-a-time dispatch", "foreground one-at-a-time dispatch"],
  ["fallback: true","`fallback` is true"],
];

const renderRunbook = (docsDir) => String.raw`# Gate round runbook

You run one \`draft_gate\`, \`pre_approval_gate\` or \`review\` round for one PR at one head (GATE-EXEC-GATE-COORDINATOR). Read only this runbook. For a rule ID named here run \`grep -n 'rule: <rule ID>' "$D"/*.md\`, then read a bounded range. The contract \`$CONTRACT\` is canonical; this runbook loosens none of its rules.

On the \`review\` gate run no judge and no lifecycle step: skip steps 2b, 4, 5, 6 and 11 to 13, omit \`--ci-file\` (step 7), \`--spec-authority\` (steps 10 and 14) and every judge flag, and write the log from \`$F/ledger.json\` (step 14). Omit \`actList\`, \`specAuthorityIdentity\` and \`judgeSummary\` from the result.

Run every command as \`dev-loops-run --repo-root "$W" ...\` with no \`cd\` prefix (WORKTREE-SCRIPT-LAUNCHER-CWD). Repeat the variables in every Bash call; double-quote every expansion. Parse JSON only with \`jq\` or a step \`--jq\` (OPS-NO-INLINE-INTERPRETER).

## Variables

\`\`\`sh
W="<review-target root>"; R="<owner/name>"; N=<pr>; GATE=<draft_gate|pre_approval_gate|review>; H=<full head SHA>
PREV=<latest of the prior heads the dev-loop coordinator passes in the dispatch arguments; none on round 1>; PRIORS=<all of those prior heads>
HARNESS=<pi|claude|codex, your own harness>; BASE=<PR base branch, pr.baseRefName from view-pr.mjs>
CONTRACT="${path.join(docsDir, CONTRACT_FILE)}"; D="$(dirname "$CONTRACT")"
SLUG="$(echo "$R" | tr / -)"; G="$W/tmp/gate-context/$SLUG/pr-$N"; F="$W/tmp/gate-fanin/$SLUG/pr-$N/$GATE-$H"
A="$W/tmp/gate-judge/$SLUG/pr-$N/$GATE-$H"; mkdir -p "$F" "$A"
FOCUS=<operator file, else "$F/focus.json" holding { "round": "<text>" } for round text, else unset>
\`\`\`

Operator focus (GATE-EXEC-OPERATOR-FOCUS). Round text plus a named file whose \`round\` is absent or differs: stop, hand back the conflict. Step 3: not \`review\`.

## Steps

0. Recheck tools after preflight: \`Agent\` (Claude), \`subagent\` (Pi), \`collaboration.spawn_agent\` (Codex). Absent: return \`FANOUT_UNAVAILABLE_MESSAGE\` (\`FANOUT_UNAVAILABLE\`) naming the tool; stop. Head or route may have changed.
1. Head check. \`git -C "$W" rev-parse HEAD\` must equal $H. Otherwise stop with \`head_changed\`.
2. Validation (GATE-EXEC-VALIDATION-RESOLUTION). An \`incomplete\` status is valid evidence; continue. Pass each targeted \`gateSuites\` entry of \`resolveTargetedValidation(changedPaths)\` as a repeated \`--suite\`. When targeting is unsafe or yields no suite, use \`--profile full-repository\` with no \`--suite\`.
   \`dev-loops-run --repo-root "$W" cli/index.mjs gate resolve-validation --profile targeted --suite <gateSuite> --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H"\`
2b. Dispatch mode (GATE-EXEC-PROPORTIONALITY, GATE-EXEC-LIGHT-ESCALATION). Skip on \`review\`. The gate token is \`draft\` for \`draft_gate\` and \`preApproval\` for \`pre_approval_gate\`. Add \`--full-label\` on \`gate:full\`.
   \`dev-loops-run --repo-root "$W" scripts/loop/resolve-gate-dispatch.mjs --gate <draft|preApproval> --base "origin/$BASE" --head "$H"\`
   On \`mode: "full_fanout"\` continue. On the inline mode run no fan-out and no judge: do steps 3 and 4, review the diff in one pass, write the findings (severity, disposition, angle, summary) as a JSON array to \`$F/inline-findings.json\` and set \`VERDICT\` to \`clean\` or \`findings_present\`. A blocking-severity finding escalates first: rerun this step with \`--inline-severities <csv>\` and continue at step 3 on \`full_fanout\`. Otherwise write the log:
   \`dev-loops-run --repo-root "$W" cli/index.mjs gate write-findings-log --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H" --verdict "$VERDICT" --execution-mode inline_single_agent --findings-file "$F/inline-findings.json" --spec-authority "$G/$GATE-$H.spec-identity.json" > "$F/findings-log.json"\`
   Return \`executionMode: inline_single_agent\`, the resolver's \`reason\` and the findings summary (the writer takes no reason flag).
3. Context (Phase 1; GATE-EXEC-BUILD-ONCE-SEED). Build ONE bundle for every reviewer. No \`FOCUS\`: omit it. Add \`--available-reviewers <n>\` or omit it. Read \`jq -c '{ok, path}' "$F/wgc.json"\`, then \`jq -c '.artifact.fanout.preflight' <path>\` (GATE-EXEC-REVIEWER-BUDGET-PREFLIGHT). On \`dispatch: false\` spawn zero reviewers, record no verdict and stop with \`budget_shortfall\`, never \`inline_single_agent\`. Resume at this head with a new budget.
   \`dev-loops-run --repo-root "$W" scripts/github/write-gate-context.mjs --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H" --harness "$HARNESS" --base "$BASE" --validation-results "$G/$GATE-$H.validation.json" --operator-focus-file "$FOCUS" > "$F/wgc.json"\`
4. Spec identity, before the resolver and dispatch (GATE-EXEC-JUDGE-PHASE). Skip on \`review\`. Take the spec source from the routed authority, \`--issue <n>\` for the single issue the gate context links, \`--pr "$N"\` only for \`pr_body\` authority. With no source or several issues, stop and hand back the ambiguity. Keep the printed \`sha256:...\` as \`DIGEST\`.
   \`dev-loops-run --repo-root "$W" scripts/loop/spec-context.mjs --repo "$R" --issue <n> --content-file "$G/$GATE-$H.diff" --head-sha "$H" --spec-out "$G/$GATE-$H.spec.json" --identity-out "$G/$GATE-$H.spec-identity.json" --jq .contentDigest\`
5. Carry-forward (Phase 1.2). Skip on \`review\` and on the gate's first round (no prior head). Otherwise run the resolver for the latest prior head \`$PREV\`; a re-gate never skips it (GATE-EXEC-ANGLE-CARRY-FORWARD, GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED). Add \`--rerun-angle <angle>\` per GATE-EXEC-RERUN-ANGLE.
   \`dev-loops-run --repo-root "$W" scripts/github/resolve-angle-carry-forward.mjs --repo "$R" --pr "$N" --gate "$GATE" --prev-head "$PREV" --head-sha "$H" --spec-authority "$G/$GATE-$H.spec-identity.json" > "$F/carry.json"\`
   Keep \`PLAN\` = \`jq -r .carryForwardPlanPath "$F/carry.json"\` and \`CARRIED\` = \`jq -c '[.carried[].angle]' "$F/carry.json"\`. After each resolver run, rerun step 3 (add \`--carried-angles "$CARRIED"\` if \`CARRIED\` is not empty). On a non-zero exit run \`jq -e --arg p "$PREV" '.fallback == true and .prevHead == $p' "$G/$GATE-$H.carry-forward-plan.json"\`: when the plan of this head records \`fallback\` is true, carry nothing and continue with the full dispatch. On any other non-zero exit stop and hand back the refusal.
6. CI check. Skip on \`review\`. Re-read current-head CI just before fan-out. Step 7 refuses a non-green head with \`ci_not_green\` unless the gate's \`requireCi\` is false (\`gates.draft\` or \`gates.preApproval\`): stop on that refusal, and continue when \`requireCi\` is false.
   \`dev-loops-run --repo-root "$W" scripts/github/wait-pr-checks.mjs --repo "$R" --pr "$N" --timeout 0 > "$F/ci.json"\`
7. Emit. Round 1: no \`--pending\`. After a carry-forward with \`CARRIED\`, or on resume, add \`--pending\` (\`--retry-crashed <unit>\` for a crashed unit: its stdout \`name\`; \`--carry-forward-plan-file "$PLAN"\` with carried angles). Pass \`--ci-file\` on \`draft_gate\` and \`pre_approval_gate\`. No \`FOCUS\`: omit it.
   \`dev-loops-run --repo-root "$W" scripts/github/emit-fanout-dispatch.mjs --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H" --ci-file "$F/ci.json" --operator-focus-file "$FOCUS" > "$F/emit.json"\`
   Read \`jq -c '{count, maxConcurrent}' "$F/emit.json"\` and \`jq -r '.units[] | .scope, .dispatchPrompt' "$F/emit.json"\`. A \`count\` of 0 means every angle is carried: dispatch no reviewer, skip steps 8 and 9, and continue at step 10.
8. Waves (GATE-EXEC-FANOUT-CAPACITY, GATE-EXEC-FIRST-WAVE-RELEASE). Split the emitted units into waves of at most \`maxConcurrent\` units (\`gates.fanout.sequential: true\` means 1, GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK). Release the first wave at once. Run step 9 per wave and join it before the next.
9. Dispatch and join one wave.
   Models (MAIN-CLAUDE-DISPATCH-MODEL): \`dev-loops-run --repo-root "$W" cli/index.mjs gate resolve-role --gate "$GATE" --angle <angle> --harness "$HARNESS"\` per angle of the unit. Use the common model, else the \`review\` role model (\`gate resolve-role --role review --harness "$HARNESS"\`). On Pi use \`resolveRoleModel\`, non-null.
   Dispatch (GATE-EXEC-FANOUT-DISPATCH-EMIT): every unit of the wave in ONE message, one \`Agent\` call per unit with \`subagent_type: "dev-loops:review"\` and \`prompt\` = that unit's \`dispatchPrompt\` byte for byte, with no added prose. On Pi send the wave as ONE \`subagent\` call with one \`runs.all\` and a unique key per unit.
   Collect (GATE-EXEC-COLLECTABLE-DISPATCH): reviewers write \`tmp/gate-reviews/$SLUG/pr-$N/$GATE-$H/<angle>.json\`; a killed reviewer is failed, never evidence.
   Join (GATE-EXEC-HARNESS-JOIN) in the same turn, in the foreground, with an explicit \`--timeout\` and one \`--unit <scope>\` per unit of the wave:
   \`dev-loops-run --repo-root "$W" cli/index.mjs gate wait-for-units --emit-plan "$G/$GATE-$H.emit-plan.json" --unit <scope> --timeout 540\`
   The outcome decides, never a notification. \`all_done\`: continue. \`pending\` (GATE-EXEC-BOUNDED-WAIT-CAP): run \`reissue\` unchanged. \`timeout\`: re-run the original command with the original \`--timeout\`; after three consecutive \`timeout\` outcomes with the same \`missing\` scopes, stop with \`units_stalled\`. \`round_retired\`: stop with \`round_retired\` (GATE-EXEC-ROUND-RETIREMENT). Never join in the background, wait with \`sleep\`, a poll loop or \`Monitor\`, or end the turn to await a child (END-TURN-AND-AWAIT-WAKE). On Pi the blocking \`runs.all\` call is the join.
   A failed unit follows GATE-EXEC-DISPATCH-RETRY-BACKOFF. Retry the same unit on a transient 429 or 5xx after 30s, 60s and 120s (\`planDispatchRetry\`). Never abort the round on a transient failure. When \`planDispatchRetry\` returns \`reduceConcurrency: true\`, halve the concurrency through \`backoffMaxConcurrent\`, recompute the waves, then fall back to foreground one-at-a-time dispatch. On a hard 4xx (for example 402) retry nothing and escalate to the supervisor at once.
10. Fan-in (Phase 3; GATE-EXEC-ARTIFACT-HEAD-STAMP). \`--expected-dispatch-units\` is the emitter's stdout \`count\`. At a \`count\` of 0 omit \`--expected-dispatch-units\`. On a carry-forward round add \`--carried-angles "$CARRIED" --carry-forward-plan-file "$PLAN"\`. A non-zero exit stops the round.
    \`dev-loops-run --repo-root "$W" cli/index.mjs gate consolidate-fanin --repo "$R" --pr "$N" --findings-dir "$W/tmp/gate-reviews/$SLUG/pr-$N/$GATE-$H" --head-sha "$H" --gate "$GATE" --expected-dispatch-units <n> --out "$F/findings.json" --ledger-out "$F/ledger.json" --spec-authority "$G/$GATE-$H.spec-identity.json" --emit-plan "$G/$GATE-$H.emit-plan.json" > "$F/fanin-result.json"\`
    Read \`jq -c '{overallVerdict, severityCounts}' "$F/fanin-result.json"\`.
11. Judge work order (Phase 3.5; GATE-EXEC-JUDGE-PHASE, GATE-EXEC-JUDGE-NOT-FRESH). Pass no \`--round\`: the emitter derives it. For each head in \`$PRIORS\` add \`--prior-verdict <that head's judge-verdict path>\`, read from its \`judge-emit-plan.json\` \`.workOrder.outputRefs\`. No \`FOCUS\`: omit it.
    \`dev-loops-run --repo-root "$W" scripts/loop/emit-judge-work-order.mjs --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H" --findings-file "$F/ledger.json" --spec-file "$G/$GATE-$H.spec.json" --identity-file "$G/$GATE-$H.spec-identity.json" --tmp-root "$W/tmp" --operator-focus-file "$FOCUS" > "$F/judge-emit.json"\`
    When it returns \`judgeSkipped\`, run no judge or \`judge-pass\`, write the log with step 14, and return \`judgeSkipped\` and \`scopeDrift\` in place of the judge summary with no act-list path.
12. Dispatch the judge. Read \`jq -r '.planPath, .dispatchPrompt' "$F/judge-emit.json"\`. One \`Agent\` call, \`subagent_type: "dev-loops:judge"\`, \`prompt\` = \`dispatchPrompt\` byte for byte, model per MAIN-CLAUDE-DISPATCH-MODEL (\`gate resolve-role --role judge --harness "$HARNESS"\`). Join it as in step 9:
    \`dev-loops-run --repo-root "$W" cli/index.mjs gate wait-for-units --judge-plan <planPath> --timeout 540\`
    On a judge failure, emit and dispatch once more at the same head.
13. Judge pass (GATE-EXEC-RECURRENCE-ESCALATION). The judge outputs (\`judge-verdict.json\`, \`spec-authority-verdict.json\`, directory \`J\`) are \`jq -r '.workOrder.outputRefs[]' <planPath>\`. On re-entry add \`--prior-approvals "$W/tmp/gate-judge/$SLUG/pr-$N/$GATE-<head>/approvals.json"\` for the latest head in \`$PRIORS\` whose file exists. When none exists (fresh approval chain) omit it and the \`--changed-paths\`/\`--coverage-map\` pair. On a fixer-push re-entry with a coverage map pass \`--changed-paths <file> --coverage-map <file>\` together (paths: \`scripts/loop/spec-context.mjs changed-paths --base <approvals head> --head "$H"\`).
    \`dev-loops-run --repo-root "$W" cli/index.mjs gate judge-pass --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H" --findings-file "$F/ledger.json" --judge-verdict "$J/judge-verdict.json" --judge-plan <planPath> --out "$A/act-list.json" --ledger-out "$F/enriched-ledger.json" --approvals-out "$A/approvals.json" --spec-file "$G/$GATE-$H.spec.json" --content-digest "$DIGEST" --spec-authority-verdict "$J/spec-authority-verdict.json" > "$F/judge-pass.json"\`
    When it fails with \`humanDecisionRequired\` (exit 1), stop at once at the human spec decision and hand back its output. On any other failure rerun steps 11 to 13 once at the same head; stop on a second failure. Read \`jq -c '{counts, scopeDrift, escalations, escalationsSkipped, overridden}' "$F/judge-pass.json"\`. Add escalations, escalationsSkipped and overridden to the result; an escalation withholds its cluster siblings (\`clusterFingerprints[]\`).
14. Durable findings log (GATE-EXEC-DISPOSITION-LEDGER). On a judged round write from the enriched ledger of step 13 and omit \`--verdict\`: the keyed fan-in ledger supplies it. On a \`judgeSkipped\` round or on \`review\` pass \`--findings-file "$F/ledger.json"\` and no \`--judge-verdict\`; \`review\` also passes no \`--spec-authority\`. Pass \`--context-tmp-root "$W/tmp"\` when the bundle was relocated, and on \`gate:full\` also \`--full-label\`. Pass \`--tmp-root\` only as the ledger root from the round arguments, never a path inside a linked worktree.
    \`dev-loops-run --repo-root "$W" cli/index.mjs gate write-findings-log --repo "$R" --pr "$N" --gate "$GATE" --head-sha "$H" --findings-file "$F/enriched-ledger.json" --judge-verdict "$J/judge-verdict.json" --spec-authority "$G/$GATE-$H.spec-identity.json" > "$F/findings-log.json"\`
    Read \`jq -c '{ok, path}' "$F/findings-log.json"\`, then \`jq -r .verdict <path>\` and return that persisted verdict, not the fan-in verdict.

## Stop conditions

Return the typed observation, not the result, when: step 0 finds no dispatch tool (\`FANOUT_UNAVAILABLE\`); the head changed (step 1 or a script); the emitter refuses \`ci_not_green\`; a dispatch fails with a hard 4xx; a join returns \`units_stalled\` or \`round_retired\`; fan-in exits non-zero; the judge or \`judge-pass\` fails twice; \`judge-pass\` returns \`humanDecisionRequired\`. A script refusal with a \`recovery\` field runs that command once, then re-runs the refused step once (RECOVERY-COMMAND-REQUIRED); hand the refusal back when the recovery fails, names \`operator\`, or recurs. Never repair a refused step by hand (GATE-EXEC-NO-DEAD-END).

## Boundary

No verdict comment, no ready flip, no push, no merge, no fixer dispatch, no tracked-file edit. Write only under \`$W/tmp/\` and the ledger root. Telemetry: GATE-EXEC-EXECUTION-RECORD.
## Typed round result

Return once, after step 14 or at a stop condition. Never hand back an interim result while a dispatched unit is pending (GATE-EXEC-HARNESS-JOIN).

\`\`\`
verdict: <persisted verdict from the log in step 14>
executionMode: fanout_fanin
severityCounts: {high, medium, low, question, nit}
faninOutput: $F/findings.json (ledger $F/ledger.json)
findingsLog: <path from step 14>
actList: $A/act-list.json
specAuthorityIdentity: $G/$GATE-$H.spec-identity.json
judgeSummary: act/defer/reject counts; scopeDrift; one line per act item (severity, angle, fingerprint, remedy)
escalations, escalationsSkipped, overridden: from judge-pass, if present
\`\`\`
`.replaceAll("\\`", "`");

function refuse(reason, error, recovery) {
  return { ok: false, refused: true, reason, error, recovery };
}

/** Rule IDs the runbook text names. */
export function runbookRuleIds(text = renderRunbook(DEFAULT_DOCS_DIR)) {
  return [...new Set(text.match(RULE_ID_PATTERN) ?? [])].sort();
}

/** Rule IDs that carry a `<!-- rule: ID -->` marker in any doc under `docsDir`. */
function markedRuleIds(docsDir) {
  const ids = new Set();
  for (const file of readdirSync(docsDir).filter((name) => name.endsWith(".md"))) {
    for (const match of readFileSync(path.join(docsDir, file), "utf8").matchAll(/<!--\s*rule:\s*([A-Z0-9-]+)\s*-->/g)) ids.add(match[1]);
  }
  return ids;
}

export function buildGateRunbook({ docsDir = DEFAULT_DOCS_DIR } = {}) {
  const contract = path.join(docsDir, CONTRACT_FILE);
  const rerun = `then rerun ${RUNBOOK_COMMAND}.`;
  if (!existsSync(contract)) {
    return refuse("contract_missing", `The gate contract is missing: ${contract}`, `operator: reinstall the dev-loops package or restore ${contract} from the dev-loops source checkout, ${rerun}`);
  }
  const marked = markedRuleIds(docsDir);
  // Scan a placeholder-path render: an uppercase hyphenated directory name is not a rule ID.
  const unresolved = runbookRuleIds(renderRunbook("docs")).filter((id) => !marked.has(id));
  if (unresolved.length > 0) {
    return refuse("rule_unresolved", `The runbook names rule IDs with no rule marker in ${docsDir}: ${unresolved.join(", ")}`, `operator: reinstall the dev-loops package, or fix the source: add the rule marker for ${unresolved[0]} under ${docsDir} or update scripts/loop/gate-runbook.mjs to the current rule ID, ${rerun}`);
  }
  const text = readFileSync(contract, "utf8");
  const drifted = CONTRACT_PINS.map(([pin]) => pin).filter((pin) => !text.includes(pin));
  if (drifted.length > 0) {
    return refuse("contract_drift", `The contract no longer holds pinned phrases the runbook projects: ${drifted.join(" | ")}`, `operator: reinstall the dev-loops package, or fix the source: update scripts/loop/gate-runbook.mjs to the current contract text for ${drifted[0]}, ${rerun}`);
  }
  return { ok: true, runbook: renderRunbook(docsDir) };
}

export function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, "docs-dir": { type: "string" } } }));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  if (values.help) { stdout.write(`${USAGE}\n`); return 0; }
  const explicit = values["docs-dir"];
  const result = buildGateRunbook({ docsDir: explicit === undefined ? undefined : path.resolve(explicit) });
  if (!result.ok) { stderr.write(`${JSON.stringify(result)}\n`); return 1; }
  stdout.write(result.runbook);
  return 0;
}

if (isDirectCliRun(import.meta.url)) process.exitCode = runCli();
