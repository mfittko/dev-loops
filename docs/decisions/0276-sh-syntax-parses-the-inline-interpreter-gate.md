# 0276. The inline-interpreter Bash gate parses commands with sh-syntax

## Status

Proposed

This decision is provisional. The orchestrator took it on 2026-11-15 under the operator's overnight authorization, in [issue 2442 comment 6901538277](https://github.com/mfittko/dev-loops/issues/2442#issuecomment-6901538277). The operator may revert it. The record moves to Accepted when the operator confirms it or the implementing PR merges.

## Context

Source: [issue 2442](https://github.com/mfittko/dev-loops/issues/2442), `OPS-NO-INLINE-INTERPRETER`.

The gate decided from hand-written quote and segment models. Five consecutive `draft_gate` rounds on the replacement PRs found a command that main denied and the new parser allowed: line continuations, nesting caps, value flags, `case`, fd-prefixed heredocs and quote pairing (a quote inside a wrapper's env value swallowed the real head, review 5912982100 on PR 3217). The hand-written parser did not converge, and every heuristic that tried to tell data from code produced a new misfire.

The policy does not change. Operator decisions 1 to 5 of 2026-11-15 stand: the operator-owned write guards stay hard blocks, the inline-interpreter rule is a narrow closed list with an allow-by-default ceiling, and no case that main denied becomes allowed outside the listed ceiling cases. Only the tokenizing and segmenting layer under that policy changes.

## Decision

- The runtime dependency is `sh-syntax` 0.8.7, pinned exactly in `packages/core/package.json` (no caret). It is MIT licensed (mvdan/sh compiled to wasm) and 4.4 MB unpacked, of which `main.wasm` is 4.1 MB.
- The gate uses the documented synchronous Node entry, `sh-syntax/sync` (Bash variant). `decideBashGateDeny`, `commandContainsInlineInterpreter` and the Claude hook stay synchronous. The earlier note that the package is async only was wrong.
- `packages/core/src/loop/shell-ast.mjs` is a thin adapter. It loads the module with `createRequire` on the first parse, so importing `bash-command-classify.mjs` (the Pi extension, the CLI, the other predicates) loads no wasm. It returns `{ file }` or `{ error }` for a `ParseError` and rethrows every other error.
- The deny walks every simple command of the syntax tree: `$(...)` and backtick bodies, `<(...)`, function bodies, `case` arms, `coproc` and substitutions in an unquoted heredoc body. The head is read from the parsed word list after env assignments and wrappers. A quoted-delimiter heredoc body is text. String payloads (`bash -c`, `eval`, here-strings, `watch`, `trap`) stay ceiling cases that `check-retro-tooling` reports.
- A parse failure denies only when the raw text names a closed-list head (an interpreter, an in-place `sed` or `awk`, a `cat` or `tee` heredoc). The reason quotes the parse error and names the editor tools. Any other unparsable command is allowed as a ceiling case and listed by the retro report. This machine's shell is zsh, and a blanket deny would block legitimate zsh-only syntax with no exit, which `PURPOSE-STEER-NOT-TRAP` forbids. The decision narrows the first recommendation of the re-grill (deny every parse failure).
- The plugin source is `./.claude` from git, and its hooks run before any `node_modules` exists. `scripts/claude/generate-claude-assets.mjs` vendors the sync entry, its internal module, `vendors/wasm_exec.cjs`, `main.wasm` and `LICENSE` into `.claude/hooks/_vendor/sh-syntax/`, keeping the package layout, and emits `.claude/hooks/_shell-ast.mjs` with a relative specifier. `test/contracts/claude-assets-reproducible.test.mjs` compares the vendored files byte for byte, and an installed-plugin test runs the hook with no `node_modules`.
- Upgrade path: a new version is an explicit change. It edits the pin, reruns the generator, and must keep the shared fixture table (`test/fixtures/inline-interpreter-forms.mjs`) and the differential test green. The generator reads the internal module name from the sync entry, so a renamed bundle file needs no generator edit.

## Alternatives rejected

- Keep the hand-written parser. It did not converge (above).
- The async `sh-syntax` API with an async gate decision. The sync entry removes the need.
- `web-tree-sitter` with `tree-sitter-bash`: 4.5 MB plus a 1.4 MB grammar, the same shipping cost, and not smoke-tested.
- Resolve `sh-syntax` from the plugin's auto-installed `node_modules`. It adds no binary to git, but the deny stays off until the install runs.
- A text prefilter that skips the parse when no closed-list name appears. It would allow by word list, which the guard-classifier rule forbids.

## Consequences

- A 4.1 MB binary lives in git per `sh-syntax` version. It ships in the `dev-loops` npm tarball (`.claude/hooks/`) and again through `@dev-loops/core` in `node_modules`.
- The first parse costs a wasm load. On the PreToolUse hook (Node, `ls`), wall time rose from about 65 ms to about 95 ms.
- `sh-syntax` is a single-maintainer wrapper over mvdan/sh. The exact pin makes each upgrade explicit.
- Zsh-only syntax that names a closed-list head becomes a parse-failure deny. The reason quotes the parse error so the agent can rewrite the command.
- A hook that cannot load the vendored parser crashes, and Claude Code treats a crashed PreToolUse hook as a non-blocking error. The installed-plugin test guards a missing asset.
