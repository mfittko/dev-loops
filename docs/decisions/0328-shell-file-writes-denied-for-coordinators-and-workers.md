# 0328. The Claude Bash gate denies shell file writes for coordinators, developers and fixers

## Status

Accepted — 2026-11-26 ([issue 2683](https://github.com/mfittko/dev-loops/issues/2683)).

Amends [0080](./0080-coordinator-worker-delegation-boundary.md) ceiling 1 ("Bash-driven tracked-file mutations ... remain convention-enforced") for the roles and write forms below. ADR 0080 stays unedited.

## Context

The Write/Edit guards deny a coordinator's tracked-file edit and a fixer's edit outside its pull grant. The Bash gate denied no shell write to a repository file, so agents wrote files with `sed -i`, redirects, heredocs, `cp` and throwaway scripts, and no hook refused it. The issue lists at least 15 retro findings since PR 2675, one landed edit on `main` (PR 3194) and a coordinator that wrote two tracked files with a `tmp/` Node script (issue 3395 lane). `agents/fixer.agent.md` already forbade the writes in prose, and fixers broke it anyway.

## Decision

1. `shellWriteTargets(command)` in `bash-command-classify.mjs` returns each write target of a command with its operation (`write`, `copy`, `remove`, or `run` for a `tmp/` script). It reads redirects, `tee`, `sed -i`, `perl -i`, `cp`/`mv`/`rm` operands and payload words, joins a relative target to the last literal `cd`, and marks a word with `$`, a backtick, a glob character or `~` as unresolvable unless the word is fully single-quoted (a literal path). Its `copy` entries carry `sources`, the `cp`/`mv` source words.
2. The Bash hook resolves each target against its cwd and classifies it with `classifyRepoMutation` in `worktree-guard.mjs`, the same function the Write guard uses: a repo mutation is inside a repository working tree and not gitignored, or under a `.git` segment. An unknown ignore status counts as a mutation.
3. `decideBashGateDeny` applies a role table as its last rule, `OPS-EDITOR-TOOL-WRITES`. A coordinator (`dev-loop`, `gate-coordinator`, under `DEVLOOPS_COORDINATOR_READONLY=1`) is denied a repo-mutating write or copy, the removal of an existing file and a `tmp/` script run, with the `COORDINATOR_DELEGATION_BOUNDARY` reason. A removal counts an existing directory like an existing file, and a `tmp/` script is one under the `tmp/` of its own repository (an absolute path, a `cd` join and flag values are read). A developer or fixer (always on, with or without a pull grant) is denied a repo-mutating write, a copy over an existing file (a directory destination resolves to `<dir>/<basename(source)>`) and a copy under a `.git` segment, with the `OPS-EDITOR-TOOL-WRITES` reason. A worker copy or rename to a new path and a worker `rm` stay allowed (`WORKTREE-NONINTERACTIVE-FILE-OPS`). An unresolvable target is denied, except for a worker `rm`; a glob or `$` copy source into an existing directory makes the target unresolvable. The hook fails closed when classifying a target throws.
4. `commandContainsCodeVerificationEntrypoint` also matches `dev-loops-run [--repo-root <wt>] scripts/run-bun-test.mjs`.
5. A command with no write target is never denied by this rule. `git apply`, `patch`, `git checkout -- <path>`, package managers and scripts under `scripts/` or `cli/` that write files stay outside the classifier.

The deny is Claude-only. Pi stays convention-only: its `readonly-role-gate` restricts only `judge` and `review`, all evidence is from Claude lanes, and Pi's role gate has no write-target model. A Pi adapter that supplies no `shellWrites` fact never denies.

## Consequences

Agents write repository files with Edit and Write. A false positive is a command that holds a write form the classifier reads (a double-quoted glob in a real file name, for example); the deny names its recovery. The ceiling stays open for the forms in decision 5, for a `cd` inside a `( ... )` group, and for these shortcuts of the classifier: `pushd`, `awk -i inplace`, `>(...)` process substitution, `cp -t DIR`, `dd of=`, `install`, `ln` and `touch` are not read. Revert by removing `decideShellWriteDeny` and the hook's `shellWrites` fact.
