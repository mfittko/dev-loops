import { parse as parseYaml } from "yaml";
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

// Pins #1385 + #1464: gate-evidence must re-fire when a NEW unresolved thread
// can appear (review submitted, or a review comment opens a thread) AND when a
// gate verdict comment is created/edited (verdicts are issue comments, so
// without that trigger a clean current-head verdict leaves the required status
// stale-pending forever). Head-staleness (synchronize) and the draft no-op
// guard must survive unchanged. NOTE: GitHub Actions has NO
// `pull_request_review_thread` workflow trigger (thread resolve/unresolve is a
// webhook but not an `on:` event); using it makes the whole workflow file
// server-side-invalid, so it must never be added.
const VALID_WORKFLOW_EVENTS = new Set([
  "pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment",
  "issue_comment",
]);
test("gate-evidence workflow re-fires on review submission, review comments, and gate-verdict issue comments, with only valid Actions triggers", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);
  const triggers = workflow.on;

  assert.deepEqual(triggers.pull_request.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
  assert.deepEqual(triggers.pull_request_review.types, ["submitted"]);
  assert.deepEqual(triggers.pull_request_review_comment.types, ["created"]);
  // #1464: verdicts are issue comments; created covers a fresh verdict post.
  // edited is the lost-run recovery: editing an existing verdict comment
  // re-fires the check (the idempotent same-head upsert is a suppressed noop
  // that performs no edit, so it is NOT what edited covers).
  assert.deepEqual(triggers.issue_comment.types, ["created", "edited"]);

  // Guard against a recurrence of the invalid `pull_request_review_thread` trigger
  // (and any other non-existent event) that GitHub's parser rejects wholesale.
  assert.ok(!("pull_request_review_thread" in triggers), "pull_request_review_thread is not a valid Actions trigger");
  for (const event of Object.keys(triggers)) {
    assert.ok(VALID_WORKFLOW_EVENTS.has(event), `unknown/invalid workflow trigger: ${event}`);
  }

  // The trigger's marker literal must match what BOTH verdict producers
  // actually emit — a drifted heading would silently disarm the re-fire.
  const upsert = await readRepo("scripts/github/upsert-checkpoint-verdict.mjs");
  const fallback = await readRepo("skills/dev-loop/scripts/post-gate-verdict-fallback.mjs");
  assert.match(content, /### Gate review:/);
  assert.ok(upsert.includes("### Gate review:"), "upsert-checkpoint-verdict must emit the marker heading the workflow guard matches");
  assert.ok(fallback.includes("### Gate review:"), "fallback poster must emit the marker heading the workflow guard matches");

  const job = workflow.jobs["gate-evidence-runner"];
  // Concurrency must live at JOB level: a workflow-level group is joined
  // before the job `if` runs, letting a marker-skipped ordinary-comment run
  // cancel a live evaluation and post nothing (stale-status deadlock).
  assert.ok(!("concurrency" in workflow), "concurrency must not be declared at workflow level");
  assert.ok(job.concurrency, "job-level concurrency group required");
  assert.equal(job.concurrency["cancel-in-progress"], true);
  assert.equal(
    job.concurrency.group,
    "gate-evidence-${{ github.event.pull_request.number || github.event.issue.number }}",
  );
  // pull_request/review events skip drafts via the payload; issue_comment runs
  // start only for PR comments carrying the gate-comment marker (draft state is
  // resolved in-job, since issue_comment payloads have no pull_request object).
  // Exact-composition pin: substring checks alone would let a boolean rewrite
  // (e.g. an || that opens the guard) slip through.
  assert.equal(
    job.if.replace(/\s+/gu, " ").trim(),
    "(github.event_name != 'issue_comment' && github.event.pull_request.draft == false) || " +
      "(github.event_name == 'issue_comment' && github.event.issue.pull_request && " +
      "startsWith(github.event.comment.body, '### Gate review:') && " +
      "contains(fromJSON('[\"OWNER\", \"MEMBER\", \"COLLABORATOR\"]'), github.event.comment.author_association))",
  );
  assert.equal(workflow.permissions.statuses, "write");
});

// Pins the #1385 gate-review must-fix (as evolved by #1464): review/comment
// events set github.sha to the BASE branch's latest commit, not the PR head,
// and issue_comment events carry no pull_request object at all — so the job
// resolves number/draft/head SHA once (Resolve-PR-facts step) and posts an
// explicit commit status to that resolved head SHA. No job may be named
// `gate-evidence` (that would create a second, wrong-SHA reporter racing the
// explicit head-SHA status under the same required context).
test("gate-evidence posts an explicit status to the resolved PR head SHA, not the job's own check-run", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);

  assert.ok(!("gate-evidence" in workflow.jobs), "no job may be named gate-evidence — that context is reserved for the explicit head-SHA status");

  const steps = workflow.jobs["gate-evidence-runner"].steps;
  const factsStep = steps.find((step) => step.id === "pr");
  assert.ok(factsStep, "expected a Resolve-PR-facts step with id 'pr'");
  assert.match(factsStep.run, /issue_comment/);
  assert.match(factsStep.run, /number=/);
  assert.match(factsStep.run, /head_sha=/);
  assert.match(factsStep.run, /draft=/);

  // Evaluation code must be TRUSTED: checkout pinned to the default branch
  // (never the PR head — a head checkout in these base-context statuses:write
  // runs would let a fork PR forge the required check), with no persisted
  // git credentials.
  const checkoutStep = steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout"));
  assert.ok(checkoutStep, "expected a checkout step");
  assert.equal(checkoutStep.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(checkoutStep.with["persist-credentials"], false);

  // The detector must consume the RESOLVED number, not a payload field that
  // is absent on issue_comment events.
  const detectorStep = steps.find((step) => step.id === "gate_check");
  assert.ok(detectorStep, "expected the detector step");
  assert.match(detectorStep.run, /--pr "\$\{\{ steps\.pr\.outputs\.number \}\}"/);

  const statusStep = steps.find((step) => typeof step.run === "string" && step.run.includes("gh api --method POST"));
  assert.ok(statusStep, "expected a step posting an explicit commit status");
  // !cancelled() (not always()): a failed detector still fail-closed posts,
  // but a run superseded via cancel-in-progress must NOT race the newer run
  // with a spurious failure; the draft guard keeps the draft no-op.
  assert.equal(
    statusStep.if.replace(/\s+/gu, " ").trim(),
    "${{ !cancelled() && steps.pr.outputs.draft == 'false' }}",
  );
  assert.match(statusStep.run, /statuses\/\$\{\{ steps\.pr\.outputs\.head_sha \}\}/);
  assert.match(statusStep.run, /context=gate-evidence/);

  // Every step that needs a checkout/deps or reports must skip on drafts,
  // matching the previous job-level draft no-op.
  for (const step of steps) {
    if (step.id === "pr") continue;
    assert.match(String(step.if ?? ""), /steps\.pr\.outputs\.draft == 'false'/, `step "${step.name}" must carry the draft guard`);
  }
});
