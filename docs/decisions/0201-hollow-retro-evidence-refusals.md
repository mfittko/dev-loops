# 0201. Hollow retro evidence and truncated audit output are refused

## Status

Accepted — 2026-10-28 ([PR 2966](https://github.com/mfittko/dev-loops/pull/2966))

Amends the record-source ceiling of [0053](./0053-fresh-context-retrospective-provenance.md): `--record-source` must now also contain the `--merge-commit` oid, not only be an existing non-empty file.

## Context

Issue [2887](https://github.com/mfittko/dev-loops/issues/2887) reported two paths that accepted hollow evidence without an error.

`checkpoint-contract.mjs --state complete` required `--record-source` to name an existing, non-empty file. Any such file passed, so a retro could be recorded `complete` against a record from another cycle.

The `dev-loops` wrapper ran routed subcommands with `spawnSync` and the default output buffer. When `audit-session` output exceeded that buffer, the child was killed and the wrapper wrote the partial stdout. A large whole-document `--json` record was also observed cut mid-object on a pipe. Readers received a truncated document with no message.

The change re-scopes a rule in [Retrospective checkpoint contract](../../skills/docs/retrospective-checkpoint-contract.md), which trips the ADR tripwire.

## Decision

- `checkpoint-contract.mjs --state complete` refuses with `retro_artifact_missing` when the `--record-source` file is missing or empty, or when it does not contain the `--merge-commit` oid (case-insensitive match).
- The `dev-loops` wrapper spawns routed subcommands with a 64 MiB `maxBuffer` (`SPAWN_MAX_BUFFER` in `cli/index.mjs`). On `ENOBUFS` it writes no partial stdout and exits 1 with `child_output_too_large`. Any other spawn error exits 1 with `subcommand_spawn_failed: <code>`.
- `audit-pi-session.mjs` refuses a whole-document `--json` record above 1,000,000 bytes (`MAX_JSON_BYTES`) with `audit_json_too_large` and exit 1. `--jq`, `--fields` and `--silent` output is exempt from this cap, and the wrapper buffer is its backstop.

## Consequences

A `complete` retro checkpoint now proves that its record names the cycle's merge commit. A record that names another cycle is refused at write time.

Oversized audit output fails with a typed message on stderr. Callers narrow the output with `--jq` or `--fields`, or audit one transcript at a time.

`MAX_JSON_BYTES` in `scripts/loop/audit-pi-session.mjs` must stay below `SPAWN_MAX_BUFFER` in `cli/index.mjs`. Otherwise the wrapper kills the child before the typed refusal is written.
