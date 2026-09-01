# rc.7 retro PR-body accuracy corrections — PRs 1854 and 1847

Record of the merged-artifact corrections applied per #1890 (from the rc.7
fresh-context retro triage #1874, findings "pr-body-accuracy").

## What was false

1. **PR 1854** — title "records-floor closed (completes #1468 cache-align)" and DoD
   checkbox "[x] #1468 records-floor residual closed" over-claimed. At merge commit
   `f342fa91`, `scripts/loop/consolidate-fanin.mjs` enforced the briefing-prefix and
   expected-units checks only when `reviewerCount > 0`, and
   `scripts/github/verify-briefing-prefixes.mjs` returned `{verified:true}` when
   `sentinels.length === 0` — an unrecorded/agent-composed round still passed vacuously.
   #1468 itself was and is still OPEN; the code gap was tracked by #1868 and has since
   been fixed (merged to main in #1881).
2. **PR 1847** — DoD checkbox "[x] Manual: `/loop-review` run interactively against an
   open PR, Leave pending chosen …" claimed a verification that was not performed:
   #1842 B3 (same session, same deliverable) records the interactive submit-choice flow
   as un-exercised, and no artifact (PR URL / draft-review id) corroborates an
   interactive run. Only the deterministic headless refusals and the headless
   `--submit comment` posting were verified.

## Corrections applied (2026-09-01)

- **PR 1854** — title restated as "records-floor closed on the canonical path only
  (completes #1468 cache-align; zero-records residual tracked by #1868)"; body carries a
  dated correction paragraph (what was true at merge, what was not), an amended AC line,
  and the DoD line restated as "records-floor residual closed on the canonical composer
  path only; the vacuous-pass on an unrecorded/agent-composed round remained at merge
  (tracked by #1868, since fixed)". Provenance record comment:
  <https://github.com/mfittko/dev-loops/pull/1854#issuecomment-5495739939>
- **PR 1847** — DoD line restated as deterministic-only: the interactive manual step was
  NOT performed; what was verified is the headless refusals (`--submit approve` /
  `--submit request-changes` refused under `--auto`; `--submit` on gate surfaces
  rejected) and the headless `--submit comment` posting
  (pull/1461#pullrequestreview-5062828929). Provenance record comment:
  <https://github.com/mfittko/dev-loops/pull/1847#issuecomment-5495741479>
- **Issue #1890** — its single AC checkbox checked against these evidence pointers.

## Why in-tree

The correction itself is GitHub-side (title/body/comment edits on merged PRs; the code
content of both PRs is unchanged), but a durable record belongs in the repository so
the accuracy fix survives link-rot and is greppable next to the AC-truthfulness class
#1863's PR-description backfill was meant to end. This file is that record; it makes
no behavioral claim and changes no tooling.
