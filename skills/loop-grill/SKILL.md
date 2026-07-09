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

This grill is the bounded, closed sub-loop modeled by `packages/core/src/loop/refinement-grill-state.mjs` (detector `scripts/loop/detect-refinement-grill-state.mjs`), rendered on the State atlas; see `docs/refinement-grill-state-graph.md`. It obeys `GRILL-SUBLOOP-STATE-MACHINE`, `GRILL-SUBLOOP-ITERATE-TO-CLEAN`, `GRILL-SUBLOOP-NO-EMBED-SYNTHESIS`, and `GRILL-SUBLOOP-HONEST-HANDOFF`. Iteration lives in the transition graph; the answer/synthesis is the bounded input consumed at the `await_answers` state.

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

- **Tracker-first:** fetch the issue body (title + description).
- **PR body:** fetch the PR body via `scripts/github/view-pr.mjs` (never raw `gh`).
- **Local-planning:** read the plan file from disk.

"Is it refined" is decided by `detectIssueRefinementArtifact` (`packages/core/src/loop/issue-refinement-artifact.mjs`) — the single source of truth, same as the enqueue gate; do not add a divergent check. An already-refined artifact (AC/DoD present) is a zero-iteration `grill_clean`: do not rewrite the body.

## Step 1b — Surface external resources

Before detecting gaps, scan the loaded content for external resource references: links, other repo URLs, API endpoints, doc URLs, screenshots, or Playwright navigation descriptors.

- **Interactive mode:** if external resources are present, ask the operator to confirm they are accessible or to provide them before the Q&A starts.
- **`--auto` mode:** attempt to fetch each resource using bounded wrapper commands (e.g. `gh`, API wrapper scripts under `scripts/`). Do not fetch resources inline with raw `curl` or token-heavy calls. Flag any inaccessible resource as `unresolved` in the findings rather than silently skipping it.
- When no external resources are present, skip this step silently.

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

The body carries ONLY the synthesized sharpened sections. Do NOT write a `## Grill findings` section and do NOT embed the raw Q&A table in the body (`GRILL-SUBLOOP-NO-EMBED-SYNTHESIS`).

If a body migrated from older embed behavior still carries a `## Grill findings` section, **remove** it as part of write-back — strip from that heading through the next `##`-level heading (exclusive) or end of file, using the same replace-section boundary logic. This is a removal-only migration, never a re-introduction of the embed.

Write the raw Q&A transcript ONLY to the gitignored, ephemeral, session-scoped artifact `tmp/issues/issue-<n>/grill/<timestamp>.md` (`tmp/` is already gitignored; never committed). For PR-body and plan-file surfaces, use the same tmp path shape scoped by surface (issues: `tmp/issues/issue-<n>/grill/`; a parallel `tmp/...` path for PR/plan).

**Tracker-first write-back:** update the GitHub issue body using:

```
node scripts/github/edit-issue.mjs --repo <owner/repo> --issue <n> --body-file <tmp-path>
```

The synthesized sections live in the issue body, not as a comment. Do not use `comment-issue.mjs` here — that creates a comment, not a body update.

**PR-body write-back:** update the PR body via `scripts/github/edit-pr.mjs` (never raw `gh`), same replace-section semantics.

**GitHub body size guard:** issue/PR bodies are capped at 65,536 characters. Before writing back, check whether the updated body would exceed this limit. If so, warn: `Warning: updated body would exceed GitHub's 65,536-character limit — write-back skipped. Sharpen the sections or the body manually.` Do not silently truncate.

**Local-planning write-back:** update the plan file in place using the edit tool.

## Output artifact format

Two distinct artifacts:

1. **Synthesized body sections** (issue/PR/plan body): only `## Acceptance criteria`, `## Definition of done`, and `## Non-goals`, sharpened from the answers. No raw Q&A.

2. **Raw Q&A transcript** (ephemeral `tmp/issues/issue-<n>/grill/<timestamp>.md` only — never the body):

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

After write-back, emit the verdict line to stdout:

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
