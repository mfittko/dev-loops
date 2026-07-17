# Release runbook

Releasing is fully automated from a tag. **Pushing a `v<version>` tag is the only
manual step.** Everything after the tag is hands-off.

## Procedure

1. On `main` (merged, green), bump the version, run
   `node scripts/claude/generate-claude-assets.mjs` (stamps the bumped version
   into the generated `npx dev-loops@<version>` pins and the plugin manifest;
   a stale manifest fails `verify` at publish), and add the matching
   `## <version> - <date>` section to `CHANGELOG.md` (the empty `## Unreleased`
   heading stays above the latest version).
2. Tag the release commit and push the tag:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

That is the whole manual flow. Do **not** create the GitHub Release by hand —
the workflow does it (and is idempotent if you already created one).

## What happens automatically

- **`.github/workflows/release.yml`** fires on the `v*` tag push. It verifies the
  tagged commit is on `origin/main`, extracts the `## <version>` block from
  `CHANGELOG.md` via `scripts/release/extract-changelog-section.mjs`, and creates
  the GitHub Release (`--latest` for a stable version, `--prerelease` for a
  prerelease version such as `1.0.0-rc.1`; notes = that CHANGELOG section). It is
  **idempotent** (no-op if a Release for the tag already exists) and **fails
  closed** if the version has no CHANGELOG section — an undocumented version never
  gets an empty release.
- **`.github/workflows/npm-publish.yml`** is dispatched by the step above via
  `workflow_dispatch` (`gh workflow run npm-publish.yml --ref <tag>`): a
  `GITHUB_TOKEN`-created Release does **not** emit the `release` event, so the
  automated tag flow relies on that explicit dispatch rather than `on: release`
  (the `release: published` trigger remains only for a Release published by hand
  in the UI). It publishes the packages to npm under the dist-tag resolved by
  `scripts/release/resolve-npm-dist-tag.mjs`: a stable version → `latest`; a
  prerelease → its channel (`1.0.0-rc.1` → `rc`, `…-next.N` → `next`, …) and
  **never** `latest`, so a release candidate is opt-in (`npm install dev-loops@rc`)
  and cannot become the default `npm install dev-loops`.

## Failure modes

- Tag not on `main`: the release workflow fails the on-main guard — re-tag the
  correct commit.
- Missing CHANGELOG section: the extraction step exits non-zero and no Release is
  created. The workflow checks out the tagged commit, so editing `CHANGELOG.md`
  alone is not enough — commit the `## <version>` section, then move the tag to
  the new commit and re-push:

  ```bash
  git tag -f v<version>
  git push --force origin v<version>
  ```
