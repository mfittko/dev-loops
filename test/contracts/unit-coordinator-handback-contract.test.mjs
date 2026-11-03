// Issue 2532 (amended by 2955): report points, continuity soft cap, no mandatory fresh coordinator per phase.
// The boundaries are tooling-emitted (`envelope.unitBoundaries`), the successor re-resolves
// authoritative state instead of inheriting a predecessor's brief, and the hand-back packet
// stays compact. Both harness mirrors must keep carrying the rule (#1086).
import { buildCoordinatorWorkOrder } from "@dev-loops/core/loop/coordinator-work-order";
import { buildDevLoopHandoffEnvelope, STATELESS_UNIT_STRATEGIES, validateHandoffEnvelope } from "@dev-loops/core/loop/handoff-envelope";
import {
  INTERNAL_DEV_LOOP_STRATEGY,
  DEV_LOOP_TARGET_KIND,
} from "@dev-loops/core/loop/public-dev-loop-routing-contract";
import { STRATEGY_OWNERSHIP_GATE } from "../../scripts/loop/resolve-dev-loop-startup.mjs";

import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const OPTIONS = { repoSlug: "owner/repo", repoRoot: "/repo" };
const SETTINGS = { autonomy: { stopAt: ["merge"] }, workflow: { asyncStartMode: "required" } };

function bundle({ kind, id, strategy = INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, linkedPr = null }) {
  return {
    bundle: {
      selectedStrategy: strategy,
      executionMode: "bounded_handoff",
      routeKind: "route",
      nextAction: "Continue the unit.",
      requiredReads: ["skills/docs/public-dev-loop-contract.md"],
      activeArtifact: kind === DEV_LOOP_TARGET_KIND.PR
        ? { kind, pr: id, issue: null, linkedPr: null, branch: null }
        : { kind, issue: id, pr: null, linkedPr, branch: null },
    },
  };
}

const envelopeFor = (input, gateState = {}) => buildDevLoopHandoffEnvelope(input, SETTINGS, gateState, OPTIONS);

test("hand-back: the successor brief derives only from authoritative state", () => {
  const input = bundle({ kind: DEV_LOOP_TARGET_KIND.ISSUE, id: 42 });
  const first = envelopeFor(input);
  const second = envelopeFor(input, { copilotRoundCount: 7, unresolvedThreadCount: 2, ciStatus: "success" });
  assert.deepEqual(first.unitBoundaries, second.unitBoundaries);
  // No producer input can carry a coordinator-authored brief or envelope override.
  const envelope = { ...first, gateState: { ...first.gateState } };
  for (const key of ["brief", "summaryFile", "payload"]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope, [key]: "x" }), /accepts only envelope and allowedFiles/);
  }
  assert.throws(
    () => buildCoordinatorWorkOrder({ envelope: { ...envelope, overrides: { customStopAt: [] } } }),
    /overrides are not a coordinator source/,
  );
  // Tooling emits the next brief: the boundary must survive into the EMITTED work order, not
  // only into the envelope. `coordinator-work-order.mjs` builds `handoff` by rest-spreading the
  // envelope minus `gateState`, so a future field allowlist would drop `unitBoundaries` while
  // every envelope-level assertion above stayed green.
  const { workOrder } = buildCoordinatorWorkOrder({ envelope });
  assert.ok(envelope.unitBoundaries, "fixture must carry tooling-emitted boundaries");
  assert.deepEqual(workOrder.handoff.unitBoundaries, envelope.unitBoundaries);
});

test("hand-back: cwd names the unit's own worktree root, never a nested namespace", () => {
  const root = "/repo/tmp/worktrees/dev-loops/issue-42";
  const env = buildDevLoopHandoffEnvelope(
    bundle({ kind: DEV_LOOP_TARGET_KIND.ISSUE, id: 42, strategy: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION }),
    SETTINGS, {}, { ...OPTIONS, repoRoot: root },
  );
  assert.equal(env.cwd, root);
  assert.ok(!env.cwd.slice(root.length).includes("tmp/worktrees"));
});

// The stateless-route list is hand-maintained against the routing contract's read/observe
// classification; ADR 0181 accepts that maintenance, not silent drift. Nothing else relates the
// two lists, so a route newly classified read-only would keep emitting a hand-back boundary that
// contradicts its own stop rules with every suite green.
test("hand-back: the stateless-route list matches the routed read/observe classification", () => {
  const readOnly = Object.entries(STRATEGY_OWNERSHIP_GATE)
    // `none` is the terminal reconciliation sentinel, not a routed read/observe strategy.
    .filter(([strategy, gated]) => gated === false && strategy !== "none")
    .map(([strategy]) => strategy)
    .sort();
  assert.deepEqual([...STATELESS_UNIT_STRATEGIES].sort(), readOnly);
});

// Rule prose lives in the two owning docs; both harness mirrors must keep carrying it.
// Claims and content are whitespace-normalized: a reflow must never fail a rule that is
// still stated, only a claim that has actually been dropped.
const RULE_PROSE = {
  "agents/dev-loop.agent.md": [
    "unitBoundaries` names your report points",
    "reaches `draft_pr_opened` when it opens its draft PR",
    "reaches `gate_verdict_posted` after posting its own gate verdict",
    "unit identity, status, `nextAction`, evidence links",
    "No transcript, no tool output, no review text",
    // The successor, never the orchestrator, re-resolves the resume identity the envelope carries.
    "The replacement re-resolves `unitBoundaries.resume`",
    // The packet's closed field list has a slot for the successor dispatch's required input.
    "including the startup-output path your unit ran",
    // The packet's closed field list also carries the optional open question (dod:8).
    "and an open question if one is needed",
    // Only final_approval is a recorded naming approximation; issue_intake reaches both points.
    "recorded naming approximation",
    // A pull-dispatched coordinator keeps its pulled order and adopts the new PR identity.
    "builds no new envelope",
    "adopts the new PR identity for state reads and gate calls under the same assigned task",
  ],
  "skills/docs/main-agent-contract.md": [
    "never writes or summarizes the next brief",
    "unit identity, status, `nextAction`, evidence",
    // The same dispatch input the agent-side packet pins, on the contract surface this time.
    "including the startup-output path that unit ran",
    // The packet's closed field list also carries the optional open question (dod:8).
    "and an open question if one is needed",
    "at most 10% empty wakeups, measured against root turns rather than wait duration",
    "adopts the new PR identity for state reads and gate calls under the same assigned task",
  ],
};

const squeeze = (text) => text.replace(/\s+/g, " ");

for (const [doc, claims] of Object.entries(RULE_PROSE)) {
  test(`hand-back rule prose is owned by ${doc}`, async () => {
    const content = squeeze(await readRepo(doc));
    for (const claim of claims) assert.ok(content.includes(squeeze(claim)), `${doc} must state: ${claim}`);
  });
}

test("hand-back contract carries no harness-specific drift (#1086)", async () => {
  // Both harness mirrors of every doc this PR changes are asserted, including the generated
  // `.claude/skills/docs` copies: a claim kept only inside a `<!-- pi-only -->` region would
  // otherwise disappear from the Claude baseline while every test stayed green.
  const mirrorClaims = {
    "agents/dev-loop.agent.md": ["## Unit coordinator report points", "COORDINATOR-CONTINUITY-SOFT-CAP", "ordered list"],
    ".claude/agents/dev-loop.md": ["## Unit coordinator report points", "COORDINATOR-CONTINUITY-SOFT-CAP", "ordered list"],
    "skills/docs/main-agent-contract.md": ["## Unit coordinator boundaries", "COORDINATOR-CONTINUITY-SOFT-CAP", "at most 10% empty wakeups, measured against root turns rather than wait duration"],
    ".claude/skills/docs/main-agent-contract.md": ["## Unit coordinator boundaries", "COORDINATOR-CONTINUITY-SOFT-CAP", "at most 10% empty wakeups, measured against root turns rather than wait duration"],
    "skills/docs/workflow-handoff-contract.md": ["## Unit coordinator boundaries", "reportAfter", "each point is reported when reached"],
    ".claude/skills/docs/workflow-handoff-contract.md": ["## Unit coordinator boundaries", "reportAfter", "each point is reported when reached"],
  };
  for (const [doc, claims] of Object.entries(mirrorClaims)) {
    const normalized = squeeze((await readRepo(doc)).replace(/\r\n/g, "\n"));
    for (const claim of claims) {
      assert.ok(normalized.includes(squeeze(claim)), `${doc} keeps its harness-agnostic rule: ${claim}`);
    }
  }
});

// Issue 2955: report points replace the forced per-phase hand-back; 150K is advisory only.
const MIRRORED_DOCS = [
  "agents/dev-loop.agent.md",
  ".claude/agents/dev-loop.md",
  "skills/docs/main-agent-contract.md",
  ".claude/skills/docs/main-agent-contract.md",
  "skills/docs/workflow-handoff-contract.md",
  ".claude/skills/docs/workflow-handoff-contract.md",
  "skills/docs/retrospective-checkpoint-contract.md",
  ".claude/skills/docs/retrospective-checkpoint-contract.md",
];

test("2955: issue-intake and PR units emit reportAfter and no handBackAfter", () => {
  for (const target of [
    bundle({ kind: DEV_LOOP_TARGET_KIND.ISSUE, id: 42, strategy: INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE }),
    bundle({ kind: DEV_LOOP_TARGET_KIND.PR, id: 7 }),
  ]) {
    const { unitBoundaries } = envelopeFor(target);
    assert.ok(Array.isArray(unitBoundaries.reportAfter) && unitBoundaries.reportAfter.length > 0);
    assert.equal("handBackAfter" in unitBoundaries, false);
  }
});

test("2955: no doc or agent text mandates a fresh coordinator per phase or a hard 150K cap", async () => {
  for (const doc of MIRRORED_DOCS) {
    const text = squeeze(await readRepo(doc));
    assert.doesNotMatch(text, /fresh unit coordinator per phase/, doc);
    assert.doesNotMatch(text, /handBackAfter/, doc);
  }
});

test("2955: every harness mirror carries the soft-cap rule, unknown-never-zero retro prose and reviewer isolation", async () => {
  for (const doc of ["skills/docs/main-agent-contract.md", ".claude/skills/docs/main-agent-contract.md"]) {
    const text = squeeze(await readRepo(doc));
    assert.match(text, /COORDINATOR-CONTINUITY-SOFT-CAP.*advisory retrospective diagnostic/);
    assert.match(text, /Crossing 150K never stops, relaunches or blocks a coordinator, a gate, completion or merge/);
    assert.match(text, /Staying below 150K is not an acceptance prerequisite/);
    assert.match(text, /Fresh dispatch stays for reviewer and judge isolation, genuine recovery/);
    assert.match(text, /reported as unknown, never zero/);
  }
  for (const doc of ["skills/docs/retrospective-checkpoint-contract.md", ".claude/skills/docs/retrospective-checkpoint-contract.md"]) {
    const text = squeeze(await readRepo(doc));
    assert.match(text, /reported as "unknown", never zero/);
    assert.match(text, /context size, token traffic and billing/);
  }
  for (const doc of ["agents/dev-loop.agent.md", ".claude/agents/dev-loop.md"]) {
    assert.match(squeeze(await readRepo(doc)), /Crossing it never stops or relaunches you/);
  }
});

// Review round fixes (issue 2955): the hard-cap guard rejects every spelling, and one canonical
// run-ending list is stated once and matched by the other surfaces.
const HARD_CAP = /150K(-token)? cap/i;

test("2955: the hard-cap guard rejects every cap spelling and accepts the advisory wording", () => {
  for (const rejected of ["150K-token cap", "hard 150K cap", "150K cap", "150k-Token Cap"]) {
    assert.match(rejected, HARD_CAP, rejected);
  }
  for (const accepted of [
    "150K peak input is an advisory retrospective diagnostic",
    "Crossing 150K never stops, relaunches or blocks a coordinator",
  ]) {
    assert.doesNotMatch(accepted, HARD_CAP, accepted);
  }
});

test("2955: no mirrored contract doc mandates a hard 150K cap", async () => {
  for (const doc of MIRRORED_DOCS) {
    assert.doesNotMatch(squeeze(await readRepo(doc)), HARD_CAP, doc);
  }
});

const RUN_ENDING_CASES = [
  "final_approval_ready", "decision", "terminal completion", "changed route", "lockout",
  "genuine recovery", "unavailable actor", "runtime constraint", "operator direction",
];
const between = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = text.indexOf(to, start);
  assert.ok(end > start, `missing ${to}`);
  return text.slice(start, end);
};

test("2955: one canonical run-ending list in the shared prose, no harness-specific tool name", async () => {
  for (const doc of ["skills/docs/main-agent-contract.md", ".claude/skills/docs/main-agent-contract.md"]) {
    const text = squeeze(await readRepo(doc));
    const list = between(text, "the one canonical list of run-ending cases", "When the orchestrator dispatches");
    for (const item of RUN_ENDING_CASES) assert.ok(list.includes(item), `${doc} run-ending list: ${item}`);
    assert.ok(!list.includes("SubagentHandback"), `${doc} shared paragraph must not name SubagentHandback`);
    // The Claude Code one-report rule cites the list rather than restating a third one.
    assert.match(text, /final report at one of the run-ending cases in the Unit coordinator boundaries section, the one canonical list\./);
  }
  for (const doc of ["agents/dev-loop.agent.md", ".claude/agents/dev-loop.md"]) {
    const text = squeeze(await readRepo(doc));
    const list = between(text, "Hand back only at the run-ending cases", "The orchestrator never runs");
    for (const item of RUN_ENDING_CASES) assert.ok(list.includes(item), `${doc} run-ending list: ${item}`);
    assert.ok(!list.includes("SubagentHandback"), `${doc} shared paragraph must not name SubagentHandback`);
  }
  const adr = squeeze(await readRepo("docs/decisions/0220-coordinator-report-points-replace-per-phase-handback.md"));
  const adrList = between(adr, "The fresh-dispatch cases stay", "Rejected:");
  for (const item of RUN_ENDING_CASES) assert.ok(adrList.includes(item), `ADR 0220 run-ending list: ${item}`);
});

test("2955: the replacement reason is read from the predecessor hand-back status, not an orchestrator note", async () => {
  for (const base of ["skills/docs", ".claude/skills/docs"]) {
    const retro = squeeze(await readRepo(`${base}/retrospective-checkpoint-contract.md`));
    assert.match(retro, /read from the predecessor's hand-back packet `status`, which names the run-ending case, reported as "unknown" when the status is absent/);
    assert.ok(!/dispatch\s+note/i.test(retro), `${base} retrospective must not cite an orchestrator note`);
    const main = squeeze(await readRepo(`${base}/main-agent-contract.md`));
    assert.match(main, /The packet `status` names the run-ending case from the canonical list in Unit coordinator boundaries, so it is the replacement reason\./);
  }
});

// AC2 fixtures: a reported peak above 150K and absent telemetry. No runtime code reads peak
// context, so the emitted boundaries and work order must be identical with or without it.
// These fixtures pin only that extraneous input is ignored; the advisory policy itself is pinned
// by the contract-prose tests above.
test("2955: envelope and work order are unchanged by a reported peak above 150K", () => {
  const target = bundle({ kind: DEV_LOOP_TARGET_KIND.ISSUE, id: 42, linkedPr: 7 });
  const baseline = envelopeFor(target);
  const heavy = envelopeFor(
    { bundle: { ...target.bundle, telemetry: { peakContextTokens: 200000 } } },
    { peakContextTokens: 200000 },
  );
  assert.deepEqual(heavy.unitBoundaries, baseline.unitBoundaries);
  assert.equal(validateHandoffEnvelope(heavy).ok, true);
  const order = buildCoordinatorWorkOrder({ envelope: heavy }).workOrder;
  assert.deepEqual(order.handoff.unitBoundaries, baseline.unitBoundaries);
  assert.ok(!/stop|relaunch|block/i.test(JSON.stringify(heavy.unitBoundaries)));
});

test("2955: envelope and work order are unchanged by unknown peak telemetry", () => {
  const target = bundle({ kind: DEV_LOOP_TARGET_KIND.ISSUE, id: 42, linkedPr: 7 });
  const baseline = envelopeFor(target);
  const unknown = envelopeFor(
    { bundle: { ...target.bundle, telemetry: { peakContextTokens: null } } },
    { peakContextTokens: null },
  );
  assert.deepEqual(unknown.unitBoundaries, baseline.unitBoundaries);
  assert.equal(validateHandoffEnvelope(unknown).ok, true);
  const order = buildCoordinatorWorkOrder({ envelope: unknown }).workOrder;
  assert.deepEqual(order.handoff.unitBoundaries, baseline.unitBoundaries);
  // Unknown is never reported as zero: no peak figure appears at all.
  assert.ok(!/peak/i.test(JSON.stringify(order)), "unknown telemetry must not surface a peak value, zero or otherwise");
});

test("2955: the issue-to-PR re-target caused by the unit's own draft PR is a continuation", async () => {
  const phrase = /issue-to-PR re-target caused by the unit's own draft PR is a continuation, not a changed route/;
  for (const doc of ["skills/docs/main-agent-contract.md", ".claude/skills/docs/main-agent-contract.md", "agents/dev-loop.agent.md", ".claude/agents/dev-loop.md", "docs/decisions/0220-coordinator-report-points-replace-per-phase-handback.md"]) {
    assert.match(squeeze(await readRepo(doc)), phrase, doc);
  }
});

test("2500: the coordinator hands back merge-pr --check and never merges; a brief carries no merge step", async () => {
  for (const doc of ["skills/dev-loop/SKILL.md", ".claude/skills/dev-loop/SKILL.md"]) {
    const text = squeeze(await readRepo(doc));
    assert.match(text, /dev-loop coordinator never merges: at the merge-ready point it hands back the `merge-pr\.mjs --check` result/, doc);
  }
  for (const doc of ["skills/docs/workflow-handoff-contract.md", ".claude/skills/docs/workflow-handoff-contract.md"]) {
    const text = squeeze(await readRepo(doc));
    assert.match(text, /brief never contains a merge step/, doc);
    assert.match(text, /exact `merge-pr\.mjs` command line, with `--human-approved-by <login>`.*`--standing-authorization`/, doc);
    assert.match(text, /`approvalPath: comment_marker`.*exact `approveMergeLine`/, doc);
  }
  for (const doc of ["skills/dev-loop/SKILL.md", ".claude/skills/dev-loop/SKILL.md"]) {
    assert.match(squeeze(await readRepo(doc)), /`approvalPath: comment_marker`.*exact `approveMergeLine`/, doc);
  }
});
