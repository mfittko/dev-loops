### Fixed

- A judge decision with `remedyKind: "pr_body"` marks a PR-body-only finding, so a cap round of such items exits by the body-only converged post, not a refused fixer route (#3309)
- `write-gate-findings-log.mjs --rejudge-same-round` overlays `remedyKind: "pr_body"` onto the live same-head ledger in place, keeping the round number (`GATE-LEDGER-REJUDGE-SAME-ROUND`) (#3309)
- A review-thread act item with no file refuses `body_item_locatable`, and a `remedyKind` outside `evidence_only` and `pr_body` is refused by the writer and validator (#3309)
