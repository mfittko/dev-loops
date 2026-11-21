### Fixed

- A clean cap round proven only by its local ledger no longer counts as clean draft_gate evidence: the coordination check reports the cap-round condition `clean_cap_verdict_unposted` and `ready-for-review.mjs` refuses until the verdict is posted (#3366)

### Added

- `gate upsert-verdict --gate draft_gate --post-sealed-cap-round` posts the sealed clean cap-round verdict, deriving head, verdict and findings from the ledger (#3366)
