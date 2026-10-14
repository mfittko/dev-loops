### Fixed

- Gate reviews enforce validation role boundaries, share bound validation evidence, and stop reviewer dispatch when validation fails (#2470)
- Reviewers keep read-only `gh api .../pulls/<n>/(reviews|commits)`, `gh pr view` and `gate resolve-role` commands (#2470)
- npm/pnpm test aliases and direct `bun run <file>.mjs` launches such as `bun run ./scripts/verify.mjs` retain full-validation classification (#2470)
- Fan-out, sentinel, blocked-result and context-builder help explain typed validation refusals (#2470)
- Install-and-test aliases and ambiguous runtime option values cannot bypass full-validation denial; Pi reviewers can resolve roles through their own installed package's Node CLI helper (#2470)
- Developers and fixers keep targeted checks on both harnesses; redirects and shell prefixes preserve validation reach (#2470)
