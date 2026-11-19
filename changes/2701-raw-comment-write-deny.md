### Fixed

- Security: the Claude Bash hook denies raw `gh` comment, review, close/reopen-with-comment and graphql comment writes for every actor, wrapped forms included (#2701)
- The Claude Bash hook has one predicate list: `decideBashGate` and the token rules decide every command (#2701)
