---
name: pi-session-audit
description: >-
  Audit Pi or Claude Code session transcripts via `dev-loops loop audit-session` to measure token efficiency,
  identify context snowballing in coordinators, verify cache hit ratios, and report
  per-agent and per-model token breakdowns across runs.
allowed-tools: read bash
user-invocable: false
claude-sync: false
---

# Pi Session Audit

The `pi-session-audit` skill inspects Pi or Claude Code session usage transcripts to measure token efficiency, detect coordinator context snowballing, and report per-agent/per-unit token breakdowns. It is harness-agnostic: the metric and threshold logic is identical for both harnesses; only transcript-record extraction (field names and streaming-record dedupe) differs per harness, and harness is auto-detected from the record schema unless `--harness` overrides it.

## Motivation & Context

In complex agent orchestration workflows (such as multi-turn dev-loop runs), monolithic coordinator agents can retain conversation history across hundreds of turns. Because prompt context accumulates linearly or super-linearly with turn count, a long-running coordinator will repeatedly submit massive prompts on every turn. Even with prompt caching, a 400+ turn run can easily consume over 100M-150M tokens and incur substantial unnecessary cost ($15-$25+ per run).

This skill provides an automated inspection tool to:
1. Parse usage transcripts across the coordinator and child subagents.
2. Group token consumption by model and agent role (`dev-loop`, `review`, `fixer`, `judge`, etc.).
3. Measure context snowball metrics: turn count, initial vs final turn prompt sizes, prompt growth factor, and cache hit ratio.
4. Flag anti-pattern thresholds (e.g. coordinator runs > 100 turns, context growth > 15x, low cache hit ratio).

## CLI Invocation

The skill is backed by `scripts/loop/audit-pi-session.mjs` (available directly or via the CLI as `dev-loops loop audit-session`):

```bash
# Audit the latest session for this repository (including its tmp/worktrees runs)
node scripts/loop/audit-pi-session.mjs --latest

# Or using the dev-loops CLI:
dev-loops loop audit-session --latest

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

Claude Code streams one JSONL record per content block; records sharing one `message.id`
(including interleaved, not just adjacent, repeats) are deduped to a single turn in
first-appearance order, keeping the last record's usage. A resumed Claude session can also
replay prior history across files sharing one `message.id` + `requestId`; the file whose
earliest usage turn is chronologically first wins a shared `message.id`:`requestId` pair
(path order as tie-breaker), so later replays of the same turn in other files are skipped
regardless of the files' name-sorted order. A Claude Code
transcript's prompt size is `input + cacheRead + cacheCreate` on its first/last
turn (Pi's is `input + cacheRead`, unchanged); this is the only place the two harnesses'
metric definitions differ, per the issue that introduced Claude support. Role and session
name come from the sibling `agent-<id>.meta.json` (`agentType` / `description`) when
present; a Claude `agent-<id>.jsonl` transcript without a meta sidecar defaults to
`subagent` instead, since the `coordinator` fallback is reserved for main-session Claude
transcripts (`<uuid>.jsonl`). A background-task `.output` file is only
collected when its first non-empty line parses as a JSON object shaped like a transcript
record (a string `type`, or an object `message`); a plain-text or non-transcript-JSON
`.output` file (e.g. `{"ok":true}`) is skipped rather than surfaced as malformed lines.

## Interpreting Output

### 1. Overall Summary
- **Harness**: Top-level `harness` field reports `pi`, `claude`, or `mixed`. `mixed` covers both a single file whose records match both shapes and a directory audit whose transcript files individually resolve to different harnesses. The Markdown heading follows this value (`Pi Session Token Audit`, `Claude Code Session Token Audit`, or `Session Token Audit` for `mixed`). Claude transcripts never report a cost, so **Estimated Cost** is always `n/a` (`unavailable`) in pure Claude mode; in `mixed` mode the Pi turns still carry cost, so it reports a `partial` sum covering only those turns.
- **Resolved Target**: Absolute session path selected by `--latest` or supplied explicitly. A single transcript file target is audited alone; **Transcript Files Examined** makes that scope visible in Markdown.
- **Total Turns**: Sum of assistant turns carrying a non-zero usage envelope (any of `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, or `cost`). For a genuine fork transcript (its `session` header has a non-empty string `parentSession`), this excludes the inherited replay prefix and includes the fork's own turns; multiple `session_info` records in an ordinary transcript are all retained.
- **Total Tokens**: Sum of `input + output + cacheRead + cacheWrite` when those provider dimensions are reported.
- **Uncached Input vs Cached Read**: Demonstrates cache effectiveness.
- **Cache Hit Ratio**: Calculated as `cachedRead / (uncachedInput + cachedRead)`. JSON reports a 0-1 fraction; Markdown reports a percentage. In long coordinator sessions with good prefix alignment, this should typically exceed 85-90%.
- **Estimated Cost**: Sum of provider billed costs from message usage envelopes that report cost.
- **Partial usage data**: Known values are still summed when only some envelopes report a dimension. JSON exposes `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `cacheHitRatio`, and `estimatedCost` under each `availability` object as `complete`, `partial`, or `unavailable`; the vocabulary is identical in `summary`, `sessions[]`, and `byModel[]`. Markdown appends `(partial)` to incomplete sums. A dimension renders as `n/a` only when no envelope reports it.
- **Fork Snapshots**: Reports snapshots processed, fork-own turns retained, inherited replay turns excluded, and unresolved timestamp boundaries in both JSON counters (`forkSnapshotsProcessed`, `retainedForkTurns`, `skippedInheritedForkTurns`, and `unresolvedForkBoundaries`) and the Markdown summary. An unresolved boundary warns that totals may be incomplete rather than silently presenting the inherited replay as fork-own usage.

### 2. Usage by Model
Breaks down token volume and cache ratios per model provider (e.g., `gemini-3.8-flash`, `zai-org/GLM-5.3`).

### 3. Session Breakdown & Context Snowballing
Each row represents one `session_info` agent segment within a transcript, so multiple rows can share the same `file`. In JSON, `file` identifies the transcript, `sessionName` preserves the segment's `session_info.name` (or is `null` when absent), and top-level `activeSessionsCount` is the number of emitted segment rows. Each row includes:
- **Role**: Inferred agent role (`dev-loop`, `review`, `fixer`, etc.).
- **Turns**: Count of assistant turns carrying a non-zero usage envelope (any of `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, or `cost`) for that specific agent segment. In a fork snapshot, inherited replay turns are excluded when its timestamp boundary is resolved.
- **Init Prompt**: Size of the prompt on the first prompt-bearing turn (the first post-fork prompt-bearing turn for a fork snapshot): `input + cacheRead` for Pi, `input + cacheRead + cacheCreate` for Claude Code (see [Pi vs Claude Code](#pi-vs-claude-code)).
- **Final Prompt**: Size of the prompt on the final prompt-bearing turn.
- **Growth**: Growth factor `finalPromptTokens / initialPromptTokens`.

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
