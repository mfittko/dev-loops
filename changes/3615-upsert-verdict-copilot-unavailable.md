### Fixed

- `gate upsert-verdict` now posts a clean `pre_approval_gate` verdict when `loop gate-coordination` reports `copilot_unavailable`, and every gate-entry refusal carries a `recovery` naming `loop gate-coordination` (#3615)
