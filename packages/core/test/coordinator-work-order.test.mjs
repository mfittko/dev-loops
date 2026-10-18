import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildDevLoopHandoffEnvelope, validateHandoffEnvelope } from "../src/loop/handoff-envelope.mjs";
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
  assert.deepEqual(workOrder.handoff.stopRules, envelope.stopRules);
  assert.deepEqual(workOrder.handoff.requiredReads, envelope.requiredReads);
  assert.equal(workOrder.role, "coordinator");
});

test("C1 a needs_reconcile envelope keeps its stop-rule order and still validates", () => {
  const envelope = buildDevLoopHandoffEnvelope(
    { bundleKind: "needs_reconcile", selectedStrategy: "none", bundle: { bundleKind: "needs_reconcile", selectedStrategy: null, routeKind: "needs_reconcile", selectedGate: "fail_closed_reconcile", executionMode: "bounded_handoff", nextAction: "Reconcile the canonical state before routing.", requiredReads: [], activeArtifact: artifact("issue", { issue: 2483 }) } },
    { workflow: { humanMergeOnly: true } }, { currentHeadSha: "a".repeat(40) }, { repoSlug: "o/r", repoRoot: "/checkout-a" },
  );
  assert.equal(envelope.stopRules[0], "reconcile");
  const { workOrder } = buildCoordinatorWorkOrder({ envelope });
  assert.deepEqual(workOrder.handoff.stopRules, envelope.stopRules);
  assert.equal(validateHandoffEnvelope(workOrder.handoff).ok, true);
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
  const withGate = (envelope, gateConfig) => ({ ...envelope, gateConfig });
  const a = buildCoordinatorWorkOrder({
    envelope: withGate(issueEnvelope({ repoRoot: "/checkout-a", now: new Date(1) }), { angles: ["x", "y"], excludeAngles: ["p", "q"], blockCleanOnFindingSeverities: ["high", "medium"], requireCi: true }),
    allowedFiles: ["src/a.mjs", "src/b.mjs"],
  });
  const b = buildCoordinatorWorkOrder({
    envelope: withGate(issueEnvelope({ repoRoot: "/elsewhere/checkout-b", now: new Date(2) }), { angles: ["y", "x"], excludeAngles: ["q", "p"], blockCleanOnFindingSeverities: ["medium", "high"], requireCi: true }),
    allowedFiles: ["src/b.mjs", "src/a.mjs"],
  });
  assert.notEqual(a.workOrder.handoff.cwd, b.workOrder.handoff.cwd);
  assert.equal(a.workOrderDigest, b.workOrderDigest);
  assert.match(a.workOrderDigest, /^sha256:[0-9a-f]{64}$/);
});

test("C2 changing a semantic input changes the digest", () => {
  const base = buildCoordinatorWorkOrder({ envelope: issueEnvelope() }).workOrderDigest;
  assert.notEqual(buildCoordinatorWorkOrder({ envelope: issueEnvelope({ requiredReads: ["skills/docs/c.md"] }) }).workOrderDigest, base);
  assert.notEqual(buildCoordinatorWorkOrder({ envelope: issueEnvelope({ requiredReads: ["skills/docs/a.md", "skills/docs/b.md"] }) }).workOrderDigest, base);
  for (const bad of [["/checkout/skills/docs/a.md"], ["skills/docs/a.md", "/checkout/skills/docs/b.md"]]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope: issueEnvelope({ requiredReads: bad }) }), CoordinatorWorkOrderRefusal, bad.join());
  }
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

test("C19 allowed files are normalized and control characters are refused", () => {
  const { workOrder } = buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: ["./src//a.mjs", "src/./a.mjs", "changes/2483-*.md"] });
  assert.deepEqual(workOrder.allowedFiles, ["changes/2483-*.md", "src/a.mjs"]);
  for (const bad of ["src/a\n.mjs", "src/a\u0000.mjs", "", ".", "changes\\README.md", "changes\\9999-x.md", "a\\..\\..\\x", "\\etc\\passwd", "src\\a.mjs"]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: [bad] }), CoordinatorWorkOrderRefusal, JSON.stringify(bad));
  }
});

test("C19 a changes entry other than the unit's own fragment is refused", () => {
  for (const bad of ["changes/9999-*.md", "changes/README.md", "./changes/2484-x.md", "changes/2483-a.md", "changes", "changes/", "**", "*/9999-x.md", "change?/x.md", "{changes,src}/x.md", "[c]hanges/x.md", "Changes/9999-x.md", "CHANGES/README.md", "@(changes)/x.md", "+(changes)/x.md", "!(src)/x.md", " changes/9999-x.md"]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: [bad] }), CoordinatorWorkOrderRefusal, bad);
  }
});

test("C19 glob entries below a non-changes directory are accepted", () => {
  const { workOrder } = buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: ["src/**"] });
  assert.deepEqual(workOrder.allowedFiles, ["changes/2483-*.md", "src/**"]);
  for (const ok of ["src/a.mjs", "docs/x/y.md", "./src/a.mjs", ".github/workflows/ci.yml", "src/**/*.mjs"]) {
    assert.doesNotThrow(() => buildCoordinatorWorkOrder({ envelope: issueEnvelope(), allowedFiles: [ok] }), ok);
  }
});

test("C19 a target with neither issue nor pr is refused", () => {
  const envelope = issueEnvelope();
  const target = { ...envelope.target };
  delete target.issue;
  delete target.pr;
  assert.throws(() => buildCoordinatorWorkOrder({ envelope: { ...envelope, target } }), CoordinatorWorkOrderRefusal);
});

test("C1 missing input refuses with CoordinatorWorkOrderRefusal, not a TypeError", () => {
  for (const bad of [undefined, null]) assert.throws(() => buildCoordinatorWorkOrder(bad), CoordinatorWorkOrderRefusal);
});

test("C2 attempt 0, 1.5 and the string \"2\" are refused", () => {
  for (const bad of [0, 1.5, "2", 1e20, 2 ** 53]) {
    assert.throws(() => buildCoordinatorWorkOrder({ envelope: issueEnvelope(), attempt: bad }), CoordinatorWorkOrderRefusal, String(bad));
  }
  for (const good of [1, 2, Number.MAX_SAFE_INTEGER]) {
    assert.equal(buildCoordinatorWorkOrder({ envelope: issueEnvelope(), attempt: good }).workOrder.attempt, good);
  }
});
