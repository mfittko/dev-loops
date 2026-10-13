### Fixed

- Gate reviews enforce validation role boundaries, share bound validation evidence, and stop reviewer dispatch when validation fails (#2470)
- Reviewers keep the contract-mandated read-only `gh api .../pulls/<n>/(reviews|commits)`, `gh pr view` and `gate resolve-role` commands; npm/pnpm alias forms (`npm t`, `npm run-script`, `bun run <script>`) now classify as full-repository validation; fan-out, sentinel, `emit-reviewer-blocked` and `write-gate-context` help describe the typed validation refusals (#2470)
