### Fixed
- The project board item query selects `__typename`, so pull request items list with `prNumber` set instead of as issues (#3268)
- `queue add` reports an issue that is already on the board with `issueNumber` set and `prNumber` null, because the `GET_PROJECT_ITEMS_BY_CONTENT` query in `add-queue-item` now selects `__typename` (#3268)
