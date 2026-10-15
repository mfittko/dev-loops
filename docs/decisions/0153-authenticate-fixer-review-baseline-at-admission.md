# 0153. Authenticate fixer reviewed-baseline authority at admission

## Status

Accepted — 2026-10-15 ([implementation commit](https://github.com/mfittko/dev-loops/commit/3bd692da0cfd9d12d16ae102a82886bc8e602357)) <!-- secret-scan:allow public implementation commit URL, verified Git object; not a credential -->

## Context

[Issue 2793](https://github.com/mfittko/dev-loops/issues/2793) separates the original
reviewed baseline A from the full fixer's candidate head B before populated producer
support in [issue 2786](https://github.com/mfittko/dev-loops/issues/2786). The existing
optional completion consumer already uses that distinction. Pull and mutation grants
must authenticate supplied authority independently, including old-reader receipts.
The delegated queue implementation accepts this enforcement seam on its implementation
commit; the status records that actual commit before pre-PR review and first push.

## Decision

Share one pure `assertFixerReviewBaseline` in the existing work-order digest module,
vendored by the existing Claude asset generator. Canonical locator/pull, current grant
and completion admission authenticate the optional own field against unique required
ACT/Delta reads, exact bytes and lengths, complete JSON content digests and Delta's
matching 40-character lowercase reviewed head. Preserve all JSON keys, absolute strings
and array order in content identity. Reject malformed, inapplicable or partial authority.

Protect each distinct A/B with existing retirement scans and timestamps. Continue
branch containment against B alone. Absent authority returns before new ACT/history
reads and retains legacy behavior. Keep populated production disabled in this change.

Completion-only enforcement would let a genuine old-reader receipt grant mutation
under unauthenticated authority. Reusing the work-order canonicalizer would discard
semantic JSON content. Neither alternative provides the required admission boundary.

## Consequences

The later producer can supply the field after these independently exercised consumers
land. Current-main and PR-head producers still omit it and remain compatible. Supplied
authority requires modern ACT/Delta read metadata; absent historical records and their
separate revalidation path retain unchanged qualification requirements. Prior decision
records, historical coverage hashes, receipt binding and archival authority stay unchanged.
