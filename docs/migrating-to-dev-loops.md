# Migrating from `pi-dev-loops` to `dev-loops`

This project was renamed from **`pi-dev-loops`** to **`dev-loops`** as part of making
the tool harness-agnostic (it runs under both Claude Code and Pi, and standalone via
`npx`). This guide lists every change a consumer repo must make.

Because the project is still `0.x`, these breaking changes ship without a long
deprecation window. Where a cheap compatibility shim was feasible it is noted below;
the environment variables are a deliberate clean break (no aliases).

## 1. Package name

| Before | After |
| --- | --- |
| `pi-dev-loops` (npm package) | `dev-loops` |
| `@pi-dev-loops/core` | `@dev-loops/core` |

Update `package.json` dependencies and any `npx`/import references:

```diff
- "dev-loops": "npx pi-dev-loops@<version>"
+ "dev-loops": "npx dev-loops@<version>"
```

```bash
npx dev-loops --help        # was: npx pi-dev-loops --help
```

## 2. Repository slug

The GitHub repo moved from `mfittko/pi-dev-loops` to `mfittko/dev-loops`. Update any
hardcoded `--repo` flags, issue/PR links, the Claude Code marketplace registration, and
the config schema `$id` URL:

```text
/plugin marketplace add mfittko/dev-loops    # was: mfittko/pi-dev-loops
/plugin install dev-loops@dev-loops
```

> Only replace the exact slug `mfittko/pi-dev-loops`. Do **not** bulk-replace the bare
> substring `pi-dev-loops` — it is part of the `@pi-dev-loops/core` identifier handled in
> row 1.

## 3. Environment variables (clean break — no aliases)

Every dev-loops-owned operational env var was renamed from `PI_*` to `DEVLOOPS_*`. There
is **no alias and no fallback** — the old names are simply ignored. Rename them wherever
you set them (CI config, shell profiles, runner scripts):

| Before (`PI_*`) | After (`DEVLOOPS_*`) |
| --- | --- |
| `PI_SUBAGENT_RUN_ID` | `DEVLOOPS_RUN_ID` |
| `PI_SUBAGENT_AVAILABLE` | `DEVLOOPS_SUBAGENT_AVAILABLE` |
| `PI_PREFLIGHT_BYPASS` | `DEVLOOPS_PREFLIGHT_BYPASS` |
| `PI_PREPUSH_BYPASS` | `DEVLOOPS_PREPUSH_BYPASS` |
| `PI_WORKTREE_BYPASS` | `DEVLOOPS_WORKTREE_BYPASS` |
| `PI_DEV_LOOPS_DEBUG` | `DEVLOOPS_DEBUG` |
| `PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS` | `DEVLOOPS_STALE_RUNNER_MAX_AGE_MS` |
| `PI_DEV_LOOP_DETACHED` | `DEVLOOPS_DETACHED` |

`DEVLOOPS_MAIN_AGENT_READONLY` (opt-in main-agent read-only enforcement) was already
`DEVLOOPS_`-prefixed and is unchanged.

### Pi harness users: these `PI_*` vars are unchanged

dev-loops reads a small set of `PI_*` variables that the **Pi runtime injects** (it does
not own or define them) purely to integrate with the Pi harness. These keep their `PI_*`
names because the Pi runtime sets them, and are read only at the harness-adapter boundary:

`PI_SESSION`, `PI_INTERACTIVE`, `PI_AGENT_SESSIONS_DIR`, `PI_SUBAGENT_SESSIONS_DIR`,
`PI_SUBAGENT_ASYNC_RUNS_DIR`, `PI_SUBAGENT_ASYNC_RESULTS_DIR`.

If you run under Pi and previously relied on dev-loops reading `PI_SUBAGENT_RUN_ID`, set
`DEVLOOPS_RUN_ID` instead — the run-id is now resolved from the `DEVLOOPS_` name only.

## 4. Config file location

Consumer overrides should live in **`.devloops`** at the repo root. The legacy
`.pi/dev-loop/settings.yaml` still loads, but emits a deprecation warning — move your
overrides to `.devloops` (`.yml`/`.json` extensions are also accepted). Packaged defaults
ship with the extension (`.pi/dev-loop/defaults.yaml`); you only need to override the keys
you want to change.

## See also

- [`CHANGELOG.md`](../CHANGELOG.md) — the `PI_*`→`DEVLOOPS_*` env-var rename entry records the full mapping.
- [Extension Documentation](../extension/README.md) — config keys and defaults.
