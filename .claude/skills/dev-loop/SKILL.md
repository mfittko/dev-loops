---
name: "dev-loop"
description: "Single public dev-loop entrypoint. Resolve canonical current state first, then load only route-specific internal skills."
allowed-tools: Read Bash Edit Write Agent
user-invocable: true
---
<!-- GENERATED from skills/dev-loop/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


**No-implicit-start rule:** Never start implementation without explicit instruction.

**Work-origin rule:** All work must originate from a tracked artifact: a GitHub issue (tracker-first), a persisted markdown plan file (local-planning), or — on the sanctioned lightweight path — the PR description itself as the spec-of-record (`--lightweight`, `canonicalSpecSource: pr_body`; no committed plan artifact; issue-less PR-first is size-gated by the light-mode threshold unless `localImplementation.issueless.enabled` sanctions it at any change scope). See [Artifact Authority Contract](../docs/artifact-authority-contract.md) for canonical mode definitions and settings. No work may originate from a PR (other than the sanctioned lightweight PR-body-as-spec path) or a direct local change unless explicitly requested.

# Unified Dev Loop

This is the public `dev-loop` façade — a summary of the authoritative routing contract. The authoritative contract is [Public Dev Loop Contract](../docs/public-dev-loop-contract.md). Runtime evaluator: `@dev-loops/core/loop/public-dev-loop-routing`. For status/progress/readiness/merge-state/next-step queries, resolve authoritative artifact identity first; for issue targets, identity resolution is handled by the startup resolver. Fail closed to reconcile/unknown when unresolved. When an open linked PR exists, treat it as the single canonical artifact for the issue and reuse it instead of opening another PR.

## Installed skill layout

Required installed runtime contract docs are shared bundled copies under `../docs/` from this skill directory. Read those bundled `../docs/` files from the installed skill layout — do not assume a source checkout. If a required bundled contract doc is missing, treat it as a packaging/installer bug.

## Startup procedure

### Resolve authoritative state

> Under the Claude Code harness the dev-loop runs as a single agent: run these steps directly — no read-only boundary and no separate async-subagent dispatch. See [Main Agent Contract](../docs/main-agent-contract.md).

Resolve authoritative state via the startup resolver (`npx dev-loops@1.0.0-rc.1 loop startup --issue <n>` for issues, `npx dev-loops@1.0.0-rc.1 loop startup --pr <n>` for PRs), then immediately build the handoff envelope via `npx dev-loops@1.0.0-rc.1 loop build-envelope --input <resolver-output.json>`. The envelope determines `requiredReads`, `nextAction`, `stopRules`, and `acceptance` — load only those files, execute only that bounded task. It is the first handoff artifact consumed before loading any route pack. See [Workflow Handoff Contract](../docs/workflow-handoff-contract.md) for the derivation contract.

**Retrospective checkpoint gate:** the resolver reads `.pi/dev-loop-retrospective-checkpoint.json` and injects the state. When the checkpoint is `missing` and the repo config `workflow.requireRetrospective` (set via `.devloops` at repo root) is `true`, the resolver returns `needs_reconcile`. Complete or explicitly skip the retrospective before starting.

**Pre-flight PR gate (mandatory):** Before working an existing PR, the dev-loop must run `npx dev-loops@1.0.0-rc.1 loop handoff --repo <owner/name> --pr <number>` and abort if `action: "stop"`. When `terminal: true`, proceed inline. When `terminal: false`, resolve the blocking condition first.

**Worktree cwd (mandatory):** Always use a worktree checkout for git operations, file reads/writes, and validation commands — never use the `main` checkout.

**Worktree fetch (mandatory):** Always run `git fetch origin` before creating or reusing any worktree.

### Resume from existing loop state

When the startup resolver returns a fresh-start routing but an existing outer-loop checkpoint
(`tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json`) is present on disk, the
dev-loop must check the checkpoint before treating the start as a fresh intake or follow-up:

1. Read the outer-loop checkpoint (authored by `outer-loop.mjs`).
2. If `outerAction` is `continue_wait`, `reenter_copilot_loop`, or `reenter_reviewer_loop`:
   - Skip issue-intake normalization or fresh-intake routing.
   - Route directly to the existing PR's follow-up path (the PR number is in the
     checkpoint's `pr` field). For `reenter_copilot_loop`, enter the copilot-pr-followup
     path. For `reenter_reviewer_loop`, enter the reviewer-loop path.
   - Use the checkpoint's `copilotState` and `reviewerState` as last-known context for
     re-attachment, then re-baseline with fresh detectors (`copilot-pr-handoff.mjs`
     or `detect-copilot-loop-state.mjs`) before acting on the state.
3. If `outerAction` is `stop`:
   - Report the `reason` field and the authoritative state from the checkpoint.
   - `stop` means the loop is blocked or needs a human decision; ask for direction
     rather than guessing or starting fresh.
4. If no checkpoint exists, or `outerAction` is `done`:
   - Treat as normal fresh startup (the existing startup resolver path).

This eliminates the manual "report-and-resume" or "exit and resume later" pattern when the
deterministic state already knows the next action.

The outer-loop checkpoint is the canonical re-attachment artifact. Do not rely on chat
context, local notes, or prose recollection of "where we left off."

## Route table

Load only the route-specific internal skill required by `selectedStrategy`:

| Strategy | Route pack to load |
| --- | --- |
| `local_implementation` | [Local Implementation Skill](../local-implementation/SKILL.md) |
| `issue_intake` | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) + [Copilot Loop Operations](../docs/copilot-loop-operations.md) + [Issue Intake Procedure](../docs/issue-intake-procedure.md) |
| `copilot_pr_followup` | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) + [Copilot Loop Operations](../docs/copilot-loop-operations.md) |
| `external_pr_followup` | same as `copilot_pr_followup` |
| `reviewer_fixer` | same as `copilot_pr_followup` |
| `wait_watch` | same as `copilot_pr_followup` |
| `final_approval` | same as `copilot_pr_followup` + [Final Approval Skill](../final-approval/SKILL.md) |

Do not preload route packs before the resolver selects the strategy.

## Async dispatch

**Async dispatch rule (enforced):** the resolver fails closed for GitHub-first strategies when `canonicalStateSummary.requiresAsyncDispatch` is `true` (default `required` mode) — inline invocation without an async run-id marker (`DEVLOOPS_RUN_ID` or `PI_SUBAGENT_RUN_ID`) is rejected for those routes. Under the Claude Code harness this requirement is relaxed automatically. See [Startup procedure](#startup-procedure).

## Fallback gate-comment poster

When the `@dev-loops/core` package is not installed in the consumer repo, the full `scripts/github/upsert-checkpoint-verdict.mjs` helper (referenced from the copilot-pr-followup skill procedure) is unavailable. To keep the PR audit trail intact in that mode, the dev-loop skill ships a small gh-only fallback poster at `scripts/post-gate-verdict-fallback.mjs` (relative to the dev-loop skill root) that renders the same visible comment format and fails closed if posting cannot succeed.

Use the fallback poster only when the full helper cannot be reached:

1. Detect the missing helper: try `node scripts/github/upsert-checkpoint-verdict.mjs --help` from the consumer repo. If the script is absent or imports fail, switch to the fallback path.
2. Invoke the fallback from the installed dev-loop skill directory: `node <resolved-skill-scripts>/post-gate-verdict-fallback.mjs --repo <owner/name> --pr <number> --head-sha <sha> --verdict <clean|findings_present|blocked> (--findings-summary <text> | --findings-file <path>) --next-action <text> [--gate <draft_gate|pre_approval_gate>]`.
3. Treat every successful fallback-posted gate comment as a one-shot create with no idempotent same-head update: if the agent reruns the gate on the same head, a duplicate comment will be created. Detect duplicates manually and update manually if needed.
4. Treat every fallback-posted gate comment as a degraded audit-trail artifact: the visible body uses the same parser-stable shape as the full helper (gate name, head SHA, verdict, blocking severities when applicable, findings summary, next action), but the helper skips stale-head detection, gate-coordination validation, blocking-severity count enforcement, and the internal-only PR short-circuit.
5. If the fallback helper exits non-zero, stop the gate and report the posting failure: do not mark the PR ready for review and do not proceed to merge readiness until the comment is posted.

When `@dev-loops/core` is available again, switch back to the full helper. The fallback poster is a degraded path, not a permanent replacement.

## Read-only info shortcut

Info/handoff requests can be served directly via `npx dev-loops@1.0.0-rc.1 loop info` (read-only; no full dev-loop run required):
- `npx dev-loops@1.0.0-rc.1 loop info --issue <n>` — human-readable issue state summary (strategy, route, linked PR, next action)
- `npx dev-loops@1.0.0-rc.1 loop info --pr <n>` — human-readable PR state summary (branch, CI, threads, rounds, action)
- `npx dev-loops@1.0.0-rc.1 loop info --issue <n> --json` — machine-readable JSON output

## Reading tool output (token-economical convention)

When you need a fact from a dev-loops JSON-emitting script, climb this ladder and stop at the first rung that answers the question — never read more output than you need:

1. **Prefer the dev-loops subcommand / concise mode.** Use `loop info` or a script's `--concise`/`--summary` mode (e.g. `run-watch-cycle.mjs --concise`, `probe-copilot-review.mjs --concise`) for a human-readable digest. The concise modes surface loop state, Copilot round count, unresolved/actionable thread counts, round-cap-clean eligibility, CI status, next action, and the current round's new Copilot comment bodies.
2. **`--silent` / `-s` for a yes/no check.** Reads ZERO output: `… --jq '<predicate>' --silent; echo $?` exits `0` for true / `1` for false. Without `--jq`, `--silent` maps the script's success (`ok:true`) to exit `0`, failure to `1` — unless the tool documents a stricter `--silent` contract in its own usage text (e.g. `request-copilot-review.mjs` exits `0` only for `status: "requested"`). Example: `probe-copilot-review.mjs --repo o/r --pr N --jq '.status=="idle"' -s`.
3. **`--jq <filter>` to extract a single field.** `--jq`/`--silent` are a BASE-CLI GUARANTEE across every operator-facing JSON-result dev-loops command — each accepts a gh-style `--jq` filter (jq subset: field access, `.[]`/`.[N]`, `|`, `select(...)`, `==`/`!=`/`<`/`<=`/`>`/`>=`, `length`, `keys`), not just a named subset. (A few scripts are out of scope — e.g. build/smoke tooling, dashboard servers, dormant/unwired adapters, and scripts that write JSON to a file rather than stdout — each carried with its reason in the contract test's exclusion list.) It prints only the filtered value. An invalid filter fails closed (stderr + exit `2`), distinct from a clean predicate-false (silent exit `1`). This is enforced by a contract test (`test/contracts/jq-output-base-guarantee-contract.test.mjs`) that fails the build if a new JSON-emitting command ships without wiring the shared `scripts/lib/jq-output.mjs` emit path.
4. **Use a dev-loops wrapper for `gh` reads — never an agent-level raw `gh`.** A raw `gh` call is a recorded advisory retro violation (issue #1077: reported, never blocking). If no script covers the read you need, treat it as a tooling gap: file/build a thin wrapper (reuse `scripts/lib/jq-output.mjs`, like the ones below), don't shell out. The reads/edits that already have wrappers:
   - CI run-log tail (a failing PR's job log) → `scripts/github/fetch-ci-logs.mjs --repo <o/r> --pr <n> [--failed-only] [--tail <n>]`, **never raw `gh run view --log`/`--log-failed`**. (`probe-ci-status.mjs` names the failed checks; this returns the LOG.)
   - Issue list/filter → `scripts/github/list-issues.mjs --repo <o/r> [--state <open|closed|all>] [--label <l>] [--limit <n>]`, **never raw `gh issue list`**. (The queue tool lists the project board; this is for arbitrary issue queries.)
   - Issue comment → `scripts/github/comment-issue.mjs --repo <o/r> --issue <n> (--body <text> | --body-file <path>)`, **never raw `gh issue comment`**. Returns `{ ok, commentUrl }`.
   - Issue facts read (body/state/author/labels/etc.) → `scripts/github/view-issue.mjs --repo <o/r> --issue <n> [--json <fields>]`, **never raw `gh issue view`**. Returns the issue body that `list-issues.mjs` does not; the sanctioned reader for issue bodies (parallel to `view-pr`).
   - PR facts read (branch/state/mergeStateStatus/head SHA/etc.) → `scripts/github/view-pr.mjs --repo <o/r> --pr <n> [--json <fields>]`, **never raw `gh pr view`**. (For composite loop-routing/CI facts prefer `loop info --pr`; this is the thin field-read counterpart.)
   - PR edit (title/body/assignee/milestone) → `scripts/github/edit-pr.mjs --repo <o/r> --pr <n> [--title <t>] [--body <b> | --body-file <path>] [--add-assignee <u>] [--remove-assignee <u>] [--milestone <m>]`, **never raw `gh pr edit`**. Returns `{ ok, repo, pr, edited }`.
   - PR checks/status → `scripts/github/probe-ci-status.mjs --repo <o/r> --pr <n> --timeout-ms 0` for a single live combined-CI check, **never raw `gh pr checks`**. (Provider-agnostic; drop the `--timeout-ms 0` to block-wait.)

   These accept the same `--jq`/`--silent` output flags as every other JSON-emitting script (base-CLI guarantee) — including `probe-ci-status.mjs`, watch-shaped as it is.
5. **NEVER `| python3` or `node -e`** to parse tool JSON. If a field you need is missing from a script's output, add it to the script (or its concise mode), not an inline parser.

## Guard rules

**Handoff envelope precedence:** The dev-loop builds the envelope immediately after authoritative-state resolution and treats it as the first handoff artifact. Read it first, load only `requiredReads`, execute `nextAction`. See [Resolve authoritative state](#resolve-authoritative-state). Derivation contract: [Workflow Handoff Contract](../docs/workflow-handoff-contract.md).

**Handoff contract rule:** When no envelope is present, use the `workflow-handoff-contract.md` contract. Never delegate with abbreviated task summaries. Include deterministic routing inputs, explicit `cwd`, bounded task scope, exit conditions.

**Inline-first rule:** Prefer inline commands over nested async delegation when managing a single PR. Use nested delegation only for parallel fan-out or when the parent needs to continue other work.

**Bounded async task contract:** Break work into discrete tasks with clear inputs, explicit outputs, bounded scope. No shell polling — use `run-watch-cycle.mjs` or `gh run watch`. Fan-out reviewer waits (gate sub-loops or any Agent-tool fan-out) follow `ANTIPATTERN-FANIN-WAIT` in [Anti-patterns](../docs/anti-patterns.md): await completion via the harness notification or the reviewer's findings artifact at its deterministic path and join via `consolidateFanin` — never transcript-tail, `node -e`/`python3`-parse tool JSON, or `sleep`-poll.

**Round-cap budget check (enforced):** After every watch cycle, fix pass, or reply-resolve, check whether completed Copilot review rounds have reached the resolved round cap (`refinement.maxCopilotRounds`, default 5; light-dispatched PRs resolve the lower `resolveEffectiveCopilotRoundCap`, default 1 — owned by `COPILOT-FOLLOWUP-ROUND-CAP`). Stop re-requesting Copilot review when the limit is reached **within that review cycle**. Exception: the post-convergence new-cycle re-request carve-out (a converged loop that later takes significant post-convergence changes on a newer head opens a new cycle even if the previous one hit the cap) is owned by `COPILOT-FOLLOWUP-ROUND-CAP`. Read these gate-cadence facts via the token-economical convention above (`run-watch-cycle.mjs --concise`, or `--jq`/`--silent` for a single field/predicate) — never `| python3` or `node -e`.

## Shorthand issue-based auto trigger contract

- `auto dev loop on issue <n>` → public `dev-loop` intent `auto_continue_current` after authoritative current-state resolution
- Continue through GitHub/Copilot loop until stop condition or human approval checkpoint
- Stop at the human approval checkpoint by default unless merge explicitly authorized

## Headless auto-refine of parked un-refined items

Headless/`--auto` only. The enqueue refinement gate never lets an un-refined issue reach the pickup column: in `--auto` mode `add-queue-item.mjs` diverts it to the non-pickup park column with a recorded reason (`refined:false, diverted:true, parkedColumn, reason`), and it deliberately does NOT grill — synthesizing the missing artifact is this orchestrator's job, never the coordinator script's (keeps `OPS-NO-INLINE-INTERPRETER` clean). So a headless auto session that finds the pickup source empty may still have parked issues awaiting refinement. Before idling, run this bounded sub-loop (skip it entirely for interactive runs and for a specific `--issue`/`--pr` target):

1. **Discover (deterministic, no LLM).** List parked un-refined issues via `npx dev-loops@1.0.0-rc.1 queue parked-unrefined --repo <owner/name>` (project auto-resolved from `.devloops`; add `--jq`/`--silent` per the token-economical convention). It reads the park column and runs the same refinement-completeness check as the enqueue gate; each item carries `{ issueNumber, reason, missing }`. Empty list → nothing to refine; proceed to the normal fail-closed idle. Iterate the returned items in **ascending `issueNumber` order**, and attempt each **at most once per session** (steps 2–4). This is what bounds the sub-loop: one grill attempt per discovered item, then idle.
2. **Auto-refine (the LLM step, here in the orchestrator).** For each discovered item, in order, run `/loop-grill <issueNumber> --auto` (the `loop-grill` skill synthesizes AC/DoD/Non-goals into the issue body — do not re-implement grilling, and never move it into a coordinator script).
3. **Promote via the sanctioned move.** After a `grill-clean` verdict the issue is refined — confirmed by the same completeness check the enqueue gate runs (`detectIssueRefinementArtifact`), so this move admits exactly what the gate would. The item is already on the board in the park column, so **move** it into the pickup column with `npx dev-loops@1.0.0-rc.1 queue move --repo <owner/name> --item <issueNumber> --to-column "<pickup column>"` (the configured Next Up column). Do NOT use `add-queue-item` here: it is an idempotent no-op for an already-present item and cannot promote it. Then continue to the next discovered item.
4. **Fail-safe (unrefinable → leave parked, do not re-attempt).** If grilling cannot produce a usable artifact (`N unresolved items`, or the body still lacks AC/DoD/linked-doc), do NOT move the issue into the pickup column. It is already in the park column where discovery found it, so **leave it there** — no move, no re-enqueue — and surface the `reason` from the step-1 discovery output for a human. **Advance to the next discovered item — do NOT re-grill an item already attempted this session**, so a permanently-unrefinable issue can neither spin the loop nor starve the refinable items behind it. Never hand-move an item into the pickup column that grilling could not refine.

The sub-loop terminates once every discovered item has had its single attempt (all refinable ones promoted, the rest left parked with a reason), then proceeds to the normal fail-closed idle. A still-parked item is re-attempted only on a later session, not within this one. This wires the auto-refine convenience at the orchestrator (LLM-agent) layer only. The deterministic scripts keep just the park/allow decision and the parked-item discovery.

## No gate exemptions

All PRs must pass the full gate pipeline before merge. No scope is exempt: docs-only, tooling, meta, configuration, internal-process — all require `draft_gate`, current-head `pre_approval_gate` evidence, and Copilot review (except internal-only PRs detected by path pattern, which skip the Copilot convergence requirement).

## Authority boundary

- Source code, tests, config, CI, and shared contract docs are authoritative.
- Main-agent delegation contract: [Main Agent Contract](../docs/main-agent-contract.md) — how dev-loop work is structured per harness (Pi: read-only main agent + async-subagent dispatch; Claude: a single agent runs the steps directly).
- Before any state-changing action, get explicit confirmation unless already authorized.
- A question requires an answer, not an action.
- Stop and ask rather than guessing when facts don't agree.
- Cross-harness regression contract: [Cross-Harness Regression Contract](../docs/cross-harness-regression-contract.md).
