import { parse as parseYaml } from "yaml";
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

// Pins #1385: gate-evidence must re-fire on review-thread state changes (not
// just push/ready), so a required green check can't go stale on the thread
// axis. Head-staleness (synchronize) and the draft no-op guard must survive
// unchanged.
test("gate-evidence workflow re-fires on review submission, thread resolve/unresolve, and standalone review comments", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);
  const triggers = workflow.on;

  assert.deepEqual(triggers.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  assert.deepEqual(triggers.pull_request_review.types, ["submitted"]);
  assert.deepEqual(triggers.pull_request_review_thread.types, ["resolved", "unresolved"]);
  assert.deepEqual(triggers.pull_request_review_comment.types, ["created"]);

  const job = workflow.jobs["gate-evidence-runner"];
  // Draft PRs must still no-op regardless of which event triggered the run —
  // every added event type carries the same pull_request.draft field pull_request
  // events do.
  assert.equal(job.if, "github.event.pull_request.draft == false");
  assert.equal(workflow.permissions.statuses, "write");
});

// Pins the #1385 gate-review must-fix: pull_request_review/_thread/_comment
// events set github.sha to the BASE branch's latest commit, not the PR head, so
// the job's own implicit check-run would land on the wrong commit for those
// triggers. The fix posts an explicit commit status to the PR's real head SHA
// instead, and no job may be named `gate-evidence` (that would create a second,
// base-SHA-pinned reporter racing the explicit head-SHA status under the same
// required context).
test("gate-evidence posts an explicit status to the PR head SHA, not the job's own check-run", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);

  assert.ok(!("gate-evidence" in workflow.jobs), "no job may be named gate-evidence — that context is reserved for the explicit head-SHA status");

  const steps = workflow.jobs["gate-evidence-runner"].steps;
  const statusStep = steps.find((step) => typeof step.run === "string" && step.run.includes("gh api --method POST"));
  assert.ok(statusStep, "expected a step posting an explicit commit status");
  assert.equal(statusStep.if, "always()");
  assert.match(statusStep.run, /statuses\/\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(statusStep.run, /context=gate-evidence/);
});
