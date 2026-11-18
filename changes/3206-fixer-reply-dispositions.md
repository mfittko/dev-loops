### Fixed

- The operator focus file now carries a per-thread reply disposition and note, bound by `fingerprint` or `threadId` (#3206)
- `verify-fixer-disposition.mjs` no longer posts "Fixed in commit" on a no-change or partly fixed thread; it posts the pinned disposition note (#3206)
