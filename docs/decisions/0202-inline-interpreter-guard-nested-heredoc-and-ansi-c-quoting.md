# 0202. The inline-interpreter guard fails closed on nested heredocs and reads ANSI-C quoted words

## Status

Accepted — 2026-10-28 ([PR 2967](https://github.com/mfittko/dev-loops/pull/2967))

Amends the matcher scope of [0193](./0193-retro-check-uses-shared-interpreter-matcher.md): the retro tooling check now runs the shared matcher on every segment before its head dispatch, so it also reports `python`/`python3` inline forms inside `$(...)` or backticks.

## Context

Issue [2943](https://github.com/mfittko/dev-loops/issues/2943) reported inline interpreter forms that the `OPS-NO-INLINE-INTERPRETER` guard (`commandContainsInlineInterpreter` in `packages/core/src/loop/bash-command-classify.mjs`) did not refuse.

The guard blanks literal text before it scans for `$(` and backtick substitutions. Literal text includes heredoc bodies, single-quoted spans, and escaped characters. The heredoc regexes consume one heredoc per operator. A second heredoc on one line or an unusual delimiter left an operator unconsumed, and the blanking could then hide a live substitution.

The tokenizer did not know bash ANSI-C quoting. A `$'...'` option value with spaces split into several tokens, so the flag and stdin checks saw the wrong words.

The retro tooling check (`scripts/loop/check-retro-tooling.mjs`) dispatched on the segment head first. An allowed head such as `gh pr ready 5 $(node -e 1)` hid the substitution from the shared matcher.

## Decision

- Unconsumed heredoc. The guard counts heredoc operators that have a later newline, after quoted-delimiter and unquoted-delimiter heredoc bodies are removed. When that count exceeds the number of consumed heredocs, the guard scans the raw command text (fail closed).
- Single-line mention. An operator with no later newline has no body to hide, so it does not trigger the raw-text fallback.
- ANSI-C quoting. The tokenizer treats a `$'...'` span as one word and removes its backslash escapes, as bash does, before the flag and stdin checks.
- Retro check. `check-retro-tooling.mjs` calls `commandContainsInlineInterpreter` on each raw segment before head dispatch. A hit is reported with the `node inline`, `python3` or `python` label. `skills/docs/retrospective-checkpoint-contract.md` names the substitution forms.

## Consequences

A nested or second heredoc can no longer hide an inline interpreter from the guard. The fallback can over-report on a multi-line command that quotes `<<`; that direction is accepted.

A `$'...'` quoted flag value no longer shifts the guard's token positions.

The retro check and the guard agree on substitution forms for node and python. The guard remains a token-level matcher. The forms named in its `ponytail:` ceiling comment stay outside this decision.
