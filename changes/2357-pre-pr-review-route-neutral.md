### Fixed

- **The pre-PR review now runs on every route that creates a PR (issue [#2357](https://github.com/mfittko/dev-loops/issues/2357)).** `PRE-PR-BEFORE-FIRST-PUSH` is route-neutral, and GitHub-first sessions that create their own branch and PR reach the step at `OPS-DRAFT-FIRST-PR`, before the first push and before `create-pr.mjs`. The review itself is unchanged. ADR 0085 (`docs/decisions/0085-pre-pr-review-route-neutral-trigger.md`) records the change and amends ADR 0079.
