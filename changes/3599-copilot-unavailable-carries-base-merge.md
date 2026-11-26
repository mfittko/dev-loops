### Fixed

- The Copilot-unavailable record now carries across a base-only merge, so a base refresh no longer resets it and the PR reaches `pre_approval_gate` (#3599). A consumer that set `refinement.maxCopilotRounds: 0` as a workaround can revert it
