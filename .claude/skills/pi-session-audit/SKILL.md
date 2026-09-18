---
name: "pi-session-audit"
description: "Audit Pi session transcripts (.jsonl files) to measure token efficiency, identify context snowballing in coordinators, verify cache hit ratios, and report per-agent and per-model token breakdowns across runs."
allowed-tools: Read Bash
user-invocable: false
---
<!-- GENERATED from skills/pi-session-audit/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# Pi Session Audit

The `pi-session-audit` skill inspects Pi session usage transcripts (`session.jsonl` files) to measure token efficiency, detect coordinator context snowballing, and report per-agent/per-unit token breakdowns.

## Motivation & Context

In complex agent orchestration workflows (such as multi-turn dev-loop runs), monolithic coordinator agents can retain conversation history across hundreds of turns. Because prompt context accumulates linearly or super-linearly with turn count, a long-running coordinator will repeatedly submit massive prompts on every turn. Even with prompt caching, a 400+ turn run can easily consume over 100M-150M tokens and incur substantial unnecessary cost ($15-$25+ per run).

This skill provides an automated inspection tool to:
1. Parse usage transcripts across the coordinator and child subagents.
2. Group token consumption by model and agent role (`dev-loop`, `review`, `fixer`, `judge`, etc.).
3. Measure context snowball metrics: turn count, initial vs final turn prompt sizes, prompt growth factor, and cache hit ratio.
4. Flag anti-pattern thresholds (e.g. coordinator runs > 100 turns, context growth > 15x, low cache hit ratio).

## CLI Invocation

The skill is backed by `scripts/loop/audit-pi-session.mjs` (available directly or via the CLI as `dev-loops-run cli/index.mjs loop audit-session`):

```bash
# Audit the latest session under ~/.pi/agent/sessions/--Users-*-dev-loops--/
dev-loops-run scripts/loop/audit-pi-session.mjs --latest

# Or using the dev-loops CLI:
node cli/index.mjs loop audit-session --latest

# Audit a specific session directory or session file:
dev-loops-run scripts/loop/audit-pi-session.mjs ~/.pi/agent/sessions/--Users-user-dev-loops--/<session-id>

# Emit structured JSON:
dev-loops-run scripts/loop/audit-pi-session.mjs --latest --json

# Query specific metrics via --jq (per BASE-JQ-OUTPUT-GUARANTEE):
dev-loops-run scripts/loop/audit-pi-session.mjs --latest --jq '.summary.totalTokens'
dev-loops-run scripts/loop/audit-pi-session.mjs --latest --jq '.summary.cacheHitRatio'
dev-loops-run scripts/loop/audit-pi-session.mjs --latest --jq '.sessions[] | select(.snowball.promptGrowthFactor > 10)'
```

## Interpreting Output

### 1. Overall Summary
- **Total Turns**: Sum of all assistant turns recorded in the session transcripts.
- **Total Tokens**: Sum of `input + output + cacheRead + cacheWrite`.
- **Uncached Input vs Cached Read**: Demonstrates cache effectiveness.
- **Cache Hit Ratio**: Calculated as `cachedRead / (uncachedInput + cachedRead)`. In long coordinator sessions with good prefix alignment, this should typically exceed 85-90%.
- **Estimated Cost**: Total provider billed cost when reported in message usage envelopes.

### 2. Usage by Model
Breaks down token volume and cache ratios per model provider (e.g., `gemini-3.8-flash`, `zai-org/GLM-5.3`).

### 3. Session Breakdown & Context Snowballing
Each subagent and coordinator session is listed with:
- **Role**: Inferred agent role (`dev-loop`, `review`, `fixer`, etc.).
- **Turns**: Turn count for that specific subagent process.
- **Init Prompt**: Size of the prompt (input + cacheRead) on Turn 1.
- **Final Prompt**: Size of the prompt on the final turn.
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
