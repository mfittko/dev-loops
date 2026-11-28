### Changed

- Breaking: dead named exports in `@dev-loops/core` are deleted from `./config`, `./debt`, `./github`, `./loop` and `./security`; an importer of a removed name fails after upgrade (#3474)
- The external healthy wait and the persistent internal wait messages no longer say "persistent unattended" (#3474)
