### Removed

- Breaking: dead named exports and unwired code in `@dev-loops/core` are deleted (#3474). An importer of a removed name gets a SyntaxError after upgrade. Removed exports per subpath:
  - `./config`: `BUILTIN_TIER_ALIASES`, `POST_MERGE_ACTION_DEFAULT_TIMEOUT_MS`, `POST_MERGE_ACTION_TIMEOUT_CEILING_MS`, `POST_MERGE_VERIFY_DEFAULT_TIMEOUT_MS`, `POST_MERGE_VERIFY_TIMEOUT_CEILING_MS`, `POST_MERGE_VERIFY_DEFAULT_INTERVAL_MS`, `POST_MERGE_VERIFY_INTERVAL_CEILING_MS`, `RUNNING_VERSION`, `DEFAULT_FANOUT_SEQUENTIAL`
  - `./debt/cluster`: `clusterSignals`
  - `./debt/signal`: `DebtSignalSourceType`, `DebtSignalSeverity`, `DebtSignalLocation`, `DebtSignalRepository`
  - `./github/review-threads`: `isActionableComment`, `isActionableThread`
  - `./loop/gate-carry-forward`: `resolveCarryForwardAngles`
  - `./loop/issue-refinement-artifact`: `extractChecklistItems`, `detectIssueRefinementArtifact`, `GRILL_MARKER_PATTERN`, `detectGrillMarker`, `summarizeRefinementGateCheck`
  - `./loop/review-dispatch-plan`: `BREAKPOINT_CONTROL_VALUES`, `BARRIER_SIGNAL_VALUES`, `CACHE_TTL_CONTROL_VALUES`, `USAGE_TELEMETRY_VALUES`, `opaqueMarker`, `fingerprintStablePrefix`, `composeCacheAwareRequest`
  - `./loop/reviewer-loop-state`: `selectReviewerPlan`, `mergeReviewerResults`, `REVIEWER_SUPPORTED_ANGLES`
  - `./loop/timeout-policy`: `DEV_LOOP_TIMEOUT_CLASSIFICATION`
  - `./loop/worktree-guard`: `SUBAGENT_AVAILABLE_VARS`
  - `./security/secret-scan`: `parseAddedLines`

### Changed

- Both the external healthy wait and the persistent internal wait messages no longer say "persistent unattended" (#3474)
