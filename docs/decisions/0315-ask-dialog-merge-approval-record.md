# 0315. An ask-dialog answer counts as merge approval through a harness-written record

## Status

Accepted — 2026-11-21 ([issue 3438](https://github.com/mfittko/dev-loops/issues/3438))

## Context

A size-budget-escalated or stable-release merge needs a fresh per-merge approval: an APPROVED review or an `approve merge <sha> [patch-id <id>]` comment. Agents never write that line (`OPERATOR-OWNED-LINE`). The operator and the agents share one GitHub credential. A comment an agent posts after an ask answer therefore looks the same as a forged one. The operator had to type a `gh pr comment` command by hand, which breaks the rule that the only human step is answering a question.

## Decision

The harness records the operator's ask-dialog answer. An agent does not.

- Trust model. The operator's answer reaches the PostToolUse `AskUserQuestion` hook as tool output that the harness produces. No agent tool call writes it. A record written by that hook is human attestation. A comment an agent posts is not, because an agent holds the same credential and can post any text.
- Question. The orchestrator asks `Approve merge of <owner/name> PR #<n> at head <40-hex> with patch-id <40-hex>?`. The hook parses the facts from the question text and requires exactly one repo, PR, head and patch-id.
- Record. On a yes answer the hook writes `{repo, pr, headSha, patchId, question, answer, time, session}` to `~/.config/dev-loops/merge-approvals/<id>.json` (`DEVLOOPS_APPROVAL_DIR` overrides the directory). The directory is outside every checkout and every agent-writable path.
- Integrity proof (the named mechanism). An HMAC-SHA256 over the canonical record, keyed by a random 32-byte key in `.key` (mode 0600) in the same directory. The hook creates the key. The record id is a second HMAC over the first. The merge wrapper recomputes the HMAC and compares in constant time. An agent that cannot read the key cannot produce a valid record.
- Path guard. `pre-tool-use-approval-guard.mjs` denies Bash, Read, Edit, Write, NotebookEdit, Grep and Glob calls that name the directory or the override variable.
- Comment. The hook posts `approve merge <head> patch-id <id>` and a marker line `<!-- dev-loops:ask-approval id=<record-id> -->` through `gh`. GitHub keeps the visible audit trail. Agents cannot post the line (the raw comment write deny and `OPERATOR-OWNED-LINE`).
- Reader. `merge-pr.mjs` keeps accepting an unmarked operator comment (the Pi path). It drops a marked comment unless a valid record for the same repo, PR, head and patch-id exists, and the head or patch-id equals the current one. Each refusal names its recovery: ask the approval question again with the current facts (`RECOVERY-COMMAND-REQUIRED`).

## Consequences

Under Claude Code the operator answers a question instead of typing a command. Pi has no hook, so the comment-line path stays unchanged (#1086).

Limits. The key protects against agent tool calls the hooks judge. A same-user process that bypasses the hooks (a wrapper file, a shell function, an unhooked harness) can read the key. This matches the ceiling of `OPERATOR-DECISION-RECORDER`. The hook does not check the live head at answer time. The merge wrapper checks currency at merge time.

Weakening `OPERATOR-OWNED-LINE` and changing which merges need fresh approval are out of scope.
