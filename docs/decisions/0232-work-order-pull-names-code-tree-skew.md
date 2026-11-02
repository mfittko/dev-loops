# 0232. A work order pull across two code trees names the skew and the rerun command

## Status

Accepted — 2026-11-02

## Context

Issue [2662](https://github.com/mfittko/dev-loops/issues/2662) describes a work order emitted by one dev-loops code tree and pulled by another. When the work-order identity code may differ between the trees, the digest does not reproduce and the pull refuses with a bare `semantic_identity_mismatch`. The message gives no sign that two code trees are involved.

ADR 0117 and ADR 0124 already delegate review and fixer pulls to the emitting tree by index location and authority branch. The skew case is the one where that delegation did not apply.

## Decision

- The emitter records its toolchain root as `emitterRoot` in the execution index entry.
- A `semantic_identity_mismatch` refusal, and the `judge-pass.mjs` "does not reproduce the work order" refusal, append a note when the recorded `emitterRoot` differs from the pulling tree's toolchain root. The note names both roots, both dev-loops versions and the rerun command through the emitting tree: `dev-loops-run --repo-root <emitterRoot> <script> <arguments>`.
- The refusal code and the original message stay unchanged. A same-root mismatch and an index entry without `emitterRoot` keep the plain refusal.
- The pull refuses and names the remedy. It does not retry through the recorded root on its own, because that would execute another tree's code from a path the pulling tree has not validated.

## Consequences

An operator or coordinator sees the code-tree skew and reruns the pull through the emitting tree. Index entries gain one field. Older entries stay readable.
