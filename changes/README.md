# Changeset fragments

Each PR that makes a notable change (a `feat`/`fix` commit or a code-file diff)
records its changelog note here as a NEW, uniquely named fragment file instead
of editing `CHANGELOG.md` directly. Uniquely named fragments never collide, so
concurrent PRs stop conflicting on the changelog (issue #2293).

## Adding a fragment

Create `changes/<slug>.md` (any unique slug — the issue/PR number plus a short
name works well, e.g. `changes/2293-changeset-fragments.md`). Write one or more
Keep-a-Changelog bullet lines describing the user-facing change:

```markdown
- **Short summary of the change (issue #NNNN).** Longer description of what
  changed and why it matters to a consumer.
```

Write bullet lines (a `### Added`/`### Fixed` level-3 subsection is fine). Do
NOT put a level-2 `## ` heading in a fragment: the release assembler treats the
next `## ` heading as the end of the section, so a `## ` line would truncate the
assembled notes. The fragment must be a real, non-empty, regular file (not a
symlink).

The changelog-completeness gate
(`scripts/docs/validate-changelog-completeness.mjs`) accepts such a fragment in
place of a direct `CHANGELOG.md` edit, so a PR that ships only a fragment passes;
it rejects an empty fragment, a symlink, or a fragment containing a `## ` heading.

## Release assembly

At release, `scripts/release/bump-version.mjs` (via
`scripts/release/assemble-changelog-fragments.mjs`) folds every pending fragment
into the `## Unreleased` section of `CHANGELOG.md`, removes the consumed
fragment files, and stamps `## Unreleased` to `## <version>`. This `README.md`
is never treated as a fragment.
