# Release runbook

Releasing is fully automated from a tag. **Pushing a `v<version>` tag is the
only manual step** for prereleases; a **stable** cut additionally requires the
operator `approve release v<version>` comment **before** the tag push — see
[Operator release approval gate](#operator-release-approval-gate-stable-releases).
Everything after the tag is hands-off.

## Procedure

1. On `main` (merged, green), bump the version, run
   `node scripts/claude/generate-claude-assets.mjs` (stamps the bumped version
   into the generated `npx dev-loops@<version>` pins and the plugin manifest;
   a stale manifest fails `verify` at publish), and add the matching
   `## <version> - <date>` section to `CHANGELOG.md` (the empty `## Unreleased`
   heading stays above the latest version). Regenerate `package-lock.json` so
   its root/workspace version fields and the `@dev-loops/core` dependency spec
   track the full new version including the prerelease token
   (`npm install --package-lock-only`) and stage it with the release files —
   `release.yml`'s lockstep guard
   (`scripts/release/assert-core-dependency-version.mjs`) now fails the tag if
   the lockfile is out of lockstep, so a stale lockfile can never ship a
   release green (rc.7 did: #1886). Committing and pushing this release
   commit lands directly on `main`, which the default-branch guard hooks (see
   [Default-branch guard](worktree-guidance.md#default-branch-guard)) now refuse
   by default — a sanctioned release commits and pushes with
   `DEVLOOPS_ALLOW_MAIN=1`:

   ```bash
   DEVLOOPS_ALLOW_MAIN=1 git commit -m "chore(release): v<version>"
   DEVLOOPS_ALLOW_MAIN=1 git push origin main
   ```

   **Staging the release commit.** Stage the exact release files explicitly
   (the version bump, `CHANGELOG.md`, `package-lock.json`, and any regenerated
   assets) — never
   `git add -A` or `git add .`. The release commit runs with
   `DEVLOOPS_ALLOW_MAIN=1`, which intentionally turns the default-branch guard
   off, so a broad add sweeps accumulated main-checkout scratch straight into
   the release commit (this has already cost a cancelled publish run and a tag
   re-cut). Before committing, run `git status --porcelain` and verify every
   staged path is an intended release file; abort the commit if anything
   unexpected is staged.
2. Tag the release commit and push the tag:

   ```bash
   git tag v<version>
   git push origin v<version>
   ```

   For a **stable** version, post the operator `approve release v<version>`
   comment **before** pushing the tag — the gate refuses a stable tag with no
   approval record (see
   [Operator release approval gate](#operator-release-approval-gate-stable-releases)).

That is the whole manual flow. Do **not** create the GitHub Release by hand —
the workflow does it (and is idempotent if you already created one).

## Operator release approval gate (stable releases)

Cutting a **stable** tag (`vX.Y.Z`, no prerelease suffix) and publishing it to
npm is a **gated release decision, not an agent judgment call**. The first
v1.0.0 cut was tagged and published by a dev-loop subagent acting on a generic
"continue" plus a blanket merge authorization, and had to be rolled back — the
approval was read as transferable. It is not. Blanket merge authorizations and
generic "continue" instructions never satisfy this gate.

**Sanctioned division:**

- **Agents may** stage, verify, and prepare everything up to and including the
  release commit on a branch or `main` per the staging rules above.
- **The operator** owns the tag-push + `npm publish`/dist-tag decision, per
  release. The accepted approval record is an issue comment authored by the
  repo owner (operator) on a repo issue (typically the release tracking issue)
  stating `approve release v<version>` — or the operator running the publish
  commands themselves.

**Deterministic enforcement (fail closed).** Both release workflows run
`scripts/release/verify-release-approval.mjs` before anything is published:

- `release.yml` (fired by the `v*` tag push) refuses — no GitHub Release, no
  npm-publish dispatch — with a named refusal when no operator approval record
  exists for this exact version.
- `npm-publish.yml` runs the same check against the root and the
  `@dev-loops/core` package versions independently, closing the direct
  `workflow_dispatch` bypass against a stable version. Each invocation matches
  its package version exactly, so one `approve release v<version>` record
  covers both packages only while their versions are byte-identical (the
  normal case). If the core patch version diverges from the root, the core
  publish needs its own `approve release v<core-version>` record.
- A prerelease (`rc`/`next`/`beta`/…) is out of scope: the gate applies to
  stable releases only and the prerelease flow is unchanged.

The refusal names exactly what is missing:

```text
stable release v1.0.0 blocked: no explicit operator release approval record
found. Expected an issue comment by the operator (@owner) stating
"approve release v1.0.0", or the operator running the publish commands
themselves. Blanket merge authorizations and generic continue instructions do
NOT satisfy this gate.
```

**Operator path for a stable cut:** post the approval comment on the release
tracking issue (then the automated flow proceeds), or run the publish steps
manually. Local pre-flight (optional but recommended before pushing the tag):
`node scripts/release/verify-release-approval.mjs --version <X.Y.Z> --repo
<owner/name>`.

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

- Release commit contains unintended content: cancel the publish run
  **first** (the run is the irreversible step — it publishes from the tag),
  then clean up `main`, then delete and re-cut the tag:

  ```bash
  gh run cancel <publish-run-id>          # 1. stop the publish run first
  # 2. fix/remove the unintended commit on main (guard override as above)
  git tag -d v<version> && git push origin :refs/tags/v<version>
  git tag v<version> && git push origin v<version>   # 3. re-cut the tag
  ```
- Tag not on `main`: the release workflow fails the on-main guard — re-tag the
  correct commit.
- Missing CHANGELOG section: the extraction step exits non-zero and no Release is
  created. The workflow checks out the tagged commit, so editing `CHANGELOG.md`
  alone is not enough — commit the `## <version>` section (a main-landing
  commit/push needs the guard override), then move the tag to the new commit
  and re-push:

  ```bash
  DEVLOOPS_ALLOW_MAIN=1 git add CHANGELOG.md
  DEVLOOPS_ALLOW_MAIN=1 git commit -m "docs: add v<version> CHANGELOG section"
  DEVLOOPS_ALLOW_MAIN=1 git push origin main
  git tag -f v<version>
  git push --force origin v<version>
  ```
