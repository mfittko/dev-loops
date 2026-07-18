# AGENTS.md

## Repo contract
- `dev-loop` is the single public workflow entrypoint.
- For routed work, run `dev-loops loop startup ...` first, then load only the returned `requiredReads`.
- Canonical workflow docs live under `skills/docs/`.

## Working rules
- Main agent: read-only for all files tracked by the repository. All mutations flow through `dev-loop` async subagent. `skills/docs/main-agent-contract.md` is a mandatory baseline read alongside AGENTS.md (intentional exception to requiredReads-only loading for routed work; it defines the absolute delegation boundary that applies in all sessions).
- No direct commits to `main`; use feature branches, worktrees, and PRs.
- Use `tmp/worktrees/<issue-or-branch-slug>/` for mutating local work; keep the main checkout for inspection.
- Always run `git fetch origin` before creating or reusing a worktree — never create from a stale `origin/main`.
- Canonical guidance lives in `skills/docs/worktree-guidance.md`.
- Prefer the GitHub-first routed path for branch/PR/CI/review work; use local implementation only when explicitly requested.
- Use `npm run verify` as the default local validation path.
- When creating GitHub issues via `gh issue create`, always include `--assignee @me` so the new artifact is self-assigned.
- When creating PRs in this repo, use the canonical `dev-loops pr create ...` path (always draft, self-assigned by default; `--assignee @me` is the default) — never raw `gh pr create`.
- Never start implementation (file mutation, branch creation, PR creation) without explicit instruction. "Queue," "add to list," "track," "note" are NOT implementation triggers. Only proceed when the user says "start," "go," "implement," "do it," "work on," or equivalent imperative. Confirm if unsure.
- All work must originate from a tracked artifact: a GitHub issue (tracker-first), a persisted markdown plan file (local-planning), or — on the sanctioned lightweight path — the PR description itself as the spec-of-record (`--lightweight`, `canonicalSpecSource: pr_body`; no committed plan artifact). See [Artifact Authority Contract](skills/docs/artifact-authority-contract.md) for canonical mode definitions and settings. No work may originate from a PR (other than the sanctioned lightweight PR-body-as-spec path) or a direct local change unless explicitly requested.
- Implement one phase at a time; if durable repo docs explicitly record a reprioritization exception, follow [Implementation State](docs/IMPLEMENTATION_STATE.md) and the active phase doc.
- Keep compatibility surface minimal; do not add legacy aliases, wrappers, or duplicate docs unless explicitly requested.
- A question requires an answer, not an action. When the user asks a question — even one implying criticism or correction — answer first before taking any action. Do not treat a question as implicit authorization to act.
- Keep workflow procedure out of AGENTS; put shared contracts under `skills/docs/`. Brief, high-signal main-agent dispatch contracts (e.g., sequential dispatch) are the narrow exception — they stay in AGENTS.md because AGENTS.md is the canonical main-agent instruction surface.
- No PR scope has gate exemptions (#579): see skills/dev-loop/SKILL.md "No gate exemptions" section.
- **Sequential dispatch contract (#693):** When the user says "sequential", "one at a time", "serially", or "in order" with multiple `dev-loop` targets, the main agent must dispatch `dev-loop` async subagents one at a time — each blocking on prior completion before the next starts. This is deterministic: the keyword must always produce serial execution, never concurrent. The main agent is the sequencer; do not dispatch all targets at once.
- **Harness-agnostic non-regression (#1086):** dev-loops is harness-agnostic (Pi + Claude Code). Any harness-specific change MUST NOT regress other harnesses — add/keep cross-harness regression coverage. Canonical procedure: [Cross-Harness Regression Contract](skills/docs/cross-harness-regression-contract.md).
