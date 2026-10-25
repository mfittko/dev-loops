// Issue 2532: one fresh unit coordinator per phase, at or below the 150K peak-context cap.
// The boundaries are tooling-emitted (`envelope.unitBoundaries`), the successor re-resolves
// authoritative state instead of inheriting a predecessor's brief, and the hand-back packet
// stays compact. Both harness mirrors must keep carrying the rule (#1086).
import { buildCoordinatorWorkOrder } from "@dev-loops/core/loop/coordinator-work-order";
import { buildDevLoopHandoffEnvelope, STATELESS_UNIT_STRATEGIES } from "@dev-loops/core/loop/handoff-envelope";
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
    "unitBoundaries` names where your unit ends",
    "stops when it opens its draft PR",
    "stops after posting its own gate verdict",
    "unit identity, status, `nextAction`, evidence links",
    "No transcript, no tool output, no review text",
    "150K-token cap",
    // The successor, never the orchestrator, re-resolves the resume identity the envelope carries.
    "the successor re-resolves `unitBoundaries.resume`",
    // The packet's closed field list has a slot for the successor dispatch's required input.
    "including the startup-output path your unit ran",
    // The packet's closed field list also carries the optional open question (dod:8).
    "and an open question if one is needed",
    // Both listed-but-unreachable verdict entries are recorded naming approximations.
    "recorded naming approximations",
  ],
  "skills/docs/main-agent-contract.md": [
    "fresh unit coordinator per phase",
    "never writes or summarizes the next brief",
    "unit identity, status, `nextAction`, evidence",
    // The same dispatch input the agent-side packet pins, on the contract surface this time.
    "including the startup-output path that unit ran",
    // The packet's closed field list also carries the optional open question (dod:8).
    "and an open question if one is needed",
    "150K-token cap",
    "at most 10% empty wakeups, measured against root turns rather than wait duration",
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
    "agents/dev-loop.agent.md": ["## Unit coordinator hand-back", "150K-token cap", "ordered, first-match"],
    ".claude/agents/dev-loop.md": ["## Unit coordinator hand-back", "150K-token cap", "ordered, first-match"],
    "skills/docs/main-agent-contract.md": ["## Unit coordinator boundaries", "150K-token cap", "at most 10% empty wakeups, measured against root turns rather than wait duration"],
    ".claude/skills/docs/main-agent-contract.md": ["## Unit coordinator boundaries", "150K-token cap", "at most 10% empty wakeups, measured against root turns rather than wait duration"],
    "skills/docs/workflow-handoff-contract.md": ["## Unit coordinator boundaries", "handBackAfter", "ordered and first-match"],
    ".claude/skills/docs/workflow-handoff-contract.md": ["## Unit coordinator boundaries", "handBackAfter", "ordered and first-match"],
  };
  for (const [doc, claims] of Object.entries(mirrorClaims)) {
    const normalized = squeeze((await readRepo(doc)).replace(/\r\n/g, "\n"));
    for (const claim of claims) {
      assert.ok(normalized.includes(squeeze(claim)), `${doc} keeps its harness-agnostic rule: ${claim}`);
    }
  }
});
