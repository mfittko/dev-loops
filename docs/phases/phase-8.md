# phase-8 durable plan

## Status

active (slice-1-implemented; additional Phase 8 closure work pending)

## Reconciliation note

Phase 8 is the active durable phase on `main`. Phase 8 was pulled forward ahead of the deferred Phase 7 pilot, so this document now owns the active phase truth until the repo either closes Phase 8 or deliberately reprioritizes again.

## Objective

Define a durable, inspectable configuration contract for `dev-loop` / routed workflow behavior so repo/operator defaults move from implicit prompt/skill/chat-memory seams into one canonical, validated configuration surface with clear precedence, fail-closed semantics, and explicit shipped-defaults vs repo-local-settings ownership.

## Why this phase exists now

Workflow policy decisions are accumulating in too many scattered places, and enough of the config-contract surface has already shipped on `main` that the durable docs need to treat Phase 8 as the active phase rather than a future idea:
- operator instructions in chat
- issue-specific overrides
- skill text / prompt wording
- hardcoded defaults in scripts or extension behavior

Examples now clearly needing first-class configuration:
- local-first vs GitHub-first default per workflow class
- conductor model selection
- per-role subagent model selection
- refinement fan-out shape (count, roles, parallel vs sequential)
- gate inspection angles and per-angle model overrides
- autonomy stop boundaries

Without a configuration contract, behavior drifts between runs, repo policy and per-run overrides are hard to separate, and future changes become prompt surgery instead of contract updates.

## In scope

- define the canonical config surface and schema for dev-loop / routed workflow defaults
- define the canonical home for workflow-policy contract definitions (`.pi/dev-loop/`)
- define loader precedence for config files: built-in defaults → shipped defaults → repo-local settings (preferred `settings.*`, with legacy `overrides.*` fallback); higher-level per-run flags remain above this loader contract
- distinguish shipped defaults from repo-local settings and higher-level per-run overrides without inventing a second gitignored session-only layer
- define validation with fail-closed behavior for unknown or contradictory config
- support at minimum these config families:
  1. **Execution strategy** — local-first vs GitHub-first default, plus per-workflow overrides
  2. **Model routing** — conductor model, per-role subagent model overrides
  3. **Refinement policy** — fan-out count, parallel vs sequential, which roles
  4. **Gate review policy** — which angles run at draft gate and pre-approval gate
  5. **Autonomy policy** — named stop boundaries defining what gates require operator confirmation
- define role resolution: lens name → agent persona lookup → model override → default reviewer fallback
- implement the zod schema, config loader with precedence merging, and validation
- write contract tests for schema validation and precedence
- wire the config into at least one real workflow entrypoint (conductor model or strategy routing) to prove it integrates
- update [Project Plan](../../PLAN.md) and contract docs to reference the config surface as the canonical source of truth for workflow defaults

## Explicit non-goals

- implementing every config family in full depth in one slice — wire one or two to prove integration
- building a generic settings platform without bounded workflow need
- replacing deterministic workflow contracts with free-form prompt tuning
- UI or interactive config editing
- config migration/versioning beyond `version: 1` in this phase
- consuming the config from every workflow surface at once — focus on the schema, loader, and one real integration point

## Design decisions (pre-refined)

These reflect the brainstorming session on 2026-06-01 and serve as the starting point for the phase plan. The fan-out/fan-in loop may refine them further.

### Config home

- Shipped defaults: `.pi/dev-loop/defaults.yaml` (committed, tracked with the package)
- Repo-local override surface: `.pi/dev-loop/settings.yaml` (preferred); the loader also accepts `.pi/dev-loop/settings.yml` and `.pi/dev-loop/settings.json`, and legacy `overrides.*` still load as fallbacks
- Precedence: per-run CLI flags/env vars > repo-local settings > shipped defaults > built-in defaults
- Merge is shallow (missing keys fall through, no deep merging)

### Schema shape

```typescript
// zod schema — single source of truth, types inferred
const DevLoopConfig = z.strictObject({
  version: z.literal(1),
  strategy: z.strictObject({
    default: z.enum(["local-first", "github-first"]).default("github-first"),
    byWorkflow: z.record(z.string(), z.enum(["local-first", "github-first"])).optional(),
  }).default({}),
  models: z.strictObject({
    conductor: z.string().optional(),
    roles: z.record(z.string(), z.string()).optional(),
  }).default({}),
  refinement: z.strictObject({
    fanOut: z.number().int().min(1).max(10).default(3),
    mode: z.enum(["parallel", "sequential"]).default("parallel"),
    roles: z.array(z.string()).optional(),
  }).default({}),
  gates: z.strictObject({
    draft: z.strictObject({
      angles: z.array(z.string()),
      required: z.boolean().default(true),
    }).optional(),
    preApproval: z.strictObject({
      angles: z.array(z.string()),
      required: z.boolean().default(true),
    }).optional(),
  }).default({}),
  autonomy: z.strictObject({
    stopAt: z.array(
      z.enum(["refinement", "draft-pr", "pre-approval", "merge"])
    ).optional(),
  }).default({}),
});
```

### Role resolution for gate angles

When a gate specifies `angles: ["security", "style", "correctness"]`:

1. Look up agent persona by role name — if a dedicated agent exists (e.g. `security-reviewer`), use it with its own system prompt and default model
2. Apply model override from `models.roles[name]` if present — overrides the agent's default model
3. Fallback: no agent persona found → default reviewer agent + role name injected as focus lens + any model override still applied

This means angles are lenses first, optionally backed by dedicated agent personas. No config wiring needed for the binding itself — drop a persona definition in and it takes over automatically.

### Autonomy levels

`stopAt` is the source of truth — an ordered list of gates that require operator confirmation. A convenience `level` name (`manual | semi | full`) could be a computed/sugared view, but the config stores the explicit list.

## Acceptance criteria

- `.pi/dev-loop/defaults.yaml` is defined and validated through the same zod-backed config contract
- `.pi/dev-loop/settings.yaml` (plus accepted `.yml` / `.json` forms) uses the same schema as the shipped defaults
- config loader resolves file-surface precedence correctly: `settings.*` → legacy `overrides.*` → `defaults.*` → built-in defaults
- unknown keys cause fail-closed rejection (zod `.strict()`)
- contradictory values (e.g. unknown enum member) cause clear parse errors
- role resolution follows the documented 3-step order
- at least one real integration point consumes the config (conductor model or strategy routing)
- contract tests cover: valid configs, precedence merging, unknown keys, bad enums, missing version
- `npm test` passes locally
- GitHub Actions Node 24 CI passes
- [Project Plan](../../PLAN.md) updated to reference the config surface
- [Phase 8 Plan](./phase-8.md) updated to reflect as-implemented reality

## Definition of done

- zod schema committed under `packages/core/src/config/` (or equivalent canonical path)
- config loader committed with precedence merging
- contract tests pass with ≥ 90% coverage on the config module
- `.pi/dev-loop/defaults.yaml` exists in the repo with sensible defaults
- `.pi/dev-loop/settings.yaml` is the preferred repo-local override surface (with `.yml` / `.json` accepted by the loader)
- one real workflow entrypoint reads the config and applies it (conductor model or strategy)
- [Phase 8 Plan](phase-8.md) is updated to reflect the shipped surface
- [Project Plan](../../PLAN.md) acknowledges the config contract as the canonical source for workflow defaults
- issue #286 is closed or updated with a pointer to the landed phase
- PR body is structured per the PR description contract

## Validation approach

- zod `.parse()` / `.safeParse()` as the primary validation layer
- contract tests for every failure mode: unknown keys, bad enums, missing version, out-of-range fanOut
- contract tests for precedence: each layer overrides the one below
- integration test: load config and verify the correct model/strategy is resolved
- run the full `npm test` suite

## Resolved open questions

- **Config module path:** `packages/core/src/config/` — follows the existing `src/<domain>/` pattern (`loop/`, `github/`)
- **First integration point:** strategy routing (`public-dev-loop-routing.mjs`) — clean, non-destructive proof of the config pipeline; `models.conductor` is the natural second wire after the pipeline is proven
- **`autonomy.stopAt` default:** `["merge"]` — matches the current auto-continue-through-gates posture; more conservative repos override with `["draft-pr", "pre-approval", "merge"]`
- **`$schema` field:** no — Zod is the single validation source of truth; `zod-to-json-schema` exists if IDE hints become desired later

## Links

- GitHub issue: [#286](https://github.com/mfittko/dev-loops/issues/286)
- Local execution artifacts will live under `tmp/phases/phase-8/`
