### Fixed

- A judge decision with `remedyKind: "pr_body"` marks a finding whose only remedy is a PR-body edit. `isDeltaBodyItem` routes it to every body-only exit (`delta_body_only_act_set`, the `loop gate-coordination` body-only branch, `composeBodyOnlyConvergedDraftGate`) even when its scope names a file, so a cap round whose act items are all PR-body items exits by the body-only converged post instead of a refused fixer or chain-extension route. `spec-authority`, `judge-pass` and `write-gate-findings-log` accept the value and carry it into the ledger (#3309)
