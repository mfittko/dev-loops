---
title: Ops, CI and release
status: snapshot
snapshot_date: 2026-11-19
---
<a id="10-ops-ci-release"></a>

## Ops, CI and release

dev-loops ships through six GitHub Actions workflows and a tag-driven release. Pull requests run on a feature branch inside a worktree under `tmp/worktrees/dev-loops/`. CI on the current head is the validation authority, because this repo's `.devloops` sets `validation.mode: ci-only`. The runbook lands the release commit directly on `main` under the `DEVLOOPS_ALLOW_MAIN=1` override. The recent tags sit on squash-merged release pull requests instead, a path that `merge-pr.mjs --stable-release` supports. Pushing a `v*` tag then creates the GitHub Release and dispatches the npm publish. A stable tag also needs a fresh operator `approve release v<version>` comment, which two workflows check independently. Counts in this section come from `git tag` and `git for-each-ref` on the main checkout on 2026-11-19, unless a caption names another command.

<a id="d129"></a>

### Event to workflow map

Type: `flowchart`

Which GitHub event starts which workflow. Pull requests reach only `CI` and `Gate evidence`. A push to `main` also runs Pages and the wiki compile. Only a `v*` tag reaches the release path, and `npm-publish.yml` is started by an explicit `gh workflow run` because a release created with `GITHUB_TOKEN` never fires `on: release`. Derived from the `on:` blocks of `.github/workflows/ci.yml`, `.github/workflows/gate-evidence.yml`, `.github/workflows/release.yml`, `.github/workflows/npm-publish.yml`, `.github/workflows/pages.yml` and `.github/workflows/wiki.yml`.

```mermaid
flowchart LR
  pr(["pull_request"])
  rev(["review / review comment"])
  ic(["issue_comment"])
  pm(["push to main"])
  tag(["push tag v*"])
  wd(["workflow_dispatch"])
  rp(["release published (UI)"])
  ci["ci.yml"]
  ge["gate-evidence.yml"]
  pg["pages.yml"]
  wk["wiki.yml"]
  rl["release.yml"]
  np["npm-publish.yml"]
  pr --> ci
  pr --> ge
  rev --> ge
  ic --> ge
  pm --> ci
  pm --> pg
  pm --> wk
  tag --> rl
  rl -- "gh workflow run --ref tag" --> np
  wd --> np
  wd --> pg
  wd --> wk
  rp --> np
```

<a id="d130"></a>

### CI jobs in ci.yml

Type: `block-beta`

The job layout of the `CI` workflow. `changes` computes diff scopes and a trusted timing snapshot. Six `verify-suite` matrix legs run in parallel: `test:docs`, `test:workflows` and four `test:all` shards. Three WebKit smoke jobs run on `ubuntu-24.04` only when their scope output is true. `verify` is the single aggregate check and accepts `skipped` only for the smoke jobs. `publish-timings` runs only on a push to the default branch. Derived from the `jobs:` block of `.github/workflows/ci.yml` and the suite list in `scripts/verify.mjs`.

```mermaid
block-beta
  columns 6
  ch["changes: diff scope + timing snapshot"]:6
  d["test:docs"] w["test:workflows"] a1["test:all 1/4"] a2["test:all 2/4"] a3["test:all 3/4"] a4["test:all 4/4"]
  vs["viewer-smoke (if scope)"]:2 dk["deck-smoke (if scope)"]:2 ar["article-smoke (if scope)"]:2
  ve["verify: aggregate required check"]:6
  pt["publish-timings: main push only"]:6
```

<a id="d131"></a>

### Pull request and release on one graph

Type: `gitGraph`

A feature branch created by `ensure-worktree.mjs` from fresh `origin/main`, a squash-merged pull request, then a release branch whose bump is squash-merged and tagged on `main`. The runbook also allows a direct release commit on `main` with `DEVLOOPS_ALLOW_MAIN=1`, which the default-branch guard hooks refuse otherwise. The tags from v1.0.11 to v1.0.12-pre.5 point at release commits whose subjects carry a PR number (`git log -1 --format=%s <tag>`), while v1.0.5 to v1.0.10 carry none. Branch names, tag names and the PR number are synthetic. Derived from `skills/docs/worktree-guidance.md` (`WORKTREE-CREATE-PROVISION`, `WORKTREE-DEFAULT-BRANCH-GUARD`), `skills/docs/release-runbook.md` (Procedure), `scripts/release/bump-version.mjs` and `scripts/github/merge-pr.mjs` (default `--method squash`, `--stable-release`).

```mermaid
gitGraph
  commit id: "main tip"
  branch issue-4001
  checkout issue-4001
  commit id: "test first"
  commit id: "fix + changes fragment"
  checkout main
  commit id: "other squash merge"
  checkout issue-4001
  merge main id: "sync base"
  commit id: "review fix"
  checkout main
  commit id: "squash of issue-4001"
  branch release-1-2-0
  checkout release-1-2-0
  commit id: "bump-version.mjs 1.2.0"
  checkout main
  commit id: "chore(release): v1.2.0 (#4002)" tag: "v1.2.0"
```

<a id="d132"></a>

### Tag push to npm

Type: `sequenceDiagram`

The automated path after the operator or an agent pushes a tag. `release.yml` runs four guards before it creates the Release: the commit is on `origin/main`, the manifests and lockfile are in lockstep, the stable approval exists, and the CHANGELOG section exists. `npm-publish.yml` repeats the on-main guard and the approval gate for both packages, runs `bun run verify`, dry-run packs both packages, and publishes each package only when the version is absent from the registry. Derived from `.github/workflows/release.yml`, `.github/workflows/npm-publish.yml` and `skills/docs/release-runbook.md` ("What happens automatically").

```mermaid
sequenceDiagram
  actor Op as Operator or agent
  participant GH as GitHub
  participant RL as release.yml
  participant NP as npm-publish.yml
  participant NPM as npm registry
  Op->>GH: git push origin vX.Y.Z
  GH->>RL: on push tags v*
  RL->>RL: tag commit is ancestor of origin/main
  RL->>RL: assert-core-dependency-version.mjs
  RL->>RL: verify-release-approval.mjs (stable only)
  alt Release already exists
    RL->>RL: skip create (idempotent)
  else no Release yet
    RL->>RL: extract-changelog-section.mjs (fail closed)
    RL->>GH: gh release create --latest or --prerelease
  end
  RL->>GH: gh workflow run npm-publish.yml --ref tag
  GH->>NP: workflow_dispatch
  NP->>NP: on-main guard + approval for root and core
  NP->>NP: bun run verify + npm pack --dry-run x2
  loop core, then root
    NP->>NPM: npm view name@version
    alt not published
      NP->>NPM: npm publish --provenance --tag dist-tag
    else already published
      NP->>NP: notice and skip
    end
  end
```

<a id="d133"></a>

### Stable approval gate

Type: `stateDiagram-v2`

How `resolveApprovalState` decides a release. A prerelease resolves to a non-`latest` dist-tag and the gate does not apply. A stable version without a parseable release commit date throws, so the gate fails closed. For a stable version, only comments by the operator that pass `isGenuineApprovalAssertion` count: quoted, instructional and negated phrases are dropped. One genuine approval whose `created_at` is strictly after the release commit date is enough. Otherwise the refusal names the case in this order of preference: stale, unverifiable, or missing. Derived from `scripts/release/verify-release-approval.mjs` and the "Operator release approval gate" section of `skills/docs/release-runbook.md`.

```mermaid
stateDiagram-v2
  [*] --> DistTag: resolveNpmDistTag(version)
  DistTag --> NotApplicable: dist-tag is not latest
  DistTag --> Ref: dist-tag is latest
  NotApplicable --> [*]
  Ref --> Thrown: release commit date not parseable
  Thrown --> [*]: fail closed
  Ref --> Filter: release commit date parsed
  Filter --> Genuine: author is operator and assertion is genuine
  Filter --> Missing: no genuine match
  Genuine --> Approved: any created_at after release commit
  Genuine --> Stale: else some created_at at or before
  Genuine --> Unverifiable: else created_at not parseable
  Approved --> [*]
  Stale --> Refused
  Unverifiable --> Refused
  Missing --> Refused
  Refused --> [*]: exit 1, no Release, no publish
```

<a id="d134"></a>

### npm dist-tag resolution

Type: `flowchart`

How `resolve-npm-dist-tag.mjs` picks the npm dist-tag. Both `release.yml` (for the `--latest` or `--prerelease` flag) and `npm-publish.yml` (for `--tag`) call it, so the GitHub Release flag and the npm dist-tag cannot drift. Build metadata is stripped before the prerelease part is read. A purely numeric prerelease and the token `latest` both fall back to `next`. A garbled version fails closed with exit 2 and never falls through to `latest`. Derived from `scripts/release/resolve-npm-dist-tag.mjs`, `.github/workflows/release.yml` and `.github/workflows/npm-publish.yml`.

```mermaid
flowchart TD
  v["--version input"] --> s{"matches SemVer 2.0.0 regex?"}
  s -- no --> e["exit 2: fail closed"]
  s -- yes --> p{"has prerelease part?"}
  p -- no --> l["latest"]
  p -- yes --> t{"first identifier starts with letters?"}
  t -- yes --> ex["1.0.0-rc.1 to rc, x-pre.5 to pre"]
  t -- "no, or token is latest" --> nx["next"]
  l --> gr["gh release create --latest"]
  ex --> gp["gh release create --prerelease"]
  nx --> gp
  l --> np["npm publish --tag latest"]
  ex --> nc["npm publish --tag channel"]
  nx --> nc
```

<a id="d135"></a>

### Gate validation authority

Type: `flowchart`

How `gate resolve-validation` produces full-repository evidence. A dirty worktree or a stale base resolves `incomplete` first. The gate reads the `validation` block from the default branch, never from the PR head. A PR whose checkout block differs in anything other than `paths` resolves `incomplete` and runs nothing (ADR 0192 admits a paths-only difference). In `ci-only` mode, which this repo uses, current-head CI is the only authority and no local suite runs. In `local` mode, the gate runs the declared `fullCommand`, or else checks the Bun pin and runs the `package.json` suites, reusing another lifecycle gate's passing artifact for the same head when one matches. Derived from `scripts/loop/resolve-validation.mjs`, `skills/docs/validation-policy.md` (`VALIDATE-TARGETED-FIRST`) and the `validation:` block of `.devloops`.

```mermaid
flowchart TD
  st["gate resolve-validation"] --> cl{"clean worktree and fresh base?"}
  cl -- no --> inc0["incomplete"]
  cl -- yes --> b["read base validation block from origin/HEAD"]
  b --> d{"checkout block differs outside paths?"}
  d -- yes --> inc["incomplete: config-source change"]
  d -- no --> m{"base mode"}
  m -- "ci-only" --> h{"CI rollup at requested head?"}
  h -- "wrong head or pending" --> inc2["incomplete"]
  h -- failure --> f["failed"]
  h -- success --> r{"any SUCCESS check ran?"}
  r -- no --> inc3["incomplete: CI ran no checks"]
  r -- yes --> ok["complete, authority ci-authoritative"]
  m -- local --> dc{"fullCommand declared?"}
  dc -- yes --> runc["run declared fullCommand"]
  dc -- no --> pin{"bun version matches packageManager pin?"}
  pin -- no --> inc4["incomplete"]
  pin -- yes --> run["run package suites or reuse same-head artifact"]
  runc --> art["write head-pinned artifact"]
  run --> art
```

<a id="d136"></a>

### Gate evidence trust split

Type: `sequenceDiagram`

The three jobs of `Gate evidence` and their trust boundary. PR head code runs only in `head-declared-keys`, which has `permissions: {}` and no secrets, and its output is data. The runner and reporter run default-branch code only. The runner uses a cancelling per-PR concurrency group. The reporter uses a non-cancelling group, so the final event in a burst always posts the required status. On `issue_comment`, only gate verdict, `approve merge` and carried-heads markers from owners, members or collaborators start a run. Derived from `.github/workflows/gate-evidence.yml`.

```mermaid
sequenceDiagram
  participant Ev as PR or comment event
  participant HK as head-declared-keys
  participant RN as gate-evidence-runner
  participant RP as gate-evidence-reporter
  participant St as Commit status
  Ev->>HK: pull_request* on a ready PR
  Note over HK: head code, permissions {}, no secrets
  HK-->>RN: declared_keys as data (may be empty)
  Ev->>RN: marker comment or ready PR event
  Note over RN: default-branch code, cancel-in-progress true
  RN-->>RP: evidence_state (absent if cancelled)
  Note over RP: always() unless runner skipped, cancel-in-progress false
  RP->>RP: resolve PR number, draft, head SHA again
  RP->>St: post gate evidence status for head SHA
```

<a id="d137"></a>

### Worktree lifecycle

Type: `stateDiagram-v2`

The life of a loop-owned worktree. `ensure-worktree.mjs` fetches, then reuses an existing worktree at the canonical path or creates one. An existing worktree on a different branch is a hard conflict. On create, the branch origin is an existing local branch, a tracked remote branch, or a new branch off the base, and only a created worktree gets `bun install --frozen-lockfile`. Both paths install the `pre-commit`, `pre-merge-commit` and `pre-push` guard hooks. After a confirmed merge, `scripts/github/merge-pr.mjs` calls `cleanupWorktree`. Cleanup skips a dirty or locked worktree or one that holds `tmp/gate-findings/` files, and never touches a path outside `tmp/worktrees/dev-loops/`. Derived from `skills/docs/worktree-guidance.md` (`WORKTREE-CREATE-PROVISION`, `WORKTREE-CLEANUP`), `scripts/loop/ensure-worktree.mjs`, `packages/core/src/loop/default-branch-guard.mjs` and `scripts/loop/cleanup-worktree.mjs`.

```mermaid
stateDiagram-v2
  [*] --> Fetch: ensure-worktree.mjs
  Fetch --> PathCheck: git fetch --prune (best effort)
  PathCheck --> Conflict: worktree on other branch
  Conflict --> [*]: hard error
  PathCheck --> Reused: worktree at path exists
  PathCheck --> Create: no worktree at path
  Reused --> Guarded: reused-local or reused-detached
  Create --> Provisioned: reused-local, tracked-remote or created-from-base
  Provisioned --> Guarded: bun install --frozen-lockfile
  Guarded --> Working: guard hooks installed
  Working --> Merged: PR merged
  Merged --> Removed: cleanup-worktree.mjs
  Merged --> Kept: dirty, locked or gate-findings present
  Removed --> [*]
  Kept --> [*]: manual cleanup fallback
```

<a id="d138"></a>

### Seven bump surfaces

Type: `mindmap`

The seven release surfaces that one `bump-version.mjs <version>` call sets in lockstep, plus the drift guards it runs afterwards. The script stages only these files and never commits, tags, pushes or publishes. Derived from `skills/docs/release-runbook.md` (Procedure step 1), `scripts/release/bump-version.mjs`, `scripts/release/assemble-changelog-fragments.mjs` and `scripts/release/assert-core-dependency-version.mjs`.

```mermaid
mindmap
  root((bump-version.mjs))
    Manifests
      root package.json version
      packages/core version
      root core range
    Lockfiles
      bun.lock
    Claude plugin
      plugin manifest version
      .claude package pin and lock
    Changelog
      assemble changes fragments
      fold prerelease sections
      stamp Unreleased heading
    Drift guards
      assert-core-dependency-version
      generate-claude-assets --check
```

<a id="d139"></a>

### Release week

Type: `gantt`

One release week from v1.0.11-pre.1 to v1.0.12-pre.5. The milestone dates are real tag creation dates from `git for-each-ref --sort=creatordate refs/tags`. The bar spans between tags are synthetic and only show the order of work. The combined retro and the five post-release steps are runbook rules (`RELEASE-COMBINED-RETRO`, `RELEASE-POST-RELEASE-RECURRING-STEPS`) that the orchestrator files as issues, so their bars are spec-only and their dates are synthetic. Derived from `skills/docs/release-runbook.md` and the tag list.

```mermaid
gantt
  title Release week (tag dates real, spans synthetic)
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section Stable cut
  v1.0.11-pre.1 tag :milestone, m1, 2026-11-09, 0d
  Soak prerelease :a1, 2026-11-09, 2d
  Operator approval comment, synthetic :a2, 2026-11-11, 1d
  v1.0.11 tag :milestone, m2, 2026-11-11, 0d
  section Next milestone
  Combined retro, spec-only :b1, 2026-11-11, 1d
  Post-release steps, spec-only :b2, 2026-11-12, 3d
  v1.0.12-pre.1 tag :milestone, m3, 2026-11-12, 0d
  v1.0.12-pre.2 tag :milestone, m4, 2026-11-13, 0d
  v1.0.12-pre.3 and pre.4 tags :milestone, m5, 2026-11-16, 0d
  v1.0.12-pre.5 tag :milestone, m6, 2026-11-17, 0d
```

<a id="d140"></a>

### Stable release history

Type: `timeline`

The stable tags from v1.0.5 to v1.0.11 with their creation dates, and the prereleases cut before each one. Dates come from `git for-each-ref --sort=creatordate --format='%(refname:short) %(creatordate:short)' refs/tags`. The insight: from v1.0.8 on, every stable cut follows one to four `-pre.N` tags, while v1.0.7 shipped without one. Derived from the repository tags and `.github/workflows/release.yml`.

```mermaid
timeline
  title Stable tags and their prereleases
  2026-10-01 : v1.0.5 : after pre.0 and pre.1
  2026-10-16 : v1.0.6 : after pre.0 to pre.2
  2026-10-19 : v1.0.7
  2026-10-28 : v1.0.8 : after pre.1 to pre.3
  2026-11-04 : v1.0.9 : after pre.1 to pre.4
  2026-11-06 : v1.0.10 : after pre.1 and pre.3
  2026-11-11 : v1.0.11 : after pre.1
```

<a id="d141"></a>

### Days between stable tags

Type: `xychart-beta`

The gap in days from each stable tag to the previous one. The values are differences of the tag dates from `git for-each-ref --sort=creatordate refs/tags`. The cadence tightened from 15 days to between 2 and 9 days. Derived from the repository tags.

```mermaid
xychart-beta
  title "Days since previous stable tag"
  x-axis ["v1.0.6", "v1.0.7", "v1.0.8", "v1.0.9", "v1.0.10", "v1.0.11"]
  y-axis "days" 0 --> 16
  bar [15, 3, 9, 7, 2, 5]
```

<a id="d142"></a>

### Tags by kind

Type: `pie`

All 68 version tags split by kind. `git tag | grep -c -v -e '-'` gives 35 stable tags, and the prerelease suffixes give 25 `pre`, 7 `rc` and 1 `slim`. Every prerelease kind maps to its own npm dist-tag channel and never to `latest`. Derived from `git tag` and `scripts/release/resolve-npm-dist-tag.mjs`.

```mermaid
pie showData
  title Version tags by kind (git tag)
  "stable" : 35
  "pre" : 25
  "rc" : 7
  "slim" : 1
```

