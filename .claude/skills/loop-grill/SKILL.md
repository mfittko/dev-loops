---
name: "loop-grill"
description: "Standalone pre-loop Socratic Q&A grill for issues (tracker-first) or local plan files (local-planning). Detects spec gaps, asks clarifying questions (interactive) or self-answers them from codebase context (--auto), then writes a ## Grill findings section back to the source artifact."
allowed-tools: Read Bash Edit Write
user-invocable: false
---
<!-- GENERATED from skills/loop-grill/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->

# Loop-grill skill

A standalone, on-demand pre-loop grilling skill. Run it against an issue or a local plan file **before** the dev loop starts to surface underspecified acceptance criteria, fuzzy scope boundaries, unresolved primary actors, and undocumented hard-to-reverse decisions.

It is entirely separate from the in-loop docs-grill (`docs/docs-grill-step.md`), which audits code/doc drift while the loop runs. This skill operates on the *spec* before any implementation begins.

## Interface

```
/loop-grill <issue-number>             # tracker-first, interactive
/loop-grill <issue-number> --auto      # tracker-first, auto-answer
/loop-grill <path/to/plan.md>          # local-planning, interactive
/loop-grill <path/to/plan.md> --auto   # local-planning, auto-answer
```

## Argument validation (fail-closed)

Before doing anything else:

1. Confirm exactly one positional argument is present (issue number or path). No argument → error, stop.
2. Confirm the only optional flag is `--auto`. Any other flag → error, stop.
3. **Tracker-first:** verify the issue exists. Non-existent issue → `Error: issue #<n> not found.`, stop.
4. **Local-planning:** verify the file exists. Missing file → `Error: plan file not found: <path>`, stop.
5. Never mutate any artifact when argument validation fails.

## Step 1 — Load the target

- **Tracker-first:** fetch the issue body (title + description + any existing `## Grill findings` section).
- **Local-planning:** read the plan file from disk.

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

## Step 4 — Write back (replace-section semantics)

Write a `## Grill findings` section back to the source artifact using **replace-section** semantics:

- **Find** the existing `## Grill findings` section: the range from the `## Grill findings` heading through the next `##`-level heading (exclusive) or end of file.
- **Replace** that range in place with the new section content.
- If no `## Grill findings` section exists, **append** it.
- This makes re-runs idempotent — no accumulated noise, no duplicate sections.
- If parsing the section boundary fails, **abort with an error** rather than silently truncating.

**Tracker-first write-back:** update the GitHub issue body using:

```
gh issue edit <n> --repo <owner/repo> --body-file <tmp-path>
```

The `## Grill findings` section lives in the issue body, not as a comment. Do not use `comment-issue.mjs` here — that creates a comment, not a body update.

**GitHub body size guard:** issue bodies are capped at 65,536 characters. Before writing back, check whether the updated body would exceed this limit. If so, warn: `Warning: updated body would exceed GitHub's 65,536-character limit — write-back skipped. Truncate the findings or the issue body manually.` Do not silently truncate.

**Local-planning write-back:** update the plan file in place using the edit tool.

## Output artifact format

The `## Grill findings` section written to the artifact:

```markdown
## Grill findings

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

Running `/loop-grill` twice on the same target must produce a single `## Grill findings` section, not two. The replace-section logic handles the already-present-section case. On the second run, if the gap set is identical to the first run, the section content is replaced with an equivalent section (same questions, same answers, updated timestamp).

## Non-goals

- Auto-triggering from `issue_intake` — this is on-demand only.
- Replacing or modifying the in-loop docs-grill (`docs/docs-grill-step.md`, `scripts/loop/docs-grill-contract.mjs`) — different concern, different firing surface.
- Full DDD `CONTEXT.md` management.
- Scheduling or storing grill runs — stateless and on-demand.
- Any CI/CD integration.
