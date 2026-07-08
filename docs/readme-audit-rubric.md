# README audit rubric (LLM-as-judge)

This rubric replaces the brittle exact-prose `assert.match`/`assert.doesNotMatch` checks that used to pin README wording in `test/contracts/*.test.mjs`. Those tests broke on every legitimate rewording and, in at least one case, enforced *incorrect* framing. Instead, `README.md` is audited **semantically** by an LLM judge — **on demand** and **harness-driven**: you invoke your agent host (Claude Code / Pi) and have it evaluate the README against the properties below. There is no API/CI wiring here yet; the harness is the runtime.

## How to run the audit (on demand)

Hand this rubric and `README.md` to your agent (e.g. ask the `dev-loop` skill, a reviewer subagent, or any harness agent):

> Read `README.md` and audit it against every property in `docs/readme-audit-rubric.md`. For each property output PASS or FAIL with a one-line reason grounded in a quote or a concrete gap. End with an overall verdict. This is read-only — do not edit anything.

The judge reasons about intent; it must tolerate rewording. A property fails only when the README genuinely lacks or contradicts it — never because a specific sentence changed.

## Properties

1. **Harness-agnostic framing.** Presents the Claude Code plugin, the Pi extension, and the CLI as three surfaces over one shared core; does not center the narrative on Pi (or any single harness).
2. **Public entrypoint.** Establishes `dev-loop` as the single public entrypoint / router. Does not present internal routed seams (e.g. `copilot-dev-loop`, `copilot-autopilot`, `local-implementation`, `final-approval`) as user-facing workflow choices.
3. **Accurate command surface.** Command names match the code: Claude Code plugin commands are `/loop-*` (generated 1:1 from `commands/loop-*.command.md`); Pi exposes them as `/dev-loops <sub>`. Distinguishes dev-loop entrypoints from top-level utilities (`status`, `doctor`, `gates`). No invented or renamed commands.
4. **Landing-page discipline.** Stays a landing page: points readers to `docs/index.md` for deep navigation; does not become a second owner of live execution status or duplicate deep links into `docs/IMPLEMENTATION_STATE.md` / `docs/IMPLEMENTATION_WORKFLOW.md`.
5. **Accurate install / config / requirements.** The shipped-defaults path is correct (`packages/core/src/config/extension-defaults.yaml`), with `.devloops` as the consumer override. Universal requirements (Node ≥24, authenticated `gh`) are separated from Pi-harness-only ones (`pi-subagents`, the `@earendil-works/*` peer deps).
6. **No stale status claims.** Does not assert an execution-phase status that contradicts the status docs (`docs/IMPLEMENTATION_STATE.md`, `docs/index.md`) — prefer omitting internal phase status from the landing page entirely.
7. **Further-reading links resolve.** The docs it links (contract, extension, scripts, migration, UI/slides docs) exist and are the right targets. (`node scripts/docs/validate-links.mjs` covers link resolution deterministically; the judge covers whether the *right* docs are surfaced.)

## Owning this rubric

This file is the single owner of the README's intended properties. Adjusting what "good" means is an edit here — a prose/config change — not a new brittle assertion in a test. Deterministic, non-semantic guarantees (link resolution, no hardcoded version majors) stay in `validate-links.mjs` and the `docs-identity` version-drift check; everything about *framing, accuracy, and completeness* is judged here.
