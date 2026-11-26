### Fixed

- The Copilot-unavailable record now survives a base-only merge, so a PR reaches `pre_approval_gate`; revert the `refinement.maxCopilotRounds: 0` workaround (#3599)
