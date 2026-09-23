### Fixed

- **`dev-loops queue move` and `queue reorder` find items that the lagging board listing omits (issue [#2397](https://github.com/mfittko/dev-loops/issues/2397)).** A number ref is now looked up from the issue side (`issueOrPullRequest(number).projectItems`) and a node ID ref with `node(id)`, both scoped to the configured project and repository. A nonexistent number or unknown node ID fails closed with `ITEM_NOT_FOUND` (exit 3). `ghGraphql` with `allowErrors` now returns the GraphQL `errors` payload when `gh api graphql` exits non-zero with that JSON on stdout.
