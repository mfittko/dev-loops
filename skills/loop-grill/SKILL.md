---
name: loop-grill
description: >-
  Standalone pre-loop Socratic Q&A grill for issues (tracker-first), PR bodies,
  or local plan files (local-planning). Detects spec gaps, asks clarifying
  questions (interactive) or self-answers them from codebase context (--auto),
  then synthesizes Acceptance criteria / Definition of done / Non-goals into the
  body while keeping the raw Q&A only in an ephemeral tmp artifact.
allowed-tools: read bash edit write
user-invocable: false
---
# Loop-grill skill

A standalone, on-demand pre-loop grilling skill. Run it against an issue or a local plan file **before** the dev loop starts to surface underspecified acceptance criteria, fuzzy scope boundaries, unresolved primary actors, and undocumented hard-to-reverse decisions.

It is entirely separate from the in-loop docs-grill (`skills/docs/docs-grill-step.md`), which audits code/doc drift while the loop runs. This skill operates on the *spec* before any implementation begins.

## State machine

This grill is the bounded, closed sub-loop modeled by `packages/core/src/loop/refinement-grill-state.mjs` (detector `scripts/loop/detect-refinement-grill-state.mjs`), rendered on the State atlas; see `docs/refinement-grill-state-graph.md`. It obeys `GRILL-SUBLOOP-STATE-MACHINE`, `GRILL-SUBLOOP-ITERATE-TO-CLEAN`, `GRILL-SUBLOOP-NO-EMBED-SYNTHESIS`, `GRILL-SUBLOOP-HONEST-HANDOFF`, `GRILL-SUBLOOP-FULL-REWRITE`, `GRILL-SUBLOOP-RATIONALE-COMMENT`, and `GRILL-SUBLOOP-NO-BARE-HASH`. Iteration lives in the transition graph; the answer/synthesis is the bounded input consumed at the `await_answers` state.

## Interface

```
/loop-grill <issue-number>             # tracker-first, interactive
/loop-grill <issue-number> --auto      # tracker-first, auto-answer
/loop-grill <pr-url-or-number>         # PR body, interactive
/loop-grill <pr-url-or-number> --auto  # PR body, auto-answer
/loop-grill <path/to/plan.md>          # local-planning, interactive
/loop-grill <path/to/plan.md> --auto   # local-planning, auto-answer
```

In a consumer (plugin) install these run as `/dev-loops:loop-grill …`; the bare `/loop-grill` form is dev-loops-repo-local (repo-local `.claude/commands`).

PR bodies are supported the same way as issues: fetch/edit the PR body via the existing PR wrappers (`scripts/github/view-pr.mjs` / `scripts/github/edit-pr.mjs`), never raw `gh`.

## Argument validation (fail-closed)

Before doing anything else:

1. Confirm exactly one positional argument is present (issue number or path). No argument → error, stop.
2. Confirm the only optional flag is `--auto`. Any other flag → error, stop.
3. **Tracker-first:** verify the issue exists. Non-existent issue → `Error: issue #<n> not found.`, stop.
4. **Local-planning:** verify the file exists. Missing file → `Error: plan file not found: <path>`, stop.
5. Never mutate any artifact when argument validation fails.

## Step 1 — Load the target

- **Tracker-first:** fetch the issue body (title + description) via `scripts/github/view-issue.mjs` (never raw `gh`).
- **PR body:** fetch the PR body via `scripts/github/view-pr.mjs` (never raw `gh`).
- **Local-planning:** read the plan file from disk.

"Is it refined" is decided by `detectIssueRefinementArtifact` (`packages/core/src/loop/issue-refinement-artifact.mjs`) — the single source of truth, same as the enqueue gate; do not add a divergent check. A body carrying only AC/DoD checklists and no mapping matrix is NOT refined (`missing_ac_dod_matrix`) and MUST be grilled to synthesize the matrix — a matrix-missing issue can never emit `grill-clean`.

The zero-iteration `grill_clean` exit requires BOTH a shape-clean artifact AND recorded provenance (ADR 0084, amends ADR 0029): a `🔬 Grill / refinement results` comment already posted on the target. Decide this deterministically — never by agent judgment of the fetched comments:

1. Fetch the body into its own file, extracting past the wrapper's envelope: for **tracker-first**, `node scripts/github/view-issue.mjs --repo <owner/repo> --issue <n> --json body --jq '.issue.body' > <body-path>` (never raw `gh`); for **PR body**, `node scripts/github/view-pr.mjs --repo <owner/repo> --pr <n> --json body --jq '.pr.body' > <body-path>`. The `--jq` extraction on a string field prints the raw string, not JSON-quoted, so `<body-path>` holds exactly the raw markdown body the detector expects — feeding it the unextracted `{ "ok": true, "issue"|"pr": { "body": "..." } }` envelope, or the envelope plus title, defeats `detectIssueRefinementArtifact`'s matrix detection and forces an already-provenanced target back through a full re-grill.
2. Fetch comments into their own JSON file, extracting past the wrapper's envelope: for **tracker-first**, `node scripts/github/view-issue.mjs --repo <owner/repo> --issue <n> --json comments --jq '.issue.comments' > <comments-path>` (never raw `gh`); for **PR body**, `node scripts/github/view-pr.mjs --repo <owner/repo> --pr <n> --json comments --jq '.pr.comments' > <comments-path>`. The `--jq` extraction is required: the wrapper's own output is `{ "ok": true, "issue"|"pr": { "comments": [...] } }`, and the detector's `--comments-file` accepts only a bare array or `{ "comments": [...] }` — feeding it the unextracted envelope fails closed.
3. Run `node scripts/loop/detect-refinement-grill-state.mjs --body-file <body-path> --surface <issue|pr> --comments-file <comments-path>`.
4. Take the zero-iteration exit ONLY when the detector's output has `state == grill_clean`. On `state == grill_clean` the run stops here: it does not rewrite the body, posts no new results comment, and emits `grill-clean`. Any other state (including `detect_gaps` with `reason: provenance_missing`) means the target is NOT a zero-iteration exit — run the full grill (Steps 2–4) anyway; a zero-gap pass still records its own provenance by posting the results comment (Step 4), stating that no gaps were found.

**Local-planning** plan files have no comment surface, so they keep shape-only behavior: a shape-clean plan file is always a zero-iteration `grill_clean`, do not rewrite it.

## Step 1b — Surface external resources

Before detecting gaps, scan the loaded content for external resource references: links, other repo URLs, API endpoints, doc URLs, screenshots, or Playwright navigation descriptors.

- **Interactive mode:** if external resources are present, ask the operator to confirm they are accessible or to provide them before the Q&A starts.
- **`--auto` mode:** attempt to fetch each resource using bounded wrapper commands (e.g. `gh`, API wrapper scripts under `scripts/`). Do not fetch resources inline with raw `curl` or token-heavy calls. Flag any inaccessible resource as `unresolved` in the findings rather than silently skipping it.
- When no external resources are present, skip this step silently.

### Visual resources

Screenshots and Playwright navigation descriptors are visual resources: they let a design/UI gap be answered against the current screen instead of ambiguous prose. Surface them here, before the Q&A, alongside the other external resources.

- **Screenshot (file path or URL):** include the referenced image as context when answering design/UI-related gaps. A local path is loaded directly with the read tool (it renders images); a URL is fetched with a bounded wrapper command, never a raw token-heavy call. An unreadable path or an inaccessible URL is flagged `unresolved` — never describe a screen you could not see.
- **Playwright navigation descriptor** (an ordered path to a screen, e.g. "go to /settings, click Edit Profile"):
  - **`--auto` mode:** invoke the bounded wrapper `dev-loops loop visual-grill-capture --repo-root <p> --app-url <url> --output-dir <p> --descriptor <json|@file>` (source-repo fallback: `node scripts/loop/visual-grill-capture.mjs …`) to drive a headless browser and capture that screen's screenshot as context. The wrapper is a thin adapter over the ui_review drive harness; do not run browser code inline. A `@<file>` descriptor reference must be a relative, non-traversing path inside the repo root (an absolute or `..`-escaping path is rejected unread). Navigation is confined to the running app: only http/https `goto` targets on the app's own origin are allowed (a `file:`/`data:` scheme or a cross-origin override is rejected), steps are limited to DOM-interaction actions that reach a screen (`goto`/`click`/`fill`/`select`/`dispatch` — `upload` and unknown actions are rejected so no local file is read), and the descriptor is capped at a bounded step count. Confinement is also enforced at runtime — if a redirect or a click-navigation leaves the app origin, the capture fails closed rather than screenshotting an off-origin page. Only the final screen is persisted: intermediate step captures (which may hold sensitive state, e.g. a screen after a credential `fill`) are pruned as the walk advances. When it returns `ok: false` (the runner is unavailable, login fails, a step cannot be reached, or navigation is rejected), flag the visual gap `unresolved` — never re-describe the screen in prose. Playwright is an optional peer dependency, so an install that never set it up returns `ok: false` with the install instructions in `stopReason` (`npm install --save-dev @playwright/test`, then `npx playwright install webkit`); that is a resolvable setup gap, not a defect in the target.
  - **Interactive mode:** ask the operator to provide the screenshot or confirm the navigation steps before the Q&A starts.
- Any inaccessible screenshot, or a navigation descriptor that cannot be captured, is flagged `unresolved` — the same fail-closed degradation rule as every other external resource.

## Step 2 — Detect gaps

Scan the loaded content and identify each gap. The minimum required gap detectors are:

| Gap kind | Detection signal |
|---|---|
| Missing acceptance criteria | No `## Acceptance criteria` section, or section is empty / stub |
| Missing scope boundary | No explicit in-scope / out-of-scope statement or non-goals section |
| Unresolved primary actor | No named user, system, or role that is the main beneficiary of the feature |
| Undocumented hard-to-reverse decision | Destructive or irreversible operations described without a rationale or rollback note |

Additional gaps discovered through semantic reading of the spec are also recorded.

### Count-based acceptance criteria guardrail

<!-- rule: GRILL-COUNT-AC-UNIT-DISPATCH-MODE -->
`GRILL-COUNT-AC-UNIT-DISPATCH-MODE`: An acceptance criterion that names a **count** (sentinel count, angle count, dispatch-unit count) MUST specify which unit the count refers to — `sentinel` vs `angle` vs `dispatch-unit` — and MUST be validated against BOTH per-angle dispatch and the shipped grouped-dispatch default, not just one. Grouped fan-out writes one sentinel per emitted dispatch unit, not per angle; the AC MUST call out that interaction. Detect an omitted unit or dispatch-mode interaction as a gap before synthesis, then record the outcome and validation evidence in the authoritative `## AC / DoD matrix` required by Step 4.

For each gap, classify it as either:
- **Bounded choice** — the answer is one of a small discrete set (e.g. yes/no, A/B/C).
- **Open-ended** — the answer requires free-form elaboration.

## Step 3 — Fill gaps

### Interactive mode (default)

For each gap, in order:

- **Bounded choice gap:** use `AskUserQuestion` with the question text and the choice options, plus an "Other / free text" option. Block until the user answers.
- **Open-ended gap:** present the question as a plain text turn. Block until the user answers.

Record each answer's source as the operator's GitHub handle: resolve it once per run with `gh api user --jq .login`. This direct self-lookup is a knowingly accepted advisory raw-`gh` call under the wrapper-for-`gh`-reads rule owned by the [Dev Loop Skill](../dev-loop/SKILL.md) — the operator declared a dedicated wrapper a non-goal for this one read-only self-read; every other `gh` read still goes through a wrapper. Treat the login as resolved only when the command exits 0 and its trimmed stdout is non-empty, is not the literal `null`, and matches `^[A-Za-z0-9-]{1,39}$` (a plain GitHub handle — never markdown-significant text); use that handle (e.g. `mfittko`) as the `Source` value for every human-answered gap. In every other case fall back to the literal `human`. `--auto` mode is unaffected — its evidence-source tokens are not human answers.

> `AskUserQuestion` is a Claude Code–native construct. If you are running outside Claude Code, use `--auto` mode instead.

### Auto mode (`--auto`)

Answer every grilling question yourself without prompting the user. Source answers from (in priority order):

1. **`codebase`** — inspectable source files, tests, scripts, config in the repository.
2. **`docs`** — markdown files under `docs/`, `skills/docs/`, and adjacent contract docs.
3. **`context`** — `CONTEXT.md` at the repo root, if present. When absent, skip silently — do not crash, no warning required.
4. **`inferred`** — reasoning from the issue/plan text alone, with no external citation.

Record the evidence source for every answer. Flag a question as **`unresolved`** when:
- The only available source is `inferred`, **and**
- No codebase path, doc section, or issue/plan text can be cited as the basis for the answer.

Do not silently guess an `inferred` answer when no evidence can be cited — flag it `unresolved` instead.

## Step 4 — Write back (synthesize sections; raw Q&A to tmp only)

Synthesize the answers into the body as the authoritative **`## AC / DoD matrix`** (a two-column table mapping each acceptance-criterion outcome to its required completion evidence) plus a `## Non-goals` section (#1951, "matrix on the issue, checklist on the PR"). The matrix is the authoritative issue artifact; do NOT synthesize duplicate interactive `## Acceptance criteria` / `## Definition of done` checklists on the issue merely to satisfy detection — those list-form checkboxes belong on the PR body (derived via `derivePrChecklistsFromIssueMatrix`), never inside table cells. Each matrix row MUST map a concrete criterion to concrete completion evidence; a tautological/identifier-only row (`AC1 → D1`) is invalid and `detectIssueRefinementArtifact` rejects it as `malformed_ac_dod_matrix`. Per canonical heading, use **replace-section** semantics:

- **Find** the existing section: the range from that `##`-level heading through the next `##`-level heading (exclusive) or end of file.
- **Replace** that range in place with the synthesized content; if the section is absent, **append** it.
- This makes re-runs idempotent — no accumulated noise, no duplicate sections.
- If parsing a section boundary fails, **abort with an error** rather than silently truncating.

The synthesized sections carry no rationale scaffolding: do NOT write a `## Grill findings` section and do NOT embed the raw Q&A table in the body (`GRILL-SUBLOOP-NO-EMBED-SYNTHESIS`). (The full rewrite below defines the complete set of content the locked body keeps — context, decided approach, and the canonical sections — so this is a "no embed", not a "sections only".)

If a body migrated from older embed behavior still carries a `## Grill findings` section, **remove** it as part of write-back — strip from that heading through the next `##`-level heading (exclusive) or end of file, using the same replace-section boundary logic. This is a removal-only migration, never a re-introduction of the embed.

Write the raw Q&A transcript ONLY to the gitignored, ephemeral, session-scoped artifact `tmp/issues/issue-<n>/grill/<timestamp>.md` (`tmp/` is already gitignored; never committed). For PR-body and plan-file surfaces, use the same tmp path shape scoped by surface (issues: `tmp/issues/issue-<n>/grill/`; a parallel `tmp/...` path for PR/plan).

**Tracker-first write-back is a full rewrite, not an append** (`GRILL-SUBLOOP-FULL-REWRITE`). After the replace-section synthesis above, scan the ENTIRE remaining description (not just the canonical headings) and resolve it into one locked, unambiguous spec:

- Any "suggested / option A or B / TBD" phrasing that describes a gap THIS grill run just decided: rewrite it to the decided form only; delete the rejected alternative(s). A leftover undecided option for a gap the grill already resolved is a write-back defect.
- Any `Refinement notes` / `Grill findings` / RFC-style rationale narrative (gap tables, recommendation + rejected alternatives, decision log) anywhere in the description: remove it entirely. That content is never body prose — it moves to the results comment (see below), not the description.
- Any contradiction between now-stale prose and the locked AC/DoD/approach: resolve in favor of the locked form; delete the stale prose.
- Any bare `#<number>` used as a defect/item enumeration rather than a genuine issue/PR reference (`GRILL-SUBLOOP-NO-BARE-HASH`): rewrite as `defect N` / `item N` / backticks. GitHub auto-links a bare `#<number>` to an unrelated issue/PR in this repo — reserve `#<number>` only for a real issue/PR cross-reference.

The rewritten description carries ONLY normative locked content: context, the decided approach, the `## AC / DoD matrix` (the authoritative AC→DoD mapping table), `## Non-goals`, and a linked refinement doc reference if present. (A body MAY additionally carry human-readable `## Acceptance criteria` / `## Definition of done` prose, but the matrix — not those checklists — is what refinement detection requires.) Write it back with:

```
dev-loops issue edit --repo <owner/repo> --issue <n> --body-file <tmp-body-path>
```

(source-repo fallback: `node scripts/github/edit-issue.mjs --repo <owner/repo> --issue <n> --body-file <tmp-body-path>`)

**Post the rationale as a separate results comment** (`GRILL-SUBLOOP-RATIONALE-COMMENT`): the description and the rationale are two distinct artifacts — never merge them. When the operator accepts an escalated RFC-worthy decision from the rationale, it is persisted as an ADR per the [Decision record contract](../docs/decision-record-contract.md). Write the rationale (gaps found and filled, the RFC recommendation and rejected alternatives, and decisions taken) to a second tmp file whose FIRST LINE MUST be exactly `## 🔬 Grill / refinement results` — the detector (`detectGrillProvenance`) recognizes a results comment only when the title is the comment's first non-empty line; a bold title, a suffixed title (e.g. "... results for issue N"), or any preamble line before it is NOT detected as provenance, and the target then loops at `detect_gaps`/`provenance_missing` on every re-run. Any `source:` and `bypass:` line comes immediately AFTER that first line, never before it. Post it:

```
node scripts/github/comment-issue.mjs --repo <owner/repo> --issue <n> --body-file <tmp-rationale-path>
```

Never `gh issue comment` directly, and never fold this content back into the issue body. The same `#<number>` hygiene rule (`GRILL-SUBLOOP-NO-BARE-HASH`) applies to the comment. Every semantic pass (Steps 2–4 actually ran) MUST post this results comment — on the issue surface AND the PR surface alike — including a zero-gap pass that finds no gaps to fill — its comment states plainly that no gaps were found, so the pass records its own provenance and a later re-run reaches the zero-iteration exit. Bypass means skipping an AVAILABLE zero-iteration exit: the target is already shape-clean AND already carries a recorded results comment (Step 1's `state == grill_clean`), and the operator authorizes another semantic pass anyway; that pass records a `bypass: operator-authorized by <handle>` line in the comment. A first pass on a shape-clean target with no recorded results comment is the normal REQUIRED pass (Step 1 owes it) and carries no bypass line — only re-grilling an already-provenanced target counts as a bypass. Only the provenance-recorded zero-iteration `grill_clean` exit from Step 1 (already refined AND a results comment already posted, or a `plan` surface) has no rationale to post and skips this step.

**PR-body write-back:** update the PR body via `scripts/github/edit-pr.mjs` (never raw `gh`), same replace-section semantics. Post the results comment the same way as the issue surface: GitHub issue comments work on PR numbers too, so `node scripts/github/comment-issue.mjs --repo <owner/repo> --issue <pr-number> --body-file <tmp-rationale-path>` posts it on the PR.

**GitHub body size guard:** issue/PR bodies are capped at 65,536 characters. Before writing back, check whether the updated body would exceed this limit. If so, warn: `Warning: updated body would exceed GitHub's 65,536-character limit — write-back skipped. Sharpen the sections or the body manually.` Do not silently truncate.

**Local-planning write-back:** update the plan file in place using the edit tool.

## Output artifact format

Three distinct artifacts for tracker-first AND PR-body (two for local-planning, which has no comment surface at all in this contract):

1. **Rewritten description** (issue/PR/plan body): the fully rewritten, locked spec — context, decided approach, the authoritative `## AC / DoD matrix`, and `## Non-goals` (optional human-readable AC/DoD prose may accompany the matrix). No raw Q&A, no rationale narrative, no unresolved "suggested … or …" phrasing, no bare non-issue `#<number>`.

2. **Results comment** (issue AND PR surfaces, posted separately; the comment's FIRST LINE MUST be exactly `## 🔬 Grill / refinement results` — that exact first line is what the detector keys provenance on): the rationale — gaps found and filled, the RFC recommendation and rejected alternatives, and decisions taken. The `source:` (and, when applicable, `bypass:`) line comes immediately after that first line, on its own line, never before it. For an interactive run the preamble reads `source: <handle> answers via operator Q&A` using the same resolved handle (fallback: `source: human answers via operator Q&A`). Same `#<number>` hygiene rule applies. Posted via `node scripts/github/comment-issue.mjs --repo <owner/repo> --issue <n|pr-number> --body-file <tmp-rationale-path>` in both cases — GitHub issue comments work on PR numbers too.

3. **Raw Q&A transcript** (ephemeral `tmp/issues/issue-<n>/grill/<timestamp>.md` only — never the body, never the comment):

```markdown
<!-- loop-grill: <timestamp> mode:<interactive|auto> -->

### Resolved gaps

| # | Gap | Question | Answer | Source |
|---|-----|----------|--------|--------|
| 1 | Missing AC | <question text> | <answer text> | codebase \| docs \| context \| inferred \| <operator-handle> (interactive; fallback `human`) |

### Unresolved gaps

| # | Gap | Question | Reason unresolved |
|---|-----|----------|-------------------|
| 1 | Unresolved primary actor | <question text> | No citable evidence found |

### Verdict

grill-clean
```

Replace `grill-clean` with `N unresolved items` when unresolved gaps remain.

## Step 5 — Emit verdict

Before emitting the verdict for a tracker-first or PR-body grill whose semantic pass ran (Steps 2–4), verify the write-back contract and fail closed if any check fails — stop and report the specific violation instead of emitting a verdict:

1. The rewritten description has no `Refinement notes` / `Grill findings` / rationale narrative section. (Applies only when the body was rewritten — i.e. at least one gap was filled.)
2. The rewritten description has no unresolved "suggested … or …" / "option A or B" marker for a gap this run decided. (Applies only when the body was rewritten.)
3. Neither the rewritten description nor the results comment contains a bare non-issue `#<number>`.
4. A `🔬 Grill / refinement results` comment was actually posted. (Applies to every semantic pass, skip this check only for the provenance-recorded zero-iteration `grill_clean` path from Step 1, which has no rationale to post; a zero-gap semantic pass still MUST post one.)

After write-back (and, for tracker-first or PR-body, after the above verification passes), emit the verdict line to stdout:

- `grill-clean` when no unresolved gaps remain.
- `N unresolved items` (e.g. `3 unresolved items`) when gaps remain after all questions are answered.

## Idempotency guarantee

Use Step 4's replace-section boundaries; an already-refined target stays unchanged. Write a fresh timestamped tmp transcript per run.

## Non-goals

- Auto-triggering from `issue_intake` — this is on-demand only.
- Replacing or modifying the in-loop docs-grill (`skills/docs/docs-grill-step.md`, `scripts/loop/docs-grill-contract.mjs`) — different concern, different firing surface.
- Full DDD `CONTEXT.md` management.
- Scheduling or storing grill runs — stateless and on-demand.
- Any CI/CD integration.
