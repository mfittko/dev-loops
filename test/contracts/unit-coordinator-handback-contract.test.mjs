// Issue 2532: one fresh unit coordinator per phase, at or below the 150K peak-context cap.
// The boundaries are tooling-emitted (`envelope.unitBoundaries`), the successor re-resolves
// authoritative state instead of inheriting a predecessor's brief, and the hand-back packet
// stays compact. Both harness mirrors must keep carrying the rule (#1086).
import { buildCoordinatorWorkOrder } from "@dev-loops/core/loop/coordinator-work-order";
import { buildDevLoopHandoffEnvelope } from "@dev-loops/core/loop/handoff-envelope";
import {
  INTERNAL_DEV_LOOP_STRATEGY,
  DEV_LOOP_TARGET_KIND,
} from "@dev-loops/core/loop/public-dev-loop-routing-contract";

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

// Rule prose lives in the two owning docs; both harness mirrors must keep carrying it.
// Claims and content are whitespace-normalized: a reflow must never fail a rule that is
// still stated, only a claim that has actually been dropped.
const RULE_PROSE = {
  "agents/dev-loop.agent.md": [
    "unitBoundaries` names where your unit ends",
    "opening the draft PR, and after posting a gate verdict",
    "unit identity, status, `nextAction`, evidence links",
    "No transcript, no tool output, no review text",
    "150K-token cap",
  ],
  "skills/docs/main-agent-contract.md": [
    "fresh unit coordinator per phase",
    "never writes or summarizes the next brief",
    "unit identity, status, `nextAction`, evidence",
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
  const sources = [await readRepo("agents/dev-loop.agent.md"), await readRepo(".claude/agents/dev-loop.md")];
  for (const content of sources) {
    const normalized = content.replace(/\r\n/g, "\n");
    assert.ok(normalized.includes("## Unit coordinator hand-back"), "every harness mirror keeps the hand-back section");
    assert.ok(normalized.includes("150K-token cap"), "every harness mirror keeps the peak-context cap");
  }
});
