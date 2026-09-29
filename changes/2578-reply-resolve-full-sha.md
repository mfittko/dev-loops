### Fixed
- The reply-resolve scripts now require `--disposition fixed|deferred|rejected` and refuse a `fixed` reply without a full 40-character SHA contained in the PR head, before any post or resolve; the fixer work order and disposition writer also refuse a threadless act item's non-node `threadId` (#2578)
