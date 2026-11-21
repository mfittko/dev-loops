### Changed
- A draft_gate round fans out only on settled green current-head CI; red CI routes to the CI-fix route, and a verdict post refused for red CI hands back `fix_ci_failure` with the act list (#3414)
