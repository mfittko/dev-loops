### Added
- `RECOVERY-COMMAND-REQUIRED` rule and a CI ratchet over `ok: false` refusals, including the shared `scripts/lib/format-cli-error.mjs` catch-all; CI fails on any count that differs from the committed baseline (#3420)
