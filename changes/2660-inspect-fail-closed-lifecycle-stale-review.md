### Fixed

- `inspect-run` reports `lifecyclePhase: "unknown"` for a PR without dev-loop evidence instead of a phase guessed from the Copilot state map. (#2660)
- The reviewer layer reports `re_review_needed` when the latest submitted review targets a stale commit and no fresh review is requested. (#2660)
