import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import {
  BLOCKED_ON,
  CAP_ROUND_REFUSAL,
  evaluatePrGateCoordination,
  PR_CHECKPOINT_ACTION,
} from "../../packages/core/src/loop/pr-gate-coordination.mjs";
import { hasRunnableCommand, isTyped, isTypedOrKnownGap, KNOWN_GAPS } from "../../packages/core/src/loop/gate-no-dead-end.mjs";
import { DISPOSITION, STATE } from "../../packages/core/src/loop/copilot-loop-state.mjs";
import { SUBCOMMAND_ROUTES } from "../../cli/index.mjs";
import { parseExtendCapRoundChainCliArgs } from "../../scripts/loop/extend-cap-round-chain.mjs";

// Issue 3105 slice 1: no-dead-end invariant. Every report_blocked result names who decides
// (`blockedOn`) or the command an agent can run (`agentRemedy.command`), unless it is a listed
// known gap. The finding-class and override dimensions have no evaluator input yet; slices 2
// and 8 add them to this walk.

const gate = (headSha, verdict) => ({ visible: true, headSha, verdict, contractComplete: true });
const HEAD = "abc123456789";
const CLEAN = gate("abc1234", "clean");

function* walk() {
  const draftCapFacts = [{}, { draftRoundRefused: true }, { draftCapRoundFixed: true }, { draftRoundRefused: true, draftCapRoundFixed: true }];
  for (const lifecycleState of Object.values(STATE)) {
    for (const prDraft of [true, false]) {
      for (const ciStatus of ["success", "failure", "pending", "none", "crediblyGreen"]) {
        for (const copilotReviewRoundCount of [0, 2, 3]) {
          for (const unresolvedThreadCount of [0, 3, null]) {
            for (const cap of draftCapFacts) {
              for (const unresolvedGateThreadCount of [0, 2, -1]) {
                for (const withGate of [false, true]) {
                  for (const prTitle of ["plain", "WIP: x"]) {
                    yield {
                      pr: 7,
                      repo: "o/r",
                      currentHeadSha: HEAD,
                      prDraft,
                      lifecycleState,
                      loopDisposition: DISPOSITION.ACTION_REQUIRED,
                      ciStatus,
                      maxCopilotRounds: 2,
                      copilotReviewRoundCount,
                      unresolvedThreadCount,
                      unresolvedGateThreadCount,
                      ...cap,
                      ...(withGate ? { draftGate: CLEAN, draftGateMarker: CLEAN } : {}),
                      prTitle,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

test("every report_blocked result is typed or a listed known gap", () => {
  const hits = new Map(KNOWN_GAPS.map((gap) => [gap.id, 0]));
  const violations = [];
  let blocked = 0;
  for (const input of walk()) {
    const result = evaluatePrGateCoordination(input);
    if (result.nextAction !== PR_CHECKPOINT_ACTION.REPORT_BLOCKED) continue;
    blocked += 1;
    const typed = isTyped(result);
    if (!typed) {
      for (const gap of KNOWN_GAPS) if (gap.matches(input, result)) hits.set(gap.id, hits.get(gap.id) + 1);
    }
    if (!isTypedOrKnownGap(input, result) && violations.length < 5) {
      violations.push({ input, reason: result.reason });
    }
  }
  assert.ok(blocked > 0);
  assert.deepEqual(violations, []);
  for (const [id, count] of hits) assert.ok(count > 0, `stale known-gap entry: ${id}`);
});

test("the predicate flags a typed result with its remedy stripped", () => {
  const input = { pr: 7, repo: "o/r", currentHeadSha: HEAD, prDraft: false, lifecycleState: STATE.PR_READY_NO_FEEDBACK, prTitle: "WIP: x", draftGate: CLEAN, draftGateMarker: CLEAN, ciStatus: "success", maxCopilotRounds: 0 };
  const typed = evaluatePrGateCoordination(input);
  assert.equal(typed.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.ok(isTypedOrKnownGap(input, typed));
  const { agentRemedy: _drop, ...stripped } = typed;
  assert.equal(isTypedOrKnownGap(input, stripped), false);
});

const titleInput = (prTitle, extra = {}) => ({ pr: 7, repo: "o/r", currentHeadSha: HEAD, prDraft: false, lifecycleState: STATE.PR_READY_NO_FEEDBACK, prTitle, draftGate: CLEAN, draftGateMarker: CLEAN, ciStatus: "success", maxCopilotRounds: 0, ...extra });

test("early-surface stops are typed across sizeBudget and adrTripwire", () => {
  const sizes = [null, { outcome: "unknown" }, { outcome: "block", waivable: false }, { outcome: "block", waivable: true }];
  const adrs = [null, { outcome: "unknown" }];
  let stuckSeen = 0;
  for (const sizeBudget of sizes) {
    for (const adrTripwire of adrs) {
      for (const ids of [{ pr: 7, repo: "o/r" }, {}]) {
        const input = {
          ...ids, currentHeadSha: HEAD, prDraft: true, lifecycleState: STATE.PR_DRAFT_NO_FEEDBACK,
          draftGate: CLEAN, draftGateMarker: CLEAN, ciStatus: "success", maxCopilotRounds: 0,
          ...(sizeBudget ? { sizeBudget } : {}), ...(adrTripwire ? { adrTripwire } : {}),
        };
        const result = evaluatePrGateCoordination(input);
        if (result.nextAction !== PR_CHECKPOINT_ACTION.REPORT_BLOCKED) continue;
        stuckSeen += 1;
        assert.ok(isTypedOrKnownGap(input, result), JSON.stringify({ sizeBudget, adrTripwire, ids }));
        if (sizeBudget?.waivable === false) assert.equal(result.blockedOn, BLOCKED_ON.OPERATOR_DECISION);
        else if (ids.pr) assert.match(result.agentRemedy.command, /^git fetch origin && dev-loops loop startup --pr 7$/);
      }
    }
  }
  assert.ok(stuckSeen > 0);
});

test("the title remedy single-quotes the title so shell expansions stay inert", () => {
  const title = "fix: $(touch /tmp/x) `id` it's";
  const result = evaluatePrGateCoordination(titleInput(`WIP: ${title}`));
  const command = result.agentRemedy.command;
  assert.ok(command.endsWith(`--title '${title.replaceAll("'", "'\\''")}'`));
  assert.equal(command.slice(0, command.indexOf("--title")).includes("$("), false);
});

test("the title remedy strips markers with the detector's anchors", () => {
  const cmd = (t) => evaluatePrGateCoordination(titleInput(t)).agentRemedy.command;
  assert.equal(evaluatePrGateCoordination(titleInput("DRAFT")).blockedOn, BLOCKED_ON.OPERATOR_DECISION);
  assert.ok(cmd("[WIP] fix(draft): x").endsWith("--title 'fix(draft): x'"));
  assert.equal(evaluatePrGateCoordination(titleInput("feat/draft: x")).nextAction === PR_CHECKPOINT_ACTION.REPORT_BLOCKED, false);
});

test("a title that edit-pr would read as a flag names the operator", () => {
  const result = evaluatePrGateCoordination(titleInput("WIP: --check support"));
  assert.equal(result.blockedOn, BLOCKED_ON.OPERATOR_DECISION);
  assert.equal(result.agentRemedy, undefined);
});

test("a blocked result without a real repo or integer pr names the operator", () => {
  const result = evaluatePrGateCoordination(titleInput("WIP: x", { pr: undefined }));
  assert.equal(result.blockedOn, BLOCKED_ON.OPERATOR_DECISION);
  assert.equal(result.agentRemedy, undefined);
});

test("hasRunnableCommand accepts quoted angle brackets and rejects unfilled placeholders", () => {
  const ok = [
    "dev-loops-run scripts/github/edit-pr.mjs --repo o/r --pr 7 --title 'map a -> b'",
    "dev-loops-run scripts/github/edit-pr.mjs --repo o/r --pr 7 --title 'support Map<K, V>'",
    "dev-loops loop startup --pr 7",
    "dev-loops-run scripts/github/wait-pr-checks.mjs --repo mfittko/dev-loops --pr 7",
    "git fetch origin && dev-loops loop startup --pr 7",
    "dev-loops-run scripts/github/edit-pr.mjs --repo mfittko/dev-loops --pr 7 --title 'feat: <x> title'",
    "dev-loops-run scripts/github/edit-pr.mjs --repo o/r --pr 7 --title 'don'\\''t break Array<T>'",
  ];
  const bad = [
    "dev-loops-run scripts/github/wait-pr-checks.mjs --repo <repo> --pr <n> --timeout 600",
    "dev-loops loop startup --pr <n>",
    "dev-loops-run scripts/github/wait-pr-checks.mjs --repo <owner/name> --pr 7",
    "dev-loops gate extend-cap-round-chain --head <40-hex>",
    "",
    "   ",
  ];
  for (const c of ok) assert.equal(hasRunnableCommand(c), true, c);
  for (const c of bad) assert.equal(hasRunnableCommand(c), false, c);
  const result = evaluatePrGateCoordination(titleInput("WIP: support Map<K, V>"));
  assert.ok(isTyped(result));
  assert.ok(isTypedOrKnownGap(titleInput("WIP: support Map<K, V>"), result));
});

test("a repo that is not a plain slug or a non-positive pr names the operator", () => {
  for (const extra of [{ repo: "o/r;id" }, { repo: "../.." }, { repo: "./r" }, { repo: "o/.." },{ repo: "o/$(id)" }, { repo: "o" }, { repo: "" }, { pr: 0 }, { pr: -1 }]) {
    const result = evaluatePrGateCoordination(titleInput("WIP: x", extra));
    assert.equal(result.blockedOn, BLOCKED_ON.OPERATOR_DECISION, JSON.stringify(extra));
    assert.equal(result.agentRemedy, undefined);
  }
  assert.match(evaluatePrGateCoordination(titleInput("WIP: x", { repo: "mfittko/dev-loops" })).agentRemedy.command, /--repo mfittko\/dev-loops --pr 7/);
});

// Issue 3122 / ADR 0255: the cap-round dead end. Every cap-round block names the operator or a command that exists and that the extension route accepts,
// and every remedy text the cap-round tools print names a command in the CLI registry.
const COMMAND_PATTERN = /(?:dev-loops|cli\/index\.mjs|\$\{CLI\}) (gate|loop|pr) ([a-z][a-z-]*)/g;

test("every cap-round block is typed: a command that parses on the extension route, or the operator", () => {
  const failures = [undefined, ...Object.keys(CAP_ROUND_REFUSAL)];
  let commands = 0;
  for (const draftCapRoundFailure of failures) {
    const result = evaluatePrGateCoordination({ pr: 7, repo: "o/r", currentHeadSha: HEAD, prDraft: true, lifecycleState: STATE.PR_DRAFT_NO_FEEDBACK, loopDisposition: DISPOSITION.ACTION_REQUIRED, ciStatus: "success", maxCopilotRounds: 0, draftRoundRefused: true, draftCapRoundFixed: false, draftCapRoundFailure });
    assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED, String(draftCapRoundFailure));
    assert.ok(isTyped(result), `${draftCapRoundFailure} is untyped`);
    if (!result.agentRemedy) { assert.equal(result.blockedOn, BLOCKED_ON.OPERATOR_DECISION, String(draftCapRoundFailure)); continue; }
    commands += 1;
    const command = result.agentRemedy.command;
    assert.ok(hasRunnableCommand(command), command);
    const [, group, sub, ...args] = command.split(" ");
    assert.ok(SUBCOMMAND_ROUTES[group]?.[sub], `${command} is not a CLI command`);
    assert.doesNotThrow(() => parseExtendCapRoundChainCliArgs(args), command);
  }
  assert.ok(commands >= 4);
});

test("the remedy texts of the cap-round tools name only CLI commands that exist", () => {
  for (const file of ["packages/core/src/loop/pr-gate-coordination.mjs", "scripts/loop/extend-cap-round-chain.mjs", "scripts/loop/check-pre-push-delta.mjs"]) {
    const source = readFileSync(path.join(import.meta.dir, "..", "..", file), "utf8");
    const seen = [...source.matchAll(COMMAND_PATTERN)].map((m) => `${m[1]} ${m[2]}`);
    assert.ok(seen.length > 0, file);
    for (const command of seen) { const [group, sub] = command.split(" "); assert.ok(SUBCOMMAND_ROUTES[group]?.[sub], `${file} names the missing command "${command}"`); }
    if (!file.endsWith("check-pre-push-delta.mjs")) assert.doesNotMatch(source, /check-pre-push-delta\.mjs --result`|run check-pre-push-delta\.mjs --result/, `${file} names a script instead of a command`);
  }
});
