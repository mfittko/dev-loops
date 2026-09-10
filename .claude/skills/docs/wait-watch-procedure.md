# Wait / watch procedure

Execution procedure for the internal `wait_watch` route. Start with the validated
handoff envelope and the public routing contract already loaded. Use the package
root resolved by the `dev-loop` entrypoint for the commands below. References here
identify policy owners; they do not require loading the full follow-up, gate, or
retrospective procedures before waiting. Startup's retrospective reconciliation
check still applies.

## Enter the wait

Use the envelope's artifact identity, `nextAction`, `stopRules`, and timeout policy.
Preserve the existing outer-loop checkpoint reattachment procedure in the public
entrypoint; checkpoint state is context for a fresh detector, not permission to act
on a stale head. If facts conflict or a required helper is unavailable, report the
concrete reconciliation problem.

| Current boundary | Command / action |
| --- | --- |
| Initial Copilot implementation, no follow-up-ready PR | `dev-loops loop watch-initial --repo <owner/name> --issue <N>`; preserve the bootstrap budget and exceptions in `FACADE-BOOTSTRAP-WATCH-ROUTE` and its adjacent rules in the public contract. |
| Current PR | Refresh with `dev-loops loop loop-state --repo <owner/name> --pr <N>`. If the refreshed state remains waiting and preflight below is satisfied, use `dev-loops loop watch-cycle --repo <owner/name> --pr <N> --concise`. |
| Pending/absent CI | The cycle routes to the provider-agnostic CI watcher. The direct equivalent is `dev-loops loop watch-ci --repo <owner/name> --pr <N> --timeout-ms <remaining-budget-ms>`. Failed CI needs follow-up, not more waiting. |

Before invoking handoff/watch-cycle, route a newly actionable state through the
fresh-envelope sequence below. If the snapshot reports `mergeStateStatus=BEHIND`
or `DIRTY`, `mergeable=CONFLICTING`, or a new review request is needed, load the
full follow-up and operations procedures for the sanctioned preflight before
invoking it. Those are conditional additional reads, not savings on a preflight
that actually needs them. Preserve ownership, worktree, and authorization checks;
if an authorized route cannot be established, stop for reconciliation. The
handoff owns base-integration and request decisions; obey its stop result. Enter
a review watcher only when it returns
`action: "watch"` and `requestWatchContract.watchEntryConfirmed=true`. The cycle
helper performs this check; do not reconstruct request eligibility or turn a
suppressed/unavailable request into a wait. New-head re-request, green posture,
and round-cap policy remain owned by `COPILOT-FOLLOWUP-REREQUEST-AFTER-PUSH`,
`COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE`, `COPILOT-FOLLOWUP-REQUEST-BRANCHING`, and
`COPILOT-FOLLOWUP-ROUND-CAP` in the [follow-up skill](../copilot-pr-followup/SKILL.md).
The watch result does not independently authorize a fix, gate, ready transition,
or merge.

## Observe, refresh, re-enter

After a watch settles:

1. Refresh authoritative state with `dev-loops loop loop-state --repo <owner/name> --pr <N>`.
   For `timeout`/`idle`, use `dev-loops loop handoff --repo <owner/name> --pr <N> --watch-status <status>`
   for the existing timeout refresh. Bootstrap
   waits re-resolve the issue and its linked PR. Use command `--jq`/`--silent`
   fields or concise output; no inline JSON interpreters.
2. Run `dev-loops loop startup --pr <N>` (or `--issue <N>` for bootstrap), preserving
   the active run's intent/settings and watch outcome. Build the fresh
   envelope with `dev-loops loop build-envelope --input <startup-output.json>`;
   validate it before consuming it. A failed resolver or invalid envelope stops
   execution. Keep the same canonical artifact; reuse a newly resolved linked PR.
3. Load the fresh envelope's ordered `requiredReads` before executing its
   `nextAction`. A destination route restores its own ownership, isolation, gate,
   and retrospective requirements. Never enter fixing or approval from the old
   watch envelope. `stop`/`needs_reconcile` remain terminal decision boundaries.
4. For feedback, the destination follow-up procedure reads the current unresolved
   working set with `capture-review-threads.mjs --unresolved --bodies` and the
   reply/resolve IDs with `list-review-threads.mjs --unresolved-only` (both take
   `--repo <owner/name> --pr <N>`). Dispatch fixing through its fixer procedure;
   unresolved feedback is not completion.

Preserve the existing [timeout policy](copilot-loop-operations.md#timeout-and-watch-policy):
each review watch boundary has a 30-minute maximum budget; a refresh still showing
`waiting_for_copilot_review` after that budget expires stops with
`watch timeout — PR #<N> needs manual attention`. Do not start another cycle to
evade that exhausted boundary. Extending it requires existing user/conductor
authorization. Quiet observations before exhaustion are healthy waits, not
blockers. The initial-implementation seam retains its separate one-hour budget
and public-contract quiet/activity exceptions. Use explicit bounded timeouts on
direct probes; zero-timeout probes are only for requested one-shot status checks.
The cycle helper supplies its bounded policy internally; do not invent unsupported
flags such as `--probe-only` or `--poll-interval-ms`.

For zero current-head CI suites only, the existing detector exception remains:
previous-head CI green plus local `bun run verify` passed for this exact head
allows a refresh with `--local-validation-head-sha <head-sha>` to establish
`crediblyGreen`. Never infer it from missing CI alone.

Wait only through the deterministic tools in `COPILOT-FOLLOWUP-WAIT-TOOLS`.
Helper-owned polling is expected; do not create shell sleep/poll loops, detached
watchers, or transcript-tailing automation.

Under Claude Code, continue pending non-terminal waits inline in the same agent,
using the fresh envelope on each re-entry, until the requested stop boundary or
budget is reached. Do not exit just to have a parent re-dispatch the watch loop.

Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA. Do not stop or report completion without this evidence.

## Cross-references

- [Public dev-loop contract](public-dev-loop-contract.md)
- [Follow-up procedure](../copilot-pr-followup/SKILL.md#step-6-async-watch-behavior)
- [Operations reference](copilot-loop-operations.md)
