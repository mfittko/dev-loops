# 0139. PR create requires a pre-PR review record

## Status

Accepted — 2026-10-11 ([issue 2618](https://github.com/mfittko/dev-loops/issues/2618))

## Context

`PRE-PR-BEFORE-FIRST-PUSH` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md) requires a local review before a branch opens a PR. Three units skipped that review and opened PRs anyway. No script checked the rule, so the skip surfaced only in retros.

## Decision

- `dev-loops loop pre-pr-review --verdict <clean|findings_fixed> --disposition <none|all_applied|rationale_recorded>` is the only writer of the pre-PR review record. It reads the head from git (`git rev-parse HEAD`) and never takes it as an argument. The record holds `head`, `verdict`, `disposition` and an `integrity` field: a sha256 digest over head, verdict and disposition. The writer stores it at `tmp/pre-pr-review/<head>.json` under the main checkout's gate-artifact tmp root, so every worktree shares one record store.
- `pr create` refuses with the typed code `pre_pr_review_missing` when no valid record covers the resolved `--head` branch. The refusal names the rule `PRE-PR-BEFORE-FIRST-PUSH` and the writer command. Head resolution reads the local ref and `origin/<head>`. When both exist and name different commits, `pr create` refuses, because the PR opens at the pushed branch. When only one exists, that one is used.
- A record for the exact head covers it. A record for an ancestor head also covers it when every file changed since that ancestor classifies as `docs` or `test` under the repository classify rules (`.devloops` classify configuration). With a resolvable base, only ancestors in `base..head` count.
- Two cases need no record: a `--lightweight` create, and a plan-doc promotion branch whose whole `base...head` diff is `.md` files under `docs/phases/`. Contract and skill prose under `skills/` always needs a record.
- Enforcement is single-step and immediate. The writer and the guard land in the same change, with no advisory phase. The unkeyed digest stops hand-built record files. It does not stop a determined forger who recomputes the digest.

## Consequences

A skipped pre-PR review now fails `pr create` with a typed, actionable refusal instead of surfacing in a retro. Docs-only and test-only follow-up commits on a reviewed head do not need a new review. Plan-doc promotion and lightweight PRs keep their current flow. A forged record remains possible. A keyed signature is the upgrade path if forgery becomes a real risk.
