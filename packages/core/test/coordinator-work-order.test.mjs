import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildDevLoopHandoffEnvelope } from "../src/loop/handoff-envelope.mjs";
import { buildCoordinatorWorkOrder, CoordinatorWorkOrderRefusal } from "../src/loop/coordinator-work-order.mjs";
import { INTERNAL_DEV_LOOP_STRATEGY } from "../src/loop/public-dev-loop-routing-contract.mjs";

const artifact = (kind, fields) => ({ kind, branch: null, phase: null, ...fields });
function envelopeFor(activeArtifact, { repoRoot = "/checkout-a", requiredReads, now } = {}) {
  const resolved = { bundle: {
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
    executionMode: "bounded_handoff",
    nextAction: "Follow up on the PR.",
    requiredReads: requiredReads ?? ["skills/docs/b.md", "skills/docs/a.md"],
    activeArtifact,
  } };
  const settings = { workflow: { humanMergeOnly: true } };
  const options = { repoSlug: "o/r", repoRoot, sanctionedCommands: { merge: "scripts/github/merge-pr.mjs", ready: "scripts/github/ready.mjs" } };
  return buildDevLoopHandoffEnvelope(resolved, settings, { currentHeadSha: "a".repeat(40) }, options, now);
}
const issueEnvelope = (opts) => envelopeFor(artifact("issue", { issue: 2483, pr: 2900, linkedPr: null }), opts);
const prEnvelope = (opts) => envelopeFor(artifact("pr", { pr: 2900, issue: null }), opts);

// C1
test("C1 the order carries the resolver envelope's route, next action, stops, acceptance, reads and commands unchanged", () => {
  const envelope = issueEnvelope();
  const { workOrder } = buildCoordinatorWorkOrder({ envelope });
  for (const key of ["nextAction", "currentGate", "executionMode", "acceptance", "sanctionedCommands", "target", "control"]) {
    assert.deepEqual(workOrder.handoff[key], envelope[key], key);
  }
  assert.deepEqual([...workOrder.handoff.stopRules].sort(), [...envelope.stopRules].sort());
  assert.deepEqual([...workOrder.handoff.requiredReads].sort(), [...envelope.requiredReads].sort());
  assert.equal(workOrder.role, "coordinator");
});

test("C1 a free-form brief, appended instructions, payload JSON or summary file is refused", () => {
  const envelope = issueEnvelope();
  for (const extra of [{ brief: "do X" }, { instructions: "also Y" }, { payload: {} }, { summaryFile: "s.md" }, { overrides: { mergeAuthorized: true } }]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope, ...extra }), CoordinatorWorkOrderRefusal, Object.keys(extra)[0]);
  }
});

test("C1 an envelope with overrides, or a missing or malformed envelope, emits no order", () => {
  const withOverrides = buildDevLoopHandoffEnvelope(
    { bundle: { selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, executionMode: "bounded_handoff", nextAction: "n", requiredReads: [], activeArtifact: artifact("pr", { pr: 5 }) } },
    {}, {}, { repoSlug: "o/r", overrides: { mergeAuthorized: true } },
  );
  assert.throws(() => buildCoordinatorWorkOrder({ envelope: withOverrides }), /overrides/);
  assert.throws(() => buildCoordinatorWorkOrder({}), CoordinatorWorkOrderRefusal);
  assert.throws(() => buildCoordinatorWorkOrder({ envelope: { target: {} } }), CoordinatorWorkOrderRefusal);
});

// C2
test("C2 permuted set ordering, two checkout roots and different collection times give one digest", () => {
  const a = buildCoordinatorWorkOrder({ envelope: issueEnvelope({ repoRoot: "/checkout-a", now: new Date(1) }), allowedFiles: ["src/a.mjs", "src/b.mjs"] });
  const b = buildCoordinatorWorkOrder({
    envelope: issueEnvelope({ repoRoot: "/elsewhere/checkout-b", requiredReads: ["skills/docs/a.md", "skills/docs/b.md"], now: new Date(2) }),
    allowedFiles: ["src/b.mjs", "src/a.mjs"],
  });
  assert.notEqual(a.workOrder.handoff.cwd, b.workOrder.handoff.cwd);
  assert.equal(a.workOrderDigest, b.workOrderDigest);
  assert.match(a.workOrderDigest, /^sha256:[0-9a-f]{64}$/);
});

test("C2 changing a semantic input changes the digest", () => {
  const base = buildCoordinatorWorkOrder({ envelope: issueEnvelope() }).workOrderDigest;
  assert.notEqual(buildCoordinatorWorkOrder({ envelope: issueEnvelope({ requiredReads: ["skills/docs/c.md"] }) }).workOrderDigest, base);
  assert.notEqual(buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: ["src/x.mjs"] }).workOrderDigest, base);
  assert.notEqual(buildCoordinatorWorkOrder({ envelope: issueEnvelope(), attempt: 2 }).workOrderDigest, base);
});

// C19
test("C19 the allowed files include changes/<issue>-*.md when the scope names no changes path", () => {
  const { workOrder } = buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: ["src/a.mjs"] });
  assert.deepEqual(workOrder.allowedFiles, ["changes/2483-*.md", "src/a.mjs"]);
});

test("C19 a lightweight unit without an issue uses its PR number", () => {
  const { workOrder } = buildCoordinatorWorkOrder({ envelope: prEnvelope() });
  assert.deepEqual(workOrder.allowedFiles, ["changes/2900-*.md"]);
});

test("C19 an absolute or escaping allowed file is refused", () => {
  for (const bad of ["/etc/passwd", "../x", "a/../../x"]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: [bad] }), CoordinatorWorkOrderRefusal, bad);
  }
});
