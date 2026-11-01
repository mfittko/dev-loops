### Fixed
- A PR runner claim no longer outlives its run: hand-back releases it with an explicit run id on every harness, `status` reports owner liveness, `takeover` refuses a live owner, and gate writers heartbeat the owner's claim (#2884)
