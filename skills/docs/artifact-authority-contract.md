# Artifact authority contract

This document is the canonical authority for the artifact-selection model: when work originates from a GitHub issue (tracker-first) vs a persisted markdown plan file (local-planning).

This canonical owner lives in the shipped `skills/docs/` surface because installed skill/runtime consumers reliably own the skills subtree. In installed layouts, read the same contract via [Artifact Authority Contract](../docs/artifact-authority-contract.md) from the installed skill directory.

Other repo docs may summarize or link this contract, but they should not redefine it.

## Two-tier model

dev-loops supports two mutually exclusive artifact authority modes. Every work item must originate from exactly one authoritative artifact — a GitHub issue or a persisted markdown plan file. No work may originate from a PR or direct local change unless explicitly requested.

### Tracker-first (default)

**GitHub issues are the authoritative artifact store.** Work originates from a GitHub issue. A linked PR is the execution artifact. GitHub is the canonical source of truth for issue identity, acceptance criteria, scope, and lifecycle state.

Artifacts:
- **Planning artifact:** GitHub issue (title, body, labels, assignees, acceptance criteria)
- **Execution artifact:** GitHub PR (linked to issue; created during implementation)
- **No local duplicate:** Do not create `docs/phases/phase-<n>.md` for the same session when a GitHub issue is the canonical spec

Key contract:
- GitHub issue state is authoritative — not local notes or chat context
- A linked PR is the single canonical follow-up artifact for the issue
- When an open linked PR exists, reuse it rather than opening another
- Implementation may proceed through either the GitHub-first routed path or the local implementation strategy (see [Public Dev Loop Contract](public-dev-loop-contract.md) `targetPreference`)

### Local-planning (opt-out)

**Persisted markdown plan files are the authoritative artifact store.** Work originates from a markdown plan file committed to the repository. No GitHub issue is required. GitHub PRs are still used for review and merge, but the plan file is the canonical spec.

Artifacts:
- **Planning artifact:** Persisted markdown plan file (e.g., `docs/phases/phase-<n>.md`); its format and required base sections are defined in the [Plan-file Contract](plan-file-contract.md)
- **Execution artifact:** Local branch and associated GitHub PR (created during implementation)
- **No GitHub issue:** The plan file replaces the issue as the canonical spec

Key contract:
- The markdown plan file is the canonical spec — not a duplicate of a tracker issue
- GitHub issues may still be used for tracking or linking, but the plan file is authoritative for scope and acceptance criteria
- A tracker-backed local implementation session (GitHub issue as canonical spec) must not also maintain a duplicate `docs/phases/phase-<n>.md` — see [Public Dev Loop Contract](public-dev-loop-contract.md) "Tracker-backed local implementation input-source contract"

### Mode selection table

| Mode | Canonical artifact | GitHub issue required | Settings values |
|---|---|---|---|
| Tracker-first (default) | GitHub issue | Yes | `strategy.default: github-first` |
| Local-planning (opt-out) | Markdown plan file | No | `strategy.default: local-first` |

`inputSource.default` further disambiguates local-first startup:
| inputSource | Meaning |
|---|---|
| `tracker` (default) | Local agent implements from the GitHub issue body; no phase doc created |
| `phase-docs` | Local agent implements from persisted phase docs (e.g., `docs/phases/phase-<n>.md`) |

## Settings mechanism

Artifact authority mode is controlled by `.devloops` at repo root:

```yaml
# .devloops
strategy:
  default: github-first   # tracker-first (GitHub issue required)
  # default: local-first  # local-planning (markdown plan file)
inputSource:
  default: tracker        # spec source for local-first: tracker (issue body) or phase-docs
```

The `strategy.default` key serves dual purpose:
1. It selects the artifact authority mode (tracker-first vs local-planning)
2. It sets the default routing preference for `targetPreference` in dev-loop startup

The `inputSource.default` key disambiguates local-first startup:
- `tracker` (default): local agent implements from the GitHub issue body; the issue is canonical spec
- `phase-docs`: local agent implements from persisted phase docs; no tracker issue required

These keys are already defined in `.pi/dev-loop/defaults.yaml` (shipped with dev-loops) and may be overridden in `.devloops` (per-repo).

### Defaults resolution

1. `.pi/dev-loop/defaults.yaml` — shipped default (`github-first`)
2. `.devloops` — per-repo override (takes precedence)

### Explicit non-knobs

These are not valid artifact authority mode selectors:
- `strategy.default: copilot` — not a valid mode; must be `github-first` or `local-first`
- Free-form string values — fail closed
- Omitting `strategy.default` entirely — defaults to `github-first` from the shipped defaults

## dev-loops own mode

dev-loops is **tracker-first (opted in, GitHub backend).**

- **Mode:** Tracker-first
- **Settings:** `.pi/dev-loop/defaults.yaml` sets `strategy.default: github-first`
- **Artifact authority:** GitHub issues are the canonical spec for all work in this repository
- **No local-planning override:** This repo does not opt out to local-planning mode
- **Why tracker-first:** All work in this repo originates from GitHub issues. The public dev-loop contract, Copilot follow-up state machines, and gate pipeline all assume issues are the primary artifact. Self-improvement work on dev-loops itself follows the same tracker-first contract.

## Relationship to other docs

| Doc | Relationship |
|---|---|
| [Public Dev Loop Contract](public-dev-loop-contract.md) | This contract is the canonical entrypoint; artifact authority contract defines the artifact model it assumes |
| [Plan-file Contract](plan-file-contract.md) | Defines the plan-file format (phase-doc format) and its required base sections for local-planning mode |
| [Tracker-First Loop State](tracker-first-loop-state.md) | That doc defines the PR-level state machine for tracker-first PR workflows — it is about execution state, not artifact authority |
| [Main Agent Contract](main-agent-contract.md) | Defines the delegation boundary; artifact authority defines which artifacts govern work |
| AGENTS.md | Repo constitution; cites the work-origin rule and points to this contract |
| [Dev Loop Skill](../dev-loop/SKILL.md) | Public entrypoint skill; cites the work-origin rule and points to this contract |

### Distinction: artifact authority vs tracker-first PR workflow

`tracker-first-loop-state.md` defines a state machine for PR lifecycle management when a tracker item (e.g., Shortcut story) drives a GitHub PR. That is a **PR-level workflow contract**, not the artifact authority model. The term "tracker-first" in that doc refers to tracker-driven PR state transitions — it does not redefine the artifact authority contract defined here.

## Non-goals

- Defining tracker adapters or multi-tracker support
- Specifying how PRs map to issues in detail (that is the [Public Dev Loop Contract](public-dev-loop-contract.md))
- Changing the dev-loop startup resolver behavior
- Adding tracker-specific settings beyond `inputSource` — further tracker adapters or multi-tracker support remain out of scope
