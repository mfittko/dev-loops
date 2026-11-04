import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  BLOCKED_ON,
  evaluatePrGateCoordination,
  PR_CHECKPOINT_ACTION,
} from "../../packages/core/src/loop/pr-gate-coordination.mjs";
import { hasRunnableCommand, isTyped, isTypedOrKnownGap, KNOWN_GAPS } from "../../packages/core/src/loop/gate-no-dead-end.mjs";
import { DISPOSITION, STATE } from "../../packages/core/src/loop/copilot-loop-state.mjs";

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
    "dev-loops-run scripts/github/edit-pr.mjs --repo o/r --pr 7 --title 'don'\\''t break Array<T>'",
  ];
  const bad = [
    "dev-loops-run scripts/github/wait-pr-checks.mjs --repo <repo> --pr <n> --timeout 600",
    "dev-loops loop startup --pr <n>",
    "",
  ];
  for (const c of ok) assert.equal(hasRunnableCommand(c), true, c);
  for (const c of bad) assert.equal(hasRunnableCommand(c), false, c);
  const result = evaluatePrGateCoordination(titleInput("WIP: support Map<K, V>"));
  assert.ok(isTypedOrKnownGap(titleInput("WIP: support Map<K, V>"), result));
});

test("a repo that is not a plain slug or a non-positive pr names the operator", () => {
  for (const extra of [{ repo: "o/r;id" }, { repo: "o/$(id)" }, { repo: "o" }, { repo: "" }, { pr: 0 }, { pr: -1 }]) {
    const result = evaluatePrGateCoordination(titleInput("WIP: x", extra));
    assert.equal(result.blockedOn, BLOCKED_ON.OPERATOR_DECISION, JSON.stringify(extra));
    assert.equal(result.agentRemedy, undefined);
  }
  assert.match(evaluatePrGateCoordination(titleInput("WIP: x", { repo: "mfittko/dev-loops" })).agentRemedy.command, /--repo mfittko\/dev-loops --pr 7/);
});
