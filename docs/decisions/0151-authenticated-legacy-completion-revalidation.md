# 0151. Authenticate explicit legacy completion revalidation

## Status

Proposed — accepted on merge of [issue 2785](https://github.com/mfittko/dev-loops/issues/2785).

## Context

ADR 0150 reserves later qualification of historical Delta records without coverage
hashes. Those records must remain unchanged. Semantic work-order identity excludes
local read paths, hashes and byte lengths, so an archived semantic digest alone
cannot authenticate which ACT and Delta bytes the original full worker read.

## Decision

Add one explicit consumer exception inside the existing semantic-and-byte-bound
completion input: `legacyRevalidation: { origin: "legacy_revalidated", originalFull:
{ workOrderRef, workOrderDigest, executionIdentity, planBytesDigest },
handbackBytesDigest, clearingDecisionBytesDigest, treeOid, queryOutputBytesDigest }`.
Keep the original commit-only `completion.origin` triple unchanged. Only both
historical coverage hashes absent, with no modern binding fields, qualify.
Malformed, null, partial or current bindings refuse without downgrade.

Derive the canonical archive, original prompt, receipt, ACT/Delta and clearing
paths. Authenticate the distinct older original full identity and original
canonical receipt subject. Bind raw archive bytes and semantic identity; require
the exact old prompt hash to match both archive and real receipt materialization
hashes. Its complete final Work order JSON suffix must equal the entire archived
order, sealing the excluded local read fields without rerendering old prose.
Require exactly one required ACT and Delta read with matching original/current
raw hashes/lengths and semantic authorities. No original full report is required.

After the common genuine commit-only pull/subject/after-pull/raw-handback checks,
require canonical clearing bytes, fresh unchanged `locally_clear`/`push` candidate
and resolved ACT members. Independently run the sole supported ACT literal
`readValidationEvidence|requireBinding|validationResultsPath|prefix-file` using
native `git --no-pager -c color.ui=never grep -n -E <literal> <full-candidate> --`.
Use repository top-level cwd, scrub Git directory overrides, disable object
replacement, and bound every identity/tree/query call to 10000ms, SIGKILL and 1MiB.
Reject every failed, partial or malformed result. Compare exact stdout bytes and
complete raw file/form coverage, using normalization only to validate gaps.
Recheck tree and active canonical plan after the query in every consumer mode.

## Consequences

Historical evidence and receipt bytes remain untouched; archives never become
pullable plans. Existing protocol authentication does not attest unrelated receipt
bytes. Current authenticated compound authority asserts capture before pointer
replacement; hashes and timestamps do not independently prove that chronology.
Later producer work must perform/prove archive ordering and fresh-worker smoke.
This consumer enables no producer, source recovery, new Delta or A1 operation.
Generated native fixtures and historical producer/pull acceptance prove consumer
behavior only. Accepted ADRs 0147–0150 remain unchanged.
