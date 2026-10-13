# 0145. Enforce validation role boundaries and share gate evidence

## Status

Accepted — 2026-10-13 ([operator acceptance record](https://github.com/mfittko/dev-loops/commit/3c27dc0cb2cb6bb886f7808d7519140f9b845b04)) <!-- secret-scan:allow public acceptance commit link, no credential value -->

## Context

[ADR 0105](./0105-targeted-validation-and-full-run-authority.md) assigns targeted checks to workers and local full-repository validation to one resolver; it leaves runtime enforcement to a later slice. [Issue #2470](https://github.com/mfittko/dev-loops/issues/2470), implemented by [PR #2754](https://github.com/mfittko/dev-loops/pull/2754), supplies that boundary and moves gate participants onto the resolver's evidence. The shared docs-review prompts previously directed reviewers to execute mechanical link validation, contrary to the review role's evidence-only responsibility.

Operator acceptance is recorded in [the issue acceptance comment](https://github.com/mfittko/dev-loops/issues/2470#issuecomment-6155777358).

This record extends ADR 0105. It preserves [ADR 0136](./0136-judge-bash-boundary-allows-decision-check.md)'s sanctioned judge-decision check and [ADR 0137](./0137-validation-modes-and-consumer-configured-commands.md)'s validation modes and trusted command source. Those accepted records remain unchanged. <!-- secret-scan:allow public ADR links, no credential value -->

## Decision

Scoped and standalone reviewers and judges cannot start test or build processes. Developers and fixers retain the targeted checks selected by `resolveTargetedValidation(changedPaths)`; local full-repository runs belong only to `dev-loops gate resolve-validation`. Coordinators request or consume validation through that resolver and its artifact. No role gains a direct package-manager full-run escape.

Claude Code enforces these boundaries through the native `agent_type` Bash hook input, and Pi through its role-aware tool-call handler. Codex semantic gate execution remains unqualified and fails closed until a supported execution boundary denies the process before it starts. Pi dispatch role-marker wiring remains separate work under [issue #2582](https://github.com/mfittko/dev-loops/issues/2582).

The gate preamble, context, reviewer work orders and judge inputs share the head-bound `<gate>-<headSha>.validation.json` reference at `scope.validationResultsPath`. Reviewers and judges return typed blocked or incomplete results for absent or wrong-head evidence and never run validation as a fallback. Docs reviewers inspect link intent and consume the mechanical link result from this evidence. The judge retains read/search and verdict-artifact writing, including its existing sanctioned decision check.

For `draft_gate` and `pre_approval_gate`, red evidence stops reviewer fan-out before work-order writes. A failed artifact returns `validation_failed` with each failing suite and log path; incomplete evidence returns `validation_incomplete` with its reason. Neither route dispatches reviewers or a judge or posts a verdict. The dev-loop coordinator routes failed evidence through a typed fixer work order using `--validation-file`, binding the failing logs as required reads. Fixers run targeted checks, and the next head gets fresh resolver evidence. Incomplete evidence permits one same-head retry; a second incomplete result stops for the operator. The gate coordinator reports the observation and never dispatches the fixer.

Independent participant reruns and command-spelling changes cannot substitute for the shared evidence or its owner. This decision adds neither a missing-artifact fan-out stop nor a red-evidence stop for standalone `review`.

## Consequences

Gate participants assess one auditable current-head result without repeating validation. Failed validation reaches a fixer before semantic review, while unsupported harness execution and unavailable evidence stay explicit. Existing CI, review, approval and merge requirements remain in force. Persistent cross-gate evidence reuse and CI-import measurement remain outside this slice.
