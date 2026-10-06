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
| One distinct name `judge` | Pull line only |
| One distinct name `review` | Pull line plus read and search forms |
| One distinct name, another roster role | Unrestricted |
| Blank name, an unknown `dev-loops:` name, or two different names | Pull-only |
| A bare name outside the roster (`reviewer`, `worker`, `scout`) | Unrestricted, as on Claude Code |

The judge may run only the sanctioned `pull-work-order.mjs` line. The Pi judge reads and searches with the shell-free builtins `read`, `grep`, `find` and `ls`: `TOOL_NAME_MAP_PI` maps `search` to `grep`, `find` and `ls`. The reviewer may also run shell-inert read and search commands. Reviewer words are unquoted, fully single-quoted or fully double-quoted, and one trailing `| cut -c<N>-<M>` is allowed. Both roles are denied test and build commands. The `gate-coordinator` role is not restricted on Pi. Known limitation: the bash gate does not bound the reviewer's own `write` and `edit` tools, which can author a script that an allowed `dev-loops-run` line then runs. `test/extension-pi-readonly-role-gate.test.mjs` pins the Pi fixtures, the parity of the Pi pull matcher with `parseSanctionedPullLine`, and the agreement of the source agents, generated `.claude` assets and Pi mapping.

The `tool_call` handler only fires when the dev-loops extension is loaded in the *calling* session, and pi-subagents never loads ambient extensions into a foreground (`async: false`) child — the shipped gate fan-out shape. Resolving the role from the `active_agent` tag is therefore necessary but not sufficient on its own: `extension/required-child-extensions.ts` registers the extension itself as a required child extension for its own session (`pi-subagents/required-child-extensions`, on `session_start`, disposed on `session_shutdown`), so every child of a dev-loops session loads the same `tool_call` handler and resolves its own tag. The registration is requested with `requireForAllRunners`, so a placement that cannot load the extension (an external CLI/job runner or a remote machine) is refused instead of running ungated; that flag exists from pi-subagents 0.75, and on 0.68–0.74 the older non-mandatory form is retried and still gates every native child. The registration API itself (`pi-subagents/required-child-extensions`) exists only from pi-subagents 0.68: below that floor the subpath does not resolve, the extension is never registered, and the child runs without the `tool_call` gate. The `pi-subagents` import is a guarded optional import resolved from bounded `node_modules` roots, so an environment without pi-subagents — including the Claude Code harness, which never loads this file — is unaffected. `test/extension-pi-required-child-extensions.test.mjs` pins the bounded root resolution, the registration shape and the `session_start`/`session_shutdown` wiring; the live Pi dispatch smoke in the PR records the end-to-end gate.

The default container image keeps its `pi-subagents` pin (`Dockerfile` `PI_SUBAGENTS_VERSION`) at or above the 0.75 mandatory-runner floor. A pin below the 0.68 registration floor leaves `pi-subagents/required-child-extensions` unresolvable, so a dispatched judge or reviewer child in that image would run ungated; `test/extension-pi-required-child-extensions.test.mjs` fails closed on such a pin.

A read-only child loads the whole extension, so the extension keeps its mutation-capable post-merge hooks (`tool_result`, `user_bash`, `agent_end`) inert in any read-only session — a restricted role or the unresolved fail-closed role. `isMergeCapableCommand` splits shell segments without quote awareness, so a reviewer's allowed read form such as `grep '; gh pr merge 42 ;' README.md` would otherwise be misread as a merge and queue post-merge updates, main-checkout sync and cleanup even though no merge ran. The `tool_call` gate already denies a read-only session any real merge, so those hooks have nothing legitimate to do there. `test/extension-pi-readonly-role-gate.test.mjs` pins the inert hooks.

## Non-goals

- No new or expanded CI matrix: `bun run verify` (which CI runs on every pull request) already covers `test:assets`, `test:extension`, `test:scripts`, `test:core`, `test:docs`, and `test:dev-loop`. Only `bun run smoke:headless` stays manual/local-only.
- No bespoke cross-harness enforcement script: the named suites that CI runs on every pull request satisfy the coverage bar.
- No rewriting of existing harness-specific code as part of adopting this contract.

## Cross-references

- [AGENTS.md](../../AGENTS.md)
- [Dev Loop Skill](../dev-loop/SKILL.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
