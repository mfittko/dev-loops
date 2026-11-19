### Security

- In a managed repo, the Claude Bash hook denies a raw `gh` issue or PR comment, PR review, close or reopen with a comment, and `gh api graphql` `addComment` or `addPullRequestReview` write for every actor, including wrapped forms (#2701)
- The Claude Bash hook has one predicate list: `decideBashGate` and the token rules decide every command (#2701)
