### Changed

- An operator focus decision that starts with `defer` closes its act item for routing: `loop gate-coordination` and `upsert-checkpoint-verdict.mjs` drop it from the open act count, and a draft PR whose every open act item is deferred routes `mark_ready_for_review` (#3652)
