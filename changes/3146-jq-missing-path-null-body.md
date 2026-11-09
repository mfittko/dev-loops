### Fixed
- `--jq` on view-issue, view-pr and list-issues: a path matching no field exits 2; view-issue and view-pr resolve against the requested fields. edit-issue refuses an empty or `null` body (#3146)
