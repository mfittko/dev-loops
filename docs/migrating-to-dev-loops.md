# Migrating from `pi-dev-loops` to `dev-loops`

This project was renamed from **`pi-dev-loops`** to **`dev-loops`** as part of making
the tool harness-agnostic (it runs under both Claude Code and Pi, and standalone via
`npx`). This guide lists every change a consumer repo must make.

Because the project is still `0.x`, these breaking changes ship without a long
deprecation window. Where a cheap compatibility shim was feasible it is noted below;
the dev-loops-owned environment variables are a deliberate clean break (no aliases).

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
npx dev-loops@<version> --help   # was: npx pi-dev-loops@<version> --help
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
names because the Pi runtime sets them. Most are read only at the harness-adapter
boundary; the run-id marker `PI_SUBAGENT_RUN_ID` is the one exception (see below):

`PI_SESSION`, `PI_INTERACTIVE`, `PI_AGENT_SESSIONS_DIR`, `PI_SUBAGENT_SESSIONS_DIR`,
`PI_SUBAGENT_ASYNC_RUNS_DIR`, `PI_SUBAGENT_ASYNC_RESULTS_DIR`, `PI_SUBAGENT_RUN_ID`.

The neutral `DEVLOOPS_RUN_ID` is the primary run-id marker and the only one dev-loops
mints/propagates. Under Pi, `PI_SUBAGENT_RUN_ID` is the run-id the Pi runtime injects into
async-subagent child envs, so dev-loops honors it as a recognized externally-injected
alias (precedence after the neutral primary). You do not need to rename it — but if you
set a run-id yourself, prefer `DEVLOOPS_RUN_ID`.

## 4. Config file location

Consumer overrides should live in **`.devloops`** at the repo root. The legacy
`.pi/dev-loop/settings.*` and `.pi/dev-loop/overrides.*` are deprecated fallbacks that load
only when no `.devloops` is present (a single deprecation warning fires when a legacy path is found) — move your
overrides to `.devloops` (`.yml`/`.json` extensions are also accepted). Packaged defaults
ship with the extension in `packages/core/src/config/extension-defaults.yaml`; a repo-local
`.pi/dev-loop/defaults.*` layer merges on top of them when present, and you only need to
override the keys you want to change.

## 5. Node version floor

The minimum supported Node version was raised **`>=20` → `>=24`** (both `dev-loops` and
`@dev-loops/core`). Consumers running Node < 24 must upgrade — `npm install` will warn (or
fail under `engine-strict`) otherwise.

## See also

- [`CHANGELOG.md`](../CHANGELOG.md) — the `PI_*`→`DEVLOOPS_*` env-var rename entry records the full mapping.
- [Extension Documentation](../extension/README.md) — config keys and defaults.
