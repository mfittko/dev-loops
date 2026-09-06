---
name: dev-loop
description: >-
  Single public dev-loop entrypoint. Resolve canonical current state first,
  then load only route-specific internal skills.
user-invocable: true
compatibility: Pi skill for git+GitHub repositories. Requires gh auth; async follow-up works best in Pi/TelePi sessions.
allowed-tools: read bash edit write subagent review_loop
---

**No-implicit-start rule:** Never start implementation without explicit instruction.

**Work-origin rule:** All work must originate from a tracked artifact: a GitHub issue (tracker-first), a persisted markdown plan file (local-planning), or — on the sanctioned lightweight path — the PR description itself as the spec-of-record (`--lightweight`, `canonicalSpecSource: pr_body`; no committed plan artifact; issue-less PR-first is size-gated by the light-mode threshold unless `localImplementation.issueless` sanctions it at any change scope). See [Artifact Authority Contract](../docs/artifact-authority-contract.md) for canonical mode definitions and settings. No work may originate from a PR (other than the sanctioned lightweight PR-body-as-spec path) or a direct local change unless explicitly requested.

# Unified Dev Loop

This is the public `dev-loop` façade — a summary of the authoritative routing contract. The authoritative contract is [Public Dev Loop Contract](../docs/public-dev-loop-contract.md). Runtime evaluator: `@dev-loops/core/loop/public-dev-loop-routing`. For status/progress/readiness/merge-state/next-step queries, resolve authoritative artifact identity first; for issue targets, identity resolution is handled by the startup resolver. Fail closed to reconcile/unknown when unresolved. When an open linked PR exists, treat it as the single canonical artifact for the issue and reuse it instead of opening another PR.

## Installed skill layout

Required installed runtime contract docs are shared bundled copies under `../docs/` from this skill directory. Read those bundled `../docs/` files from the installed skill layout — do not assume a source checkout. If a required bundled contract doc is missing, treat it as a packaging/installer bug.

## Startup procedure

**Review intent short-circuit (issue #1850):** A plain review request against a PR ("review PR #N", "review this PR") is NOT a continue/fix/merge request. Recognize review intent BEFORE resolving authoritative state below, and dispatch straight to the standalone [Review Skill](../review/SKILL.md) (`/dev-loops:loop-review <pr>`, or `/loop-review <pr>` in the dev-loops repo itself) — never run `loop startup`/`resolve-dev-loop-startup.mjs` for this route. The review route is read-only (no branch push, no fix commit, no merge, no board move, no assignee claim) and ownership-exempt by construction: it is not one of the routing evaluator's strategies, so `STRATEGY_OWNERSHIP_GATE` never applies to it and it runs on a PR owned by anyone, or by no one — see [Single-contributor ownership gate](../docs/public-dev-loop-contract.md#single-contributor-ownership-gate-resolve-dev-loop-startup). Any other request (continue the loop, fix findings, merge, watch) proceeds through the ordinary startup procedure below, which still enforces the ownership gate exactly as before.

**"Run the gates" is NOT review intent (issue #1913):** `review` is a `GATE_NAME` but it gates nothing (informational, blocks no transition — see the tier comment in `scripts/github/_gate-names.mjs`: `LIFECYCLE_GATES` vs `REVIEW_GATE`). So a request phrased around *gating* — "run this PR through the gates", "gate this PR", "gate PR #N" — with NO explicit "review" word MUST NOT match the review short-circuit above. The discriminator is the same one question the vocabulary encodes: **does it block a lifecycle transition?** "Run the gates" means the lifecycle gates (`draft_gate`, `pre_approval_gate`), which run inside the ordinary loop via the startup flow below — NOT the standalone `review` command. Route these requests through `loop startup`/`resolve-dev-loop-startup.mjs` like any other continue request; do not dispatch `/loop-review`.

<!-- pi-only -->
### Main agent (read-only)

The main agent must **always** dispatch the `dev-loop` async subagent for any dev-loop work.
Do not run `dev-loops loop startup` or any startup resolver in the main agent.
For async-required routes (config `workflow.asyncStartMode`, default `required`) the resolver needs an async run-id marker: the Pi runtime injects `PI_SUBAGENT_RUN_ID` into each async subagent's child env, or the main agent mints and propagates the neutral `DEVLOOPS_RUN_ID` before dispatch; under the Claude Code harness the requirement is relaxed automatically (no marker needed). The startup resolver also runs without a marker for non-async routes. Regardless, only the `dev-loop` subagent runs it — never the main agent.

After dispatching the async subagent in an interactive session, return control to the user — do NOT call `subagent_wait` to block on completion. Pi wakes the session on completion or needs-attention. The only exception is **run-to-completion** (the user explicitly asked for results reported back before continuing, or a skill must finish in one turn). Calling `subagent_wait` merely to wait freezes the interactive session for the full run duration and defeats async dispatch; the Pi platform default already says return control. This reinforces that default for the `dev-loop` dispatch pattern specifically. See [Async dispatch posture](../docs/main-agent-contract.md#async-dispatch-posture-pi) in the Main Agent Contract.
<!-- /pi-only -->

### Resolve authoritative state

> Under the Claude Code harness the dev-loop runs as a single agent: run these steps directly — no read-only boundary and no separate async-subagent dispatch. See [Main Agent Contract](../docs/main-agent-contract.md).

<!-- pi-only -->
**CLI invocation (`<dev-loops-package-root>`):** dev-loop CLI commands below are invoked as `node <dev-loops-package-root>/cli/index.mjs <verb...>` using the package-local CLI rather than `npx`, so they resolve unambiguously from the installed package without a global install. Resolve `<dev-loops-package-root>` via the first of these **bounded** candidates whose `cli/index.mjs` exists — never assume a single fixed layout (under a Pi user-level install the package lives at `~/.pi/agent/npm/node_modules/dev-loops/`, so the old `../../..` package-relative guess from `skills/dev-loop/SKILL.md` overshoots the package root):

1. **Node module resolution** (best-effort first try): `node -e "try{const p=require('node:path');console.log(p.resolve(p.dirname(require.resolve('dev-loops/cli/index.mjs')),'..'))}catch{process.exit(1)}"` — resolves the package root when `dev-loops` is reachable from Node's module search path (notably under `~/.pi/agent/npm`); this is cwd-dependent and commonly misses from a target-repo cwd, so the probe is wrapped in try/catch (no stack trace, exits non-zero on miss) — treat a non-zero exit as "probe missed, try the next candidate", not a hard failure.
2. **Pi user-agent npm root** (reliable for user-level installs): `~/.pi/agent/npm/node_modules/dev-loops`.
3. **Package-relative (legacy):** `../../..` from this skill's own directory (the original package-local install layout).
4. **Global npm root:** `$(npm root -g)/dev-loops`.

NEVER fall back to `find /` or any unbounded filesystem walk to locate the CLI — it stalls and trips the needs-attention timeout. If every bounded candidate fails, stop and ask the orchestrator/operator for the dev-loops package root rather than searching. (The `dev-loop` agent resolves it analogously.)
<!-- /pi-only -->

Resolve authoritative state via the startup resolver (`node <dev-loops-package-root>/cli/index.mjs loop startup --issue <n>` for issues, `node <dev-loops-package-root>/cli/index.mjs loop startup --pr <n>` for PRs), then immediately build the handoff envelope via `node <dev-loops-package-root>/cli/index.mjs loop build-envelope --input <resolver-output.json>`. The envelope determines `requiredReads`, `nextAction`, `stopRules`, and `acceptance` — load only those files, execute only that bounded task. It is the first handoff artifact consumed before loading any route pack. See [Workflow Handoff Contract](../docs/workflow-handoff-contract.md) for the derivation contract.

**Retrospective checkpoint gate:** the resolver reads `.pi/dev-loop-retrospective-checkpoint.json` (resolved from the repo's main checkout, not cwd-relative, so a worktree and the main checkout always see the same file) and, when the repo config `workflow.requireRetrospective` (set via `.devloops` at repo root) is `true`, also checks local git ancestry between the checkpoint's recorded `identity.mergeCommit` and the base branch — a `complete`/`skipped` record is treated as `missing` once anything has merged since that recorded commit (or the commit cannot be resolved locally at all), so a stale record can never satisfy a newer cycle. When the resulting state is `missing`, the resolver returns `needs_reconcile`. Complete or explicitly skip the retrospective before starting, carrying the cycle identity via `checkpoint-contract.mjs --repo`/`--pr`/`--merge-commit` (required for `complete`/`skipped`) and — for `complete` — the fresh-context provenance via `--retro-context fresh --record-source <path>` (mandatory per `RETRO-FRESH-CONTEXT-MANDATORY`; an inline self-authored retro fails the checkpoint).

**Pre-flight PR gate (mandatory):** Before working an existing PR, the dev-loop must run `node <dev-loops-package-root>/cli/index.mjs loop handoff --repo <owner/name> --pr <number>` and abort if `action: "stop"`. When `terminal: true`, proceed inline. When `terminal: false`, resolve the blocking condition first.

**Worktree cwd (mandatory):** Always use a worktree checkout for git operations, file reads/writes, and validation commands — never use the `main` checkout.

A shell's working directory can reset to the primary checkout **silently** — after a subprocess run, or when a `cd` inside a compound command does not persist into the next one. A relative-path `git add && git commit && git push` that runs after such a reset executes in the primary checkout on the default branch, landing the change straight on the remote and skipping the PR flow. `WORKTREE-DEFAULT-USE` in [worktree-guidance.md](../docs/worktree-guidance.md#default-rule-use-a-worktree-for-mutating-local-work) is the owned rule mandating `git -C <absolute-worktree-path> …` and absolute paths for exactly this reason — every mutating flow follows it, not just this skill's own. `ensure-worktree` best-effort installs `pre-commit`/`pre-merge-commit`/`pre-push` guards as defense-in-depth against the same slip — it is not a substitute; see [Default-branch guard](../docs/worktree-guidance.md#default-branch-guard) for the guard's behavior, its no-op paths, and the `DEVLOOPS_ALLOW_MAIN=1` override.

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

### Stale-installed-CLI: prefer worktree-source verdict/ledger tooling (#1661)

Before posting a `pre_approval_gate` (or `draft_gate`) verdict, resolve which layout the verdict/ledger tooling should run from via the deterministic helper (issue #1661):

```sh
node <resolved-skill-scripts>/loop/resolve-verdict-ledger-source.mjs --jq .preferredSource
```

When `preferredSource` is `worktree` (installed dev-loops CLI older than the current source/worktree), run `upsert-checkpoint-verdict.mjs`, `write-gate-findings-log.mjs`, and `detect-checkpoint-evidence.mjs` from the worktree/source `scripts/` layout — the stale installed CLI lacks the gate-evidence CI exclusion and would otherwise block verdict posting on `WAITING_FOR_CI`. When `installed`, use the resolved skill-scripts (installed) layout as usual. The copilot-pr-followup skill's [Skill asset path resolution](../copilot-pr-followup/SKILL.md#skill-asset-path-resolution) owns the full rule; this is the entrypoint pointer.

## Read-only info shortcut

Info/handoff requests can be served directly via `node <dev-loops-package-root>/cli/index.mjs loop info` (read-only; no full dev-loop run required):
- `node <dev-loops-package-root>/cli/index.mjs loop info --issue <n>` — human-readable issue state summary (strategy, route, linked PR, next action)
- `node <dev-loops-package-root>/cli/index.mjs loop info --pr <n>` — human-readable PR state summary (branch, CI, threads, rounds, action)
- `node <dev-loops-package-root>/cli/index.mjs loop info --issue <n> --json` — machine-readable JSON output

## Reading tool output (token-economical convention)

<!-- rule: BASE-JQ-OUTPUT-GUARANTEE -->
`BASE-JQ-OUTPUT-GUARANTEE`: every operator-facing JSON-result dev-loops command MUST accept `--jq`/`--silent` through the single shared emit path (`scripts/lib/jq-output.mjs`), enforced by the `jq-output-base-guarantee` contract test.

When you need a fact from a dev-loops JSON-emitting script, climb this ladder and stop at the first rung that answers the question — never read more output than you need:

1. **Prefer the dev-loops subcommand / concise mode.** Use `loop info` or a script's `--concise`/`--summary` mode (e.g. `run-watch-cycle.mjs --concise`, `probe-copilot-review.mjs --concise`) for a human-readable digest. The concise modes surface loop state, Copilot round count, unresolved/actionable thread counts, round-cap-clean eligibility, CI status, next action, and the current round's new Copilot comment bodies.
2. **`--silent` / `-s` for a yes/no check.** Reads ZERO output: `… --jq '<predicate>' --silent; echo $?` exits `0` for true / `1` for false. Without `--jq`, `--silent` maps the script's success (`ok:true`) to exit `0`, failure to `1` — unless the tool documents a stricter `--silent` contract in its own usage text (e.g. `request-copilot-review.mjs` exits `0` only for `status: "requested"`). Example: `probe-copilot-review.mjs --repo o/r --pr N --jq '.status=="idle"' -s`.
3. **`--jq <filter>` to extract a single field.** `--jq`/`--silent` are a BASE-CLI GUARANTEE across every operator-facing JSON-result dev-loops command — each accepts a gh-style `--jq` filter (jq subset: field access, `.[]`/`.[N]`, `|`, `select(...)`, `==`/`!=`/`<`/`<=`/`>`/`>=`, `length`, `keys`), not just a named subset. (A few scripts are out of scope — e.g. build/smoke tooling, dashboard servers, dormant/unwired adapters, and scripts that write JSON to a file rather than stdout — each carried with its reason in the contract test's exclusion list.) It prints only the filtered value. An invalid filter fails closed (stderr + exit `2`), distinct from a clean predicate-false (silent exit `1`). This is enforced by a contract test (`test/contracts/jq-output-base-guarantee-contract.test.mjs`) that fails the build if a new JSON-emitting command ships without wiring the shared `scripts/lib/jq-output.mjs` emit path.
4. **Use a dev-loops wrapper for `gh` reads — never an agent-level raw `gh`.** A raw `gh` call is a recorded advisory retro violation (issue #1077: reported, never blocking). If no script covers the read you need, treat it as a tooling gap: file/build a thin wrapper (reuse `scripts/lib/jq-output.mjs`, like the ones below), don't shell out. The reads/edits that already have wrappers:
   - CI run-log tail (a failing PR's job log) → `scripts/github/fetch-ci-logs.mjs --repo <o/r> --pr <n> [--failed-only] [--tail <n>]`, **never raw `gh run view --log`/`--log-failed`**. (`probe-ci-status.mjs` names the failed checks; this returns the LOG.)
   - Issue list/filter → `scripts/github/list-issues.mjs --repo <o/r> [--state <open|closed|all>] [--label <l>] [--limit <n>]`, **never raw `gh issue list`**. (The queue tool lists the project board; this is for arbitrary issue queries.)
   - Issue comment → `scripts/github/comment-issue.mjs --repo <o/r> --issue <n> (--body <text> | --body-file <path>)`, **never raw `gh issue comment`**. Returns `{ ok, commentUrl }`.
   - Edit an existing issue/PR comment → `scripts/github/edit-comment.mjs --repo <o/r> --comment-id <n> (--body <text> | --body-file <path>)`, **never raw `gh api -X PATCH .../issues/comments/{id}`**. Covers both issue comments and PR issue-comments (same REST endpoint). Returns `{ ok, commentUrl }`.
   - Issue edit (title/body/assignee/milestone/state) → `scripts/github/edit-issue.mjs --repo <o/r> --issue <n> [--title <t>] [--body <b> | --body-file <path>] [--add-assignee <u>] [--remove-assignee <u>] [--milestone <m>] [--state <open|closed>] [--reason <completed|not_planned>]`, **never raw `gh issue edit` / `gh issue close` / `gh issue reopen`**. `--state` runs the close/reopen call after any other edits. Returns `{ ok, repo, issue, edited }`.
   - Issue facts read (body/state/author/labels/etc.) → `scripts/github/view-issue.mjs --repo <o/r> --issue <n> [--json <fields>]`, **never raw `gh issue view`**. Returns the issue body that `list-issues.mjs` does not; the sanctioned reader for issue bodies (parallel to `view-pr`).
   - PR facts read (branch/state/mergeStateStatus/head SHA/etc.) → `scripts/github/view-pr.mjs --repo <o/r> --pr <n> [--json <fields>]`, **never raw `gh pr view`**. (For composite loop-routing/CI facts prefer `loop info --pr`; this is the thin field-read counterpart.)
   - PR edit (title/body/assignee/milestone) → `scripts/github/edit-pr.mjs --repo <o/r> --pr <n> [--title <t>] [--body <b> | --body-file <path>] [--add-assignee <u>] [--remove-assignee <u>] [--milestone <m>]`, **never raw `gh pr edit`**. Returns `{ ok, repo, pr, edited }`.
   - PR checks/status → `scripts/github/probe-ci-status.mjs --repo <o/r> --pr <n> --timeout-ms 0` for a single live combined-CI check, **never raw `gh pr checks`**. (Provider-agnostic; drop the `--timeout-ms 0` to block-wait.)
   - Post-drive gate-evidence audit (does the PR have its posted draft_gate + pre_approval_gate verdicts?) → `scripts/github/audit-gate-evidence.mjs --repo <o/r> --pr <n>` (**never raw issue-comment reads**); it scans BOTH verdict surfaces (PR reviews + issue comments, see GATE-EVIDENCE-AUDIT-TWO-SURFACES), so a verdict posted only as a PR review is never reported missing (#1729).
   - Reconcile a stuck `gate-evidence` required status at merge-readiness → `scripts/github/reconcile-gate-evidence-status.mjs --repo <o/r> --pr <n>`. Run it right after the post-drive audit and before the human-approval/merge checkpoint. When the current-head verdict evidence is satisfied but the `gate-evidence` commit status is stuck non-green (a `cancel-in-progress`-cancelled or read-after-write-raced verdict-post re-fire, issue #1935), it re-fires the run so the status flips to `success` without a manual `gh run rerun`. Fail-closed: when the evidence is genuinely missing it re-fires nothing (ADR 0057, see [Merge Preconditions](../docs/merge-preconditions.md)).

   These accept the same `--jq`/`--silent` output flags as every other JSON-emitting script (base-CLI guarantee) — including `probe-ci-status.mjs`, watch-shaped as it is.
5. **NEVER `| python3` or `node -e`** to parse tool JSON. If a field you need is missing from a script's output, add it to the script (or its concise mode), not an inline parser.

## Guard rules

**Handoff envelope precedence:** The dev-loop builds the envelope immediately after authoritative-state resolution and treats it as the first handoff artifact. Read it first, load only `requiredReads`, execute `nextAction`. The envelope's stable body + `requiredReads` are byte-identical across rounds for the same target+gate — the only per-round-varying values live in the trailing `gateState` block, which is **volatile: read it last, or re-derive it fresh via detectors right before acting** (this keeps the stable prefix cache-warm across fresh reviewer spawns — #1462). See [Resolve authoritative state](#resolve-authoritative-state). Derivation contract: [Workflow Handoff Contract](../docs/workflow-handoff-contract.md).

**Handoff contract rule:** When no envelope is present, use the `workflow-handoff-contract.md` contract. Never delegate with abbreviated task summaries. Include deterministic routing inputs, explicit `cwd`, bounded task scope, exit conditions.

**Inline-first rule:** Prefer inline commands over nested async delegation when managing a single PR. Use nested delegation only for parallel fan-out or when the parent needs to continue other work.

**Bounded async task contract:** Break work into discrete tasks with clear inputs, explicit outputs, bounded scope. No shell polling — use `run-watch-cycle.mjs` or `gh run watch`. Fan-out reviewer waits (gate sub-loops or any Agent-tool fan-out) follow `ANTIPATTERN-FANIN-WAIT` in [Anti-patterns](../docs/anti-patterns.md): await completion via the harness notification or the reviewer's findings artifact at its deterministic path and join via the sanctioned fan-in CLI (`dev-loops gate consolidate-fanin`) — never transcript-tail, `node -e`/`python3`-parse tool JSON, or `sleep`-poll.

**Spec authority is engaged by default on every gate round (issue 2008 / ADR 0061):** before
fan-out dispatch, run the CLI seam that derives the run's spec/digest identities so the skill
never hand-derives them:

```sh
content_digest=$(node scripts/loop/spec-context.mjs --repo <owner/name> --issue <linked_issue_number> \
  --content-file <reviewed-content-path> --head-sha <current_head_sha> \
  --spec-out <spec-path> --identity-out <identity-path> --jq '.contentDigest')
```

On a fixer-push re-entry round (a prior clean round's `--approvals-out` record exists), also derive
the AC7 affected-criteria producer's input:

```sh
node scripts/loop/spec-context.mjs changed-paths --base <prior_approved_head_sha> --head <current_head_sha> \
  --jq '.changedFiles' > <changed-paths-path>
```

**AC1 identity stamp on every durable record (issue 2008 / ADR 0061):** the SAME call also writes
the round's revision-identity stamp once via `--identity-out <identity-path>`
(`{ specDigest, headSha, contentDigest, checkedCriteria }`). Pass `--spec-authority <identity-path>`
to every durable record writer this round invokes — `consolidate-fanin --spec-authority
<identity-path>`, `write-gate-findings-log.mjs --spec-authority <identity-path>`,
`upsert-checkpoint-verdict.mjs --spec-authority <identity-path>`, and (on a carry-forward round)
`resolve-angle-carry-forward.mjs --spec-authority <identity-path>` — so every gate/fixer/
carry-forward record pins both revision identities and the checked criteria, re-entry-safe from
any record type. Full per-writer flag detail: Gate Review Sub-Loop Contract Phase 3.5.

**Gate fan-out dispatch (inline imperative — #1637):** When you dispatch the `draft_gate` / `pre_approval_gate` fan-out (parallel fresh-context reviewers seeded from the one neutral context bundle), you MUST join their results through the sanctioned fan-in CLI — not by hand-rolling the wait. Never hand-roll reviewer dispatch via `Promise.all(runs.run)` + transcript-tailing; await each reviewer's findings artifact at its deterministic output path (`tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/<angle>.json`) and consolidate via ONE call, always with `--spec-authority <identity-path>` from above:

```sh
dev-loops gate consolidate-fanin --findings-dir <dir> --head-sha <current_head_sha> --gate <gate> \
  --expected-dispatch-units <n> --out <findings-json-path> --ledger-out <ledger-path> \
  --spec-authority <identity-path> --jq '.severityCounts'
```

**Judge between fan-in and the fixer (Phase 3.5 wired, #1658):** after fan-in (and after the
durable ledger is written with `write-gate-findings-log --judge-verdict <verdict-path>
--spec-authority <identity-path>`), dispatch
the dedicated `judge` agent (`agents/judge.agent.md`) — seeded with the consolidated ledger, the
linked issue's AC/DoD/non-goals, the PR's declared scope, the prior-round judge ledgers, and the
spec-context output (the structured spec at `<spec-path>`, `specDigest`, `contentDigest`) — and
await its two verdict artifacts: the relevance verdict at
`tmp/gate-judge/<repo-slug>/pr-<N>/<gate>-<headSha>/judge-verdict.json` and the spec-authority
verdict at the sibling `spec-authority-verdict.json` (its only writes). Then run the deterministic
bridge to derive the fixer's act list for Phase 4, always with the spec-authority flags, plus the
durable-approval flags across re-entry:

```sh
dev-loops gate judge-pass --repo <owner/name> --pr <N> --gate <gate> --head-sha <current_head_sha> \
  --findings-file <ledger-path> --judge-verdict <verdict-path> --out <act-list-path> --ledger-out <enriched-ledger-path> \
  --spec-file <spec-path> --content-digest "$content_digest" --spec-authority-verdict <spec-authority-verdict-path> \
  [--prior-approvals <prior-approvals-path> --approvals-out <approvals-out-path>] \
  [--changed-paths <changed-paths-path> --coverage-map <coverage-map-path>]
```

`--prior-approvals`/`--approvals-out` thread across re-entry rounds (the first round on a fresh
approval chain has no prior-approvals record to pass yet); `--changed-paths`/`--coverage-map` are
supplied together only when a coverage map exists for the linked issue and this round is a
fixer-push re-entry (`resolveAffectedCriteria`, ADR 0061 AC7) — otherwise judge-pass keeps its
all-stale fallback. The fix pass consumes ONLY `--out`'s act list (the judge's `act` findings); a
`judge-pass` fail-closed (stale verdict head, malformed verdict, out-of-range index, undisposed
finding, mismatched spec-authority identity) means re-run the judge at the current head, never a
silent severity-only fallback or a silent skip of spec authority. See Gate Review Sub-Loop Contract
Phase 3.5 and `skills/docs/spec-authority-contract.md` for the enforcement rules these flags carry.

The cross-refs (`ANTIPATTERN-FANIN-WAIT` in [Anti-patterns](../docs/anti-patterns.md), [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md) Phase 3) remain authoritative for the full refusal list and fail-closed cases; this inline emphasis exists so the sanctioned path is visible at the point of dispatch without following a link. A subagent that skipped the cross-ref and hand-rolled `Promise.all` + transcript-tailing burned ~189k tokens and had to be interrupted and restarted fresh — do not repeat that.

**Bounded test runs (enforced — #1650):** Every focused `bun test` invocation an agent launches directly on a suite containing gh-mocking tests MUST be bounded by a hard timeout: `timeout 90 bun test <file>` (or wrap the run in `timeout`). Never invoke an unbounded `bun test` on such a suite. (Piping through `head` is NOT a substitute — it bounds output lines, not execution time; a hung test producing no output is never killed.) Failure mode: a gh-mocking test that hangs on a real `gh`/run-id call blocks the whole drive — #1526 stalled 65+ seconds on `upsert-checkpoint-verdict.test.mjs`, and a retrospective subagent hit the same hang re-running the gate suites. (#1639 stabilizes the environmental suites themselves; this guardrail bounds the run so a single hung test cannot stall a drive.) `bun run verify` already bounds its suites; this applies to ad-hoc / per-file test runs an agent launches directly. Bun is the development runner only; Node `>=24` consumer-runtime and npm publication checks remain explicit exceptions.

**Bounded Copilot/CI watch (enforced — #1660):** Copilot/CI watches an agent launches directly MUST be bounded — use `dev-loops gate probe-copilot --timeout-ms 300000` (5min) + re-check, or `timeout 600 <cmd>` — never an unbounded 30min+ blocking watch. Failure mode: `copilot-pr-handoff.mjs` emits a 30min default wait (`COPILOT_REVIEW_WAIT_TIMEOUT_MS = 1,800,000`); #1537 hung 55min and #1525 hung 20min on unbounded watches, each requiring interrupt+resume. Always pass an explicit bounded timeout on probe/watch commands; re-check on timeout rather than blocking.

**Bounded, exhaustively (dispatch discipline, #1907):** the two guardrails above name the two most-hit failure modes, not the boundary of the rule — every `bash` call this agent launches directly is `timeout`-bounded (or issued through a wrapper that already bounds itself), and every watch/probe carries an explicit `--timeout-ms` (or equivalent bounded flag); an unbounded blocking call is never sanctioned regardless of which command it wraps.

**Gate fan-out dispatch discipline (bounded-parallel default, #1907):** gate fan-out is bounded-parallel by DEFAULT — up to `gates.fanout.maxConcurrent` dispatch units per wave via blocking joins; `gates.fanout.sequential: true` is the documented load fallback for a SIGTERM-prone environment, never the default. A transient dispatch failure (429/5xx) retries the same unit with exponential backoff; a hard 4xx (e.g. `402`) escalates to the supervisor/operator immediately instead of retrying into the same wall; provider choice stays a per-dispatch decision (`STICKY-PROVIDER-PIN`). Post-merge, the only remaining steps are the main-green check, one board-move attempt, and the final report — never re-running consolidation machinery whose artifacts already exist. Owning rules: `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`, `GATE-EXEC-DISPATCH-RETRY-BACKOFF`, `GATE-EXEC-END-OF-RUN-CONTRACT` in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md); `STICKY-PROVIDER-PIN` in [Anti-patterns](../docs/anti-patterns.md).

**Blocking join for a nested single-child step, never sleep-poll (#1907):** when this run's turn is awaiting a nested child IT dispatched — a judge, a fixer, or a single reviewer — join it with a blocking dispatch (`async: false`) or one `bg_wait` nonBlocking subscription. Do not sleep-poll for it and do not end the turn to await it (observed failure: repeated 180/240/300s sleep loops). This is the actionable alternative behind `END-TURN-AND-AWAIT-WAKE` in [Anti-patterns](../docs/anti-patterns.md); see [dev-loop agent — Subagent delegation](../../agents/dev-loop.md#subagent-delegation) for the agent-contract pin of the same rule.

**Agent-level stall → auto-fresh-dispatch (#1669):** When a dev-loop child shows no turn progress for `workflow.stallDetection.thresholdMinutes` (default 5) with no pending supervisor request, auto-bail to a fresh-context dispatch (carrying worktree state + a recovery brief) instead of waiting through a manual interrupt+resume. Distinguish a TRUE stall (no turn progress) from a SANCTIONED long watch (an active bash/subagent tool call that heartbeats its runner claim) — a fresh runner-coordination heartbeat exempts a run from stall. Detector + probe: `node scripts/loop/detect-agent-stall.mjs --repo <owner/name> [--pr <n>] [--status <path>]`. See [Agent-level stall detection](../docs/agent-stall-detection.md). Interrupt+resume remains the manual fallback.

**Round-cap budget check (enforced):** After every watch cycle, fix pass, or reply-resolve, check whether completed Copilot review rounds have reached the resolved round cap (`refinement.maxCopilotRounds`, default 5; light-dispatched PRs resolve the lower `resolveEffectiveCopilotRoundCap`, default 1 — owned by `COPILOT-FOLLOWUP-ROUND-CAP`). Stop re-requesting Copilot review when the limit is reached **within that review cycle**. Exception: the post-convergence new-cycle re-request carve-out (a converged loop that later takes significant post-convergence changes on a newer head opens a new cycle even if the previous one hit the cap) is owned by `COPILOT-FOLLOWUP-ROUND-CAP`. Read these gate-cadence facts via the token-economical convention above (`run-watch-cycle.mjs --concise`, or `--jq`/`--silent` for a single field/predicate) — never `| python3` or `node -e`.

## Shorthand issue-based auto trigger contract

- `auto dev loop on issue <n>` → public `dev-loop` intent `auto_continue_current` after authoritative current-state resolution
- Continue through GitHub/Copilot loop until stop condition or human approval checkpoint
- Stop at the human approval checkpoint by default unless merge explicitly authorized

## Headless auto-refine of parked un-refined items

Headless/`--auto` only. The enqueue refinement gate never lets an un-refined issue reach the pickup column: in `--auto` mode `add-queue-item.mjs` diverts it to the non-pickup park column with a recorded reason (`refined:false, diverted:true, parkedColumn, reason`), and it deliberately does NOT grill — synthesizing the missing artifact is this orchestrator's job, never the coordinator script's (keeps `OPS-NO-INLINE-INTERPRETER` clean). So a headless auto session that finds the pickup source empty may still have parked issues awaiting refinement. Before idling, run this bounded sub-loop (skip it entirely for interactive runs and for a specific `--issue`/`--pr` target):

1. **Discover (deterministic, no LLM).** List parked un-refined issues via `node <dev-loops-package-root>/cli/index.mjs queue parked-unrefined --repo <owner/name>` (project auto-resolved from `.devloops`; add `--jq`/`--silent` per the token-economical convention). It reads the park column and runs the same refinement-completeness check as the enqueue gate; each item carries `{ issueNumber, reason, missing }`. Empty list → nothing to refine; proceed to the normal fail-closed idle. Iterate the returned items in **ascending `issueNumber` order**, and attempt each **at most once per session** (steps 2–4). This is what bounds the sub-loop: one grill attempt per discovered item, then idle.
2. **Auto-refine (the LLM step, here in the orchestrator).** For each discovered item, in order, run `/dev-loops:loop-grill <issueNumber> --auto` (or `/loop-grill <issueNumber> --auto` in the dev-loops repo itself) (the `loop-grill` skill synthesizes AC/DoD/Non-goals into the issue body — do not re-implement grilling, and never move it into a coordinator script).
3. **Promote via the sanctioned move.** After a `grill-clean` verdict the issue is refined — confirmed by the same completeness check the enqueue gate runs (`detectIssueRefinementArtifact`), so this move admits exactly what the gate would. The item is already on the board in the park column, so **move** it into the pickup column with `node <dev-loops-package-root>/cli/index.mjs queue move --repo <owner/name> --item <issueNumber> --to-column "<pickup column>"` (the configured Next Up column). Do NOT use `add-queue-item` here: it is an idempotent no-op for an already-present item and cannot promote it. Then continue to the next discovered item.
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
