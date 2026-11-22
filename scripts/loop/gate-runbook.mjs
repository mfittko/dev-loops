#!/usr/bin/env node
/**
 * gate-runbook: print the gate coordinator's round runbook. The runbook is a short,
 * ordered projection of `skills/docs/gate-review-sub-loop-contract.md`: every step names the rule IDs that
 * own it. The generator fails closed when the contract is missing or a named rule has no marker in the
 * canonical docs, so the runbook cannot cite a rule that no longer exists. The contract stays canonical.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isDirectCliRun } from "../_core-helpers.mjs";

const USAGE = `Usage: gate-runbook.mjs [--docs-dir <path>]
Print the gate coordinator round runbook, compiled from skills/docs/gate-review-sub-loop-contract.md.
Refusal (stderr, JSON, exit 1): { "ok": false, "refused": true, "reason": "contract_missing" | "rule_unresolved", "error": "...", "recovery": "..." }
  --docs-dir <path>  Directory that holds the canonical docs (default: the package's skills/docs)`;

export const CONTRACT_FILE = "gate-review-sub-loop-contract.md";
export const RUNBOOK_COMMAND = "dev-loops gate runbook";
const DEFAULT_DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/docs");
const RULE_ID_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,}\b/g;

const RUNBOOK = String.raw`# Gate round runbook

You run one \`draft_gate\`, \`pre_approval_gate\` or \`review\` round for one PR at one head (GATE-EXEC-GATE-COORDINATOR). Read only this runbook before you act. Read the contract (\`skills/docs/${CONTRACT_FILE}\`) only for a rule ID named here, with \`grep -n '<RULE-ID>'\` and a bounded \`sed -n\` range. The contract is canonical. This runbook loosens none of its rules.

On the \`review\` gate (the dev-loop \`--review\` route) run no judge: skip steps 11 to 13, run step 14 without \`--judge-verdict\` and without \`--ledger-out\`, and omit \`actList\`, \`specAuthorityIdentity\` and \`judgeSummary\` from the result.

Run every command as \`dev-loops-run --repo-root $W ...\` with no \`cd\` prefix (WORKTREE-SCRIPT-LAUNCHER-CWD). Repeat the variables in every Bash call. Parse JSON only with \`jq\` or the step's \`--jq\`; inline \`node -e\` and \`python3 -c\` are blocked (OPS-NO-INLINE-INTERPRETER). Copy, move and delete files per WORKTREE-NONINTERACTIVE-FILE-OPS.

## Variables

\`\`\`sh
W=<review-target root>; R=<owner/name>; N=<pr>; GATE=<draft_gate|pre_approval_gate|review>; H=<full head SHA>
HARNESS=<pi|claude|codex, your own harness>
SLUG=$(echo $R | tr / -); G=$W/tmp/gate-context/$SLUG/pr-$N; F=$W/tmp/gate-fanin-$N; mkdir -p $F
\`\`\`

Operator focus (GATE-EXEC-OPERATOR-FOCUS). When the round arguments carry operator context, write it to \`$F/focus.json\` as \`{ "round": "<text>" }\` and pass \`--operator-focus-file $F/focus.json\` to steps 7 and 11. With no operator context, pass no focus file.

## Steps

0. Dispatch tool. Check your tool surface for \`Agent\` (Claude Code) or \`subagent\` (Pi). When it is absent, return the \`FANOUT_UNAVAILABLE_MESSAGE\` result (\`FANOUT_UNAVAILABLE\`) at once, with a detail that names the missing tool. Run no other step: no validation, no context, no emitter call, no round id (GATE-EXEC-GATE-COORDINATOR).
1. Head check. \`git -C $W rev-parse HEAD\` must equal $H. Otherwise stop with \`head_changed\`.
2. Validation (GATE-EXEC-VALIDATION-RESOLUTION). An \`incomplete\` status is valid evidence; continue.
   \`dev-loops-run --repo-root $W cli/index.mjs gate resolve-validation --profile full-repository --repo $R --pr $N --gate $GATE --head-sha $H > $F/validation-result.json\`
2b. Dispatch mode (GATE-EXEC-PROPORTIONALITY, GATE-EXEC-LIGHT-ESCALATION). Run \`dev-loops-run --repo-root $W scripts/loop/resolve-gate-dispatch.mjs --gate <draft|preApproval> --base main --head $H\` (add \`--full-label\` on a \`gate:full\` PR). On \`mode: "full_fanout"\` continue. On the inline mode run no fan-out and no judge: review the diff yourself in one pass, write the log with \`--execution-mode inline_single_agent --inline-reason <reason>\` (step 14 without \`--judge-verdict\`), and return \`executionMode: inline_single_agent\` with the reason and findings summary. A finding at a blocking severity escalates to the full fan-out: rerun this step with \`--inline-severities <csv>\`.
3. Context (Phase 1; GATE-EXEC-BUILD-ONCE-SEED). Build ONE context bundle for the pass and reuse it for every reviewer. Add \`--available-reviewers <n>\` with your harness's remaining reviewer budget; omit it when the harness exposes none. Check \`jq -c '{ok, path}' $F/wgc.json\`, then read the preflight (GATE-EXEC-REVIEWER-BUDGET-PREFLIGHT): \`jq -c '.artifact.fanout.preflight | {dispatch, reason, requiredReviewers, availableReviewers, shortfall}' <path>\`. On \`dispatch: false\` (\`budget_shortfall\`) spawn zero reviewers, keep the completed artifacts, record no verdict and stop with \`budget_shortfall\`. Never fall back to \`inline_single_agent\` for a shortfall. Resume at the same head by rerunning this step with the refreshed budget.
   \`dev-loops-run --repo-root $W scripts/github/write-gate-context.mjs --repo $R --pr $N --gate $GATE --head-sha $H --harness $HARNESS --base main --validation-results $G/$GATE-$H.validation.json > $F/wgc.json\`
4. Carry-forward (Phase 1.2). Skip only on the gate's first round (no prior head in the round arguments). Otherwise run the resolver for the latest prior head \`$PREV\`; a re-gate never skips it (GATE-EXEC-ANGLE-CARRY-FORWARD, GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED). Add \`--rerun-angle <angle>\` per GATE-EXEC-RERUN-ANGLE.
   \`dev-loops-run --repo-root $W scripts/github/resolve-angle-carry-forward.mjs --repo $R --pr $N --gate $GATE --prev-head $PREV --head-sha $H > $F/carry.json\`
   Read \`jq -c '{ok, carryForwardPlanPath, carried}' $F/carry.json\`. Keep \`PLAN\` = \`carryForwardPlanPath\` and \`CARRIED\` = \`jq -c '[.carried[].angle]' $F/carry.json\`. When \`CARRIED\` is not empty, rerun step 3 with \`--carried-angles $CARRIED\`. When the resolver exits non-zero, stop and hand back the refusal.
5. Spec identity, before dispatch (GATE-EXEC-JUDGE-PHASE). Use \`--pr $N\` for an issue-less PR whose body is the spec, or \`--issue <n>\` when the round arguments name a spec issue. Keep the printed \`sha256:...\` as \`DIGEST\`.
   \`dev-loops-run --repo-root $W scripts/loop/spec-context.mjs --repo $R --pr $N --content-file $G/$GATE-$H.diff --head-sha $H --spec-out $G/$GATE-$H.spec.json --identity-out $G/$GATE-$H.spec-identity.json --jq .contentDigest\`
6. CI check. Re-read current-head CI immediately before fan-out. On a \`draft_gate\` the emitter needs it unless \`gates.draft.requireCi\` is false. A red or unsettled head stops the round with \`ci_not_green\`.
   \`dev-loops-run --repo-root $W scripts/github/wait-pr-checks.mjs --repo $R --pr $N --timeout 0 > $F/ci.json\`
7. Emit (Phase 2). Round 1 of a head uses no \`--pending\`. After a carry-forward with \`CARRIED\`, or to resume at the same head, add \`--pending --carry-forward-plan-file $PLAN\` (use the plan file only with carried angles). Pass \`--ci-file $F/ci.json\` on \`draft_gate\`, and \`--operator-focus-file $F/focus.json\` when you wrote one.
   \`dev-loops-run --repo-root $W scripts/github/emit-fanout-dispatch.mjs --repo $R --pr $N --gate $GATE --head-sha $H --ci-file $F/ci.json > $F/emit.json\`
   Read \`jq -c '{count, maxConcurrent}' $F/emit.json\` and \`jq -r '.units[] | .scope, .dispatchPrompt' $F/emit.json\`. The plan is \`$G/$GATE-$H.emit-plan.json\`. A refusal with a \`recovery\` field follows RECOVERY-COMMAND-REQUIRED (run the named command once, re-run the step once). A \`count\` of 0 means every angle is carried: dispatch no reviewer, skip steps 8 and 9, and continue at step 10.
8. Waves (GATE-EXEC-FANOUT-CAPACITY, GATE-EXEC-FIRST-WAVE-RELEASE). Split the emitted units into waves of at most \`maxConcurrent\` units (one wave unless \`gates.fanout.sequential\`, \`mode: per-angle\` or the \`review\` gate opts out). Release the first wave at once, with no primer or lead reviewer. Bounded parallelism is the default (GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK); \`gates.fanout.sequential: true\` is the load fallback with concurrency 1. For each wave run step 9 and join it before the next wave.
9. Dispatch and join one wave.
   Models (on Claude Code, MAIN-CLAUDE-DISPATCH-MODEL; $HARNESS is \`claude\` there): \`dev-loops-run --repo-root $W cli/index.mjs gate resolve-role --gate $GATE --angle <angle> --harness $HARNESS\` per angle of the unit. Use the common model when all angles of the unit resolve to one model, else the \`review\` role model (\`gate resolve-role --role review --harness $HARNESS\`). On Pi use \`resolveRoleModel\` and pass a non-null model; Codex resolves the same roles with its own $HARNESS.
   Dispatch (GATE-EXEC-FANOUT-DISPATCH-EMIT): every unit of the wave in ONE message, one \`Agent\` call per unit with \`subagent_type: "dev-loops:review"\` and \`prompt\` = that unit's \`dispatchPrompt\` byte for byte. Add no prose, no \`cd\` and no flags. On Pi send the wave as ONE \`subagent\` call with one \`runs.all\` and a unique key per unit.
   Collect (GATE-EXEC-COLLECTABLE-DISPATCH): every reviewer runs joinable or in the foreground; its artifact is \`tmp/gate-reviews/$SLUG/pr-$N/$GATE-$H/<angle>.json\`. A killed or unjoinable reviewer is failed, never evidence.
   Join (GATE-EXEC-HARNESS-JOIN), in the same turn, in the foreground, with an explicit \`--timeout\`. List the wave's units with one \`--unit <scope>\` each:
   \`dev-loops-run --repo-root $W cli/index.mjs gate wait-for-units --emit-plan $G/$GATE-$H.emit-plan.json --unit <scope> --timeout 540\`
   The outcome decides, never a notification. \`all_done\`: continue. \`pending\` (GATE-EXEC-BOUNDED-WAIT-CAP): run \`reissue\` unchanged. \`timeout\`: re-run the original command with the original \`--timeout\`; after three consecutive \`timeout\` outcomes with the same \`missing\` scopes, stop with \`units_stalled\`. \`round_retired\`: stop with \`round_retired\` (GATE-EXEC-ROUND-RETIREMENT). Never run the join with \`run_in_background\`, never wait with \`sleep\`, a poll loop or \`Monitor\`, and never end the turn to await a child (END-TURN-AND-AWAIT-WAKE). A failed unit follows GATE-EXEC-DISPATCH-RETRY-BACKOFF: retry it once, and stop on a second failure. On Pi the blocking \`runs.all\` call is the join.
10. Fan-in (Phase 3; GATE-EXEC-ARTIFACT-HEAD-STAMP). \`--expected-dispatch-units\` is the emitter's stdout \`count\`. On a carry-forward round add \`--carried-angles $CARRIED --carry-forward-plan-file $PLAN\`. A non-zero exit is a fan-in failure: stop.
    \`dev-loops-run --repo-root $W cli/index.mjs gate consolidate-fanin --repo $R --pr $N --findings-dir $W/tmp/gate-reviews/$SLUG/pr-$N/$GATE-$H --head-sha $H --gate $GATE --expected-dispatch-units <n> --out $F/findings.json --ledger-out $F/ledger.json --spec-authority $G/$GATE-$H.spec-identity.json --emit-plan $G/$GATE-$H.emit-plan.json > $F/fanin-result.json\`
    Read \`jq -c '{overallVerdict, severityCounts}' $F/fanin-result.json\`. Keep \`overallVerdict\` as \`VERDICT\`.
11. Judge work order (Phase 3.5; GATE-EXEC-JUDGE-PHASE, GATE-EXEC-JUDGE-NOT-FRESH). \`--round\` is 1 plus the number of prior heads. For each prior head add \`--prior-verdict <that head's judge-verdict path>\`, read from its \`judge-emit-plan.json\` \`.workOrder.outputRefs\`.
    \`dev-loops-run --repo-root $W scripts/loop/emit-judge-work-order.mjs --repo $R --pr $N --gate $GATE --head-sha $H --findings-file $F/ledger.json --spec-file $G/$GATE-$H.spec.json --identity-file $G/$GATE-$H.spec-identity.json --round <k> --tmp-root $W/tmp --operator-focus-file $F/focus.json > $F/judge-emit.json\`
    Omit \`--operator-focus-file\` when you wrote no focus file.
    When it returns \`judgeSkipped\`, dispatch no judge, run no \`judge-pass\`, join no judge, write the log with step 14 without \`--judge-verdict\` and without \`--ledger-out\`, and return \`judgeSkipped\` and \`scopeDrift\` in place of the judge summary with no act-list path.
12. Dispatch the judge. Read \`jq -r '.planPath, .dispatchPrompt' $F/judge-emit.json\`. One \`Agent\` call, \`subagent_type: "dev-loops:judge"\`, \`prompt\` = \`dispatchPrompt\` byte for byte, model per MAIN-CLAUDE-DISPATCH-MODEL (\`gate resolve-role --role judge --harness $HARNESS\`). Join it in the same turn, with the same outcome handling as step 9:
    \`dev-loops-run --repo-root $W cli/index.mjs gate wait-for-units --judge-plan <planPath> --timeout 540\`
    On a judge failure, emit and dispatch once more at the same head; a second failure stops the round.
13. Judge pass (GATE-EXEC-RECURRENCE-ESCALATION). The judge outputs are \`jq -r '.workOrder.outputRefs[]' <planPath>\` (\`judge-verdict.json\` and \`spec-authority-verdict.json\`, directory \`J\`).
    \`dev-loops-run --repo-root $W cli/index.mjs gate judge-pass --repo $R --pr $N --gate $GATE --head-sha $H --findings-file $F/ledger.json --judge-verdict $J/judge-verdict.json --judge-plan <planPath> --out $F/act-list.json --ledger-out $F/enriched-ledger.json --spec-file $G/$GATE-$H.spec.json --content-digest $DIGEST --spec-authority-verdict $J/spec-authority-verdict.json > $F/judge-pass.json\`
    Read \`jq -c '{counts, scopeDrift, escalations, escalationsSkipped}' $F/judge-pass.json\`. Include \`escalations[]\` in the result and keep the other act items; the escalation withholds its cluster siblings (\`clusterFingerprints[]\`). Include \`escalationsSkipped\` when present.
14. Durable findings log (GATE-EXEC-DISPOSITION-LEDGER). \`--verdict\` is \`VERDICT\` from step 10. Pass \`--context-tmp-root $W/tmp\` when the bundle was relocated, and on \`gate:full\` also \`--full-label\`. The writer refuses a \`fanout_fanin\` write without \`--judge-verdict\` while the round has a judge plan with no verdict yet. Pass \`--tmp-root\` only as the ledger root from the round arguments, never a path inside a linked worktree.
    \`jq '.findings' $F/ledger.json > $F/findings-array.json\`
    \`dev-loops-run --repo-root $W cli/index.mjs gate write-findings-log --repo $R --pr $N --gate $GATE --head-sha $H --verdict $VERDICT --findings-file $F/findings-array.json --judge-verdict $J/judge-verdict.json --spec-authority $G/$GATE-$H.spec-identity.json --context-tmp-root $W/tmp > $F/findings-log.json\`
    Read \`jq -c '{ok, path}' $F/findings-log.json\`.

## Stop conditions

Return the typed observation instead of the result when: step 0 finds no dispatch tool (\`FANOUT_UNAVAILABLE\`); the head changed (step 1, or a script says the head differs); the CI check is not green (\`ci_not_green\`); dispatch fails after one retry (GATE-EXEC-DISPATCH-RETRY-BACKOFF); a join returns \`units_stalled\` or \`round_retired\`; fan-in exits non-zero; the judge fails twice. A script refusal with a \`recovery\` field runs that command once, then re-runs the refused step once (RECOVERY-COMMAND-REQUIRED); hand the refusal back when the recovery fails, names \`operator\`, or the same refusal recurs. A usage error that names a missing flag is fixed once. Never repair a refused step by hand (GATE-EXEC-NO-DEAD-END).

Telemetry (GATE-EXEC-EXECUTION-RECORD) is optional: a round that records no execution-unit record is not blocked, and a record you write must pass \`validateExecutionUnitRecord\`.

## Boundary

No verdict comment, no ready flip, no push, no merge, no fixer dispatch, no tracked-file edit. Write only under \`$W/tmp/\` and the ledger root. Reviewer and judge outputs stay in your context.

## Typed round result

Return this once, after step 14, or at a stop condition. Never hand back an interim result while a dispatched unit is pending (GATE-EXEC-HARNESS-JOIN).

\`\`\`
verdict: <VERDICT>
executionMode: fanout_fanin
severityCounts: {high, medium, low, question, nit}
faninOutput: $F/findings.json (ledger $F/ledger.json)
findingsLog: <path from step 14>
actList: $F/act-list.json
specAuthorityIdentity: $G/$GATE-$H.spec-identity.json
judgeSummary: act <n>, defer <n>, reject <n>; scopeDrift <verdict>; one line per act item (severity, angle, fingerprint, remedy)
escalations: <from judge-pass, if present>
escalationsSkipped: <reason, if present>
\`\`\`
`.replaceAll("\\`", "`");

function refuse(reason, error, recovery) {
  return { ok: false, refused: true, reason, error, recovery };
}

/** Rule IDs the runbook text names. */
export function runbookRuleIds(text = RUNBOOK) {
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
  if (!existsSync(contract)) {
    return refuse("contract_missing", `The gate contract is missing: ${contract}`, `Restore ${contract} (git checkout -- skills/docs/${CONTRACT_FILE}), then rerun ${RUNBOOK_COMMAND}.`);
  }
  const marked = markedRuleIds(docsDir);
  const unresolved = runbookRuleIds().filter((id) => !marked.has(id));
  if (unresolved.length > 0) {
    return refuse("rule_unresolved", `The runbook names rule IDs with no rule marker in ${docsDir}: ${unresolved.join(", ")}`, `Add or restore the rule marker for ${unresolved[0]} in skills/docs, or update scripts/loop/gate-runbook.mjs to the current rule ID, then rerun ${RUNBOOK_COMMAND}.`);
  }
  return { ok: true, runbook: RUNBOOK };
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
  const result = buildGateRunbook({ docsDir: values["docs-dir"] ? path.resolve(values["docs-dir"]) : undefined });
  if (!result.ok) { stderr.write(`${JSON.stringify(result)}\n`); return 1; }
  stdout.write(result.runbook);
  return 0;
}

if (isDirectCliRun(import.meta.url)) process.exitCode = runCli();
