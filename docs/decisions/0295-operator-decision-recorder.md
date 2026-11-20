# 0295. One operator decision recorder writes every operator-owned decision line

## Status

Accepted, 2026-11-20 ([issue 3300](https://github.com/mfittko/dev-loops/issues/3300), slice 1).

Amends [0258](./0258-operator-owned-line-registry.md) for the `approve merge`, `adr-tripwire:allow` and Copilot `operator` entries from slice 2 on. Record 0258 stays unedited.

## Context

Every operator decision that a gate needs on GitHub ends in a manual step today. The operator types a `!` command or posts a comment or body line in the GitHub UI. The Claude Code auto-mode classifier denies an agent post that relays an operator approval, so the loop deadlocks until the operator posts by hand. The operator and the agents share one GitHub credential, so a recorder comment already carries the operator's login and author association, and the existing readers accept a recorder-written line.

The operator wants only two interventions: an answer to the question tool and an approval of a permission prompt.

## Decision

One sanctioned command, `dev-loops-run cli/index.mjs decision record`, writes every operator decision comment. It posts one comment with a reason line, a `dev-loops:operator-decision` header (`kind`, `target`, `head`, `answer-sha256`), the quoted question and answer and the body. It needs an operator answer file that holds the question, the chosen option and the answer text as the question tool returned them. It refuses a missing or malformed answer file, an empty body, an answer or body that holds the `dev-loops:operator-decision` header marker (`reason: header_marker_in_input`), a PR target without `--head`, an issue target with `--head`, a head that is not the live head, a closed target, an issue target number that is a pull request and a non-Claude harness. It hashes the raw answer-file bytes into `answer-sha256`. A comment-guard refusal returns `reason: comment_guard_refused`. Slice 1 writes the record-only kinds `accept`, `exempt` and `defer`. `exempt` never relaxes a gate (issue 579) and `defer` never replaces a judge disposition. Slices 2 to 4 add `approve-merge`, `adr-allow` and `copilot-disposition`, the typed `operator_decision_required` next step and the approval-authority invariant with its retro check.

`OPERATOR-OWNED-LINE` changes in slice 2: the recorder becomes the only agent writer of the three operator-owned lines it writes, and it skips the refusal for its own kind's registry entry only. Every other entry and every other writer keeps refusing, and `approve release v<version>` stays human-only. Until then the recorder runs the comment guard on the whole comment, so an answer or body that holds an operator-owned line is refused.

The permission prompt is the shipped `permissions.ask` pair in `.claude/settings.json`:

- `Bash(dev-loops-run cli/index.mjs decision record *)`
- `Bash(dev-loops-run --repo-root * cli/index.mjs decision record *)`

The Claude Code permission documentation (https://code.claude.com/docs/en/permissions.md) states that a `*` can go anywhere in a Bash rule and matches any text including spaces, that `:*` is recognized only at the end of a pattern, that rules evaluate deny, then ask, then allow, and that an explicit ask rule prompts in default and auto mode. Absence from `permissions.allow` is not enough, because the shipped `Bash(dev-loops-run:*)` allow rule would cover the recorder and auto mode would run it without a prompt. The documentation says a mid-pattern `*` matches, but README.md records a live observation where it did not. The plain pattern is a pure prefix match. The `--repo-root` form stays denied by the hook, for every actor, until a live session verifies the mid-pattern match, and the hook message tells the main agent to run `dev-loops-run cli/index.mjs decision record ...` from the checkout. Both patterns still ship under `permissions.ask`. The patterns use the space form so they never mix a mid-pattern `*` with `:*`. A settings test pins both patterns, asserts that none sits under `permissions.allow` and matches sample commands under the documented semantics.

The Claude Bash hook fails closed. It denies the recorder from any subagent and every spelling other than the plain prefix form `dev-loops-run cli/index.mjs decision record ` with single spaces: the `--repo-root` form, `node`, `bun`, the `scripts/github/record-operator-decision.mjs` path under any runner, `.claude/bin/dev-loops-run`, bare `dev-loops`, quoted or escaped words, backslash-newline continuations and extra whitespace. The hook stops an instruction-following agent only: a wrapper file under the checkout, a shell function, `xargs` and a word built at run time are not judged. The canonical form also needs the whole command to be one shell segment, and a word of a `dev-loops-run`, `node`, `bun` or bare `dev-loops` segment outside `[A-Za-z0-9_./-]` that the shell could expand to the recorder (a shell-built word or a matching glob) is denied. `dev-loops status` merges the allow and ask lists of the project, local and user settings files. It reports a file whose `permissions.allow` names the recorder, and it reports missing ask rules when any allow rule covers the launcher (`Bash(dev-loops-run:*)`, `Bash(dev-loops-run *)`, `Bash(dev-loops-run)` or bare `Bash`).

Pi has no permission prompt and no Bash hook (issue 3033). The recorder runs only when `CLAUDECODE=1` is set. Under Pi it refuses with `reason: harness_without_permission_prompt` and names the fallback: the operator posts the line by hand. The Pi path stays manual until Pi has a per-call approval surface. A Pi session can set `CLAUDECODE=1` itself, so the harness check guards against accident only.

## Consequences

- A Claude Code session records `accept`, `exempt` and `defer` decisions without a `!` command, and the operator's approval is the permission prompt plus the answer file.
- The tool cannot prove that the answer file came from the question tool. The permission prompt and the posted record expose a forged answer after the fact.
- The recorder runs the comment guard before any GitHub call. The guard allows the target's own number and refuses every other bare `#N`, so the orchestrator phrases the question, the answer and the body without another bare reference.
- A consumer that adds a `permissions.allow` rule for the recorder turns the prompt off. `dev-loops status` reports it, and the hook still denies subagents and non-canonical spellings.
- The Pi path keeps its existing manual step, a known gap.
- Only the plain ask pattern is relied on. A consumer that runs the CLI some other way, or from another directory through `--repo-root`, gets a hook deny and runs the plain prefix form from the checkout.
