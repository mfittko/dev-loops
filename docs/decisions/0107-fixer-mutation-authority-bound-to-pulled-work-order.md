# 0107. The fixer mutates only within its pulled work order's authority

## Status

Accepted — 2026-09-28 ([issue #2420](https://github.com/mfittko/dev-loops/issues/2420))

Amends [ADR 0106](./0106-workers-pull-deterministic-work-orders.md): the fixer registers its role adapter on the pull protocol, and a current fixer pull now also bounds what the fixer may mutate. The rest of ADR 0106 stays unchanged.

## Context

ADR 0106 moved the gate reviewer onto compact dispatch and left the fixer for a later slice. The fixer still received a prose brief. Its disposition handoff reached `verify-fixer-disposition.mjs` through caller-supplied `--dispositions` or `--dispositions-file` inputs. Nothing tied a fixer's edits, commits or pushes to the task it was given. Nothing tied the handoff to a delivered work order either.

## Decision

The fixer registers the `fixer` role adapter in `scripts/loop/emit-fixer-work-order.mjs`. The work order pins typed sources: the judge-pass act list or the unresolved review threads, plus an optional pre-push delta result. It pins the phase, `commit_only` or `full`. It pins `mutationAuthority` as `{ repo, pr, branch, allowedPaths }`, and these fields are semantic input to `workOrderDigest`. The branch comes from the PR head. Every emission uses the PR head SHA (`headRefOid`), and a different head refuses.

`allowedPaths` defaults to the whole repository, so today's fixer policy is unchanged.

The emitter prints a per-harness dispatch payload for Claude and Pi, built from the fixed compact pointer only. An unsupported harness refuses. The Claude payload names `fixer` in a dev-loops source checkout (the `dev-loops-run` checkout rule) and the plugin install's `dev-loops:fixer` elsewhere; the hooks normalize both. `assertFixerDispatchPayload` is a test-time shape check of that payload. No dispatch seam runs it at runtime, so compactness rests on the coordinator dispatching the emitted payload unchanged.

On Claude, PreToolUse hooks bound fixer mutation to a current pull. The Edit/Write guard and a commit/push Bash gate grant authority only from a fixer pull receipt in the main checkout. The receipt's plan must lie under `<main>/tmp/gate-fixer`, must still reproduce its digest and must pass the pull's own staleness checks: unchanged required reads, no retired gate round, and an authority branch that still contains the work order head. Spec staleness means a changed required read (the act list or threads, plus the delta result); the pinned contract digests and `configSha256` are digest identity only, as in the shared judge and reviewer adapters. The write grant's outputRef is derived from the plan location and execution identity, never read from the plan's outputRefs field. A grant binds to the subagent that pulled it: the Bash gate records the fixer's hook `agent_id` when it runs the sanctioned pull line, and the hooks honor a receipt only for that `agent_id`, so a replacement fixer must re-pull and a call without `agent_id` gets no grant.

The hooks deny writes and commits outside the grant branch and `allowedPaths`. They deny pushes to another destination and every push in the `commit_only` phase. They deny writes to the main checkout's `tmp/` except the work order's outputRef.

### Fixer git allowlist

The Bash gate is default-deny for fixer git. A fixer command that contains a git word runs only when every git invocation has an allowed form. The gate reads the command with quote-aware words (`extractFixerGitInvocations`). The grant, branch, path and phase checks then apply to each allowed `commit` and `push`. The hooks run their own git calls with `GIT_DIR` and `GIT_WORK_TREE` removed from the environment.

| Rule | Allowed | Denied |
| --- | --- | --- |
| Command shape | a plain chain joined by `&&`, `;` or a newline; redirections such as `2>&1` | a git word anywhere in a command that fails this shape, including a read-only search such as `grep -rn git skills \| wc -l` (use the Grep tool instead); a pipe, `\|\|`, `&`, a subshell or group, command or process substitution, a heredoc, a comment, `sh -c`, `xargs`, `eval`, `exec`, `source`, `pushd`, `popd`, a non-head `cd`, a `GIT_*` variable |
| Git word | `git` as the unquoted first word of its command | `\git`, `'git'`, `/usr/bin/git`, an `env`/`env -C`/`env --chdir` prefix, an assignment prefix, `nice`/`command`/`find -execdir` wrappers, a second git word |
| Global options | one literal `-C <dir>`, and `cd <dir>` segments before it | `-c` (including quoted values), `--git-dir`, `--work-tree`, any other global option, a second `-C`, an expanded (`$`, `~`, backtick) dir |
| Subcommand | status, diff, log, show, rev-parse, ls-files, merge-base, grep, blame, `branch` with no argument or `--show-current`, add, commit, push | cherry-pick, revert, merge, am, rebase, pull, update-ref, commit-tree, reset, checkout, switch, stash, config, `branch` with other arguments, every alias |
| Option matching | every option row reads options as git parse-options does, fail-closed: a long option matches every denied long option it is a prefix of, and a short cluster matches when it contains a denied short letter | an unlisted abbreviation or cluster never escapes a row below |
| Read-only options | the read-only subcommands' other options | `--output` and `--open-files-in-pager` with their prefixes, which write a file or run a pager command; every short cluster that contains `o` or `O`, such as `-o`, `-O`, `git status -uno` and `git log -Sfoo` |
| Add | `git add` with its other options | `--force` with its prefixes (`--f`, `--forc`) and every short cluster that contains `f`, such as `-f` and `-Af`, which stage an ignored path that the commit path check never lists |
| Push | an explicit remote and each refspec, with or without a leading `+`, as `<branch>`, `HEAD`, `HEAD:<branch>` or `<branch>:<branch>`, where either `<branch>` may be written `refs/heads/<branch>` and `<branch>` is the grant branch | a bare `git push`, `git push <remote>` without a refspec, any other source or destination (including `<src>:HEAD`, which creates `refs/heads/HEAD` on the remote, and `<sha>:<branch>` or `main:<branch>`, which rewrites the grant branch to other history), `--all`, `--mirror`, `--tags`, `--follow-tags`, `--delete` and `--prune` with their prefixes (`--tag`, `--del`, `--follow`), and every short cluster that contains `d`, such as `-d` and `-fd` |

Pi has no tool-gating surface. On Pi, the boundary is the pull contract plus the consumer checks.

`verify-fixer-disposition.mjs` requires `--fixer-plan`. The `--dispositions` and `--dispositions-file` inputs are removed. The consumer re-digests the plan and verifies a matching fixer pull receipt whose recorded plan path is the `--fixer-plan` path, so a copied plan refuses. It reads the handoff only from the outputRef derived from the plan location, refuses a plan whose outputRef differs, and reads it only when its mtime is not older than the receipt file's mtime. The handoff must name the observed live PR head.

The canonical digest moved to `@dev-loops/core/loop/work-order-digest`, so the hook bundle reuses the one serializer. Digests are unchanged.

We rejected keeping prose fixer briefs, because they bless model-authored work orders. We rejected a caller-supplied disposition handoff, because it proves nothing about delivery. We rejected a fixer-specific receipt or reader, because ADR 0106 owns one shared protocol.

## Consequences

On Claude, a fixer dispatched without a work order can no longer commit or push outside its authority through the gated git forms. The consumer no longer trusts a disposition list that the caller supplies.

The boundary has known ceilings. The Bash gate does not see indirect git: a script or interpreter that runs git, or a shell expansion that builds the git word. Non-git Bash writes and interpreters are ungated: a redirect, `cp`, `sed -i` or an interpreter writes any path, including the main checkout's `tmp/` receipts and binding markers, which the Edit/Write guard alone protects. The full closure is process-owned worker I/O ([#2343](https://github.com/mfittko/dev-loops/issues/2343)), outside this decision. The gate also does not inspect the remote a push names. A `git commit --amend` is checked only against the working-tree and index paths, never against the amended commit's earlier content. OutputRefs stay local material outside the digest, so the hooks and the consumer derive the outputRef instead of trusting the field.

`test/loop/emit-fixer-work-order.test.mjs`, `test/github/verify-fixer-disposition.test.mjs`, `packages/core/test/claude-hook-decisions.test.mjs` and `packages/core/test/bash-command-classify.test.mjs` pin this behavior.
