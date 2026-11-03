# 0242. A converted reader of a sealed gate artifact refuses a missing seal

## Status

Accepted — 2026-11-03 ([issue 2971](https://github.com/mfittko/dev-loops/issues/2971), slice 2a).

Amends [ADR 0204](./0204-seal-gate-ledgers-against-out-of-band-writes.md). The Decision bullets on legacy artifacts, the reader list and the "Known unconverted readers" section of that record are replaced by this record. Accepted records remain unchanged.

## Context

ADR 0204 added a sha256 seal beside the keyed fan-in ledger and the findings log. It accepted an artifact with no seal as a legacy artifact. An agent could delete the `.seal` file, edit the artifact and pass every sealed read. ADR 0204 also listed readers as unconverted that were already converted, and named too few converted readers. The grill on issue 2971 corrected the list against the code at `94e45f34a`.

## Decision

- `readSealed` refuses an artifact with no `.seal` file. The error carries the typed code `gate_artifact_unsealed` and names the file and the next step: re-run the sanctioned writer at that head. For a prior-head findings log, `GATE-EXEC-FINDINGS-LOG-QUARANTINE` names the quarantine command.
- A seal mismatch keeps the typed code `gate_artifact_out_of_band_write`. A reader that fails closed on one code fails closed on both, through `isSealRefusal`. `formatCliError` carries both codes.
- Legacy migration: gate ledgers and findings logs are per head and ephemeral. A pre-seal artifact is not migrated in place. The sanctioned writer produces a sealed artifact at the next run of that head, and the quarantine command moves an unsealed log aside.
- The artifacts a sanctioned writer seals are the keyed fan-in ledger (`consolidate-fanin.mjs`), the judged ledger that `judge-pass.mjs --ledger-out` writes, and the findings log (`write-gate-findings-log.mjs` and the `judge-pass.mjs` defer stamp). A reader of one of these artifacts reads it with `readSealed`. These readers are converted:
  - `write-gate-findings-log.mjs` reading the fan-in ledger.
  - `_findings-input.mjs` `resolveFindingsInput` for `--findings-file`.
  - `_gate-finding-surface.mjs` `readGateFindingsLedger` and `collectLocalJudgeDispositionMatches`.
  - `upsert-checkpoint-verdict.mjs` through `readGateFindingsLedger`.
  - `write-gate-context.mjs` `readClosedPriorRoundLogs`.
  - `resolve-angle-carry-forward.mjs` and `emit-fanout-dispatch.mjs` reading the prior findings log.
  - `emit-judge-work-order.mjs` `readSource` for the findings source.
  - `judge-pass.mjs` for the `--findings-file` ledger and the defer stamp.
  - `quarantine-gate-findings-log.mjs`, which treats a missing seal as an integrity failure it can quarantine.
  - `detect-checkpoint-evidence.mjs` (provenance and act list reads).
  - `waive-adr-tripwire.mjs` `defaultReadRecordedSpecDigest`.
- `judge-pass.mjs` reads its spec, verdict and other inputs without a seal check, because no writer seals them.
- Known unconverted reader: `check-pre-push-delta.mjs` `roundAnglesOf` reads `--findings-log` with a plain `readFileSync`. Its fixtures across several test files write unsealed logs. A follow-up converts it with `readSealed`.
- A reader whose catch skips an unreadable file treats a seal refusal as a hard failure, not as "no ledger".
- `judge-pass.mjs --ledger-out` writes with `writeSealed`, so the enriched ledger it hands to `write-gate-findings-log.mjs` carries a seal.

Split with issue 2892 (ADR 0239):

- Issue 2971 owns the sidecar seal on the keyed fan-in ledger and the findings log: refuse a missing seal, refuse a hand edit, convert the readers.
- Issue 2892 slice 2 owns binding those files, the judge decisions, dispositions, act list and verdict writer to the producing run through the run record in `tmp/evidence-runs`.
- This record builds no run record and does not call `evidence-seal.mjs`. The two layers stack. A run digest may sit next to the sidecar without changing the sidecar contract.

## Consequences

An out-of-band writer can no longer bypass the check by deleting the `.seal` file. A hand-authored `--findings-file` fails with `gate_artifact_unsealed`, so the file comes from `consolidate-fanin.mjs --ledger-out` or `judge-pass.mjs --ledger-out`, or the findings go through `--findings`. A writer that also rewrites the seal stays out of reach of the sidecar and is the scope of issue 2892.
