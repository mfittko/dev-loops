import assert from "node:assert/strict";
import { test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { readRepo } from "../imported-assets-helpers.mjs";

// Workflow-driven model of the two concurrency groups the gate-evidence
// reporter split introduced (docs/decisions/0075), simulating a "cancelling
// burst" of N review/comment events at a clean PR close. Unlike a
// hand-coded model, every input below is PARSED out of the real
// .github/workflows/gate-evidence.yml — a concurrency flip or a
// reuse/recompute head-selection swap in the workflow changes what this
// derives, which in turn flips the assertions below.
async function deriveWorkflowFacts() {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);
  const detectorJob = workflow.jobs["gate-evidence-runner"];
  const reporterJob = workflow.jobs["gate-evidence-reporter"];
  const detectorCancels = detectorJob.concurrency["cancel-in-progress"] === true;
  const reporterCancels = reporterJob.concurrency["cancel-in-progress"] === true;

  const postStep = reporterJob.steps.find((step) => step.id === "post");
  assert.ok(postStep, "expected the reporter's post step");
  const run = postStep.run;
  const env = postStep.env ?? {};

  // Classify an env var by which PR-state it ultimately reads, so the model
  // reasons in roles ("detector's own evaluated head", "this run's own
  // recompute evaluated head", "the reporter's independently-resolved own
  // head") rather than in var names — a rename survives, a role SWAP does not.
  const roleOf = (varName) => {
    const expr = env[varName];
    if (typeof expr === "string" && expr.includes("gate-evidence-runner.outputs.evaluated_head_sha")) return "detector";
    if (typeof expr === "string" && expr.includes("recompute_check.outputs.evaluated_head_sha")) return "recompute";
    if (typeof expr === "string" && expr.includes("steps.pr.outputs.head_sha")) return "reporterOwn";
    throw new Error(`unrecognized head-selection env var: ${varName} -> ${expr}`);
  };

  const recomputeIfElse = run.match(/if \[ "\$RECOMPUTE" = "true" \]; then([\s\S]*?)else([\s\S]*?)fi/);
  assert.ok(recomputeIfElse, "expected an if $RECOMPUTE = true / else / fi block in the post step");
  const recomputeVar = recomputeIfElse[1].match(/evaluated_head_sha="\$(\w+)"/)?.[1];
  const reuseVar = recomputeIfElse[2].match(/evaluated_head_sha="\$(\w+)"/)?.[1];
  assert.ok(recomputeVar && reuseVar, "expected evaluated_head_sha assigned in both RECOMPUTE branches");

  const fallbackIfElse = run.match(/if \[ -n "\$evaluated_head_sha" \]; then([\s\S]*?)else([\s\S]*?)fi/);
  assert.ok(fallbackIfElse, "expected an empty-evaluated-head fallback if/else/fi block in the post step");
  const fallbackVar = fallbackIfElse[2].match(/head_sha="\$(\w+)"/)?.[1];
  assert.ok(fallbackVar, "expected a fallback head_sha assignment");

  return {
    detectorCancels,
    reporterCancels,
    recomputeRole: roleOf(recomputeVar),
    reuseRole: roleOf(reuseVar),
    fallbackRole: roleOf(fallbackVar),
  };
}

// detectorCancels=true: cancel-in-progress lets any later-triggered detector
// run cancel an earlier in-flight one, so a caller-supplied `detectorCompletes`
// set (including the empty worst case) is honored as given. A flip to false
// would mean nothing can ever cancel a detector run, so every run completes
// regardless of what the caller simulates — contradicting an "every run
// cancelled" scenario outright.
//
// reporterCancels=false: a still-queued reporter run superseded by a newer one
// is dropped without executing, but a running one is never killed, so only
// the run triggered by the FINAL event is guaranteed to execute and post. A
// flip to true removes that guarantee — modeled here as every event's
// reporter executing, which breaks the "exactly one post, at the final event"
// invariant the tests below pin.
function runBurst({
  eventCount,
  detectorCompletes = new Set(),
  liveEvidenceState,
  detectorEvaluatedHeadByEvent = [],
  recomputeEvaluatedHeadByEvent = [],
  reporterOwnHeadByEvent = [],
  facts,
}) {
  if (eventCount < 1) throw new Error("eventCount must be >= 1");

  const detectorSurvivors = facts.detectorCancels
    ? detectorCompletes
    : new Set(Array.from({ length: eventCount }, (_, i) => i));
  const detectorOutputs = Array.from({ length: eventCount }, (_, i) => (detectorSurvivors.has(i)
    ? { evidenceState: liveEvidenceState, evaluatedHeadSha: detectorEvaluatedHeadByEvent[i] }
    : null));
  const detectorPosts = []; // the detector never posts a status — structural, unaffected by cancellation.

  const executingReporterIndices = facts.reporterCancels
    ? Array.from({ length: eventCount }, (_, i) => i)
    : [eventCount - 1];

  const reporterPosts = executingReporterIndices.map((eventIndex) => {
    const detectorOutput = detectorOutputs[eventIndex];
    const recomputed = detectorOutput === null;
    const evidenceState = recomputed ? liveEvidenceState : detectorOutput.evidenceState;
    const headByRole = {
      detector: detectorOutput?.evaluatedHeadSha,
      recompute: recomputeEvaluatedHeadByEvent[eventIndex],
      reporterOwn: reporterOwnHeadByEvent[eventIndex],
    };
    const evaluatedHeadSha = headByRole[recomputed ? facts.recomputeRole : facts.reuseRole];
    const postedHeadSha = evaluatedHeadSha || headByRole[facts.fallbackRole];
    const state = evidenceState === "satisfied" ? "success" : "failure";
    return { eventIndex, state, recomputed, postedHeadSha };
  });

  return { detectorPosts, reporterPosts };
}

test("derived workflow facts: detector cancels, reporter does not, and head-selection roles are correctly paired", async () => {
  const facts = await deriveWorkflowFacts();
  assert.equal(facts.detectorCancels, true);
  assert.equal(facts.reporterCancels, false);
  assert.equal(facts.recomputeRole, "recompute", "the RECOMPUTE branch must post to this run's OWN recompute-evaluated head");
  assert.equal(facts.reuseRole, "detector", "the REUSE branch must post to the detector's OWN evaluated head");
  assert.equal(facts.fallbackRole, "reporterOwn", "an empty evaluated head must fall back to the reporter's own resolved head");
});

test("a cancelling burst where EVERY detector run is cancelled still ends success at the final evaluated head, via reporter recompute", async () => {
  const facts = await deriveWorkflowFacts();
  const { detectorPosts, reporterPosts } = runBurst({
    eventCount: 6,
    detectorCompletes: new Set(), // worst case: even the last-triggered detector run is cancelled
    liveEvidenceState: "satisfied",
    recomputeEvaluatedHeadByEvent: { 5: "final-head" },
    reporterOwnHeadByEvent: { 5: "final-head" },
    facts,
  });
  assert.equal(detectorPosts.length, 0, "a cancelled detector run posts nothing — no spurious failure");
  assert.equal(reporterPosts.length, 1, "reporterCancels=false guarantees exactly one post");
  assert.equal(reporterPosts[0].eventIndex, 5, "the FINAL event's reporter is the one that posts");
  assert.equal(reporterPosts[0].recomputed, true, "with no detector output available, the reporter recomputes");
  assert.equal(reporterPosts[0].state, "success");
  assert.equal(reporterPosts[0].postedHeadSha, "final-head", "the recompute path posts to THIS run's own evaluated head");
});

test("when the final detector run DOES complete, the reporter reuses its output and posts to the DETECTOR's own evaluated head", async () => {
  const facts = await deriveWorkflowFacts();
  const { reporterPosts } = runBurst({
    eventCount: 3,
    detectorCompletes: new Set([2]), // only the last-triggered detector run survives
    liveEvidenceState: "satisfied",
    // Deliberately distinct from reporterOwnHeadByEvent: on issue_comment
    // events the two are separate live API resolutions, so a head-selection
    // swap that reads the reporter's own head here instead is caught.
    detectorEvaluatedHeadByEvent: { 2: "detector-evaluated-head" },
    reporterOwnHeadByEvent: { 2: "reporter-own-head" },
    facts,
  });
  assert.equal(reporterPosts[0].recomputed, false);
  assert.equal(reporterPosts[0].state, "success");
  assert.equal(reporterPosts[0].postedHeadSha, "detector-evaluated-head", "the reuse path posts to the detector's own evaluated head, never the reporter's separately-resolved head");
});

test("an empty evaluated head (detection never resolved one) falls back to the reporter's own resolved head", async () => {
  const facts = await deriveWorkflowFacts();
  const { reporterPosts } = runBurst({
    eventCount: 1,
    detectorCompletes: new Set(), // forces recompute
    liveEvidenceState: "not_established",
    recomputeEvaluatedHeadByEvent: { 0: "" }, // detection could not resolve a head at all
    reporterOwnHeadByEvent: { 0: "reporter-fallback-head" },
    facts,
  });
  assert.equal(reporterPosts[0].state, "failure", "a missing evaluated head already fails closed via evidence_state");
  assert.equal(reporterPosts[0].postedHeadSha, "reporter-fallback-head", "an empty evaluated head must still post somewhere, via the reporter's own resolved head");
});

test("unsatisfied evidence still fails closed to failure after the burst, never a stale pending", async () => {
  const facts = await deriveWorkflowFacts();
  const { reporterPosts } = runBurst({
    eventCount: 4,
    detectorCompletes: new Set(),
    liveEvidenceState: "not_established",
    recomputeEvaluatedHeadByEvent: { 3: "final-head" },
    reporterOwnHeadByEvent: { 3: "final-head" },
    facts,
  });
  assert.equal(reporterPosts[0].state, "failure");
  assert.notEqual(reporterPosts[0].state, "pending");
});

test("a single (non-burst) event still resolves via the same model", async () => {
  const facts = await deriveWorkflowFacts();
  const { reporterPosts } = runBurst({
    eventCount: 1,
    liveEvidenceState: "satisfied",
    recomputeEvaluatedHeadByEvent: { 0: "final-head" },
    reporterOwnHeadByEvent: { 0: "final-head" },
    facts,
  });
  assert.equal(reporterPosts[0].eventIndex, 0);
  assert.equal(reporterPosts[0].state, "success");
});
