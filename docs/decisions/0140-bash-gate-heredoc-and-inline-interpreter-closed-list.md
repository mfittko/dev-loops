# 0140. Bash gate: heredoc bodies are data and the inline interpreter list is closed

## Status

Accepted — 2026-10-12 ([issue 2442](https://github.com/mfittko/dev-loops/issues/2442))

## Context

`OPS-NO-INLINE-INTERPRETER` in [copilot loop operations](../../skills/docs/copilot-loop-operations.md) bars inline interpreters and Bash file writes. The Bash gate and the retro checker matched these forms with separate, loose patterns. Heredoc bodies were scanned as commands, so prose that named `node -e` produced false denials. Equivalent forms (`perl -0pi -e`, `ruby -e`, `sed --in-place`, `awk -i inplace`, a `cat` heredoc write followed by running the written file) passed.

## Decision

- Text inside a `cat` or `tee` heredoc body is data. The matcher never scans it for commands.
- The denied forms are a closed list in four classes: inline code or a stdin heredoc to `node`, `bun`, `python`, `python3`, `perl` or `ruby`; in-place editors (`sed -i`/`--in-place`, `perl -i`, `ruby -i`, `awk -i inplace`); a `cat`/`tee` heredoc write whose target is not a temp path; and running, in the same command, a file that a heredoc wrote. A form outside the list is allowed until a new decision extends the list.
- A quoted literal is inert. The exceptions are the payload of `-c`, `--command` and `eval`, and a double-quoted `$(` or backtick substitution, which the matcher still inspects.
- The Bash gate and the retro matcher in `scripts/loop/check-retro-tooling.mjs` share one predicate, `commandContainsInlineInterpreter`. One fixture table, `test/fixtures/inline-interpreter-forms.mjs`, drives both suites.
- The [main agent contract](../../skills/docs/main-agent-contract.md) passages on Bash-driven tracked mutations now cite `OPS-NO-INLINE-INTERPRETER` for `sed -i` and cat/tee heredoc writes.

## Consequences

Prose that mentions an interpreter no longer trips the gate, and the listed equivalent forms are denied. The gate and the retro checker cannot drift, because both run the same predicate and fixtures. Extending the list needs a new ADR that amends this one.
