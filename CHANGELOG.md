# Changelog

## 0.1.0 - 2026-06-15

### Added

- Initial publishable package metadata for `dev-loops`.
  - `version`: `0.1.0`
  - `files`: explicit allowlist so the published tarball includes only runtime assets (`cli/`, `lib/`, `scripts/`, and the subset of `packages/core/` used by the CLI entrypoint).
  - `publishConfig`: `{ "access": "public", "provenance": true }`
  - `repository`, `bugs`, `homepage`: point to `https://github.com/mfittko/dev-loops`
- `CHANGELOG.md` with this initial release entry.

### Changed

- `cli/index.mjs` now imports the harness adapter and retry-wrapper from relative paths inside `packages/core/`, so the published tarball can resolve them without relying on the unpublished `@pi-dev-loops/core` workspace package.

### Decisions

- Package name: `dev-loops` (unscoped) is primary per #788 confirmed decisions. `@mfittko/dev-loops` remains the documented fallback if the unscoped name is blocked on npm.
- `packages/core` is not published independently in this slice; the root package carries only the core runtime pieces the CLI entrypoint needs (#766 will decide on core publishing).

### Notes

- This release does **not** publish to npm or add the publish workflow; Phase D will add `.github/workflows/npm-publish.yml` and Phase E will cut the first release.
