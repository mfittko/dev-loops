{
  "angle": "config-drift",
  "verdict": "findings_present",
  "findings": [
    {
      "severity": "worth-fixing-now",
      "file": "skills/docs/copilot-loop-operations.md",
      "line": 191,
      "summary": "Doc drift: line 191 explicitly names probe-copilot-review.mjs and states '--timeout-ms' is a removed CLI policy flag that 'helpers hard-error when they are provided'. This PR restores --timeout-ms as an accepted watch-budget override on probe-copilot-review (--timeout-ms 0 = single idle check), so the blanket claim is now false for the very script the sentence names. An agent/operator following this doc would avoid passing --timeout-ms to probe-copilot-review and lose the single-check mode this PR restores, directly undermining the PR intent (#1087). The identical drift exists in the separate .claude/skills/docs/copilot-loop-operations.md:191 copy (not a symlink). scripts/README.md is already consistent (accepts --timeout-ms, default 1800000, 0 = single check), so the PR aligns code with README but leaves copilot-loop-operations.md contradicting it.",
      "recommendation": "Rewrite the sentence to carve out --timeout-ms for probe-copilot-review: keep --poll-interval-ms and --probe-only as removed flags across the named helpers, but state that probe-copilot-review (and probe-ci-status) accept --timeout-ms as a watch-budget override where 0 = non-watch single check, while run-watch-cycle/watch-initial-copilot-pr still reject it. Apply the edit to BOTH skills/docs/copilot-loop-operations.md and .claude/skills/docs/copilot-loop-operations.md (line 191 in each)."
    },
    {
      "severity": "defer",
      "file": "packages/core/src/loop/policy-constants.mjs",
      "line": 5,
      "summary": "Header comment says 'These replace the now-removed CLI policy flags (--timeout-ms, --poll-interval-ms, --probe-only, ...)'. After this PR --timeout-ms is no longer universally removed: probe-copilot-review and probe-ci-status accept it as an override (constants remain the default source of truth). The comment's historical framing is now slightly inaccurate.",
      "recommendation": "Soften the comment to note the constants are the default source of truth and that --timeout-ms is accepted as a budget override on the probe scripts (not universally removed). Low priority; comment-only, no behavioral impact."
    }
  ],
  "contextWidened": [
    "scripts/github/probe-ci-status.mjs",
    "scripts/loop/run-watch-cycle.mjs",
    "scripts/loop/watch-initial-copilot-pr.mjs",
    "scripts/loop/copilot-pr-handoff.mjs",
    "scripts/github/upsert-checkpoint-verdict.mjs",
    "scripts/_cli-primitives.mjs",
    "scripts/README.md",
    "packages/core/src/loop/policy-constants.mjs",
    "skills/docs/copilot-loop-operations.md",
    ".claude/skills/docs/copilot-loop-operations.md",
    "packages/core/test/retry-wrapper.test.mjs",
    "test/loop/watch-initial-copilot-pr.test.mjs"
  ]
}