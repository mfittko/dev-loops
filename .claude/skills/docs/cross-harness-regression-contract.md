# Cross-Harness Regression Contract

Canonical owner for harness-agnostic non-regression across Pi and Claude Code.

## What counts as a harness-specific change

A change is harness-specific when it touches a seam that branches by runtime harness (Pi vs Claude Code), including:

- Runner coordination (`scripts/loop/pr-runner-coordination.mjs`, `scripts/loop/_pr-runner-coordination.mjs`)
- Run-id injection / async-start semantics (`packages/core/src/loop/async-start-contract.mjs`, `packages/core/src/loop/run-context.mjs`)
- Subagent / Task fan-out tool provisioning
- Harness-specific environment variables (`PI_SUBAGENT_RUN_ID`, `DEVLOOPS_RUN_ID`)
- Session/intercom wiring
- TUI behavior
- Any capability detection or `process.env` branch whose outcome differs per harness

## Required cross-harness test coverage

Every harness-specific change MUST add or keep a test that exercises the path of the harness it does not directly target. A pull request that alters behavior on one harness without any test evidence for the other harness fails this contract.

## The additive/no-op bar

State the bar symmetrically, in both directions:

- A change additive on Pi MUST be a no-op on Claude Code, or its effect on Claude Code MUST be explicitly validated by a test.
- A change additive on Claude Code MUST be a no-op on Pi, or its effect on Pi MUST be explicitly validated by a test.

Definitions:

- **No-op**: the existing test suite for the other harness passes unmodified — no assertion needed to change, no new test required, because the seam does not fire for that harness.
- **Explicitly validated**: a new or updated test directly asserts the other harness's resulting behavior (not merely "did not throw"), covering both the case where the seam is inert and the case where it participates.

## Claude-Code-path test inventory

When a change targets a Claude-Code-specific seam, the following suites are the baseline that MUST stay green, and are the first place to add coverage for a Pi-originated change that MUST NOT regress Claude Code:

- `bun run test:assets` — runs `test/contracts/*.test.mjs`, including `test/contracts/claude-assets-reproducible.test.mjs`, `test/contracts/claude-headless-smoke.test.mjs`, `test/contracts/claude-plugin-manifest.test.mjs`, `test/contracts/claude-plugin-marketplace.test.mjs`, `test/contracts/claude-hooks-settings.test.mjs`, and `test/contracts/cli-harness-agnostic.test.mjs`
- `bun run smoke:headless` — runs `scripts/claude/headless-info-smoke.mjs` on the supported Node runtime; this is a manual/local-only check, not part of `bun test` or `bun run verify` and not run by CI — run it directly when a change touches Claude Code headless-info behavior
- `bun run test:core` — runs `packages/core/test/*.test.mjs`, including `packages/core/test/claude-headless-entry.test.mjs`, `packages/core/test/claude-hook-decisions.test.mjs`, `packages/core/test/run-context.test.mjs`, `packages/core/test/async-start-contract.test.mjs`

Symmetrically, for a change targeting the Claude-Code-specific seam that MUST NOT regress Pi, `bun run test:extension` (which runs `test/extension-*.test.mjs`, including `test/extension-pi-adapter.test.mjs`, the Pi-side adapter inventory) is the baseline suite to check and extend.

## How to add coverage

1. Identify the harness-specific seam the change touches (see the surface list above).
2. Locate the existing test file that already covers that seam for the harness being changed, and its counterpart for the other harness (from the inventory above, or the nearest analogous file).
3. Add or extend a test asserting the other harness's behavior directly — do not rely on an untested assumption that the change is inert there.
4. Run the relevant suite locally (`bun run test:assets`, `bun run test:core`, `bun run test:extension`, or `bun run smoke:headless` as applicable) before opening the pull request.

## Read-only role enforcement on Pi

The judge boundary is enforced on both harnesses. The reviewer boundary is enforced on Pi only. Claude Code enforces the judge boundary in the PreToolUse Bash gate (`decideBashGate`), which gates only the judge. Pi enforces the judge and reviewer boundaries in the `tool_call` handler in `extension/readonly-role-gate.ts`. The handler resolves the role on every call from the calling session's own `ctx.getSystemPrompt()`. The role marker is the `active_agent` tag with a `name` attribute that pi-subagents writes into each named child's system prompt. The marker value is the `name` frontmatter of `agents/*.agent.md`. dev-loops sets no env marker. The untagged row is additionally scoped to the calling session: the handler consults `ctx.getSessionId()` against the native-async marker pair, so a lone `PI_SUBAGENT_CHILD=1`, a blank `PI_SUBAGENT_PARENT_SESSION`, an absent or blank calling session id, or a calling session whose own id equals the recorded parent marker stays the unrestricted main agent. Resolution is fail closed:

| Input | Resolved behavior |
|---|---|
| No tag, not a native async child session | Main agent, unrestricted |
| No tag, native async child session (`PI_SUBAGENT_CHILD=1` plus a non-blank `PI_SUBAGENT_PARENT_SESSION`, and a non-blank calling session id that differs from the parent marker) | Pull-only |
| One distinct name `judge` | Pull line plus the `check-judge-decision.mjs` line |
| One distinct name `review` | Pull line plus read and search forms |
| One distinct name, another roster role | Unrestricted |
| Blank name, an unknown `dev-loops:` name, or two different names | Pull-only |
| A bare name outside the roster (`reviewer`, `worker`, `scout`) | Unrestricted, as on Claude Code |

The judge may run only the sanctioned `pull-work-order.mjs` line and the `check-judge-decision.mjs --file` line (a `tmp/gate-judge/` path, no `..`, no chaining). The Pi judge reads and searches with the shell-free builtins `read`, `grep`, `find` and `ls`: `TOOL_NAME_MAP_PI` maps `search` to `grep`, `find` and `ls`. The reviewer may also run shell-inert read and search commands. Reviewer words are unquoted, fully single-quoted or fully double-quoted, and one trailing `| cut -c<N>-<M>` is allowed. That read/search decision comes BEFORE the shared Bash-gate deny, whose segment classifiers split shell text without quote awareness: a quoted search text that spells a gated verb (`grep '; gh pr merge 42 ;' README.md`) stays a read, because a command carrying an unquoted shell-active character is never a read/search form at all. Both roles are denied test and build commands. The `gate-coordinator` role is not restricted on Pi. Known limitation: the bash gate does not bound the reviewer's own `write` and `edit` tools, which can author a script that an allowed `dev-loops-run` line then runs. `test/extension-pi-readonly-role-gate.test.mjs` pins the Pi fixtures, the parity of the Pi pull matcher with `parseSanctionedPullLine`, and the agreement of the source agents, generated `.claude` assets and Pi mapping.

The `tool_call` handler only fires when the dev-loops extension is loaded in the *calling* session, and pi-subagents never loads ambient extensions into a foreground (`async: false`) child — the shipped gate fan-out shape. Resolving the role from the `active_agent` tag is therefore necessary but not sufficient on its own: `extension/required-child-extensions.ts` registers the extension itself as a required child extension for its own session (`pi-subagents/required-child-extensions`, on `session_start`, disposed on `session_shutdown`), so every child of a dev-loops session loads the same `tool_call` handler and resolves its own tag. The registration is requested with `requireForAllRunners`, so a placement that cannot load the extension (an external CLI/job runner or a remote machine) is refused instead of running ungated; that flag exists from pi-subagents 0.75, and on 0.68–0.74 the older non-mandatory form is retried and still gates every native child. The registration API itself (`pi-subagents/required-child-extensions`) exists only from pi-subagents 0.68: below that floor the subpath does not resolve, the extension is never registered, and the child runs without the `tool_call` gate. The `pi-subagents` import is a guarded optional import resolved from bounded `node_modules` roots, so an environment without pi-subagents — including the Claude Code harness, which never loads this file — is unaffected. `test/extension-pi-required-child-extensions.test.mjs` pins the bounded root resolution, the registration shape and the `session_start`/`session_shutdown` wiring; the live Pi dispatch smoke in the PR records the end-to-end gate.

The default container image keeps its `pi-subagents` pin (`Dockerfile` `PI_SUBAGENTS_VERSION`) at or above the 0.75 mandatory-runner floor. A pin below the 0.68 registration floor leaves `pi-subagents/required-child-extensions` unresolvable, so a dispatched judge or reviewer child in that image would run ungated; `test/extension-pi-required-child-extensions.test.mjs` fails closed on such a pin.

A read-only child loads the whole extension, so the extension keeps its mutation-capable post-merge hooks (`tool_result`, `user_bash`, `agent_end`) inert in any read-only session — a restricted role or the unresolved fail-closed role. `isMergeCapableCommand` splits shell segments without quote awareness, so a reviewer's allowed read form such as `grep '; gh pr merge 42 ;' README.md` would otherwise be misread as a merge and queue post-merge updates, main-checkout sync and cleanup even though no merge ran. The `tool_call` gate already denies a read-only session any real merge, so those hooks have nothing legitimate to do there. `test/extension-pi-readonly-role-gate.test.mjs` pins the inert hooks.

## Bash-gate deny rules on Pi

Issue #2965 (`docs/decisions/0206-one-shared-bash-gate-deny-decision.md`). Both harnesses call one harness-neutral deny decision, `decideBashGateDeny` in `packages/core/src/loop/bash-gate-decisions.mjs`, so a Bash-gate rule cannot hold on Claude Code and fail open on Pi. The shared module is pure: each adapter injects its own facts. The Claude adapter gathers them in `.claude/hooks/pre-tool-use-bash-gate.mjs` and decides through `packages/core/src/claude/hook-decisions.mjs`. The Pi adapter resolves them in `extension/bash-gate-facts.ts` and decides through `extension/readonly-role-gate.ts`: repo root and slug from `git rev-parse --show-toplevel` and `git config --get remote.origin.url`, the `.devloops` presence probe at that root, `autonomy.humanMergeOnly` from `loadDevLoopConfig` plus `resolveHumanMergeOnly`, the role from the calling session's `active_agent` tag, and the `gh pr ready` draft-gate probe. Every injected fact is REQUIRED: `decideBashGateDeny` refuses a call that omits or mistypes one (`role`, `repoSlug`, `managedRepoSlug`, `inManagedContext`, `humanMergeOnly`, `enforceCoordinator`) with a fail-closed deny instead of defaulting it, because a permissive default switches off the rule it backs — `humanMergeOnly: false` fails STOP-HUMAN-MERGE-001 open — and the omission is invisible at the call site. `readyGate` stays explicitly nullable, because `null` is its meaningful "not probed" value, which still gates a ready verb. Those facts are cached per resolved cwd and revalidated on every call against a signature of the repo's own config sources — both repo-local layers the loader reads (`.devloops` and `.pi/dev-loop/defaults`), each probed in the loader's own exported `CONFIG_FILE_VARIANTS` order with every present file digested by its bytes — so an edit to one of those files is never served from the cache, not even a same-size rewrite inside one filesystem timestamp tick, and a variant the loader starts probing cannot leave the cache blind to it. That signature does not cover the packaged `extension-defaults` layer the loader always merges, nor the git remote URL the slug derives from. An unresolved cwd (not a repo) is not cached at all, so a directory that becomes a managed repo later is re-probed on the next call. The `gh pr ready` probe runs the dev-loops package's own `scripts/loop/pre-pr-ready-gate.mjs`, resolved from the extension's module location, with the calling repo as cwd: a managed consumer repo that ships no `scripts/loop/` of its own is not denied for the probe's absence.

`BASH_GATE_RULES` in the shared module is the pinned verdict list: every rule carries its Pi verdict, and `test/contracts/bash-gate-pi-parity.test.mjs` asserts this table lists exactly those rule IDs in that order with the matching verdict, that every rule ID the shared decider returns in its own source appears in that list, and that every listed ID stays registered in `skills/docs/required-rules.json`, so the list can neither grow silently nor shrink silently. A new deny rule therefore cannot be added without stating its Pi verdict here.

| Rule | Claude Code | Pi | Why the Pi verdict holds |
|---|---|---|---|
| `COORDINATOR-VERIFY-BOUNDARY` | Denies inline code-verification and build commands from the dev-loop coordinator and the gate coordinator | enforced | The shared seam's own `enforceCoordinator` branch runs on Pi, reached through `decideBashGateDeny` from `extension/readonly-role-gate.ts` (`test/extension-pi-bash-gate.test.mjs` drives it through the real handler): opt-in flag `DEVLOOPS_COORDINATOR_READONLY=1` in the Pi process environment, with the role from the `active_agent` tag |
| `OPS-NO-INLINE-INTERPRETER` | Denies inline interpreters and a heredoc fed to one | enforced | Command shape only, scoped by the managed-context fact from the `.devloops` probe at the resolved repo root |
| `COPILOT-FOLLOWUP-WAIT-TOOLS` | Denies detached, poll-loop and backgrounded wait wrappers | enforced | Command shape, scoped by the managed-context fact from the resolved repo root |
| `SUBISSUE-NO-ADHOC-BYPASS` | Denies ad-hoc `gh api` sub-issue writes | enforced | Command shape, scoped by the managed repo slug from `git config --get remote.origin.url` |
| `COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER` | Denies ad-hoc thread-reply and thread-resolve mutations | enforced | Command shape, scoped by the managed repo slug from `git config --get remote.origin.url` |
| `COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY` | Denies ad-hoc Copilot review requests and summon comments | enforced | Command shape, scoped by the managed repo slug from `git config --get remote.origin.url` |
| `ADR-TRIPWIRE-STANDING-WAIVER` | Denies raw PR and issue body writes | enforced | Command shape, scoped by the managed repo slug from `git config --get remote.origin.url` |
| `WORKTREE-NO-STASH` | Denies `git stash` | enforced | Command shape, scoped by the managed-context fact from the resolved repo root |
| `STOP-HUMAN-MERGE-001` | Denies `gh pr merge` outright when the repo sets `autonomy.humanMergeOnly` | enforced | `loadDevLoopConfig` plus `resolveHumanMergeOnly` at the resolved repo root, the same loader the Claude hook's `resolve-human-merge-only.mjs` helper runs |
| `OPS-DRAFT-FIRST-PR` | Denies a raw `gh pr create` outside the canonical `create-pr.mjs` wrapper | enforced | Command shape, scoped by the managed-repo facts |
| `RAW-GH-PR-MERGE-BYPASS` | Denies a raw `gh pr merge` outright | enforced | Command shape, scoped by the managed-repo facts, for every role including the untagged main agent |
| `GATE-COMMENT-DRAFT-REQUIREMENTS` | Denies `gh pr ready` without clean draft-gate evidence | enforced | The draft-gate probe: for a ready verb in a managed repo the Pi adapter runs `node scripts/loop/pre-pr-ready-gate.mjs --repo <slug> --pr <number>` and fails closed on a failed probe or an unreadable PR number |

Two further Claude Bash-gate denials are not rows above: the `timeout`-wrapped sanctioned-command deny and the subagent ad-hoc external-write deny. Both are inline denials whose message names no registry rule, so naming them here would mint rule IDs the rule registry (`skills/docs/required-rules.json`) does not own. They live in the shared module and deny identically on Pi, for every role, on the same facts.

### Claude-edge Bash-gate rules outside the shared module

Two Claude-edge rules stay in the Claude PreToolUse seam because they key on Claude role machinery. Both are covered here instead of in the table above, and neither is a rule the shared module owns:

- The `judge` command restriction: enforced on Pi by the existing read-only role gate (#2509) in `extension/readonly-role-gate.ts`, not by the shared module. The Pi judge is held to the same sanctioned pull line and the same `check-judge-decision.mjs` line, resolved from the `active_agent` tag.
- The `fixer` sanctioned-pull-line and grant-binding boundary: Claude-only, and an accepted, pre-existing carve-out — it predates the shared deny decision. The grant binding is keyed on the Claude hook's `agent_id`, which the Pi `tool_call` payload does not carry. On Pi the fixer is an unrestricted roster role, so only the shared deny set and the managed-repo scope bound it.

## Project agent set on Pi

`.pi/agents` is an untracked, gitignored directory (decision record 0173, amending the layout convention from issues 1606 and 1655). `provision-worktree.mjs` renders the Pi-valid copies of `agents/*.agent.md` into it on worktree create and reuse. The `tool_call` handler runs the `agent_set_not_rendered` check only in a dev-loops checkout and reads nothing in any other repo. There it refuses a `subagent` launch when a file the render itself writes (a `*.agent.md` name found in the packaged agents source directory) still lists `search` or `execute`. No global copy is checked (operator decisions: https://github.com/mfittko/dev-loops/issues/2865#issuecomment-6299207997 and https://github.com/mfittko/dev-loops/issues/2865#issuecomment-6300286134). The Pi `session_start` handler also renders `.pi/agents` from `agents/` when the project root is a dev-loops checkout (`package.json` names `dev-loops` and an `agents/` directory exists). The project root is the nearest ancestor of the launch cwd holding a `.pi` or `.agents` directory (the walk Pi uses; `.git` does not stop it, the home directory does: `~/.pi` and `~/.agents` never make it a project), else the launch cwd. Never restore a symlink at `.pi/agents`. The `agent_set_not_rendered` preflight cannot read Pi's project-trust state, so it cannot tell whether Pi loads the project agents in `.pi/agents`; its refusal text says so. The sources keep the neutral vocabulary and the Claude assets are unchanged.

## Non-goals

- No new or expanded CI matrix: `bun run verify` (which CI runs on every pull request) already covers `test:assets`, `test:extension`, `test:scripts`, `test:core`, `test:docs`, and `test:dev-loop`. Only `bun run smoke:headless` stays manual/local-only.
- No bespoke cross-harness enforcement script: the named suites that CI runs on every pull request satisfy the coverage bar.
- No rewriting of existing harness-specific code as part of adopting this contract.

## Cross-references

- [AGENTS.md](../../AGENTS.md)
- [Dev Loop Skill](../dev-loop/SKILL.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
