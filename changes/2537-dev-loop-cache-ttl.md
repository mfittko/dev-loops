### Changed
- The `dev-loop` coordinator agent sets `experimental.cacheTtl: 1h`, so its prompt cache survives child-agent waits over 5 minutes (Claude Code v2.1.248+) (#2537)
