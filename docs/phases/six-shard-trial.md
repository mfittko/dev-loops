# Four versus six native CI shards trial

## Status

Authorized experimental implementation; awaiting pre-PR review and hosted measurements. Draft proposal only. Promoted from the operator-approved temporary plan; this committed plan is the durable spec for the trial.

## Objective

Measure whether six native test shards consistently improve CI wall time enough to justify extra runner minutes compared with four shards.

## In scope

Run three complete successful hosted CI measurements per variant on the same source test inventory, identical frozen measured timing profile, Bun 1.4.1, and native parallelism 2. Preserve disjoint complete assignment and profile provenance. Report slowest native shard, full CI critical wall time and summed runner minutes with median and spread, exact run links, source and profile hashes. Keep an isolated worktree and draft PR for the trial.

## Explicit non-goals

No merge, release, ready transition, lifecycle gate, test deletion, scheduler rewrite, unrelated recovery work, or local full-suite execution.

## Acceptance criteria

- [ ] Three complete successful runs for four shards and three for six shards use identical source tests and measured profile bytes.
- [ ] Inventory remains complete and disjoint, with fixed native parallelism 2.
- [ ] Report medians, ranges and runner-minute costs from hosted evidence.
- [ ] Recommend six only if improvement is worthwhile and consistent.

## Definition of done

- [ ] Narrow implementation and appropriate targeted checks are complete.
- [ ] Hosted evidence and recommendation are persisted and reported.
- [ ] Work remains a draft proposal without merge or release.

## Simplest design

Use a four-or-six choice on the existing CI workflow. Its producer emits the suite matrix; push and PR retain four shards, docs, workflows, smoke and aggregation. Dispatch runs consume the committed profile without consulting the latest mutable artifact. Production publication remains default-branch-push-only with four-shard runtime provenance. Rejected alternatives: duplicate workflows would drift; changing the scheduler or timing publisher would confound the experiment.

The existing native Bun runner owns scheduling. A small native fixture checks both counts, and each hosted dispatch verifies that all successful shard measurements partition the exact frozen inventory and use identical input bytes. No new test file changes the inventory.

## Frozen profile

- File: [six-shard-trial-profile.json](six-shard-trial-profile.json)
- Exact input bytes are pinned by `TRIAL_PROFILE_SHA256` in [the timing helper](../../scripts/ci-test-timings.mjs).
- Source: successful default-branch run 42803254210, attempt 1.
- Source commit: `e201c1f4689deaa7d2c2b82cb2f5f6e417d69984`
- Workflow ID: `275874654`; published artifact ID: `13757885099`, name `ci-timings-42803254210-1`.
- Measured inventory: 551 files. Producer runtime: Bun 1.4.1, linux-x64, ubuntu26, parallelism 2, four shards, isolation false.

The producer's four-shard provenance remains intact for both variants. The dispatch input selects scheduling only. Preparation rejects an incompatible runtime, modified profile bytes, or changed inventory; final aggregation rejects missing, overlapping or unknown measurements.

## Measurement procedure

After pre-PR review and draft creation, freeze one branch commit for all six measurements. Dispatch CI on that exact branch with shard inputs 4, 6, 4, 6, 4, 6, sequentially. Record each run ID, attempt, head SHA, input, outcome and jobs. Count successful complete runs only; retain failures and retries in the report. Reject comparisons across different heads or profile hashes. Do not update the committed evidence report until the six runs finish.

Use each job's started/completed timestamps: slowest native shard is the maximum duration of the native shard jobs; complete CI wall time spans earliest job start to latest required verification job completion; runner cost is the sum of all job durations, divided by 60. Also record workflow creation-to-completion elapsed time separately so queue delay is visible. Report the three observations, median and min–max range per variant, and percentage changes in median wall time and runner minutes. Optional publish-timings is skipped on dispatch. Missing diff base forces the existing smoke jobs for both variants; report if smoke determines the critical path.

Timing diagnostics include each shard's exact input and fresh output. The dispatch-only aggregate check is required to succeed, so a successful run certifies complete/disjoint measured inventory. Retain exact run links and downloaded diagnostics alongside the report. Six is recommended only when the slowest-shard and full-CI improvements are consistent across the paired runs and proportionate to runner cost; otherwise keep four and state the limitation.

## Coverage matrix

| Acceptance | Evidence |
| --- | --- |
| Same source and profile across three runs per variant | Run head/input records, frozen digest and diagnostic bytes |
| Complete/disjoint inventory and parallelism 2 | Native fixture, workflow assertions and dispatch aggregate check |
| Medians, ranges and costs | Hosted job timestamps and persisted report |
| Recommendation | Comparison of all paired runs and costs |

## Size estimate

One bounded trial slice, approximately 150 logic lines across the CI workflow, timing helper and existing owning tests. Keep profile data and this plan with their experiment. No independent production feature is introduced.

## Validation

Targeted timing, inventory and workflow contract tests, workflow lint and the required doc-guard pass under Bun 1.4.1. Hosted measurements and recommendation remain pending; local fixture success does not establish a performance improvement.
