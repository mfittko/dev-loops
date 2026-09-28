# 0110. Reviewer diff excludes configured generated mirror trees

## Status

Accepted — 2026-09-28 ([issue 2504](https://github.com/mfittko/dev-loops/issues/2504))

Relates to ADR 0086 and ADR 0108. It amends no ADR.

## Context

Gate reviewers read the whole filtered diff, so their token cost scales with its bytes. On PR 2496 the required diff was about 178K bytes. The generated `.claude` mirrors were about 20% of it. Each reviewer cost 1.97M tokens, and all 31 reviewers hit the Read cap on the evidence file.

`filterDiffForInline` already accepted caller `excludeGlobs` with the reason `configured`. No argument parser or config key set them, so the filtered diff and the raw diff had the same sha256. The required `diff` read that ADR 0086 names already describes configured excludes. Only the wiring was missing.

## Decision

The global config key `gates.reviewDiff.excludeGlobs` takes an array of non-empty globs and defaults to empty. `scripts/github/write-gate-context.mjs` passes it to `filterDiffForInline`. It applies on every gate, on top of `DEFAULT_DIFF_EXCLUDE_GLOBS`. The configured globs never replace the defaults. As in ADR 0108, a rename or copy is excluded as `configured` only when both its old and new paths match; otherwise it stays in the filtered diff. The globs load from the reviewed head, so the dev-loop config sources (`.devloops` and its `.yaml`/`.yml`/`.json` variants, `packages/core/src/config/extension-defaults` with or without a `.yaml`/`.yml`/`.json` extension, `.pi/dev-loop/**`, and every ancestor directory of those files) are never excluded as `configured`. An ancestor directory appears in a diff only as a symlink swap, which redirects the config read. A PR that widens the globs keeps that config edit in the filtered diff.

This repo's `.devloops` sets the key to `.claude/skills/**`, `.claude/agents/**` and `.claude/commands/**`. These are the values of `GENERATED_MIRROR_GLOBS` in `packages/core/src/config/config.mjs`. `scripts/claude/generate-claude-assets.mjs` owns every file under them.

`test/contracts/review-diff-exclude-generated.test.mjs` pins this repo's `.devloops` value to `GENERATED_MIRROR_GLOBS`. It proves that every committed file matching a configured glob is a generator target and that no `.claude/hooks/**` file matches.

A gate with `requireCi: true` gives a verdict at a head only when CI passes there. CI runs the reproducibility drift test `test/contracts/claude-assets-reproducible.test.mjs`, so the excluded mirrors are proven byte-identical to their reviewed sources at that head. The exclude also applies on the standalone `review` gate and on gates with `requireCi: false`. The standalone `review` gate is advisory and never satisfies gate evidence.

Reviewers keep access to every excluded file. The unfiltered diff stays the optional `raw-diff` read. The evidence file lists each excluded path with its reason (`default` or `configured`) after the changed-files list.

## Consequences

The required reviewer read shrinks by the mirror bytes on PRs that change skills, agents or commands. Reviewers still see each excluded path by name and can widen to `raw-diff` or `git diff -- <path>`.

The ADR 0108 scope-count set `SCOPE_COUNT_EXCLUDE_GLOBS` stays hard-coded. It now spreads `GENERATED_MIRROR_GLOBS`, and its values are unchanged. The two sets share one source for the mirror globs, and only the reviewer-diff set is configurable.

A consumer repo that sets the key owns the safety of its globs. The built-in defaults do not change.

Rejected alternatives:

- A CLI flag on `write-gate-context.mjs`. The value is a stable repo property, and a flag must be repeated by every caller.
- Add `.claude/**` to `DEFAULT_DIFF_EXCLUDE_GLOBS`. Issue 1889 removed it on purpose, because consumer repos may hand-write files there.
- Exclude `.claude/hooks/**`. It holds hand-written hooks beside vendored bundle modules and has no parity proof.
