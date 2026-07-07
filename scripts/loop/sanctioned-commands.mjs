/**
 * Canonical sanctioned operation → wrapper command map (issue #1081).
 *
 * SINGLE SOURCE OF TRUTH for "which wrapper does a dev-loop subagent use for
 * which GitHub/loop operation". Previously this knowledge was re-derived per
 * handoff and scattered across SKILL.md / copilot-loop-operations.md /
 * pr-lifecycle-contract.md, so subagents burned cycles rediscovering e.g.
 * `gh pr ready` → scripts/github/ready-for-review.mjs.
 *
 * This lives in the CONSUMER layer (scripts/), NOT in @dev-loops/core, because
 * the values are THIS repo's `scripts/...` wrapper paths. Core stays
 * consumer-agnostic: it defines the envelope SHAPE and carries whatever
 * `sanctionedCommands` object the consumer supplies. The
 * `loop build-envelope` CLI injects this map into every emitted envelope so a
 * spawned subagent receives it verbatim by DEFAULT, regardless of who wrote
 * the handoff.
 *
 * Wrapper paths are repo-root-relative. A contract test
 * (test/contracts/sanctioned-commands-exist.test.mjs) asserts every mapped
 * wrapper exists on disk and fails closed if one is renamed/removed.
 */

export const SANCTIONED_COMMANDS = Object.freeze({
  // Read-only lookups. Each value is the sanctioned wrapper; several also
  // accept `loop info` as an equivalent aggregate read (noted in the doc).
  reads: Object.freeze({
    "pr-facts": "scripts/github/view-pr.mjs",
    "ci-status": "scripts/github/probe-ci-status.mjs",
    "ci-wait": "scripts/github/wait-pr-checks.mjs",
    "ci-logs": "scripts/github/fetch-ci-logs.mjs",
    "issue-list": "scripts/github/list-issues.mjs",
    "copilot-review-state": "scripts/github/probe-copilot-review.mjs",
    "review-threads": "scripts/github/list-review-threads.mjs",
    "gate-coordination": "scripts/loop/detect-pr-gate-coordination-state.mjs",
  }),

  // Metadata edits.
  edits: Object.freeze({
    "pr-body-title-assignee-milestone": "scripts/github/edit-pr.mjs",
    "issue-body-title-assignee-milestone": "scripts/github/edit-issue.mjs",
    "issue-comment": "scripts/github/comment-issue.mjs",
  }),

  // Lifecycle mutations a subagent MAY perform (state transitions on the PR /
  // review). Board status transitions are deliberately NOT here — they are
  // orchestratorOwned (see below): in the current batch model the orchestrator
  // owns board moves, and a subagent's In-Progress move rides ready-for-review.mjs
  // (#1069), so there is no standalone subagent-sanctioned board-sync op.
  lifecycle: Object.freeze({
    "ready-for-review": "scripts/github/ready-for-review.mjs",
    "pr-create": "scripts/github/create-pr.mjs",
    "copilot-request": "scripts/github/request-copilot-review.mjs",
    "reply-resolve-thread": "scripts/github/reply-resolve-review-thread.mjs",
    "reply-resolve-threads": "scripts/github/reply-resolve-review-threads.mjs",
    "gate-verdict-comment": "scripts/github/upsert-checkpoint-verdict.mjs",
  }),

  // Never allowed for any operation above — the sanctioned wrapper is mandatory.
  forbidden: Object.freeze([
    "gh pr view",
    "gh pr checks",
    "gh pr edit",
    "node -e",
    "node --input-type=module -e",
    "node -p",
    "python -c",
    "python3 -c",
    "tailing subagent transcripts",
    "sleep-poll loops",
  ]),

  // Orchestrator-owned: a spawned dev-loop subagent must NEVER do these. Board
  // status transitions live here (not in `lifecycle`) — the orchestrator owns
  // move-queue-item/sync-item-status in the current batch model.
  orchestratorOwned: Object.freeze([
    "gh pr merge",
    "board status transitions (move-queue-item / sync-item-status.mjs; current batch model)",
  ]),
});

// The wrapper-path-bearing groups are the object-valued groups (reads/edits/
// lifecycle); `forbidden`/`orchestratorOwned` are string arrays, not path maps.
const PATH_GROUP_KEYS = Object.freeze(
  Object.keys(SANCTIONED_COMMANDS).filter(
    (k) => !Array.isArray(SANCTIONED_COMMANDS[k]),
  ),
);

/**
 * EVERY value named across the path-bearing groups — with NO shape filtering,
 * so a malformed/typo'd entry is RETURNED (and then fails the contract test's
 * shape+existence assertions) rather than being silently skipped. Auto-includes
 * any future path-bearing group. This is what keeps the map from drifting off
 * disk (#1081). For a well-formed map every element is a repo-root-relative
 * `scripts/*.mjs` string; the no-filtering contract means a malformed map can
 * yield a non-string here, which the contract test is designed to catch.
 * @returns {unknown[]} wrapper-path values (strings for a well-formed map)
 */
export function listSanctionedWrapperPaths() {
  const out = [];
  for (const key of PATH_GROUP_KEYS) {
    for (const value of Object.values(SANCTIONED_COMMANDS[key])) {
      out.push(value);
    }
  }
  return out;
}
