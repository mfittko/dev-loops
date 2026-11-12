# 0267. Raw comment writes and the standing-authorization paths are denied at the Bash gate, and the grill provenance line is operator-owned

## Status

Proposed — 2026-11-12 ([issue 2410](https://github.com/mfittko/dev-loops/issues/2410))

Amends [0258](./0258-operator-owned-line-registry.md) on the registry entries, the fallback twin and the raw comment-write deny. Amends [0084](./0084-grill-clean-requires-recorded-provenance.md), as amended by [0154](./0154-pr-create-refuses-oversize-before-creation.md), on who records the bypass line. Every other decision of those records stays in force, and the records stay unedited.

## Context

ADR 0258 made every sanctioned comment writer refuse an operator-owned line. The operator and the agents share one GitHub credential, so each reader trusts an agent-written line as an operator line, and four paths still reach a reader around the wrappers:

- A raw comment write (`gh issue comment`, `gh pr comment`, a `gh api` write to an issue comment) bypasses every wrapper. The Bash gate denied only `gh issue comment` and `gh pr comment`, and only for a subagent, with no rule ID.
- `--standing-authorization` on `comment-issue.mjs` and `edit-comment.mjs` is a self-asserted flag that clears the Copilot `operator` refusal, and a subagent can pass it. A subagent can also run `waive-adr-tripwire` without a prompt.
- Coordinators wrote the grill provenance line `bypass: operator-authorized by <handle>` without operator authorization, because the loop-grill skill told them to record it. The operator decided on 2026-11-09 that the line is operator-owned.
- The Claude hook allows any command that its quick pre-check does not name, so a new deny that the pre-check does not nominate never fires.

## Decision

1. `OPERATOR_OWNED_LINES` gains `grill-provenance-bypass` with `standingAuthorization: false`. Its matcher is the reader: `detectGrillProvenance([body]).bypass`. The registry refuses the line in every body that the reader accepts as a bypass, which is a grill results comment, and nowhere else. A gate surface body that quotes the line in reviewer text posts as before. The matcher width stays narrow until the operator decides otherwise.
2. The no-core fallback twin in `post-gate-verdict-fallback.mjs` gains the same entry. It copies the reader grammar, so it is the one exception to ADR 0258 decision 4, which said no second marker regex exists: the fallback cannot import core and carries local copies of the marker and the grill grammar. The parity test covers both.
3. `decideBashGateDeny` denies a raw comment write on the managed repo for every actor, the main agent included, with rule ID `OPERATOR-OWNED-LINE`. The classifier `commandContainsRawCommentWrite` matches `gh issue|pr comment`, `gh issue|pr close|reopen` with `--comment` or `-c`, a `gh api` body write or `--input` to `issues/<n>/comments` or `issues/comments/<id>`, and a graphql `addComment` or `updateIssueComment`. A GET, a provably foreign repository and the sanctioned wrappers pass. The rule runs before the subagent inline external-write deny. That deny keeps `gh issue create`, `gh issue edit` and the comment verbs, so the comment verbs stay denied for a subagent outside the managed repo and for a foreign repository. `COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY` still runs earlier.
4. `decideBashGateDeny` denies a subagent of any role a command that runs `waive-adr-tripwire`, or `comment-issue.mjs` or `edit-comment.mjs` with any `--standing-authorization` token form, with the new rule ID `STANDING-AUTHORIZATION-MAIN-AGENT-ONLY`. The gate does not parse the flag value, because every form is denied for a subagent. The main agent runs the same commands. `merge-pr.mjs` and its flag stay outside this rule.
5. The Claude hook adds both classifiers to its quick pre-check so the decider runs for these shapes.
6. The loop-grill skill no longer tells an agent to record the provenance line. An authorized re-grill of an already-provenanced target runs Steps 2 to 4 and posts the results comment without the line. The final report names the exact line for the operator to add to the posted results comment, because the reader accepts the line only in a comment whose first non-empty line is the results heading. The detector and the state graph stay unchanged.
7. `ready-for-review.mjs` checks the raw `--reason` and `--approved-by` values against the registry before it sanitizes them, and refuses with no comment. `wrapOperatorOwnedPhrases` also wraps a bare `release [v]<digit>` version run whole and leaves text inside an author code span unchanged. The two comment wrappers share one `--standing-authorization` value parse.

## Consequences

An instruction-following agent can no longer write an operator-owned line through a raw comment path, clear the Copilot `operator` refusal with the flag as a subagent, or record the grill bypass line. The guard stops an instruction-following agent. An agent that calls the GitHub API with `curl` and the shared token, or with a script outside the wrappers, is not stopped, and a separate agent identity is a non-goal. `--standing-authorization` stays an unverified assertion for the main agent. Pi runs no Bash gate, so on Pi the wrapper refusal holds, including the grill provenance entry, and the raw comment-write deny and the subagent deny are not enforced. The human posting channel for an operator-owned line and the matcher width of the grill entry stay open operator decisions.

The raw comment-write deny applies only when the session cwd is the managed repository, so a command run from another directory against the managed repository by `--repo` or `GH_REPO` is not stopped. The classifiers read the command text only. They do not follow a `curl` or script call to the API, and they miss a `gh` literal that sits in the input text of an `xargs` or `sh -c` wrapper instead of its arguments. A `gh api graphql` call whose query field value starts with `@`, `$` (a substitution or variable) or a backtick, or that uses `--input`, is denied, because the mutation cannot be read. A substitution elsewhere in the call is not read as an opaque query. A heredoc body line that starts with `gh pr comment` is split per line like a command, which predates this rule and stays a known ceiling. An `env GH_REPO=<other>` prefix is also denied, because the scope check does not read the assignment behind `env`.
