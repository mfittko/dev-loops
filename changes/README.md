# Changeset fragments

Each PR that makes a notable change (a `feat`/`fix` commit or a code-file diff)
records its changelog note here as a NEW, uniquely named fragment file instead
of editing `CHANGELOG.md` directly. Uniquely named fragments never collide, so
concurrent PRs stop conflicting on the changelog (issue #2293).

## Adding a fragment

Create `changes/<slug>.md` with a unique slug, for example
`changes/2293-changeset-fragments.md`. The fragment must be a real, non-empty,
regular file (not a symlink).

## Fragment format

- The first line may be one section line: `### Added`, `### Changed` or
  `### Fixed`. Without it, the section is `Changed`.
- Every other line is one entry: `- <user-visible effect> (#<issue-or-PR>)`.
- An entry is at most 200 characters and never wraps onto a continuation line.
- An entry has no bold lead and no rule ids. It names a function or file only
  when that name is the user-facing command or config key.
- A fragment has no other heading. A level-2 `## ` heading would truncate the
  assembled release section.

Example:

```markdown
### Fixed

- `dev-loops queue move` finds items that the board listing omits (#2397)
```

The changelog-completeness gate
(`scripts/docs/validate-changelog-completeness.mjs`) accepts an added fragment
in place of a direct `CHANGELOG.md` edit. It rejects an empty or symlinked
fragment, and it rejects any new or changed fragment that breaks the format.
Each rejection names the broken rule.

## Release assembly

At release, `scripts/release/bump-version.mjs` (via
`scripts/release/assemble-changelog-fragments.mjs`) folds every pending fragment
into the `## Unreleased` section of `CHANGELOG.md` under one `### Added`, one
`### Changed` and one `### Fixed` heading, in that order. It removes the
consumed fragment files and stamps `## Unreleased` to `## <version>`. This
`README.md` is never treated as a fragment.
