# 0053. Fresh-context retrospective with provenance-gated checkpoints

## Status

Accepted — 2026-08-30 ([issue 1870](https://github.com/mfittko/dev-loops/issues/1870))

## Context

The post-run behavioral retrospective was an inline, self-authored pass: the same working session that did the work reflected on its own record. A self-review validates consistency, not conformance — it inherits the working agent's blind spots and cannot see a systematic error it itself committed. The motivating failure: nine rc.7 PRs shipped stripped-down descriptions and every inline post-merge retro passed them, because a uniformly-wrong template raises no anomaly signal to a self-referential reflection.

Gate reviewers already solve this class of problem with a fresh, neutral context seeded with the exact artifacts under review. The retrospective gets the same treatment, and the checkpoint must be able to distinguish a retro that actually ran that way from one that merely claims to.

## Decision

- The qualifying post-run retrospective runs as a **fresh-context, independent dispatch** — analogous to a gate reviewer — seeded with the cycle's full agent/subagent tool-call/action/result record (the existing session transcript/journal artifacts; no new transcript store). It evaluates neutrally against the contracts and the issue's acceptance criteria / definition of done / non-goals.
- An **inline, self-authored retrospective** is disallowed and fails the checkpoint, fail-closed:
  - `resolveCheckpointStateFromArtifact` (`packages/core/src/loop/retrospective-checkpoint.mjs`) treats a `complete` record whose `provenance` does not pin a fresh-context pass over the record (`context: "fresh"`, `seededFrom: "agent_tool_call_record"`, non-blank `recordSource`) as `MISSING` — every legacy inline retro fails closed. `skipped` records are not provenance-gated (no retro ran).
  - `checkpoint-contract.mjs --state complete` requires `--retro-context fresh --record-source <path>`; `--retro-context inline` is rejected outright.
- Known ceiling, disclosed: only the **attestation** is mechanism-pinned. Provenance is self-attested at write time and `--record-source` accepts any existing non-empty file; nothing verifies the file is the cycle's actual tool-call record or that the retro audited it. The dispatch half is agent discipline (`LOCAL-RETRO-FRESH-CONTEXT-DISPATCH`, `enforcement: "agent"`). The durable guarantee is that no inline/legacy record passes the checkpoint — not that the attestation itself is verifiable. Strengthening to a verified record sink is a future decision, out of scope here.

## Consequences

- Every retro checkpoint written after this decision carries provenance; a retro that claims fresh-context without the CLI-mandated flags cannot be recorded at all.
- All pre-#1870 `complete` checkpoints fail closed (provenance-less legacy shape) and must be re-discharged by an actual fresh-context retro.
- Honest-limitation cost: a determined working session could still self-attest; the ceiling is recorded here and in `RETRO-FRESH-CONTEXT-MANDATORY` rather than papered over by the AC wording.
