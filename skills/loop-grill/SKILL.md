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

It is entirely separate from the in-loop docs-grill (`docs/docs-grill-step.md`), which audits code/doc drift while the loop runs. This skill operates on the *spec* before any implementation begins.

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

"Is it refined" is decided by `detectIssueRefinementArtifact` (`packages/core/src/loop/issue-refinement-artifact.mjs`) — the single source of truth, same as the enqueue gate; do not add a divergent check. An already-refined artifact (AC/DoD present) is a zero-iteration `grill_clean`: do not rewrite the body.

## Step 1b — Surface external resources

Before detecting gaps, scan the loaded content for external resource references: links, other repo URLs, API endpoints, doc URLs, screenshots, or Playwright navigation descriptors.

- **Interactive mode:** if external resources are present, ask the operator to confirm they are accessible or to provide them before the Q&A starts.
- **`--auto` mode:** attempt to fetch each resource using bounded wrapper commands (e.g. `gh`, API wrapper scripts under `scripts/`). Do not fetch resources inline with raw `curl` or token-heavy calls. Flag any inaccessible resource as `unresolved` in the findings rather than silently skipping it.
- When no external resources are present, skip this step silently.

### Visual resources

Screenshots and Playwright navigation descriptors are visual resources: they let a design/UI gap be answered against the current screen instead of ambiguous prose. Surface them here, before the Q&A, alongside the other external resources.

- **Screenshot (file path or URL):** include the referenced image as context when answering design/UI-related gaps. A local path is loaded directly with the read tool (it renders images); a URL is fetched with a bounded wrapper command, never a raw token-heavy call. An unreadable path or an inaccessible URL is flagged `unresolved` — never describe a screen you could not see.
- **Playwright navigation descriptor** (an ordered path to a screen, e.g. "go to /settings, click Edit Profile"):
  - **`--auto` mode:** invoke the bounded wrapper `node scripts/loop/visual-grill-capture.mjs --repo-root <p> --app-url <url> --output-dir <p> --descriptor <json|@file>` to drive a headless browser and capture that screen's screenshot as context. The wrapper is a thin adapter over the ui_review drive harness; do not run browser code inline. A `@<file>` descriptor reference must be a relative, non-traversing path inside the repo root (an absolute or `..`-escaping path is rejected unread). Navigation is confined to the running app: only http/https `goto` targets on the app's own origin are allowed (a `file:`/`data:` scheme or a cross-origin override is rejected), steps are limited to DOM-interaction actions that reach a screen (`goto`/`click`/`fill`/`select`/`dispatch` — `upload` and unknown actions are rejected so no local file is read), and the descriptor is capped at a bounded step count. Confinement is also enforced at runtime — if a redirect or a click-navigation leaves the app origin, the capture fails closed rather than screenshotting an off-origin page. Only the final screen is persisted: intermediate step captures (which may hold sensitive state, e.g. a screen after a credential `fill`) are pruned as the walk advances. When it returns `ok: false` (the runner is unavailable, login fails, a step cannot be reached, or navigation is rejected), flag the visual gap `unresolved` — never re-describe the screen in prose.
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

For each gap, classify it as either:
- **Bounded choice** — the answer is one of a small discrete set (e.g. yes/no, A/B/C).
- **Open-ended** — the answer requires free-form elaboration.

## Step 3 — Fill gaps

### Interactive mode (default)

For each gap, in order:

- **Bounded choice gap:** use `AskUserQuestion` with the question text and the choice options, plus an "Other / free text" option. Block until the user answers.
- **Open-ended gap:** present the question as a plain text turn. Block until the user answers.

Record each answer with its source: `human`.

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

Synthesize the answers into the body as sharpened `## Acceptance criteria`, `## Definition of done`, and `## Non-goals` sections. Per canonical heading, use **replace-section** semantics:

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

The rewritten description carries ONLY normative locked content: context, the decided approach, `## Acceptance criteria`, `## Definition of done`, `## Non-goals`, and a linked refinement doc reference if present. Write it back with:

```
dev-loops issue edit --repo <owner/repo> --issue <n> --body-file <tmp-body-path>
```

(source-repo fallback: `node scripts/github/edit-issue.mjs --repo <owner/repo> --issue <n> --body-file <tmp-body-path>`)

**Post the rationale as a separate results comment** (`GRILL-SUBLOOP-RATIONALE-COMMENT`): the description and the rationale are two distinct artifacts — never merge them. Write the rationale (gaps found and filled, the RFC recommendation and rejected alternatives, and decisions taken) to a second tmp file and post it as its own comment titled `🔬 Grill / refinement results`:

```
node scripts/github/comment-issue.mjs --repo <owner/repo> --issue <n> --body-file <tmp-rationale-path>
```

Never `gh issue comment` directly, and never fold this content back into the issue body. The same `#<number>` hygiene rule (`GRILL-SUBLOOP-NO-BARE-HASH`) applies to the comment. A zero-iteration `grill_clean` target (already refined, body left unchanged) has no rationale to post and skips this step; any run that actually filled a gap MUST post the results comment.

**PR-body write-back:** update the PR body via `scripts/github/edit-pr.mjs` (never raw `gh`), same replace-section semantics.

**GitHub body size guard:** issue/PR bodies are capped at 65,536 characters. Before writing back, check whether the updated body would exceed this limit. If so, warn: `Warning: updated body would exceed GitHub's 65,536-character limit — write-back skipped. Sharpen the sections or the body manually.` Do not silently truncate.

**Local-planning write-back:** update the plan file in place using the edit tool.

## Output artifact format

Three distinct artifacts for tracker-first (two for PR-body/local-planning, which have no separate results-comment surface in this contract):

1. **Rewritten description** (issue/PR/plan body): the fully rewritten, locked spec — context, decided approach, `## Acceptance criteria`, `## Definition of done`, and `## Non-goals`. No raw Q&A, no rationale narrative, no unresolved "suggested … or …" phrasing, no bare non-issue `#<number>`.

2. **Results comment** (tracker-first only, posted separately, titled `🔬 Grill / refinement results`): the rationale — gaps found and filled, the RFC recommendation and rejected alternatives, and decisions taken. Same `#<number>` hygiene rule applies.

3. **Raw Q&A transcript** (ephemeral `tmp/issues/issue-<n>/grill/<timestamp>.md` only — never the body, never the comment):

```markdown
<!-- loop-grill: <timestamp> mode:<interactive|auto> -->

### Resolved gaps

| # | Gap | Question | Answer | Source |
|---|-----|----------|--------|--------|
| 1 | Missing AC | <question text> | <answer text> | codebase \| docs \| context \| inferred \| human |

### Unresolved gaps

| # | Gap | Question | Reason unresolved |
|---|-----|----------|-------------------|
| 1 | Unresolved primary actor | <question text> | No citable evidence found |

### Verdict

grill-clean
```

Replace `grill-clean` with `N unresolved items` when unresolved gaps remain.

## Step 5 — Emit verdict

Before emitting the verdict for a tracker-first grill that filled at least one gap, verify the write-back contract and fail closed if any check fails — stop and report the specific violation instead of emitting a verdict:

1. The rewritten description has no `Refinement notes` / `Grill findings` / rationale narrative section.
2. The rewritten description has no unresolved "suggested … or …" / "option A or B" marker for a gap this run decided.
3. Neither the rewritten description nor the results comment contains a bare non-issue `#<number>`.
4. A `🔬 Grill / refinement results` comment was actually posted (skip this check only for the zero-iteration `grill_clean` path, which has no rationale to post).

After write-back (and, for tracker-first, after the above verification passes), emit the verdict line to stdout:

- `grill-clean` when no unresolved gaps remain.
- `N unresolved items` (e.g. `3 unresolved items`) when gaps remain after all questions are answered.

## CONTEXT.md degradation rule

When `CONTEXT.md` is absent from the repo root, skip the context-source check silently. Do not crash. Do not emit a warning. The grill continues with the remaining sources (`codebase`, `docs`, `inferred`).

## Idempotency guarantee

Running `/loop-grill` twice on the same target must not accumulate duplicate sections: the per-heading replace-section logic replaces the synthesized `## Acceptance criteria` / `## Definition of done` / `## Non-goals` sections in place. An already-refined target is a zero-iteration `grill_clean` and its body is left unchanged. The raw Q&A transcript is written to a fresh timestamped tmp file per run; the body never carries it.

## Non-goals

- Auto-triggering from `issue_intake` — this is on-demand only.
- Replacing or modifying the in-loop docs-grill (`docs/docs-grill-step.md`, `scripts/loop/docs-grill-contract.mjs`) — different concern, different firing surface.
- Full DDD `CONTEXT.md` management.
- Scheduling or storing grill runs — stateless and on-demand.
- Any CI/CD integration.
