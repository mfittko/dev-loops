# Conductor routing statechart spike (#2659)

## Question

Is a statechart a better source of truth for reconcile routing than the hand-written `evaluateConductorRouting` in `packages/core/src/loop/conductor-routing.mjs`? If so, should it replace the evaluator, generate it, or only test it?

## Approach

The routing policy is expressed as a plain JSON chart (`packages/core/test/fixtures/conductor-routing-statechart.json`) that uses only the XState v5 config keys `id`, `initial`, `context`, `states`, `always`, `target`, `guard`, `meta`, `type`. One `route` state holds 20 `always` arrows (19 guarded, one unguarded rule 17 catch-all) in evaluator order: pre-checks `0a`, `0b`, `0c`, contract rows 1 to 16, and the rule 17 catch-all. Seven final states match the `ROUTING_OUTCOME` values. Final-state `meta` carries `outerAction`, `loopFamily` and `entrypoint`. Arrow `meta` carries `stopReason`.

Guards are names in the JSON. The implementations are a plain map of predicates in `packages/core/test/conductor-routing-statechart.test.mjs`. The same file holds `derive(input)`, a built-in runner (first guard that holds wins, then read the final state), the differential test and the coverage report. No `xstate` dependency was added and no existing file changed.

The differential test builds the full input product (15 copilot states plus empty plus unknown, 13 reviewer states plus empty plus unknown, 4 ownership values, 2 isolation values, 3 target shapes, 4 source modes) and compares `routingOutcome`, `outerAction`, `stopReason` and the `handoffEnvelope` fields `targetIdentity`, `loopFamily`, `entrypoint`, `requiredArgs`, `requiresLocalIsolation` and `confidence`. The free-text `handoffEnvelope.reason` is excluded because it interpolates state names into prose, has no routing meaning, and a chart would only duplicate the strings.

## Findings

Differential result: 24,480 inputs (17 x 15 x 4 x 2 x 3 x 4), 0 mismatches. The chart reproduces the evaluator on every compared field, including the partial `targetIdentity` of a malformed target and the empty `requiredArgs` of the three pre-checks.

Coverage report, generated at commit `be0964996` (base of the spike branch):

| Arrow | Inputs | Final state | Inputs |
|---|---|---|---|
| 0a malformed target | 16,320 | needs_reconcile | 19,344 |
| 0b missing copilot state | 480 | done_terminal | 336 |
| 0c missing reviewer state | 512 | stop_needs_human | 1,296 |
| 1 duplicate owners | 1,792 | stay_with_current_live_owner | 856 |
| 2 copilot done | 336 | handoff_to_copilot_loop | 432 |
| 3 no PR | 336 | handoff_to_reviewer_loop | 1,280 |
| 4 review unavailable | 336 | continue_current_wait | 936 |
| 5 copilot blocked | 336 | | |
| 6 reviewer blocked | 288 | | |
| 7 draft + live owner | 104 | | |
| 8 draft | 208 | | |
| 9 waiting for copilot review | 312 | | |
| 10 reviewer active + live owner | 640 | | |
| 11 reviewer active | 1,280 | | |
| 12 strong-active + live owner | 80 | | |
| 13 strong-active | 160 | | |
| 14 any wait | 624 | | |
| 15 weak-active + live owner | 32 | | |
| 16 weak-active | 64 | | |
| 17 catch-all | 240 | | |

Both columns sum to 24,480. No arrow is dead: every row takes at least 32 inputs. The 0a count is large only because 2 of the 3 target shapes are malformed.

Rule 17 fall-through. Of the 240 inputs, the ones with known states on both sides all pair `waiting_for_review_request` with one of four copilot states that appear in no contract row: `low_signal_converged`, `round_cap_reached`, `round_cap_clean_fallback`, `internal_tooling_direct_gate`. The remaining inputs carry the unknown sentinel state, which is correct fail-closed behavior. The four copilot states reach `needs_reconcile` only through the rule 17 catch-all. Whether they should stay that way is a product decision. A follow-up can turn them into explicit rows.

Drift recorded, no contract edit made:

- The three pre-checks (`0a`, `0b`, `0c`) are not rows in the contract table in `skills/docs/conductor-routing-contract.md`.
- The contract lists `submitted_review` under "Reviewer active states". The evaluator treats it as a reviewer wait state (row 14).
- The doc comment above `routeFromStates` lists 12 numbered steps and names a `decideOuterAction` adapter that no longer exists in `packages/core/src`.

Other findings:

- `requiresLocalIsolation` passthrough holds. For every pair of inputs that differ only in that flag the outcome is identical, and every final echoes the input value (`ROUTING-LOCAL-ISOLATION-PASSTHROUGH`).
- The four fail-closed arrows (`0a`, `0b`, `0c`, 1) match the evaluator's `stopReason` and `targetIdentity` (`ROUTING-FAIL-CLOSED-RECONCILE`).
- Rows that combine a state group with `live_owner` (7, 10, 12, 15) need either a compound guard or a combined guard name. The spike used combined names (for example `copilotDraftAndLiveOwner`). XState's native `and` guard would need the config key `guards`, outside the allowlist.
- The ordering of first-match-wins rows is now one visible list. Shadowing is checkable by the coverage report: a widened or reordered row that starves a later row shows up as a dead arrow.

## Recommendation

Test-only.

Keep the evaluator as the routing authority and keep the chart plus differential test as a drift guard. The spike proves equivalence. The chart offers the same capability as the evaluator, so replacing it buys nothing. Costs of each option:

- Test-only: no runtime dependency, chart of about 45 lines of JSON plus roughly 250 lines of test support. Maintenance cost is one more place to edit when a rule changes, but the differential test fails loudly on any divergence, so drift cannot go unnoticed. Contract table stays hand-written. No inner-loop migration. Cheapest option and the only one with zero production risk.
- Replace: adopting the chart as the runtime authority needs either the `xstate` package (a new runtime dependency for `@dev-loops/core`, which depends only on `yaml` and `zod`) or promoting the built-in runner into `src/` and shipping the JSON under the package `files`. The guard map must still be hand-written JavaScript, so the logic does not move into data. Chart size is about the same as the evaluator's rule logic. Migrating the inner Copilot and reviewer loops to the same format is a separate, larger effort (their transition tables are in `copilot-loop-state.mjs` and `reviewer-loop-state.mjs`). This option carries the highest cost and risk of the four.
- Generate: emit the evaluator or the contract priority table from the chart. A generator needs a build step, a committed generated artifact and a freshness check. `scripts/pages/build-state-atlas.mjs` renders only the outer states, so a generator for the guarded priority rows is new work of a few hundred lines. The benefit is removing the hand-kept contract table copy. Worth revisiting only if the table drifts again after the test-only guard exists.
- Drop: delete the three files. Dropping costs nothing up front. It discards the drift findings above and leaves the table unguarded against the evaluator.
