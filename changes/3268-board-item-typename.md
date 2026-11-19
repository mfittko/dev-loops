### Fixed
- The project board item query selects `__typename`, so pull request items list with `prNumber` set instead of as issues (#3268)
- `queue add` reports an issue already on the board with `issueNumber` set and `prNumber` null, as `add-queue-item` now selects `__typename` (#3268)
