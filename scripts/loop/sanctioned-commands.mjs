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
    "ci-logs": "scripts/github/fetch-ci-logs.mjs",
    "issue-list": "scripts/github/list-issues.mjs",
    "copilot-review-state": "scripts/github/probe-copilot-review.mjs",
    "gate-coordination": "scripts/loop/detect-pr-gate-coordination-state.mjs",
  }),

  // Metadata edits.
  edits: Object.freeze({
    "pr-body-title-assignee-milestone": "scripts/github/edit-pr.mjs",
    "issue-comment": "scripts/github/comment-issue.mjs",
  }),

  // Lifecycle mutations (state transitions on the PR / review / board).
  lifecycle: Object.freeze({
    "ready-for-review": "scripts/github/ready-for-review.mjs",
    "pr-create": "scripts/github/create-pr.mjs",
    "copilot-request": "scripts/github/request-copilot-review.mjs",
    "reply-resolve-thread": "scripts/github/reply-resolve-review-thread.mjs",
    "reply-resolve-threads": "scripts/github/reply-resolve-review-threads.mjs",
    "gate-verdict-comment": "scripts/github/upsert-checkpoint-verdict.mjs",
    "board-status-sync": "scripts/projects/sync-item-status.mjs",
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

  // Orchestrator-owned: a spawned dev-loop subagent must NEVER do these.
  orchestratorOwned: Object.freeze([
    "gh pr merge",
    "board status transitions (current batch model)",
  ]),
});

/**
 * Flat list of every repo-root-relative wrapper path named in the map.
 * Shared by the existence contract test so the map cannot drift from disk.
 * @returns {string[]}
 */
export function listSanctionedWrapperPaths() {
  const out = [];
  for (const group of [SANCTIONED_COMMANDS.reads, SANCTIONED_COMMANDS.edits, SANCTIONED_COMMANDS.lifecycle]) {
    for (const value of Object.values(group)) {
      if (typeof value === "string" && /^scripts\/.+\.mjs$/.test(value)) out.push(value);
    }
  }
  return out;
}
