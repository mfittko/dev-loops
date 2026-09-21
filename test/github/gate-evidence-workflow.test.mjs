import { parse as parseYaml } from "yaml";
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { LOOP_DERIVED_CI_CHECK_NAMES } from "@dev-loops/core/loop/copilot-ci-status";

// Pins #1385 + #1464: gate-evidence must re-fire when a NEW unresolved thread
// can appear (review submitted, or a review comment opens a thread) AND when a
// gate verdict is posted or corrected in place — verdicts are PR reviews, with
// legacy/fallback verdicts still arriving as issue comments, so without those
// triggers a clean current-head verdict leaves the required status
// stale-pending forever. The draft no-op guard must survive unchanged, and
// head-staleness via `synchronize` is now intentionally NOT re-fired
// (pre-merge-only, #1702): development pushes must not start/leave a
// gate-evidence run; the check materializes at the verdict points. Pins #2189:
// a head-pinned `approve merge <sha>` comment on an escalated/T1 PR must ALSO
// re-fire (same OWNER/MEMBER/COLLABORATOR author guard) — otherwise a
// pre-approval-era FAILURE status stands forever with no event left to clear
// it. NOTE: GitHub Actions has NO
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

  // #1702: `synchronize` (development push) is deliberately NOT a trigger — the
  // check is pre-merge-only. Development pushes must not start/leave a blocking
  // gate-evidence run; the check materializes only at ready_for_review / a
  // verdict-post / a verdict-shaped issue comment.
  assert.deepEqual(triggers.pull_request.types, ["opened", "reopened", "ready_for_review"]);
  assert.ok(
    !Array.isArray(triggers.pull_request.types) || !triggers.pull_request.types.includes("synchronize"),
    "synchronize must not be a trigger — the check is pre-merge-only",
  );
  // The verdict surface is a PR review: `submitted` fires for each verdict on a
  // NEW head, `edited` for the same-head in-place correction (PUT
  // pulls/{pr}/reviews/{id}) and for the manual lost-run recovery. BOTH types
  // are load-bearing — without `edited`, a same-head correction leaves the
  // required status at whatever the pre-verdict run computed.
  assert.deepEqual(triggers.pull_request_review.types, ["submitted", "edited"]);
  assert.deepEqual(triggers.pull_request_review_comment.types, ["created"]);
  // Legacy/fallback verdicts still land as issue comments, with the same
  // created/edited split. An identical same-head rerun noops with no event.
  // `deleted` re-fires when an approve-merge approval comment is deleted
  // (retraction), so a stale SUCCESS never stands (fail-closed).
  assert.deepEqual(triggers.issue_comment.types, ["created", "edited", "deleted"]);

  // Guard against a recurrence of the invalid `pull_request_review_thread` trigger
  // (and any other non-existent event) that GitHub's parser rejects wholesale.
  assert.ok(!("pull_request_review_thread" in triggers), "pull_request_review_thread is not a valid Actions trigger");
  for (const event of Object.keys(triggers)) {
    assert.ok(VALID_WORKFLOW_EVENTS.has(event), `unknown/invalid workflow trigger: ${event}`);
  }

  // The guard is startsWith(body, marker), so pin the RENDERED bodies of both
  // producers: each must BEGIN with the marker, or the re-fire silently
  // disarms. Source-substring greps would miss a preamble line added ahead of
  // the heading.
  const { renderGateReviewCommentBody } = await import("../../scripts/github/upsert-checkpoint-verdict.mjs");
  const { renderFallbackGateReviewCommentBody } = await import("../../skills/dev-loop/scripts/post-gate-verdict-fallback.mjs");
  const sample = {
    gate: "pre_approval_gate",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    verdict: "clean",
    findingsSummary: "sample",
    nextAction: "sample",
  };
  assert.ok(
    renderGateReviewCommentBody({ ...sample, blockCleanOnFindingSeverities: [] }).startsWith("### Gate review:"),
    "upsert-checkpoint-verdict's rendered body must START with the marker the workflow guard matches",
  );
  assert.ok(
    renderFallbackGateReviewCommentBody(sample).startsWith("### Gate review:"),
    "fallback poster's rendered body must START with the marker the workflow guard matches",
  );

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
  // start only for PR comments carrying the gate-comment marker OR the
  // head-pinned approve-merge marker (#2189) (draft state is resolved in-job,
  // since issue_comment payloads have no pull_request object).
  // Exact-composition pin: substring checks alone would let a boolean rewrite
  // (e.g. an || that opens the guard) slip through.
  const collapsedIf = job.if.replace(/\s+/gu, " ").trim();
  assert.equal(
    collapsedIf,
    "(github.event_name != 'issue_comment' && github.event.pull_request.draft == false) || " +
      "(github.event_name == 'issue_comment' && github.event.issue.pull_request && " +
      "(startsWith(github.event.comment.body, '### Gate review:') || " +
      "startsWith(github.event.comment.body, 'approve merge ') || " +
      "startsWith(github.event.changes.body.from, 'approve merge ')) && " +
      "contains(fromJSON('[\"OWNER\", \"MEMBER\", \"COLLABORATOR\"]'), github.event.comment.author_association))",
  );
  // #2189: the approve-merge marker must be a re-fire trigger, not just the
  // gate-comment marker — otherwise an approved escalated/T1 PR's stale
  // pre-approval FAILURE never gets a fresh evaluation.
  assert.ok(
    collapsedIf.includes("startsWith(github.event.comment.body, 'approve merge ')"),
    "approve-merge marker must be a gate-evidence re-fire trigger (#2189)",
  );
  // RETRACTION must also re-fire: an edit-away (new body no longer matches,
  // but `changes.body.from` carries the prior approve-merge body) must start
  // a run, or a retracted approval leaves the stale pre-retraction SUCCESS
  // standing (fail-open).
  assert.ok(
    collapsedIf.includes("startsWith(github.event.changes.body.from, 'approve merge ')"),
    "edit-away retraction of an approve-merge marker must re-fire gate-evidence (fail-closed)",
  );
  assert.equal(workflow.permissions.statuses, "write");
});

// Pin #1702's stale-PENDING regression AND #2262's split: the detector
// (`gate-evidence-runner`) no longer posts a status at all — it only computes
// and exposes `evidence_state` as a job output. The reporter
// (`gate-evidence-reporter`) OWNS the required `gate-evidence` status, is
// concurrency-exempt (non-cancelling) from the detector's cancel-in-progress
// group so the final event in a burst always gets to post, and always posts a
// definitive success/failure on the current head SHA — never `pending`. The
// check only fires at pre-merge/verdict points, so `not_established` (no
// clean verdict for the current head yet) is a fail-closed `failure` flipped
// to `success` by the next verdict-post re-fire, never a dangling pending.
test("gate-evidence-runner never posts a status; gate-evidence-reporter always posts a definitive success/failure, never a stale pending (#1702, #2262)", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);
  const runnerJob = workflow.jobs["gate-evidence-runner"];
  const reporterJob = workflow.jobs["gate-evidence-reporter"];
  assert.ok(reporterJob, "expected a gate-evidence-reporter job");

  // The detector must not itself post a status — that is the whole point of
  // the split (#2262): a job that keeps cancel-in-progress can never
  // guarantee the LAST-triggered run of a burst completes, so it must not be
  // the one the required check depends on.
  assert.ok(
    !runnerJob.steps.some((step) => typeof step.run === "string" && step.run.includes("gh api --method POST") && step.run.includes("statuses/")),
    "gate-evidence-runner must not post a status — the reporter owns the required check",
  );
  assert.ok(
    runnerJob.outputs && typeof runnerJob.outputs.evidence_state === "string" && runnerJob.outputs.evidence_state.length > 0,
    "gate-evidence-runner must expose evidence_state as a job output for the reporter to reuse",
  );

  // The reporter is concurrency-exempt from the detector's cancel-in-progress
  // group: its own NON-cancelling group, serializing per PR without ever
  // killing a running reporter, so the final event's reporter always
  // completes and posts (the design invariant closing #2262).
  assert.ok(reporterJob.concurrency, "reporter must declare its own concurrency group");
  assert.equal(
    reporterJob.concurrency.group,
    "gate-evidence-reporter-${{ github.event.pull_request.number || github.event.issue.number }}",
  );
  assert.equal(reporterJob.concurrency["cancel-in-progress"], false, "the reporter's group must be non-cancelling");
  assert.deepEqual(reporterJob.needs, ["gate-evidence-runner"]);
  assert.ok(String(reporterJob.if).includes("always()"), "the reporter must run even when the detector was cancelled");
  assert.ok(
    String(reporterJob.if).includes("needs.gate-evidence-runner.result != 'skipped'"),
    "the reporter must still no-op when the detector was guard-skipped (draft / non-marker comment)",
  );

  const statusStep = reporterJob.steps.find(
    (step) => typeof step.run === "string" && step.run.includes("gh api --method POST"),
  );
  assert.ok(statusStep, "expected the reporter to own the explicit status-posting step");

  // The case statement must never emit `pending`: satisfied is the only
  // success, everything else fails closed to failure.
  assert.ok(!/state="pending"/.test(statusStep.run), "status step must never post a pending state");
  assert.match(statusStep.run, /satisfied\) state="success"/);
  assert.match(statusStep.run, /\*\) state="failure"/);
  assert.ok(!/not_established\) state="pending"/.test(statusStep.run), "not_established must not map to pending");

  // Definitive status targets the RESOLVED PR head SHA (fork-forging guard
  // preserved) under the gate-evidence context.
  assert.match(statusStep.run, /state=\$\{state\}/);
  assert.match(statusStep.run, /statuses\/\$\{head_sha\}/);
  assert.match(statusStep.run, /context=gate-evidence/);

  // Head-pairing, closed completely: evidence_state is computed by
  // detect-checkpoint-evidence.mjs against its OWN resolved `currentHeadSha`
  // — a SEPARATE resolution from the detector's Resolve-PR-facts `steps.pr`
  // step. Pairing evidence_state with `steps.pr`'s head risks posting a
  // verdict for head X onto a Y resolved by a later push. The detector must
  // instead expose the EXACT head detect-checkpoint-evidence.mjs evaluated —
  // its own `currentHeadSha` — as a job output, and the reporter's REUSE path
  // (recompute == false) must post to THAT output, never `steps.pr`'s head.
  assert.ok(
    typeof runnerJob.outputs.evaluated_head_sha === "string" && runnerJob.outputs.evaluated_head_sha.length > 0,
    "gate-evidence-runner must expose evaluated_head_sha (detect-checkpoint-evidence.mjs's own currentHeadSha) as a job output",
  );
  assert.equal(runnerJob.outputs.evaluated_head_sha, "${{ steps.gate_check.outputs.evaluated_head_sha }}");
  const gateCheckStep = runnerJob.steps.find((step) => step.id === "gate_check");
  assert.ok(gateCheckStep, "expected the detector's gate_check step");
  assert.match(
    gateCheckStep.run,
    /jq -r '\.currentHeadSha \/\/ empty' gate_check_stdout\.json gate_check_stderr\.json/,
    "gate_check must extract currentHeadSha from detect-checkpoint-evidence.mjs's own output, not steps.pr",
  );
  assert.match(gateCheckStep.run, /evaluated_head_sha=\$\{evaluated_head_sha\}/);

  // The RECOMPUTE path likewise posts to the head recompute_check ITSELF
  // evaluated, exposed the same way.
  const recomputeStep = reporterJob.steps.find((step) => step.id === "recompute_check");
  assert.ok(recomputeStep, "expected the reporter's recompute_check step");
  assert.match(
    recomputeStep.run,
    /jq -r '\.currentHeadSha \/\/ empty' gate_check_stdout\.json gate_check_stderr\.json/,
    "recompute_check must extract currentHeadSha from its own detect-checkpoint-evidence.mjs run",
  );
  assert.match(recomputeStep.run, /evaluated_head_sha=\$\{evaluated_head_sha\}/);

  assert.equal(statusStep.env.DETECTOR_EVALUATED_HEAD_SHA, "${{ needs.gate-evidence-runner.outputs.evaluated_head_sha }}");
  assert.equal(statusStep.env.RECOMPUTE_EVALUATED_HEAD_SHA, "${{ steps.recompute_check.outputs.evaluated_head_sha }}");
  assert.equal(statusStep.env.REPORTER_HEAD_SHA, "${{ steps.pr.outputs.head_sha }}");
  assert.match(statusStep.run, /evaluated_head_sha="\$RECOMPUTE_EVALUATED_HEAD_SHA"/);
  assert.match(statusStep.run, /evaluated_head_sha="\$DETECTOR_EVALUATED_HEAD_SHA"/);

  // Fallback: an empty evaluated head (detection never resolved one — the
  // evidence_state is then empty too, already fail-closed to `failure`) still
  // posts somewhere, via the reporter's own resolved head, rather than the
  // status post being skipped outright.
  assert.match(statusStep.run, /if \[ -n "\$evaluated_head_sha" \]; then/);
  assert.match(statusStep.run, /head_sha="\$evaluated_head_sha"/);
  assert.match(statusStep.run, /head_sha="\$REPORTER_HEAD_SHA"/);

  // The status step must run under always(): without it, this step's default
  // success() condition would SKIP it whenever an earlier reporter step in
  // this job fails (decide, checkout/setup-node/setup-bun/install, or
  // recompute_check) — reintroducing the dangling required-status deadlock
  // the reporter split exists to close. The draft guard is preserved
  // alongside always() — only Resolve-PR-facts itself failing before setting
  // `draft` (the pre-existing accepted residual) still leaves this skipped.
  assert.equal(statusStep.if, "${{ always() && steps.pr.outputs.draft == 'false' }}");

  // Every `${{ }}` value the status step reads (both evaluated head SHAs, the
  // reporter's own head, and both evidence_state values) must be routed
  // through env — never spliced directly into the shell (the GitHub Actions
  // script-injection anti-pattern).
  assert.equal(statusStep.env.RECOMPUTE, "${{ steps.decide.outputs.recompute }}");
  assert.equal(statusStep.env.REUSED_EVIDENCE_STATE, "${{ steps.decide.outputs.evidence_state }}");
  assert.equal(statusStep.env.RECOMPUTED_EVIDENCE_STATE, "${{ steps.recompute_check.outputs.evidence_state }}");
  assert.ok(!statusStep.run.includes("${{ steps.decide"), "decide's outputs must be read via env, not spliced directly into the shell");
  assert.ok(!statusStep.run.includes("${{ steps.recompute_check"), "recompute_check's outputs must be read via env, not spliced directly into the shell");
  assert.ok(!statusStep.run.includes("${{ steps.pr.outputs.head_sha }}"), "the reporter's own head must be read via env (REPORTER_HEAD_SHA), not spliced directly into the shell");
  assert.ok(!statusStep.run.includes("${{ needs.gate-evidence-runner"), "the detector's evaluated head must be read via env (DETECTOR_EVALUATED_HEAD_SHA), not spliced directly into the shell");
});

// Pins the env-routing half of #2262: the `decide` step reads the
// detector's evidence_state (an attacker-influenced-shape value, since it
// flows from `detect-checkpoint-evidence.mjs` output) through env, never
// spliced directly into the shell as a `${{ }}` expression.
test("gate-evidence-reporter's decide step reads the detector's evidence_state via env, not a direct splice", async () => {
  const content = await readRepo(".github/workflows/gate-evidence.yml");
  const workflow = parseYaml(content);
  const decideStep = workflow.jobs["gate-evidence-reporter"].steps.find((step) => step.id === "decide");
  assert.ok(decideStep, "expected a decide step");
  assert.equal(decideStep.env?.EVIDENCE_STATE, "${{ needs.gate-evidence-runner.outputs.evidence_state }}");
  assert.ok(!decideStep.run.includes("${{"), "decide step must read the detector's evidence_state via env, not a direct ${{ }} splice");
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

  // Every job here surfaces as a check run named after its id, and every one
  // of those is the loop's OWN derived signal — so the loop must exclude it
  // when deriving the CI status that gates its own pre_approval step. A job id
  // missing from that list silently re-creates the waiting_for_ci deadlock,
  // because a run this workflow cancels for concurrency is deliberately not
  // read as green.
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    assert.ok(
      LOOP_DERIVED_CI_CHECK_NAMES.includes(jobId),
      `job id ${jobId} is not in LOOP_DERIVED_CI_CHECK_NAMES — add it, or the loop will gate itself on its own check run`,
    );
    // The check-run name equals the job id only while the job declares no
    // `name:` and no matrix (a matrix appends its values to the name). Either
    // one would keep the id assertion above green while the real check-run
    // name goes unexcluded — the same deadlock, silently restored.
    assert.ok(
      !("name" in job),
      `job ${jobId} declares name: — the check run would be named after it, not the job id, and the loop's exclusion would miss it`,
    );
    assert.ok(
      !("strategy" in job),
      `job ${jobId} declares strategy: — a matrix appends values to the check-run name, and the loop's exclusion would miss it`,
    );
    assert.ok(
      !("uses" in job),
      `job ${jobId} declares uses: — a called workflow's check runs are named "${jobId} / <inner job>", and the loop's exclusion would miss them`,
    );
  }

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
  assert.match(detectorStep.run, /evidence_state=/, "the detector must write evidence_state to $GITHUB_OUTPUT for the reporter to reuse");

  // Every step that needs a checkout/deps or reports must skip on drafts,
  // matching the previous job-level draft no-op. The detector job no longer
  // posts a status, so it needs no !cancelled() guard on any step.
  for (const step of steps) {
    if (step.id === "pr") continue;
    assert.match(String(step.if ?? ""), /steps\.pr\.outputs\.draft == 'false'/, `step "${step.name}" must carry the draft guard`);
  }

  // The reporter's recompute path reuses the SAME trusted-base checkout
  // configuration as the detector — its independent recomputation must be
  // evaluated against trusted code too, never the PR head.
  const reporterSteps = workflow.jobs["gate-evidence-reporter"].steps;
  const reporterFactsStep = reporterSteps.find((step) => step.id === "pr");
  assert.ok(reporterFactsStep, "expected the reporter to carry its own Resolve-PR-facts step with id 'pr'");
  assert.deepEqual(reporterFactsStep.run, factsStep.run, "the reporter's Resolve-PR-facts step must be copied verbatim from the detector's");

  const reporterCheckoutStep = reporterSteps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout"));
  assert.ok(reporterCheckoutStep, "expected the reporter's recompute path to include a checkout step");
  assert.equal(reporterCheckoutStep.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(reporterCheckoutStep.with["persist-credentials"], false);

  const reporterDetectStep = reporterSteps.find((step) => step.id === "recompute_check");
  assert.ok(reporterDetectStep, "expected the reporter's recompute detector step");
  assert.match(reporterDetectStep.run, /--pr "\$\{\{ steps\.pr\.outputs\.number \}\}"/);
  assert.match(reporterDetectStep.run, /evidence_state=/);
});

// AC1: the main required-status invariant — the required context is the
// gate-evidence commit STATUS, never the gate-evidence-runner JOB — must stay
// documented on the merge-preconditions surface, so superseded detector
// cancellations can never permanently block a merge. No committed
// branch-ruleset surface exists to assert the live required set against; the
// documented invariant is the durable pin until one is added.
test("required-context invariant (status not job) stays documented on the merge-preconditions surface", async () => {
  const doc = await readRepo("skills/docs/merge-preconditions.md");
  assert.match(doc, /MERGE-PRECOND-REQUIRED-CONTEXT-IS-STATUS/, "the required-context invariant rule id must be present");
  // Loose name checks, not a full-sentence regex: the invariant must name the
  // gate-evidence status as required and BOTH jobs as never-required, without
  // pinning exact prose (which churns on wording fixes).
  assert.match(doc, /required status is the `gate-evidence` commit status/, "the status must be named as the required context");
  assert.match(doc, /never (be )?(a|either)\s+(Gate-evidence )?job/i, "the invariant must forbid a job as the required context");
  assert.match(doc, /gate-evidence-runner/, "the runner job must be named");
  assert.match(doc, /gate-evidence-reporter/, "the reporter job must be named");
  // Tie the doc claim to the code: both jobs the invariant forbids as a required
  // context are exactly the loop-derived checks the CI derivation already
  // excludes, so a rename cannot silently drift them apart.
  assert.ok(
    LOOP_DERIVED_CI_CHECK_NAMES.includes("gate-evidence-runner") && LOOP_DERIVED_CI_CHECK_NAMES.includes("gate-evidence-reporter"),
    "both Gate-evidence jobs must remain loop-derived (non-required) checks",
  );
});
