# 0017. Put consumer configuration in a root-level `.devloops` file with layered, fail-closed precedence

## Status

Accepted

## Context

Workflow policy lived scattered across chat instructions, skill text, and hardcoded defaults, so behavior drifted between runs and every policy change was prompt surgery instead of a contract update — which is why the config contract (Phase 8, `docs/phases/phase-8.md`) was pulled forward ahead of the deferred second-repo pilot. The zod-validated schema, loader, and precedence merging landed in [PR 295](https://github.com/mfittko/dev-loops/pull/295), with the override file renamed to `settings.*` in [PR 380](https://github.com/mfittko/dev-loops/pull/380). Consumer overrides then sat at `.pi/dev-loop/settings.yaml` — a Pi-branded path buried in a harness directory — which [issue 738](https://github.com/mfittko/dev-loops/issues/738) / [PR 739](https://github.com/mfittko/dev-loops/pull/739) moved to a root-level `.devloops` file. Extension-packaged defaults were initially not loaded in consumer repos at all ([issue 802](https://github.com/mfittko/dev-loops/issues/802), fixed in [PR 803](https://github.com/mfittko/dev-loops/pull/803)), and the repo-local `defaults.yaml` duplicating them was removed in [PR 805](https://github.com/mfittko/dev-loops/pull/805). The shipped defaults later drifted stricter than the code defaults, forcing the retrospective gate on every consumer, corrected in [PR 845](https://github.com/mfittko/dev-loops/pull/845); the resolved chain lives in `packages/core/src/config/config.mjs` and this repo's own `.devloops`.

## Decision

We resolve all workflow configuration through one canonical surface with explicit layered precedence: built-in code defaults, then extension-packaged defaults, then a root-level `.devloops` file (bare YAML by default, with `.yaml`/`.yml`/`.json` variants), with per-run flags above the whole chain. Validation is fail-closed: unknown keys and contradictory config reject the load rather than silently merging. Shipped defaults must stay permissive and byte-equivalent in effect to the code defaults — dev-loops opts into its own stricter gates only via its own `.devloops`, never by tightening what consumers inherit. We rejected keeping the Pi-branded `.pi/dev-loop/settings.yaml` home (it ties the product's config identity to one harness's directory layout; it survives only as a deprecated fallback that warns and never overrides `.devloops`), and we deliberately did not invent a gitignored session-only config layer — per-run flags already cover ephemeral overrides.

## Consequences

Every configurable behavior added since resolves through this file and precedence chain, so policy changes are config edits with schema validation instead of prompt surgery, and behavior no longer drifts between runs. Consumers get permissive defaults by policy: any repo that sets nothing gets exactly the code defaults, and strictness is always an explicit local opt-in. The `.devloops` name became the product's public config identity, decoupled from the Pi harness layout, at the cost of carrying the deprecated `.pi` fallback and its migration warnings until removal. The standing commitment is that shipped defaults and code defaults must not diverge — any gap between them is a bug, not a tuning knob.
