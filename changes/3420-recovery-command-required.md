### Added
- `RECOVERY-COMMAND-REQUIRED` rule, refusal audit and a CI ratchet check over every `ok: false` object in `scripts/github`, `scripts/loop`, `cli`, `lib` and `packages/core/src`: the check fails when a file's count of refusals without `recovery` rises above `docs/refusal-recovery-baseline.json` and rewrites the baseline when a count falls (#3420)
