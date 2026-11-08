### Fixed
- A PR-body-only edit keeps the gate briefing hash: the body is a separate pr-body read and a same-head rebuild re-runs only the body-reading angles (#3080)
- The judge work order refuses a pinned PR body that differs from the live body and names both digests (#3080)
- A stale runner claim names its run in the gate_evidence failure instead of a bare stale_runner (#3080)
