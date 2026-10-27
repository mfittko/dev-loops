### Fixed

- A read-only adapter reports verified terminal execution evidence from an owned Codex journal, so an execution that finished after its worker stopped reports `completed` (#2886)
- An encoded path separator in a recorded `file:` cwd URI is rejected instead of decoded into a real separator, so it can no longer bind an expected cwd and clear the cleanup blocker (#2886)
- Terminal records are counted for an execution across the whole journal, so a second contradictory terminal under another valid thread reports `conflicting_terminal_records` instead of `completed` (#2886)
