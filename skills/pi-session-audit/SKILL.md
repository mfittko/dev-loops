---
name: pi-session-audit
description: >-
  Audit Pi or Claude Code session transcripts via `node <dev-loops-package-root>/cli/index.mjs loop audit-session` to measure token efficiency,
  identify context snowballing in coordinators, verify cache hit ratios, and report
  per-agent and per-model token breakdowns across runs.
allowed-tools: read bash
user-invocable: false
claude-sync: false
---

# Pi Session Audit

The `pi-session-audit` skill inspects Pi or Claude Code session usage transcripts to measure token efficiency, detect coordinator context snowballing, and report per-agent/per-unit token breakdowns. It is harness-agnostic: the snowball and threshold code is shared; each extractor supplies the per-turn prompt size (Pi input+cacheRead, Claude input+cacheRead+cacheCreate); see [Pi vs Claude Code](#pi-vs-claude-code). Harness is auto-detected from the record schema unless `--harness` overrides it.

## CLI Invocation

The skill is backed by `scripts/loop/audit-pi-session.mjs` (available directly or via the CLI as `node <dev-loops-package-root>/cli/index.mjs loop audit-session`):

```bash
# Audit the latest session for this repository (including its tmp/worktrees runs)
node scripts/loop/audit-pi-session.mjs --latest

# Or using the dev-loops CLI:
node <dev-loops-package-root>/cli/index.mjs loop audit-session --latest

# Audit a specific session directory or session file (a single transcript file is audited alone):
node scripts/loop/audit-pi-session.mjs ~/.pi/agent/sessions/--Users-user-dev-loops--/<session-id>

# Emit structured JSON:
node scripts/loop/audit-pi-session.mjs --latest --json

# Query specific metrics via --jq (per BASE-JQ-OUTPUT-GUARANTEE):
node scripts/loop/audit-pi-session.mjs --latest --jq '.summary.totalTokens'
# cacheHitRatio is a 0-1 fraction in JSON (Markdown renders it as a percentage)
node scripts/loop/audit-pi-session.mjs --latest --jq '.summary.cacheHitRatio'
node scripts/loop/audit-pi-session.mjs --latest --jq '.sessions[] | select(.snowball.promptGrowthFactor > 10)'

# Audit a Claude Code transcript directory (agent-<id>.jsonl / .output files); harness
# auto-detects from the record schema, so --harness is only needed to force a mode:
node scripts/loop/audit-pi-session.mjs --harness claude path/to/claude-transcripts --json
```

## Pi vs Claude Code

Harness auto-detects per record from the usage envelope's field-naming shape (Claude's
`input_tokens`/`output_tokens`/... vs Pi's `input`/`output`/...); pass `--harness pi` or
`--harness claude` only to force a mode. A file with both shapes reports its harness as
`mixed`. If a forced `--harness` mode finds zero usage turns while the other shape was
present, the error names the detected shape and suggests `--harness auto`.

Claude records sharing one `message.id` count as a single turn, even when the repeats
are not adjacent. The deduped turn keeps the last record's usage and the position of
its first appearance. That position decides the first and last turn for the Init
Prompt and Final Prompt metrics. A turn replayed across
resumed-session files (same `message.id` + `requestId`) counts once, in the file with
the earliest usage-turn timestamp. Path order breaks a timestamp tie. A Claude Code transcript's prompt size is
`input + cacheRead + cacheCreate` on its first/last turn (Pi's is `input + cacheRead`);
this is the only place the two harnesses' metric definitions differ. Role and session
name come from the sibling `agent-<id>.meta.json` (`agentType` / `description`) when
present. Without a meta sidecar, a Claude `agent-<id>.jsonl` transcript defaults to
`subagent` and a main-session transcript (`<uuid>.jsonl`) to `coordinator`. A `.output`
file that is not a transcript (plain text or other JSON, e.g. `{"ok":true}`) is skipped.

## Interpreting Output

### 1. Overall Summary
- **Harness**: Top-level `harness` field reports `pi`, `claude`, or `mixed`. `mixed` covers both a single file whose records match both shapes and a directory audit whose transcript files individually resolve to different harnesses. The Markdown heading follows this value (`Pi Session Token Audit`, `Claude Code Session Token Audit`, or `Session Token Audit` for `mixed`). Claude transcripts never report a cost, so **Estimated Cost** is always `n/a` (`unavailable`) in pure Claude mode; in `mixed` mode the Pi turns still carry cost, so it reports a `partial` sum covering only those turns.
- **Resolved Target**: Absolute session path selected by `--latest` or supplied explicitly. A single transcript file target is audited alone; **Transcript Files Examined** makes that scope visible in Markdown.
- **Total Turns**: Sum of assistant turns carrying a non-zero usage envelope (any of `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, or `cost`). For a genuine fork transcript (its `session` header has a non-empty string `parentSession`), this excludes the inherited replay prefix and includes the fork's own turns; multiple `session_info` records in an ordinary transcript are all retained.
- **Total Tokens**: Sum of `input + output + cacheRead + cacheWrite` when those provider dimensions are reported.
- **Cache Hit Ratio**: Calculated as `cachedRead / (uncachedInput + cachedRead)`. JSON reports a 0-1 fraction; Markdown reports a percentage. In long coordinator sessions with good prefix alignment, this should typically exceed 85-90%.
- **Estimated Cost**: Sum of provider billed costs from message usage envelopes that report cost.
- **Partial usage data**: Known values are still summed when only some envelopes report a dimension. JSON exposes `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `cacheHitRatio`, and `estimatedCost` under each `availability` object as `complete`, `partial`, or `unavailable`; the vocabulary is identical in `summary`, `sessions[]`, and `byModel[]`. Markdown appends `(partial)` to incomplete sums. A dimension renders as `n/a` only when no envelope reports it.
- **Fork Snapshots**: Reports snapshots processed, fork-own turns retained, inherited replay turns excluded, and unresolved timestamp boundaries in both JSON counters (`forkSnapshotsProcessed`, `retainedForkTurns`, `skippedInheritedForkTurns`, and `unresolvedForkBoundaries`) and the Markdown summary. An unresolved boundary warns that totals may be incomplete rather than silently presenting the inherited replay as fork-own usage.

### 2. Usage by Model
Breaks down token volume and cache ratios per model provider (e.g., `gemini-3.8-flash`, `zai-org/GLM-5.3`).

### 3. Session Breakdown & Context Snowballing
Each row represents one `session_info` agent segment within a transcript, so multiple rows can share the same `file`. In JSON, `file` identifies the transcript, `sessionName` preserves the segment's `session_info.name` (or is `null` when absent), and top-level `activeSessionsCount` is the number of emitted segment rows. Each row includes:
- **Role**: Inferred agent role (`dev-loop`, `review`, `fixer`, etc.).
- **Turns**: Usage-bearing assistant turns (same definition as Total Turns) for that agent segment. In a fork snapshot, inherited replay turns are excluded when its timestamp boundary is resolved.
- **Init Prompt**: Size of the prompt on the first prompt-bearing turn (the first post-fork prompt-bearing turn for a fork snapshot): `input + cacheRead` for Pi, `input + cacheRead + cacheCreate` for Claude Code (see [Pi vs Claude Code](#pi-vs-claude-code)).
- **Final Prompt**: Size of the prompt on the final prompt-bearing turn.
- **Growth**: Growth factor `finalPromptTokens / initialPromptTokens`.

### 4. Tool Calls and MCP Usage by Role
Each `sessions[]` row carries `toolCalls: { calls, byTool, denied }` over all tools of that segment. Claude `tool_use` blocks and Pi `toolCall` blocks both count. Replayed calls of a resumed Claude session count once, through the same `message.id` + `requestId` dedupe as turns.

`denied` counts Claude calls whose `tool_use_id` matches a user record with a non-empty `toolDenialKind` (hook or auto-mode denial). An ordinary `is_error` result does not count as denied. Pi has no structured denial marker, so a Pi session's `denied` is `null`.

The top-level `mcpUsageByRole` object is keyed by the session `role` and holds `{ calls, byTool, denied, bySessionCwd }` for MCP calls only (tool names matching `mcp__<server>__<tool>`). `calls` includes denied calls. A role's `denied` is `null` only when every session of that role is a Pi session, and a role mixing Pi and Claude sessions counts only its Claude denials. The `MCP usage by role` table shows `n/a` for a `null` `denied`. `bySessionCwd` always has `main`, `worktree` and `other`. The cwd comes from the calling record (Claude) or the `session` header (Pi). `worktree` is a path under `<main checkout>/tmp/worktrees/`, `main` is the main checkout or any other path inside it, and `other` is any other or missing path.

Every audited role has an entry, with zeros when it made no MCP call, so a measured zero differs from a missing report. Markdown prints this as the `### MCP usage by role` table (`Role | MCP calls | Denied | main | worktree | other | Tools`). Calls are counted, not tokens.

## Detecting Token Bloat Anti-Patterns

When auditing transcripts, look for these specific indicators:

1. **Coordinator Context Snowballing**:
   - *Symptom*: A single coordinator (`dev-loop`) runs for >100 turns, and prompt size grows from ~15k to 100k-500k+ tokens (growth factor > 15x-30x).
   - *Cause*: Retaining intermediate tool outputs, large diffs, test logs, and bash outputs in the coordinator's primary history rather than offloading to ephemeral child subagents or writing to disk.
   - *Remedy*: Bounded child subagent delegation; clean session handoffs; avoid monolithic multi-hour turns.

2. **Cold-Cache Subagent Churn**:
   - *Symptom*: Child subagents (`review`, `fixer`) exhibit <70% cache hit ratio while generating >500k tokens.
   - *Cause*: Unstable prompt prefixes (dynamic timestamps or non-deterministic ordering in system/task prompts) busting prompt caches.
   - *Remedy*: Strict prompt prefix stabilization; deterministic context bundling.

3. **Multi-Unit Review Accumulation**:
   - *Symptom*: Review subagents running 40+ turns each for simple diffs.
   - *Remedy*: Verify fresh reviewer context (`context: "fresh"`), concise role boundaries, and enforce single-pass reviews.
