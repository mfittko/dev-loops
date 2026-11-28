### Changed

- An operator focus decision of `defer` (or a `deferred` reply disposition) now closes its act item for routing, so a draft PR whose open act items are all deferred routes to the clean draft_gate verdict post, and the ready flip follows that post (#3652)
