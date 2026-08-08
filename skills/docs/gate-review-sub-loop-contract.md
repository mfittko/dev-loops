# Checkpoint Review Chain Contract

Canonical owner for gate-review **execution shape** rules shared by the two dev-loop gate
boundaries: `draft_gate` and `pre_approval_gate`.

## Purpose

Both gates share one structured sub-loop: a build-once neutral context bundle,
independent-reviewer fan-out, fan-in synthesis, and iterative fix-then-retry.

### Execution model: build once, seed many (no fork)

<!-- rule: GATE-EXEC-BUILD-ONCE-SEED -->
`GATE-EXEC-BUILD-ONCE-SEED`: Each gate pass MUST build ONE neutral context bundle once
via a deterministic context-builder script and seed every independent, fresh-context
reviewer with that bundle verbatim. Reviewers MUST NOT fork from, or inherit, a parent
agent's loaded context, and the sub-loop MUST NOT depend on any fork primitive or the
Workflow tool. Concretely:

1. A deterministic **context-builder script** (`scripts/github/write-gate-context.mjs`)
   builds ONE generous, neutral context bundle for the head SHA: the full diff plus
   a structurally-adjacent code bundle (each changed file's 1-hop import in/out-edges)
   with size guards. Because it is a script, the bundle is neutral (it cannot
   editorialize) and deterministic (identical head + diff → identical bundle).
2. Each reviewer is an **independent fresh-context Agent** that is **seeded with that
   identical neutral bundle verbatim** plus its single review angle (per-angle mode /
   `gate:full`) or every angle in its resolved dispatch unit (grouped mode, [Phase
   2](#phase-2--fan-out-independent-reviewers-seeded-with-the-neutral-bundle)), and
   widens only when a covered angle genuinely needs more. Reviewers never inherit the
   main (orchestrating) agent's conversation or opinions — that independence is the
   anti-bias requirement.
3. Fan-in consolidates the per-angle findings unchanged.

The cost win is **work-dedup**: the diff + adjacent code is built once, not re-derived
by every reviewer; a shared-prefix prompt-cache is an opportunistic bonus, not a
requirement. The exact LAYOUT of the seeded briefing text (what precedes what, and what
must be byte-identical across reviewers to make prompt-cache reuse possible at all) is
owned by `GATE-EXEC-BRIEFING-PREFIX` in [Phase 2](#phase-2--fan-out-independent-reviewers-seeded-with-the-neutral-bundle) below.

This contract owns the **execution shape** of gate-review work. It does not own:
- which review angles a specific gate runs (that stays in the skill)
- the visible gate-review PR comment format (owned by [Gate Review Comment Contract](./gate-review-comment-contract.md), whose evidence is also required for a gate to be satisfied)
- the broader PR lifecycle sequencing (owned by the workflow skill and [PR Lifecycle Contract](./pr-lifecycle-contract.md))

## Separate chains per gate

<!-- rule: GATE-EXEC-SEPARATE-CHAINS -->
`GATE-EXEC-SEPARATE-CHAINS`: Each gate (`draft_gate`, `pre_approval_gate`) MUST run its
own independent review chain with its own review angles, its own disposition ledger, its
own fix cycle, and its own exit conditions. The chains are not interchangeable; each
gate's execution is a complete, self-contained sub-loop pass. The `draft_gate` fix cycle
covers only findings that block the draft→ready transition; the `pre_approval_gate` fix
cycle covers only findings that block final approval readiness. Angles and blocking
severities per gate are in [Gate-specific configuration](#gate-specific-configuration).

## Sub-loop phases

Both gates run the identical phases with their own review angles.

### Phase 1 — Preamble: context-builder

Before fanning out reviewers, run a preamble pass that produces review handoff context
in the PR's actual worktree/head — the same checkout the reviewers will run in — so the
gitignored, worktree-local `tmp/gate-context` bundle it writes is present for them:

- the context-builder runs in fresh context and emits a NEUTRAL artifact; that artifact (never the parent session's chat history or state) is what each downstream reviewer subagent is later seeded with. **Mandatory:** every gate-review subagent must run `scripts/github/verify-fresh-review-context.mjs --scope <gate>-<angle> --context-path <path> --prefix-hash <sha256>` (or `--prefix-file <path>`) at startup and refuse to proceed on contamination or a missing gate-context artifact. Use a gate-prefixed `--scope <gate>-<angle>` (e.g. `draft-gate-coverage`) so each reviewer writes its own sentinel and attributes to its gate (see [Sentinel lifecycle](#sentinel-lifecycle)), `--context-path` to the artifact this phase writes below, and `--prefix-hash`/`--prefix-file` to record the invariant-briefing prefix hash enforced by `GATE-EXEC-BRIEFING-PREFIX`.
- **Worktree isolation is PROHIBITED for per-angle gate reviewers.** They are read-only
  (they never mutate files), so filesystem isolation buys nothing and actively breaks the
  "build once, seed many" contract: a fresh worktree is checked out from `main`, not the
  PR head, and has no access to the gitignored, worktree-local `tmp/gate-context` bundle
  this phase writes (#1135). Reviewers run in the PR's actual worktree/head — the same
  checkout the preamble ran in.
- the preamble resolves the gate's review angle set: it starts from the configured
  angle pool (`gates.<gate>.angles` — an array of angle names/objects, D3/D4) and,
  when `gates.<gate>.dynamic.subtractive` is enabled (ON by default since #1579),
  narrows it to the angles relevant to the change at hand (configured pool → resolved set). Optional code-review lenses not
  triggered by the change (for example most code lenses for a docs-only change) are
  dropped, and the reason each angle was dropped is recorded as rationale. Angle entries
  with `mandatory: true` form a floor and are always included after dynamic selection
  (filtered only by entries with `enabled: false`); they are never dropped — a mandatory angle runs even when the diff-classifier
  would otherwise prune it. Adding a
  plain (non-mandatory) angle entry is additive but not mandatory — a duplicate name is
  deduplicated by the set union (appears exactly once, never errors, and keeps that
  angle's existing mandatory/prunable status); an entry with `enabled: false` is removed
  like any other angle. Because `gates.<gate>.angles` merges BY NAME across config
  layers (D3), a consumer can add a new angle, or disable/override an existing one, by
  naming just that entry — no need to copy-paste/maintain the whole shipped `angles`
  array. When `dynamic.subtractive` is off (the opt-out escape hatch, or when no diff is
  available), the configured static pool is used unchanged — set
  `dynamic.subtractive: false` (full pool) AND apply the `gate:full` label or
  `gates.fanout.mode: per-angle` to restore the original full static fan-out. The
  `gate:full` label forces the full (untriered) angle set; as of #1601 (ADR 0048)
  it no longer forces per-angle DISPATCH — it dispatches grouped, so to also
  restore one-reviewer-per-angle dispatch shape set `gates.fanout.mode: per-angle`. Symmetrically, when `gates.<gate>.dynamic.additive` is
  enabled (default **off**), the resolver may also ADD catalog angles that
  change-category heuristics recommend but that are not already in the gate's
  configured pool, drawn from the global lens catalog (the explicit `gates.anglePool`
  override, or — when `anglePool` is not set or is empty — the union of the built-in persona
  registry's angle names and every angle actually configured across this config's
  own `gates.draft`/`gates.preApproval`/`gates.spike` `angles`). A disabled (`enabled:
  false`) entry remains a hard ceiling on additions — an excluded angle is
  never added, even if the change categories would otherwise recommend it. Additions
  are recorded in the rationale with action `"added"`, with a reason naming either the
  triggering change category or, for always-include lenses, that it is an
  always-include addition. This additive path is off by default, so existing configured angle pools
  are unaffected unless a gate explicitly opts in.
- **Security-sensitive-seam trigger (`threat-model`).** When the change categories include
  `SECURITY_SENSITIVE_SEAM` — a **code** file's diff (config/doc/markdown lines that merely
  name a primitive are file-gated out) touches browser automation, `child_process`/shell
  execution, untrusted network fetch, or destructive filesystem / local-file-upload ops — the
  resolver selects the `threat-model` angle (recommended when configured; added from the pool in
  additive mode). It is never dropped for such a diff, regardless of change size. `threat-model` is
  an adversarial-security lens that returns an exhaustive trust-boundary checklist (input allowlists,
  navigation/origin confinement pre-launch **and** at runtime, resource/loop bounds, data-at-rest +
  cleanup on every fail-closed path, exported/entry-point self-validation, error/teardown safety,
  path-traversal/deserialization, shell-injection) rather than a spot-check — so a batched up-front
  pass surfaces the trust-boundary holes that would otherwise be drip-fed serially through Copilot
  rounds. `input-validation` is likewise part of the core `LOGIC_CHANGE` subset, not pool-only.
- the preamble produces one or more review handoff artifacts (branch, head SHA, PR/issue
  scope, acceptance criteria, touched files, validation posture). The resolved angle set
  and its rationale are written as a deterministic handoff artifact under
  `tmp/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json` so the fan-out phase
  consumes a stable, auditable briefing per head SHA.
- the preamble ALSO builds the deterministic **neutral context bundle** ONCE: the full
  diff (`scope.diffPath`) plus an adjacent-code bundle (`adjacentCode`) containing each
  changed file and its 1-hop import in/out-edges (callers/callees/imports), with size
  guards (skip lockfiles/generated/binary/minified; cap per-file bytes; truncate the
  long tail) recorded in a `stripped`/`truncated`/`missing` manifest for observability.
  This is the build-once, work-deduped seed handed verbatim to every reviewer; no
  reviewer re-derives the diff + adjacent code from scratch.
  - **`scope.diffSource` posture (CLI `--base`).** `write-gate-context.mjs` records this
    full bundle only when it has a resolvable diff source. Pass `--base <ref>` and the CLI
    captures the diff itself (`git diff <ref>...HEAD`, run with color/pager/external-diff
    config isolated so the persisted bytes are environment-independent) and stamps
    `scope.diffSource: "base"` — the full build-once bundle (`scope.diffPath` +
    `scope.changedFiles` + `adjacentCode`). Without `--base`, the CLI does NOT silently
    emit a full-looking bundle: it warns and stamps `scope.diffSource: "none"` — an
    explicit **thin briefing** (`scope.diffPath: null`, `scope.changedFiles: []`, no
    `adjacentCode`) that reviewers detect and fall back from (re-derive via `git diff`). A
    `--base` that fails to resolve (its `git diff --name-status` fails) fails closed
    (non-zero exit, no artifact) rather than degrading to a thin briefing. Programmatic
    `buildGateContext({ diff })` callers are unaffected and omit `scope.diffSource` entirely.
  - **Partial `"base"` (best-effort full-diff).** `scope.diffSource: "base"` can co-occur
    with `scope.diffPath: null`: the required `git diff --name-status` succeeded (so
    `scope.changedFiles` + `adjacentCode` are present — it IS a base-derived bundle) but the
    best-effort FULL-diff capture degraded (e.g. output exceeded the buffer, a render error),
    so no persisted `.diff` was written. Reviewers MUST therefore key their diff-fallback on
    `scope.diffPath` (null → re-derive via `git diff`), NOT on `scope.diffSource`:
    `diffSource` distinguishes a base-derived bundle (`"base"`) from a thin briefing
    (`"none"`), while `diffPath` independently signals whether the persisted full diff is
    available.
  - **`scope.acceptanceCriteriaSource` posture (CLI-only spec resolution, #1496/#1511).**
    `write-gate-context.mjs` resolves the PR body, the PR's closing issue reference(s), and
    each closed issue's body from GitHub itself when the caller omits `--pr-body`/
    `--issue-body`/`--acceptance-criteria` — a caller that simply forgets a flag can no longer
    seed every fan-out reviewer with the false claim that a PR has no description or no
    acceptance criteria. An unresolvable read (PR or a linked issue) FAILS CLOSED: a named
    error, no artifact written — the bundle must never assert absence when resolution merely
    failed. Supplying `--acceptance-criteria` suppresses the automatic issue-body fetch
    entirely (it overrides the pointer the fetch would otherwise resolve), so a caller who
    passes only `--acceptance-criteria` gets no linked-issue body and no `## Linked issue`
    section; pass `--issue-body` too if the prefix should still carry issue text.
    `scope.acceptanceCriteriaSource` records how `scope.acceptanceCriteria` came to
    be: `"provided"` (caller flag, regardless of whether an issue body was independently
    supplied too), `"linked-issue"` (resolved from the closing reference(s), and at least one
    resolved issue carries a real Acceptance-criteria/DoD section or linked refinement doc),
    `"linked-issue-unrefined"` (resolved, but every linked issue is prose-only — distinguishes
    "linked, no refinement artifact" from "not fetched"), or `"none"` (the PR closes no
    issue). The field is CLI-only: programmatic `buildGateContext`/`writeGateContext` callers
    omit it entirely, so a null `acceptanceCriteria` WITHOUT this field means "never
    resolved" and one WITH it means "genuinely absent" or "genuinely unrefined". An umbrella
    PR closing several issues resolves ALL of them (not just the first), concatenated under
    one `## Linked issue <ref1>, <ref2>` section with a `### <ref>` sub-heading per issue; a
    cross-repo closing reference registered by GitHub (`closingIssuesReferences`, which
    carries the repository alongside the number) resolves against ITS OWN repository, not the
    PR's — the `Closes #N` body-keyword fallback used when GitHub reports no closing
    references is same-repo only and cannot capture an `owner/repo` prefix. `--prefix-file`
    (an orchestrator recording its own
    already-rendered prefix) skips this resolution entirely — those fields could never reach
    the recorded bytes. Because the resolved PR/issue text is embedded in the rendered
    prefix, a same-head rebuild after a live description edit yields different prefix bytes,
    which would split one fan-out across two prefix hashes — so a conductor MUST NOT rebuild
    the context while reviewers for that head are still running. This does not affect the
    frozen artifact of an already-completed gate pass. Round retirement
    (`GATE-EXEC-ROUND-RETIREMENT`) does not relax this: it recovers a round AFTER a rebuild
    stranded it, and never licenses rebuilding mid-flight.
- reference the pi-subagents `parallel context-build` technique when applicable:
  run parallel `context-builder` agents from fresh context with distinct output paths
  (e.g. `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`,
  `context-build/validation-and-risks.md`) and synthesize the outputs into the review
  handoff artifacts

### Phase 1.5 — Cache primer (MANDATORY)

<!-- rule: GATE-EXEC-PRIME -->
`GATE-EXEC-PRIME`: **Every** gate fan-out MUST prime the shared prefix. After Phase 1
renders the byte-identical `<gate>-<headSha>.briefing-prefix.txt` and BEFORE the reviewers
read it, establish the shared-prefix cache **once** so the fan-out **cache-READS** the
invariant prefix instead of each reviewer racing to write it (1-write-N-reads) — the
cold-cache race the build-once bundle otherwise leaves on the table. This is not optional
and not a config knob: build context → primer reads → fan-out reads the SAME context bundle
plus its angle-specific briefing.

**Default execution — one-reviewer-as-primer (zero extra cost):** dispatch ONE real
reviewer first, then release the rest once its prefix write has landed — on its first
streamed token if the harness streams, else on its completion (see the barrier fallback in
step 3). No extra spawn, no extra tokens — the first reviewer runs anyway; the others simply
start after its prefix write has landed. This is why priming is mandatory rather than opt-in:
in its default form it costs at most a small serialization latency, and it removes an N×
cache-write on every fan-out.

**Alternative — dedicated angle-less primer:** spawn a single scoped `review` agent seeded
with the briefing prefix **verbatim and ONLY** (no angle suffix), which runs the mandatory
`verify-fresh-review-context.mjs` check, confirms context, and returns **without reviewing**
(no findings artifact). Cleaner to reason about; costs one extra angle-less spawn. Use it
where an explicit primer is preferred; otherwise the one-reviewer form is the default.

**The `<gate>-prime` scope and "no findings artifact" details below apply ONLY to the
dedicated angle-less primer variant.** In the default one-reviewer-as-primer path there is
no separate priming run: the lead reviewer is a normal reviewer that produces normal
findings under its own angle scope, and there is no `<gate>-prime` sentinel to account for.

**The primer MUST be the `review`-agent request envelope, not a bespoke `context-reader`.**
Byte-identical *artifact* bytes are necessary but NOT sufficient: the cache key is the whole
**request prefix through the breakpoint** — model, tools + tool ordering, system/project/
agent instructions, message/content-block boundaries, thinking/tool-choice settings, the
materialized context bytes, and the breakpoint position + TTL. A primer spawned as a
different agent (different system prompt, tool set, or model) writes a DIFFERENT cache that
the `review` reviewers never read. So the primer is literally a fan-out reviewer minus the
angle suffix — same agent, same envelope — or it is useless. Because it is angle-less it is
NOT a review round and **produces no findings artifact, so fan-in ignores it.** If it runs
the invariant block's `verify-fresh-review-context.mjs` check, it uses the reserved
`<gate>-prime` scope and records the SAME prefix hash as the reviewers — so it passes
`verify-briefing-prefixes.mjs` **by construction** (a same-hash sentinel is never a
mismatch), never a spurious failure. (`verify-briefing-prefixes.mjs` does not today special-
case `<gate>-prime`; because the primer's hash matches the reviewers', no exclusion is
required for correctness. Teaching that verifier to treat `-prime` as a non-angle in its
per-gate accounting is an optional follow-up, not a precondition.)

**Ordered execution:**

1. **Compile the immutable prefix** — Phase 1's `briefing-prefix.txt` (already
   byte-identical + hash-recorded).
2. **Prime the shared prefix** over that exact serialized prefix — by default dispatch the
   lead reviewer first (one-reviewer-as-primer); or, in the dedicated-primer variant, send
   ONE angle-less primer. Either way the same byte-identical prefix is written once.
3. **Barrier: await the shared-prefix write landing** before releasing ANY reviewer — the
   write must precede the parallel reads. The write has landed once the primer has produced
   ANY model output for that request, so the barrier keys on the earliest such signal the
   harness exposes:
   - **If the harness exposes streaming** (a token/first-chunk callback): release the rest on
     the primer's first streamed token.
   - **If it only exposes completion** (the common case — an agent/subagent call that returns
     a finished result): **await the primer's completion.** This is the mandatory fallback and
     the safe default; never release reviewers off an unobservable "start."

   The two forms of the primer differ only in WHICH signal they key on, never in the
   write-before-reads ordering. The completion fallback fully serializes the lead reviewer
   ahead of the rest — a small, bounded latency cost, and the reason the near-free
   one-reviewer form is still the default rather than a mandatory streaming dependency.
4. **Release the fan-out over the SAME model and the SAME byte-identical prefix**, so each
   reviewer READS the cache the primer wrote instead of racing to write its own. A
   differing model or prefix defeats reuse and is the same failure the byte-identity rule
   already guards against.

Rationale (why the primer, not just the shared prefix): a parallel fan-out with no primer
launches every reviewer before any has written the cache — a **cold-cache race** where all
N pay a cache write and none reads. The barrier collapses that to 1 write + N reads.

**No verification pass — dev-loops runs only on agent harnesses (pi, Claude Code).** There
is no raw-API path here: the orchestrator spawns primer and reviewers via the harness's
agent/subagent mechanism and never sees a request's `usage`, cannot set a
`prompt_cache_key`, and cannot place an explicit cache breakpoint — the harness owns
caching. So the primer cannot be verified from inside and there is nothing to pin; it
relies entirely on the barrier + byte-identical prefix + same model producing a
**content-hash cache reuse** across spawns (Anthropic caching matches on the content-prefix
hash, org+model scoped — not conversation-scoped, no explicit key required). Priming is
mandatory rather than a knob precisely because its default (one-reviewer) form is essentially
free: worst case is a small serialization latency (if a harness turns out not to reuse the
prefix across spawns), best case turns N cache-writes into 1 write + N reads on every
fan-out. The unmeasurability from inside the harness is a reason to prefer the zero-extra-cost
one-reviewer form, not a reason to make the win opt-in.

<!-- rule: GATE-EXEC-VALIDATION-ARTIFACT -->
`GATE-EXEC-VALIDATION-ARTIFACT`: The preamble MUST run the round's validation set exactly
once, before any reviewer is dispatched, via `run-gate-validation.mjs`, and MUST persist
the result as `<gate>-<headSha>.validation.json` beside the gate-context artifact. When
that artifact exists, the briefing prefix MUST point every reviewer at it
(`write-gate-context.mjs --validation-results <path>`), and a reviewer MUST consume it
rather than executing any suite it records. A reviewer that finds the artifact absent,
unreadable, or stamped with a different head SHA MUST report a gate-evidence finding; it
MUST NOT silently run the suite itself and MUST NOT treat the gap as clean.

### Phase 2 — Fan-out: independent reviewers seeded with the neutral bundle

Fan out one fresh-context reviewer per resolved **dispatch unit**. In the default grouped
mode a dispatch unit is a group of angles (`resolveFanoutGroups`, below): configured
`gates.fanout.groups` are matched first (unchanged), then the leftover ungrouped angles are
auto-chunked into dispatch units of ≤ `gates.fanout.maxAnglesPerGroup` (default 3, #1601)
instead of singletons. `mode: per-angle` bypasses configured groups (one singleton per angle); it matches `maxAnglesPerGroup: 1` in unit size only when no configured multi-angle group matches
(one singleton unit per angle, bypassing the configured-groups table). `gate:full` no longer
restores per-angle dispatch (ADR 0048 supersedes 0047): it forces the full angle set upstream
(`resolveGateTier` returns `gate_full_label`, so `resolveGateAnglesDynamic` skips diff-class
tier reduction) and dispatches **grouped** — configured groups first, then the leftover pool
auto-chunked into units of ≤ N. The reviewer is the scoped `review` agent ([review agent
scoped angle-review mode](../../agents/review.md)), spawned once per dispatch unit via the
plain Agent tool. Reviewers are **independent and seeded with the identical neutral context
bundle verbatim** (Phase 1's diff + `adjacentCode`); they do NOT fork from, or inherit the
loaded context of, the main agent or a sibling reviewer. The conductor dispatches
wave-by-wave at most `gates.fanout.maxConcurrent` (default 4, #1601) dispatch units
concurrently per wave, planned by `scheduleFanoutWaves` (`@dev-loops/core/loop/gate-fanin`,
reusing `scheduleParallelWaves`); the wave plan is emitted alongside the per-unit briefings
in the gate-context artifact (`write-gate-context.mjs` → `artifact.fanout.wavePlan`), and the
conductor dispatches wave-by-wave — awaiting a free slot (wave completion) before launching
the next — instead of fire-all-then-retry. When a reviewer dispatch 429s despite the cap, the
conductor halves the active batch (`backoffMaxConcurrent`), recomputes the wave plan, and
retries before escalating to foreground one-at-a-time fallback; the backoff is recorded in
the round's provenance. Each
reviewer:

- starts in fresh context: run the mandatory `verify-fresh-review-context.mjs` invocation exactly as Phase 1 specifies. In the fan-out, `--scope` additionally keeps parallel reviewers in the same working directory from tripping false contamination on each other's sentinels, and `--context-path` (the Phase 1 artifact) fails a reviewer in the wrong/isolated checkout closed. A grouped reviewer runs this ONCE for the whole group, with `--scope <gate>-group-<name>` (below), not once per angle it covers. The sentinel is keyed per review ROUND by the current head SHA, so a retry at a new head naturally gets a fresh sentinel — see [Sentinel lifecycle](#sentinel-lifecycle). Here "fresh" means the reviewer's context is the neutral builder artifact + its angle(s), and explicitly NOT the main agent's conversation/state or a prior reviewer session's state: the injected neutral bundle is the intended seed (allowed), while main-agent / cross-session state bleed fails closed.
- is seeded with the neutral context bundle verbatim (diff + `adjacentCode`) as its base, and widens (loads more files) only when a covered angle genuinely needs more — it does not re-derive the whole diff/adjacent-code graph. When it widens, it records in the findings artifact's optional `contextWidened` field ONLY the files that actually moved its judgment, never every file it opened. Absence of `contextWidened` (or an empty one) means "not consulted" — never "consulted and clean"; carry-forward and audit logic MUST NOT infer clean-ness from that omission.
- is scoped to exactly one review angle (one angle per unit under `mode: per-angle`, which bypasses configured groups; every angle in its resolved group (grouped mode, the default — including `gate:full`, which dispatches grouped) — each angle keeps its own prompt, all appended after the one shared invariant prefix (`GATE-EXEC-BRIEFING-PREFIX`)
- is **read-only**: inspects the diff and returns findings via output artifacts only; never edits files
- runs in the PR's actual worktree/head — **never an isolated worktree** (the Phase 1
  prohibition; `verify-fresh-review-context.mjs --context-path` enforces it mechanically —
  fails closed if the seeded artifact isn't present at the reviewer's cwd).
- produces a focused findings artifact PER ANGLE it covers, each with its own verdict (clean/findings_present) and file references, stamped per the head-stamp rule below — a grouped reviewer writes as many artifacts, at the existing per-angle paths, as it has angles, never one merged artifact for the group
- completion is detected via the harness completion notification, or the reviewer's findings artifact(s) at their deterministic output paths; the orchestrator awaits fan-in on those paths and joins via the sanctioned fan-in CLI `dev-loops gate consolidate-fanin` (backed by `consolidateFanin`; Phase 3). The forbidden fan-in wait improvisations (transcript-tailing, `node -e`/`python3` tool-JSON parsing, `sleep`-poll loops) and this sanctioned wait are owned by `ANTIPATTERN-FANIN-WAIT` in [anti-patterns](./anti-patterns.md).

**Grouped dispatch (default).** Before fanning out, the conductor resolves this round's
dispatch units by calling `resolveFanoutGroups(config, gate, resolvedAngles, { fullLabel })`
(`@dev-loops/core/config`): configured `gates.fanout.groups` are matched first (an angle in
no configured group joins the leftover pool), then the leftover ungrouped angles are
auto-chunked into dispatch units of ≤ `gates.fanout.maxAnglesPerGroup` (default 3, #1601)
instead of singletons, and the fan-out spawns ONE reviewer per returned group — never per
angle. `mode: per-angle` bypasses the configured-groups table and
emits one singleton unit per angle, reproducing the original one-reviewer-per-angle fan-out.
`gate:full` no longer makes every group a singleton (ADR 0048 supersedes 0047): it forces the
full angle set upstream and dispatches GROUPED. Because fan-in, the disposition ledger,
coverage checks, and `GATE-EXEC-ARTIFACT-HEAD-STAMP` all read per-angle artifacts and never
the reviewer that produced them, none of that machinery changes between the dispatch shapes.
Provenance for a grouped round records the shared group name on every angle a group's
reviewer covered (`fanoutReviewerPairingError`'s within-group exception, [Fan-out
provenance](#fan-out-provenance-closing-the-self-produced-artifact-loophole)) — not restated
here. Both bounds count **dispatch units** (groups), not angles — a group of N angles is one
concurrent unit; `countFreshDispatchUnits` derives the `requireFanoutProvenance`
`distinctReviewers` floor from fresh dispatch units automatically (#1601, no provenance-mechanism change).
<!-- rule: GATE-EXEC-NO-CWD-DEPENDENCE -->
`GATE-EXEC-NO-CWD-DEPENDENCE`: A reviewer MUST NOT depend on the shell's working directory — each command may start in the primary checkout, not the worktree under review, so a bare `git branch`/`git log`/`git diff` can read the wrong tree and produce confident false findings. Run the mandatory sentinel invocation as ONE compound command that enters the worktree first (`cd <worktree> && node scripts/github/verify-fresh-review-context.mjs ...`) with its cwd-relative `--context-path` exactly as briefed — the locality guard depends on that form, and the compound form is the sanctioned remedy for the resetting cwd. After it passes, address the tree explicitly with the explicit-root idiom owned by `WORKTREE-DEFAULT-USE` in [worktree-guidance](./worktree-guidance.md#default-rule-use-a-worktree-for-mutating-local-work) (`git -C <repoRoot>`, absolute-path reads), where `<repoRoot>` is the briefing prefix's `worktree:` line, echoed back as `repoRoot` in `verify-fresh-review-context.mjs`'s fresh output (the directory the sentinel ran in, worktree-local when the locality guard passed).

<!-- rule: GATE-EXEC-SOURCE-READ-WORKTREE -->
`GATE-EXEC-SOURCE-READ-WORKTREE`: A reviewer citing a skill/doc/source file in a finding MUST read it from the WORKTREE SOURCE under review, not from an installed skill layout (`.pi/skills/`, `~/.pi/agent/`). Installed copies lag a PR that modifies those source files, so reading them produces false high-severity findings against text the PR already fixed (#1603). Resolve skill/doc paths (e.g. `skills/<name>/SKILL.md`, `skills/docs/...`, `docs/...`) as RELATIVE paths from the worktree cwd named on the briefing prefix's `worktree:` line. Before reporting a finding that quotes a skill/doc line, verify the cited text matches `git show HEAD:<path>` (the worktree source at the reviewed head); a finding whose cited text does not appear in `git show HEAD:<path>` is a false positive against a stale installed copy and MUST NOT be reported. This governs SOURCE FILES reviewed as content, not HELPER SCRIPT paths invoked as tooling — those still resolve from the installed skill layout per `ASSET-PATH-SOURCE-NO-REPO-LOCAL`. The briefing prefix carries this invariant as a fixed `## Reviewer source-read invariant` section (below) so every reviewer of a round is seeded with it byte-identically.


<!-- rule: GATE-EXEC-ARTIFACT-HEAD-STAMP -->
`GATE-EXEC-ARTIFACT-HEAD-STAMP`: A per-angle findings artifact MUST carry a `headSha` field stamped with the reviewed head from the briefing, and Phase 3's `consolidate-fanin --head-sha <sha>` MUST fail closed, naming the angle, when an artifact's stamp differs from the round's head or is missing/malformed — unknown provenance is a failure, not a bypass. Two exemptions exist: an angle declared carried forward via `--carried-angles`/`--carry-forward-plan` (exact declared name, matched case-insensitively), which keeps the existing carry-forward behavior and leaves the ledger's `carriedFromHead` as the single provenance field; and a `verdict: "blocked"` artifact, whose refusal shape carries no stamp and whose failure is owned by the blocked-verdict fail-closed path. This is what makes a stale artifact staged out of an earlier round distinguishable from a fresh verdict at the reviewed head.

#### Briefing composition: invariant prefix first

<!-- rule: GATE-EXEC-BRIEFING-PREFIX -->
`GATE-EXEC-BRIEFING-PREFIX`: Every per-angle reviewer briefing MUST be composed as an
**invariant block** followed by the **angle-specific prompt(s)** of its dispatch unit (one
prompt per angle under `mode: per-angle` (bypasses configured groups: one singleton unit per angle); every angle prompt under
grouped mode, the default — including `gate:full`, which dispatches grouped as of ADR 0048), in that order —
never angle-first. The invariant block MUST be byte-identical across every reviewer of the
same gate pass and MUST carry, at minimum: the repo, PR number, head SHA, and worktree path; the
`write-gate-context.mjs` gate-context artifact path (`GATE-EXEC-BUILD-ONCE-SEED`); and the
mandatory `verify-fresh-review-context.mjs` instruction above. Angle identity MUST appear
ONLY in the suffix (the angle-specific prompt, e.g.
`COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING`'s persona prompt) and the reviewer's `--scope` flag
— never inside the invariant block, or the byte-identity requirement is violated by
construction and the shared-prefix prompt-cache opportunity is destroyed byte one.

**Cache alignment.** Prefix-first, angle-last is the cache-alignment rule: a provider prompt
cache matches on a shared PREFIX of the request, so the orchestrator MUST place the
byte-identical block at the START of every reviewer prompt and the angle-specific suffix
LAST, never interleaved or reordered per reviewer. This governs prompt LAYOUT only — the
byte-identity/hash machinery above (`--prefix-hash`/`--prefix-file`,
`verify-briefing-prefixes.mjs`) is unchanged, and the rendered
`<gate>-<headSha>.briefing-prefix.txt` file remains the recorded proof of what was
byte-identical. Under a harness where
the orchestrator seeds each reviewer with a pointer to that file rather than inlining its
bytes into the prompt (`prefixMode: "file"` below, or any other pointer-based seeding), the
pointer LINE ITSELF — not just the file it names — MUST be byte-identical across every
reviewer of the round; a pointer that varies per reviewer (e.g. embeds the angle name or a
per-reviewer path) defeats prefix matching exactly as an inlined angle-first prefix would,
even though the referenced file's bytes are still shared.

**Content inlining.** `write-gate-context.mjs` renders this invariant block as a
`<gate>-<headSha>.briefing-prefix.txt` file sibling to the JSON context artifact, in a
fixed section order: header (repo/PR/head/gate/worktree + the verify-fresh instruction),
`## Reviewer source-read invariant` (the worktree-source-over-installed-copies rule
`GATE-EXEC-SOURCE-READ-WORKTREE`, identical for every reviewer), `## Reviewer token
discipline` (the per-reviewer token-waste rules, identical for every
reviewer), PR body, linked-issue body (when present), the full diff at the reviewed head,
and a changed-files/adjacent-code summary, plus one CONDITIONAL trailing section, `##
Validation results at this head`, present only when a validation-results artifact was
threaded (`GATE-EXEC-VALIDATION-ARTIFACT`); absent that input, the seven fixed sections are
the whole prefix: the conditional section appends after the fixed sections without reordering or changing them. The PR body and
each linked-issue body are
author-controlled GitHub text (PR author or linked-issue author), so each is carried in
its OWN fenced markdown block, never inlined unframed — a fence renders as inert literal
text, so a hostile body cannot forge a `##`/`###` section heading (e.g. a fake linked-issue
label, or a second `## Diff at reviewed head`/`## Changed files` section ahead of the real
one) or emit `PR_BODY_ABSENT_SENTINEL`/`ISSUE_BODY_ABSENT_SENTINEL` as if it were the
renderer's own statement. A multi-issue PR's per-issue bodies are passed through as
structured data (label + body pairs), never pre-joined into one string, so the renderer
itself — not any one issue's body — owns emitting each `### <label>` heading, outside every
fence. Every fence delimiter (`pickFence`) is sized one backtick longer than the longest
backtick run already inside the text it wraps, so the wrapped content can never close the
fence early and leak into a later section. The diff SHOULD be inlined up to a size cap
(`BRIEFING_PREFIX_INLINE_DIFF_CAP_BYTES`, a fixed constant), carried inside a fenced
markdown block sized by the same `pickFence` rule — the fence and surrounding framing are
part of the rendered prefix bytes, so "inline" means the diff content travels in the
prefix, not that its raw bytes appear unframed. Over the cap the prefix falls back to
pointer mode: it references
`scope.diffPath` when the persisted `.diff` is present, and otherwise discloses that the
diff pointer is unavailable (reviewers re-derive via `git diff`). Either way the mode is
disclosed in both the artifact (`prefixMode: "inline"|"pointer"`) and the prefix text
itself — self-rendered modes only. A third, CLI-only mode, `prefixMode: "file"`
(an orchestrator-authored prefix recorded via `--prefix-file`, below), discloses the mode
in the artifact only: the recorded bytes are the orchestrator's own composed prefix
verbatim, so the prefix text itself carries no `prefixMode` line. This is purely a
size/performance choice and a zero-semantic change to the byte-identity requirement above:
whichever mode ran, every reviewer of the same round still receives byte-identical prefix
bytes, and `verify-fresh-review-context.mjs --prefix-file`/`verify-briefing-prefixes.mjs`
hash and compare those bytes exactly as before, oblivious to which mode produced them.

**Hunk-collapse.** Inline diff rendering (prefix and scoped variants below) first collapses
any run of AT LEAST TWO consecutive hunks that is PROVABLY one pure single-token
substitution — every changed-line pair in every hunk of the run replaces the SAME old
token with the SAME new token on a whole token boundary (never a shared substring inside a
larger identifier — a rename touching `grossAmount`/`netAmount` and a different rename
touching `grossRate`/`netRate` do NOT collapse together just because both reduce to
"gross"→"net" at the character level) — into one summary line naming the substitution, the
hunk/file counts, and the affected file paths (capped, with a "+N more" tail), with a
pointer back to the byte-exact `scope.diffPath`. A run of exactly one hunk stays below the
collapse floor and renders in full, unchanged — collapsing exists to absorb large
mechanical runs, not to hide a single hunk's own diff. Any hunk not provably pure (unequal
add/remove counts, more than one token changed, an inconsistent pair, or any changed line
that is not a `+`/`-`/context line) renders in full — fail-closed. A file whose own header
carries anything beyond the bare `diff --git`/`index`/`---`/`+++` identity lines (a mode
change, a rename, a similarity-index line, a binary marker) is excluded from collapse
entirely, even when every one of its hunks is otherwise pure: that metadata lives in the
header, not a hunk, so hunk-purity analysis alone would never see it, and a collapsed
summary line would silently drop it. This only changes what
gets INLINED; the persisted `.diff` file is never touched, so a reviewer can always read
the untouched original.

**Per-angle scoped variants.** An angle whose configured `scope` (`gates.<gate>.angles[].scope`)
is `changed-files` or `docs-only` gets an additional companion file,
`<gate>-<headSha>.briefing-<scope>.txt`, sibling to the invariant prefix: `changed-files`
carries the full (hunk-collapsed) diff without the adjacent-code bundle OR the invariant
prefix's "Changed files + adjacent-code summary" section — the diff text itself still names
every changed file, but the file-count/adjacent-file-list summary is not re-rendered into
this companion; `docs-only` narrows further to doc-file hunks only — its surface's own
diff slice, explicitly stating
"(no doc-file hunks in this diff)" when that slice is empty (a round that touched no doc
files is a truthful zero, not a builder fault). No
scoped variant drops a mandatory input: both variants MUST carry the PR body, the
acceptance-criteria text (linked-issue body/sections), and the validation-results pointer
verbatim from the invariant prefix, unabridged. A scoped variant MUST ALSO link the full
bundle unconditionally — an explicit pointer back to the invariant-prefix file path AND to
`scope.diffPath` (falling back to an explicit "pointer unavailable" line when
`scope.diffPath` is null), plus the sibling JSON context-artifact path — so a reviewer
whose angle turns out to need more than its slice can always widen to the
full diff and adjacent-code bundle (`GATE-EXEC-BUILD-ONCE-SEED` still applies — a scoped
variant is an additional narrow seed, never a replacement, and AC1's reviewer-effectiveness
requirement is exactly this: no angle loses PR body, acceptance criteria, validation
results, or its surface's diff slice, and every angle can reach the full bundle on demand).
The context artifact records each
resolved angle's scope (`angleScopes`) and the emitted variant paths (`briefingVariants`);
an unconfigured/unknown scope, or any error building a variant, fails open to the full
invariant prefix.

**Enforcement.** Each reviewer passes `--prefix-hash <sha256>` (or `--prefix-file <path>`,
hashed by the tool) to `verify-fresh-review-context.mjs`, which persists the hash on the
reviewer's per-scope sentinel. This hash/file is ALWAYS the invariant prefix, never a
per-angle scoped variant: a reviewer additionally seeded with `briefingVariants[scope]`
(previous section) still hashes/records the invariant-prefix bytes it was also given, so
this per-gate record index and the one-hash-per-round check below apply unchanged whether
or not any reviewer of the round was additionally seeded with a variant — the variant
carries no hash or record of its own. An orchestrator that briefs reviewers with its OWN
composed prefix records it with `write-gate-context.mjs --prefix-file <path>` — the
record file then carries those exact bytes (`prefixMode: "file"`) instead of the
tool's self-rendered prefix, so the fan-in verification below agrees with the actual
briefing without any hand-edited record files. Before Phase 3 consolidation, the fan-in MUST run
`scripts/github/verify-briefing-prefixes.mjs --head-sha <sha>`, which fails closed (exit 1)
when sentinels for the same round record two or more DISTINCT prefix hashes, or when any
sentinel for the round records no prefix hash at all — a missing hash means the
invariant-prefix proof was never established for that reviewer and is treated the same as
a mismatch, never grandfathered in — a single hashless sentinel (e.g. a one-angle Phase 5
retry round) fails closed the same way. The check is deterministic and offline: it only
reads sentinel and record files already on disk. Verification is **per-gate by record
hash**: `write-gate-context.mjs` persists a per-gate briefing-prefix record
(`<gate>-<headSha>.briefing-prefix.txt` under `tmp/gate-context/**`), and the fan-in builds
a hash→gate(s) index from those records. Each sentinel's recorded hash must match one of
those records, so two gates reviewed at the same head each verify against their own record
instead of colliding into a spurious mismatch. A hash matching no record, or a hash
belonging to a DIFFERENT gate than the sentinel's gate-prefixed scope declares, fails
closed. Only when no on-disk records exist (offline/legacy) does it fall back to the flat
rule that all of the round's sentinels share ONE identical hash. See
`verify-briefing-prefixes.mjs --help` for the worked same-head two-gate example.

<!-- rule: GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK -->
`GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`: Reviewers SHOULD run in parallel when practical; when parallel execution is impractical
(for example due to tooling or resource constraints), the fan-out MUST run all reviewers
sequentially and MUST record why parallel execution was impractical.

**Re-run rule:** In subsequent retry cycles (Phase 5), re-running is governed by
[GATE-EXEC-ANGLE-CARRY-FORWARD](#angle-carry-forward-fail-closed): carry-forward is the
default posture, so the seam runs first and its plan decides the re-dispatch set — every
angle it proves untouched keeps its clean verdict, everything it leaves unproven is
re-reviewed, and every mandatory / always-run angle is re-reviewed regardless. A clean
angle is re-reviewed whenever the new head's delta touches its surface or the prior log
attributes any finding to it; it is spared only when the delta provably cannot affect it.

#### Sentinel lifecycle

The fresh-context sentinel, written by `verify-fresh-review-context.mjs`, is scoped **per
review round**, keyed by the head SHA. This makes the lifecycle mechanical rather than a
manual chore:

- The round key is the current head SHA (`git rev-parse HEAD`); reviewers keep invoking the
  guard as `--scope <gate>-<angle>` (a **gate-prefixed** scope, e.g. `draft-gate-coverage`)
  and get head-keyed isolation for free — no flag to pass. The gate prefix attributes each
  sentinel to its gate for the per-gate record-hash check above; the head key gives retry
  isolation. `git rev-parse HEAD` yields the same full SHA on every invocation for a given
  head, so the key is deterministic and the same-head guard cannot be defeated by an
  inconsistent spelling. The sentinel filename is therefore
  `tmp/checkpoint-context-sentinel-<scope>-<headSha>.json` in a
  git worktree. When git is unavailable (non-git worktree, no commits), the head component is
  omitted and the key falls back to the scope-only filename
  `tmp/checkpoint-context-sentinel-<scope>.json` (legacy behavior) — there is no `-<headSha>`
  file in that case.
- **A retry at a new head is never blocked by a prior round's sentinel** — a new head SHA
  produces a new key, so a re-fan-out after a fix commit passes `fresh: true` with **no
  manual clear step**.
- **Within one round the contamination guard is preserved:** a same-scope + same-head
  re-entry still fails closed (`fresh: false`, exit 1) — that is genuine main-agent /
  cross-session state bleed. (Two sanctioned same-head paths exist, neither of which is
  state bleed: the opt-in `--same-head-retry` overwrite documented below —
  `--pr-body-fix-retry` is its deprecated alias — gated on a matching prefix hash for an
  UNCHANGED briefing, and explicit round retirement under `GATE-EXEC-ROUND-RETIREMENT` for
  a REBUILT briefing.)
- The orchestrator **MUST NOT** need to manually clear sentinels between rounds, and
  **MUST NOT** clear the sentinels of carried-forward clean angles (Phase 5's re-fan
  re-invokes the surface-touched angles, every angle that produced `findings_present`, and
  every mandatory / always-run angle; carried-forward clean angles are not re-invoked. Every
  re-invoked angle gets a distinct new-head key, so no cleanup is required). A round
  retirement (`GATE-EXEC-ROUND-RETIREMENT`) does not conflict with this: its audited sweep
  is scoped to the retired gate+head, and a carried-forward angle's sentinel is keyed at
  its PRIOR head, out of the sweep's reach.
- Stale pre-round sentinels (the old scope-only name) never collide with a head-keyed round
  and are simply ignored.

**Sanctioned same-head retry.** Some legitimate re-runs never earn a new round key, so a
plain re-invocation of the same angle collides with its own pass-1 sentinel and fails closed
exactly like genuine contamination would. The sanctioned scenarios are:

- **PR-body/description-only fix** (e.g. adding a missing acceptance-criteria matrix to
  satisfy `pr-checklist-matrix`): a body edit never changes the head SHA, so the round key
  stays the same.
- **Interrupted reviewer**: a reviewer killed or interrupted AFTER running the sentinel
  check but BEFORE writing its findings artifact burned the (scope, round) sentinel while
  producing nothing; the re-dispatched reviewer for the same scope+head is a retry, not
  state bleed.
- **Harness crash** mid-round, same shape as the interrupted reviewer.

`verify-fresh-review-context.mjs --same-head-retry` (deprecated alias: `--pr-body-fix-retry`)
is the sanctioned escape hatch for all of them: it overwrites the existing sentinel for that
scope+round, but **only** when the given `--prefix-hash`/`--prefix-file` matches the existing
sentinel's recorded prefix hash **exactly**. An identical hash proves the seeded briefing
bytes were NOT rebuilt, so the byte-identity invariant (`GATE-EXEC-BRIEFING-PREFIX`) stays
fully intact for every other sentinel of the same round — the previously-clean angles'
sentinels are left untouched and still verify against the same on-disk record, so
`verify-briefing-prefixes.mjs` needs no full re-fan of clean angles and no manual sentinel
deletion. The retry's REASON never enters the decision; the hash equality is the entire
safety argument, which is why one mechanical guard covers every scenario above. A hash
mismatch (the context-builder genuinely rebuilt the briefing) or an existing sentinel
recording no prefix hash still fails closed — this flag is a narrow, auditable exception,
never a general bypass of the contamination guard. The mismatch case is not a dead end:
its sanctioned recovery is retiring the round explicitly under
`GATE-EXEC-ROUND-RETIREMENT` below. Practically: re-brief the retried
reviewer with the UNCHANGED, byte-identical invariant prefix (do not re-run
`write-gate-context.mjs`); for the PR-body-fix case additionally instruct the reviewer to
fetch the CURRENT PR body/description live (e.g. `gh pr view`) rather than trust the
prefix's now-stale inlined copy, since the point of that retry is to re-check the
just-edited description. See `verify-fresh-review-context.mjs --help` for the flag's exact
semantics and exit codes.

**Sanctioned rebuild-and-retire.**

<!-- rule: GATE-EXEC-ROUND-RETIREMENT -->
`GATE-EXEC-ROUND-RETIREMENT`: When the gate-context bundle is legitimately REBUILT at the
same head (the builder resolves PR/issue inputs itself, and correcting bad or stale
seeding is a legitimate rebuild; rebuilding while reviewers are still running remains
forbidden — see the conductor rule in Phase 1), the new briefing-prefix bytes hash
differently, so every
existing sentinel of that round fails closed forever — including under `--same-head-retry`,
whose hash-equality gate a rebuild destroys by design. The sanctioned recovery is retiring
the round explicitly: `node scripts/github/retire-gate-round.mjs --gate <gate> --head-sha <sha>
--reason "<why>" [--findings-dir <round artifacts dir>]` (`--head-sha` is the FULL 40-char
SHA the sentinels are keyed by) moves every sentinel of THAT GATE keyed by that head
(and, when given, the round's findings-artifacts directory) into an audited retirement
directory (`tmp/retired-gate-rounds/<sha>/round-<n>/` with a `retirement.json` record; the
other gate's live round at the same head is never touched), so a
FRESH fan-out can run at the same head with every reviewer of the new round agreeing on the
one new hash. Retirement MUST be explicit — `write-gate-context.mjs` warns (naming this
command) when a rebuild overwrites a differing prefix at a head with live sentinels, and
never retires as a side effect. The caller MUST pass `--findings-dir` whenever the retired
round wrote artifacts: at the same head they would pass the `GATE-EXEC-ARTIFACT-HEAD-STAMP` guard and
silently mix into the new round's fan-in; retiring them is the explicit discard. The
retirement directory keeps them recoverable for AUDIT — feeding a retired artifact back
into the new round's fan-in is NOT sanctioned (the new round re-reviews its angles; the
one-hash-per-round invariant covers only artifacts its own reviewers wrote). The
carry-forward channel is closed the same way: `resolve-angle-carry-forward.mjs` fails
closed when `--prev-head` equals `--head-sha`, so a retired round's verdict can never
re-seed the fresh fan-out at the same head via `GATE-EXEC-ANGLE-CARRY-FORWARD` either. Retirement
never weakens the `GATE-EXEC-BRIEFING-PREFIX` enforcement in
`verify-briefing-prefixes.mjs`: retired sentinels live under a subdirectory its flat scan
never reads, and sentinels of one LIVE round that disagree still fail closed. A gate+head
with no sentinels and no `--findings-dir` retires as a no-op.

### Phase 3 — Consolidation: fan-in synthesis and disposition ledger

Before consolidating, run `scripts/github/verify-briefing-prefixes.mjs --head-sha <sha>`
(the `GATE-EXEC-BRIEFING-PREFIX` enforcement check); a fail-closed result (mismatched or
missing prefix hashes across this round's reviewer sentinels) MUST stop the pass rather
than proceed to consolidation.

Merge the parallel reviewer findings into one consolidated fix plan with the
sanctioned fan-in CLI:

```
dev-loops gate consolidate-fanin --findings-dir <dir> --head-sha <sha> \
  --gate <draft_gate|pre_approval_gate> --out <path> --ledger-out <path> \
  --jq '.severityCounts' \
  [--carried-angles <json> --carry-forward-plan <json>]
```

(`scripts/loop/consolidate-fanin.mjs`), a thin wrapper over the pure
`consolidateFanin` pass from `@dev-loops/core/loop/gate-fanin` — never manual
concatenation and never an inline interpreter over the artifacts. Pass
`--head-sha <sha>` (the round's reviewed head) on every round; the fail-closed
stamp rule it activates is owned by `GATE-EXEC-ARTIFACT-HEAD-STAMP` (Phase 2).
`--gate`
applies that gate's configured `blockCleanOnFindingSeverities` to the overall
verdict; omitting it falls back to the shipped `["high"]` default. This ONE
invocation reads the per-angle artifacts directory and emits `findingsJson`
(written to `--out <path>`) — the nested per-angle shape
`upsert-checkpoint-verdict.mjs --findings-json` accepts directly, clean angles
included — plus the flat ledger shape (written to `--ledger-out <path>`) —
the exact `--findings-file` input `write-gate-findings-log.mjs` and
`post-gate-findings.mjs` accept, so neither tool needs an improvised
`--jq`/`node -e` extraction step to materialize it — the severity counts, and
the overall verdict, upserting the mandatory `pr-checklist-matrix` entry when
asked (`--pr-checklist-matrix clean`). Its stdout result carries `overallVerdict`,
`severityCounts` (the true, unbudgeted totals), and the `out`/`ledgerOut` paths
it actually wrote — a caller narrows that same stdout to just the severity
breakdown with `--jq '.severityCounts'` (as above) without a second
invocation, since the `--out`/`--ledger-out` writes already happened before
`--jq` renders. FAILS CLOSED (exit 1, naming the offending angles) when any
per-angle artifact is malformed or itself blocked — a blocked fan-in never
yields a publishable findings shape; fix or re-run the offending reviewer
first.

`--carried-angles <json>` (a JSON array of angle-name strings — Phase 1.2's
`plan.carried[].angle` values) upserts `{ angle, verdict: "clean", findings:
[], carriedFromHead: <A> }` for every named angle with no Phase 2 artifact, so
a carried angle stays visible to `findingsJson`/the mandatory-angle coverage
check/the posted verdict comment instead of reading as a truncated fan-out (an
angle whose artifact was never written and is NOT named here is still
invisible to the CLI). `--carried-angles` is PAIR-REQUIRED with both `--gate`
and `--carry-forward-plan <json>` (Phase 1.2's own plan result, or just its
`carried` array) — the plan is the proof, checked against the SAME
`angleReviewSurface` predicate `resolve-angle-carry-forward.mjs`'s own producer
uses, so the two can never drift. Given without its pair, or given a name that
predicate refuses (a configured mandatory angle, a hardcoded `ALWAYS_INCLUDE`
angle — `gate-evidence`/`renderer-security`/`pr-description` — or an
unmapped/unknown angle) or absent from the plan's own `carried` list, the CLI
FAILS CLOSED (exit 1) rather than mint a fabricated clean entry. The emitted
`carriedFromHead` field marks ONLY an entry this flag upserted — every
freshly reviewed angle's entry omits it — so `--out`'s own shape, not just the
ledger's `provenance.perAngle`, distinguishes carried from fresh.

`--out`/`--ledger-out` are also rejected at
parse time (exit 1) when they resolve to the same path as each other, or when
either resolves to a direct top-level sibling of the artifacts inside
`--findings-dir` (a subdirectory of `--findings-dir` is fine — artifact
discovery is top-level-only).

The render budget applies ONLY to the visible-comment shape (`--out`) — never
to the ledger (`--ledger-out`, always written in FULL, never budgeted). Fit is
measured by actually rendering a candidate `--out` shape through
`upsert-checkpoint-verdict.mjs`'s own render path and catching its
length-exceeded throw, not an approximated size, so a shape this CLI accepts
never later throws when `upsert-checkpoint-verdict.mjs` posts it. A round too
large to render even at minimum summary length exits 0 with
`commentBudgetExceeded: true` and degrades `--out` through four tiers, PROVIDED
`--ledger-out` was also given; without `--ledger-out` the same over-budget
round instead FAILS CLOSED (exit 1) at the point it would degrade, since a
degraded round's only durable, unbudgeted record is the ledger and nothing
would land on disk (the findings would exist only on that process's stdout,
which the sanctioned ledger/post path cannot consume). Which
tier an angle lands on is NOT decided by whether that angle's own marker fits
in isolation: angles are upgraded one at a time, in order of each angle's
most urgent severity (SEVERITY_ORDER's own rank; ties by artifact index), and
an upgrade is kept only while the WHOLE round still renders — so a low-only
angle can stay bare purely because a more urgent angle consumed the budget
first, even though its own verbose sentence would fit alone:

1. **real (unmarked)** — an angle whose own real findings, tried at their
   ORIGINAL pre-shrink length first and falling back to the
   whole-round-shrunk length, still let the whole round render keeps them
   as-is, since a marker is a compression and must never replace real
   content with something bigger.
2. **verbose** — failing that, that angle's findings are replaced with ONE
   synthetic marker finding naming its omitted count and severity breakdown.
3. **bare** — that angle's marker shortens to a bare omitted-count line when
   neither its real findings nor the verbose sentence fit.
4. **withheld** — reached only when even the CHEAPEST per-angle shape (the
   bare line, or an angle's own real findings when those render shorter)
   across the WHOLE round still does not fit: `findingsJson` in the result is
   emitted empty and `--out`, if given, is REMOVED from disk (deleted, not
   merely skipped — a stale prior-round `--out` is never left for a caller to
   read as this round's findings).

Tiers 1-3 keep the REAL angle set and each angle's REAL verdict intact (never
collapsed into one foreign section, which would fail
`upsert-checkpoint-verdict.mjs`'s mandatory-angle/pool validation). Only in
tier 4 is `--out` never written (or removed if it already existed); whoever
posts the verdict via the
[Gate comment command](../copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract)
MUST check for `--out`'s existence before passing `--findings-json <path>` —
passing a path that was never written fails closed with ENOENT; fall back to
that command's `--findings-summary` instead, naming the round size and
pointing at the ledger (`--ledger-out`), which is always complete regardless
of tier. Dropping `--findings-json` does NOT also drop
`--findings-severity-counts` — that flag's requirement is scoped to
`verdict === "clean"` under a gate with `blockCleanOnFindingSeverities`
configured, independent of execution mode, so a clean tier-4 round must still
pass it. Which artifact proves angle coverage depends on whether the comment
can carry per-angle data: `--findings-json`'s per-angle shape lets
`upsert-checkpoint-verdict.mjs` check coverage straight off the comment
content, but ANY `fanout_fanin` verdict posted without `--findings-json` —
tier 4's withheld round is the motivating case, but the code does not
distinguish it from a normal-sized round that simply omitted the flag —
carries no per-angle data to check that way. For that case,
`upsert-checkpoint-verdict.mjs` instead proves coverage from the round's
disposition ledger — when `--findings-ledger` is also passed, it re-validates
the ledger's recorded `provenance.perAngle` against the gate's mandatory
angles AND the gate's configured pool, and refuses to post (naming the
missing angle(s), or the foreign one(s)) when it does not cover them, or when
the ledger records no valid provenance at all. It shares
`checkFanoutAngleCoverage` (`@dev-loops/core`) with both the `--findings-json`
check above and `detect-checkpoint-evidence.mjs`'s own read-time
re-validation below — passing the gate's `pool` on every call site — so the
three can never define "covered" differently for either the mandatory-angle
or the foreign-angle half of the check. A tier-4 round MUST still write its
findings-log ledger via `write-gate-findings-log.mjs --provenance` covering
the gate's mandatory angles, and pass `--findings-ledger` when posting the
verdict, so this check actually runs; this is a MECHANISM, not a policy
obligation on the agent — when the gate configures mandatory angles,
`upsert-checkpoint-verdict.mjs` refuses (naming the required flags) any
`fanout_fanin` verdict that supplies NEITHER `--findings-json` NOR
`--findings-ledger`, since neither artifact is present to prove coverage. A
gate with no mandatory angles configured is unaffected (vacuously covered
either way). `detect-checkpoint-evidence.mjs`'s independent read-time
enforcement (below) remains the backstop on the merge path regardless.
`write-gate-findings-log.mjs` only runs its own write-time provenance/
mandatory-angle check when `--provenance` is actually supplied,
`gates.requireFanoutProvenance` (which would make that flag required) defaults
to `false`. `detect-checkpoint-evidence.mjs` enforces mandatory-angle coverage
from the ledger's recorded provenance BY DEFAULT for any `fanout_fanin`
verdict where the gate configures mandatory angles — a ledger with absent or
invalid provenance fails closed there regardless of `requireFanoutProvenance`.
Only the CI gate-evidence verifier bypasses this, by calling
`detect-checkpoint-evidence.mjs` with `--skip-fanout-ledger-check`; the
sanctioned pre-merge invocation runs without that flag, so the check is live
on the merge path by default. Pass `--provenance` on the tier-4 ledger write
regardless, since it is the only record of mandatory-angle coverage this round
can have, and a missing one fails both the write-time post and the
merge-evidence check closed. `commentBudgetExceeded: true` is set on every degraded round
(tiers 1-4 alike), so it does NOT distinguish tier 4 from tiers 1-3 — `--out`'s
existence is the only correct discriminator. On a marker-collapsed round, the
posted `**Findings summary:**` digest counts the real totals (not the marker
lines) when the caller also passes `--findings-severity-counts` with this
consolidation's own `severityCounts` (always the true, unbudgeted totals);
the marker text and the ledger always carry the true numbers regardless.

Consolidation:

- collate findings from all review angles
- classify each finding: `high`, `medium`, `low` (defects), or `question`/`nit`
  (non-defects) — severity is the reviewer's advisory weight only; deferral is a
  DISPOSITION — derived at fan-in for non-blocking findings, finalized per thread by the
  fix cycle / gate close — so no severity is spelled "defer" — the pre-rename spellings
  (`must-fix`, `worth-fixing-now`, `nice-to-have`, `defer`) are normalized to their
  canonical replacement on read. A LOCATABLE `question` is answered, never deferred: the
  fixer replies (an answer that reveals a defect promotes it to `high`/`medium`/`low`; an
  unanswerable question escalates to the author), and an unanswered question blocks
  gate-close exactly like an open defect. A NON-LOCATABLE `question` has no resolvable
  thread to answer through — it is body-filed and deferred by construction, exactly like
  every other non-`high` body-filed finding (`GATE-EXEC-DEFERRAL-RECORD`). A `nit` is a
  cosmetic, non-defect finding deferred immediately, with no fixer cycle.
- write the disposition ledger: every finding receives a severity classification and a
  disposition (accepted-for-fix, deferred, needs-answer, disputed, or operator_acknowledged) —
  needs-answer applies only to a LOCATABLE question; a non-locatable one gets deferred
- produce a merged findings artifact
- determine the overall gate verdict:
  - `clean`: no findings with a severity in the gate's `blockCleanOnFindingSeverities` list remain
  - `findings_present`: one or more findings with a blocking severity remain
  - `blocked`: the gate could not complete or a hard blocker prevented a verdict

Ledger content and write-before-comment sequencing are owned by
`GATE-EXEC-DISPOSITION-LEDGER` below.

<!-- rule: GATE-EXEC-POST-BEFORE-FIX -->
`GATE-EXEC-POST-BEFORE-FIX`: The round's findings MUST be visible on the PR **before** the
fix cycle in Phase 4 begins, so they are auditable and Copilot/humans are aware of them.
Fixes MUST NOT be applied until that trail exists. The trail is the round's own verdict
review (`GATE-COMMENT-SINGLE-SURFACE`): its inline finding comments plus the body-filed
findings under the verdict fields, posted by `upsert-checkpoint-verdict.mjs --findings-ledger`
in one call, so the findings and the verdict land together and no separate post step can be
skipped or reordered. The disposition ledger is written before that post
(`GATE-EXEC-DISPOSITION-LEDGER`) and regardless of it.

`post-gate-findings.mjs` renders the same findings a SECOND time, as a consolidated
marker-tagged PR issue comment grouped by severity. It is governed by
`gates.postFindingsComments` (resolved via `resolveGatePostFindingsComments(config)`,
default false / opt-in) and no-ops with a `skipped` result unless a repo explicitly turns
it on. A repo that does opt in accepts duplicated finding text on a second surface for
every reader; nothing in the gate flow requires it. This comment is itself bounded by
GitHub's per-comment character limit: a round large enough to approach that limit degrades
by dropping individual findings, least-urgent first (across every less-urgent severity before
touching a more-urgent one), so a round only slightly over the limit loses only as many
low-priority findings as it takes to fit, naming what was omitted in the posted
comment and pointing at the disposition ledger (always complete, never bounded) as the full
record; a round that cannot fit even with only one finding surviving fails the post closed
rather than reporting success. Do not assume this comment alone carries every finding of a large
round — the ledger is the one surface with that guarantee.

Because the findings ride the verdict review itself, they occupy the same post-verdict,
pre-fix slot relative to Phase 4 — unresolved threads exist on the PR before any fix is
attempted. On `pre_approval_gate`, an unresolved review thread forbids the gate's own next
actions, which is why that slot matters there; the same slot is kept for `draft_gate` too,
for uniformity, even though the draft boundary does not carry that specific refusal.

### Phase 4 — Fix

If findings with a severity in the gate's `blockCleanOnFindingSeverities` list are present:

- apply only the accepted narrow fixes on the same branch
- do not broaden scope or touch unrelated files
- run the smallest honest validation for the accepted fix scope
- commit and push fixes on the branch
- <!-- rule: GATE-EXEC-BLOCKING-ONLY-FIX --> `GATE-EXEC-BLOCKING-ONLY-FIX`: At every round,
  the fix cycle covers every finding whose severity is in the gate's
  `blockCleanOnFindingSeverities` set. Through this gate's configured medium fix
  window (default 3, `gates.<gate>.mediumFixWindow` — the deprecated
  `worthFixingNowFixWindow` key is still honored as an alias, `mediumFixWindow`
  wins when both are set; #1581) of the gate's chain, it also covers
  every open LOCATABLE medium finding — one anchored to an in-diff `file:line` and
  tracked through its own resolvable review thread per `GATE-EXEC-FINDING-THREADS` — fixed the
  same way even though that severity is not in the blocking set. From the next round on (round 4
  under the default window), an open
  locatable medium finding is no longer fixed inside the gate: it is deferred per
  `GATE-EXEC-THREAD-DISPOSITION` instead. A NON-LOCATABLE medium finding (body-filed:
  no code location, so it never gets a thread to fix through) is outside this round window
  entirely — it is deferred by construction at post time, at any round, per
  `GATE-EXEC-DEFERRAL-RECORD`. A low finding is a fixer TRIAGE target, not a silent
  auto-defer (#1585): the fixer receives every gate-authored finding (high,
  medium, AND low) as a fix/triage target and may fix-if-cheap-in-the-same-commit
  (free polish when already touching that code), else defer. Defer is permitted from round 1 on for
  low findings — no forced fix window (the medium window (#1581) is unaffected). A LOCATABLE
  question is a fixer ANSWER target, never fixed or deferred: the fixer replies with an answer
  (promoting the
  finding to a defect severity if the answer reveals one, or escalating to the author when
  unanswerable); an unanswered locatable question blocks gate-close exactly like
  an open defect (see `GATE-EXEC-THREAD-DISPOSITION` below). A NON-LOCATABLE question (body-filed)
  is, like every non-high body-filed finding, deferred by construction at post time per
  `GATE-EXEC-DEFERRAL-RECORD` — the answered/never-deferred contract applies only to a locatable
  question's own resolvable thread, which is the only surface an answer reply can land on. A nit
  is deferred immediately at round 1, with no fixer cycle at all. Two layers
  govern this, and they stay distinct: the LEDGER verdict is `clean` whenever
  no finding at a blocking severity remains, computed from `blockCleanOnFindingSeverities` alone
  and never from an open medium thread; an unresolved in-window locatable
  medium THREAD still forces another fix round, but through the unresolved-feedback
  routing `GATE-EXEC-THREAD-DISPOSITION` owns, not by changing what the ledger verdict `clean`
  means. GATE-CLOSE is a third, stricter layer (see `GATE-EXEC-THREAD-DISPOSITION` below): a
  clean verdict is NOT sufficient to close the
  gate — every gate-authored review thread (any severity) must be resolved (fix-closed by the
  fixer, answered for a locatable question, or defer-closed by the disposition pass) first, asserted by
  `fetchDraftGateEvidence` /
  `ready-for-review.mjs` / `pre-pr-ready-gate.mjs` (and the `draftGateSatisfied` field fold in
  `detect-checkpoint-evidence.mjs`) as 0 unresolved gate-authored threads
  (`GATE-EXEC-THREAD-DISPOSITION`). Widening the blocking set is a per-gate config decision (`blockCleanOnFindingSeverities`),
  never a round-by-round judgement call.

### Phase 5 — Repeat until clean

After applying fixes and advancing the head SHA:

- <!-- rule: GATE-EXEC-REGATE-MANDATORY --> `GATE-EXEC-REGATE-MANDATORY`: **Re-gate is mandatory:** a new head SHA MUST always trigger a fresh full-chain gate pass; the gate MUST NOT be skipped because a previous head was clean. The `draft_gate` one-time skip is a narrow exemption from this rule that only applies after the PR has left draft ([GATE-COMMENT-DRAFT-REQUIREMENTS](./gate-review-comment-contract.md#draft-gate-draft_gate-comment-requirements)); while the PR is still draft, every new head is re-gated per this rule.
- rerun the sub-loop from Phase 1 (context-builder preamble for the new head SHA)
- continue the fix-then-retry cycle until the synthesis verdict is `clean`
- on retry, re-invoke every reviewer whose review surface the new head's delta touched (always including any angle that previously returned `findings_present`), and re-invoke every mandatory / always-run angle; the context-builder and consolidation always run fresh. A previously-clean angle whose surface the delta provably did NOT touch is by default **carried forward** per [GATE-EXEC-ANGLE-CARRY-FORWARD](#angle-carry-forward-fail-closed) below, on that rule's proof and never on guesswork
- a clean pass means all gate-specific review angles pass and no findings with a severity in `blockCleanOnFindingSeverities` remain

#### Angle carry-forward (fail-closed) {#angle-carry-forward-fail-closed}

<!-- rule: GATE-EXEC-ANGLE-CARRY-FORWARD --> `GATE-EXEC-ANGLE-CARRY-FORWARD`: On a head bump, a previously-**clean** angle verdict IS
carried forward to the new head by default — reusing the prior reviewer's clean result
instead of re-fanning that angle — whenever, and ONLY when, the delta between the prior
reviewed head (A) and the new head (B) provably does not touch that angle's **review
surface**. Carry-forward is the DEFAULT posture at every re-gate: the re-dispatch set is
what this rule leaves unproven — every angle whose review surface the delta touches, every
angle the prior log attributes a finding to at any severity, and every mandatory /
always-run angle — and each angle the seam marks `carried` keeps its proven verdict. A full
re-dispatch of the entire resolved angle set is the EXCEPTION: it is taken when the seam
refuses to emit a plan at all (any fail-closed refusal condition below), when the gate has
no prior head, or when the prior log is not `clean`. "Default" describes which decision
procedure runs, never a per-angle presumption: the per-angle default without proof stays
`false` (see the fail-closed defaults below). This is a narrow, fail-closed refinement of the re-fan step above, NOT an exemption from `GATE-EXEC-REGATE-MANDATORY`: the full gate chain still runs at head B (context-builder + consolidation always fresh, plus every angle whose surface changed and every mandatory angle); carry-forward only spares the reviewers that provably have nothing new to look at. An angle
the prior log attributes any finding to at any severity, including a finding deferred to a
PR review thread per `GATE-EXEC-THREAD-DISPOSITION` rather than fixed in-gate, is re-reviewed
at every re-gate that follows; that is this rule's fail-closed cost, accepted deliberately.

The decision is a pure, deterministic, fail-closed seam — `resolveAngleCarryForward` / `resolveCarryForwardAngles` in `@dev-loops/core/loop/gate-carry-forward` — driven by the CLI `scripts/github/resolve-angle-carry-forward.mjs --repo <r> --pr <n> --gate <g> --prev-head <A> --head-sha <B>` (run from the worktree at head B). It reads the prior CLEAN findings-log for head A, computes the delta as the direct two-dot tree diff `git diff A..B` (never three-dot — a two-dot diff never omits a file that differs between the reviewed head A and B, so a non-fast-forward advance cannot carry an angle whose surface changed), and returns per angle `carryForward: true|false` with a reason.

**Review-surface mapping.** An angle's review surface is the set of file "surface kinds" whose change could implicate it, derived from the single source of truth for change-category → angle relevance (`CATEGORY_ANGLE_MAP`) via each file's `classifyFile` kind (`code` | `docs` | `config` | `test` | `ci`):

- code-correctness angles whose surface excludes `docs` (`scope`, `correctness`, `coverage`, `determinism`, …) → their surfaces are derived per angle from `CATEGORY_ANGLE_MAP` and vary (e.g. `scope` → `code`/`config`/`ci`; `coverage`/`determinism` → `code`/`test`); across the group the surface kinds union to `code`/`test`/`config`/`ci` but exclude `docs`, so a pure doc delta touches none of them and they carry forward.
- doc-inclusive angles (`docs`, `link-check`, `contract-surface`, `dry`) → surface includes `docs` (they are all in `CATEGORY_ANGLE_MAP[DOCS_ONLY]`); a pure doc delta re-runs them. `contract-surface` and `dry` therefore do NOT carry forward on a doc-only delta.
- `config-drift` → `config`/`ci`; `ci-guard` → `ci`.
- always-run angles (`gate-evidence`, `pr-description`, `renderer-security`, and any configured mandatory angle) → **never carried** (their surface includes inputs the file delta cannot bound, e.g. the PR body).

**Fail-closed defaults (carry forward = false unless proven safe).** Must-re-run whenever: the prior verdict is not `clean`; the prior findings-log is missing / not clean; the delta is empty or unavailable; any changed file is unclassifiable (`unknown` kind); the angle has no declared surface (unmapped); the angle is a configured mandatory angle (the CLI loads the gate's angle entries with `mandatory: true` and forces every one to re-run, never carried); the angle is named by any finding in the prior log however non-blocking (a `low` finding still means that angle is not provably clean); or any changed file's kind is in the angle's surface. The CLI additionally refuses to emit a plan at all — the whole run, not one angle — when: the prior log records one angle twice in `provenance.perAngle` (reviewer attribution would be ambiguous); the log's own recorded `headSha` disagrees with `--prev-head` (the log path and the diffed head would no longer agree, so a carried entry would stamp a head that was never diffed); the log's `findings` field is present but not an array (a malformed/truncated log cannot prove no angle has an open finding); a finding in that field has no angle (it cannot be attributed to a carried angle); or a finding's angle matches no `provenance.perAngle` entry (its attribution cannot be verified, base-name/case-insensitively). The delta and the worktree-head guard both run with `GIT_DIR`/`GIT_WORK_TREE` scrubbed from the git child-process environment, so an inherited repo pointer can never steer either to a different repository than the worktree at `cwd`.

**A dev-loop config-source delta re-runs EVERY angle.** `.devloops` (and its
`.devloops.yaml/.yml/.json` and `.pi/dev-loop/settings.*`/`defaults.*` siblings)
defines the gate's angle pool, mandatory floor, and reviewer personas/prompts —
a clean verdict produced under the OLD config has no valid provenance across a
change to it, regardless of the angle's declared surface. `classifyFile`
correctly reports these files as `config`; the carry-forward seam overrides
that via `isDevLoopConfigSourcePath` and forces a full re-run (fail-closed).

**Renames force the RENAME_ONLY angles to re-run.** A rename records only its destination path, so classifying that path alone would miss what the move itself implicates (a relocated doc breaking a link, a moved test/code file shifting scope/contract-surface). When the delta `git diff A..B` contains ANY rename/copy row, the CLI forces the RENAME_ONLY-mapped angles (`CATEGORY_ANGLE_MAP[RENAME_ONLY]`: `scope`, `correctness`, `contract-surface`, `docs`, `link-check`) to re-run for that run; the remaining angles still follow the surface rule above.

**Provenance — carried, not fabricated.** A carried verdict preserves the fail-closed evidence contract. The new head's findings-log records the carried angle in `provenance.perAngle` with `carriedFromHead: <A>` and the SAME `reviewer` identity that reviewed it at head A (honest attribution — that reviewer genuinely reviewed this angle's surface, which the delta did not change). `distinctReviewers` still counts real reviewer identities and the mandatory-angle / distinct-reviewer consistency checks in `write-gate-findings-log.mjs` are unchanged; carry-forward never invents a reviewer or a fresh review.

## Exit conditions

Each gate chain exits when one of these conditions is met:

| Condition | Result |
|---|---|
| Consolidated verdict is `clean` (no findings at any blocking severity) | Gate passes; proceed to next boundary |
| `blocked` verdict (gate could not complete) | Stop; escalate to operator |
| Maximum retry cycles exhausted without reaching `clean` | Stop; escalate to operator |
| Fix cycle produces no net progress (same findings after fix attempt) | Stop; escalate to operator |

## Copilot round-cap interplay

The gate chain can complete cleanly at a head that was accepted via round-cap fallback.
The post-convergence carve-out — significant post-convergence changes on a newer head open
a new Copilot cycle that requires another round before pre-approval — is owned by
`COPILOT-FOLLOWUP-ROUND-CAP` in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md).

**Convergence carry-forward decision seam (fail-closed, AC2).** A pure doc/prose head bump
after convergence should not need to re-open a blocking Copilot cycle.
`resolveConvergenceCarryForward` (`@dev-loops/core/loop/gate-carry-forward`, also surfaced as
the `copilotConvergence` field of `resolve-angle-carry-forward.mjs`) computes that decision:
`carryForward: true` when the delta since the converged head touches none of Copilot's
review surface (every changed file classifies as `docs`), and fail-closed `false` on any
code/test/config/CI file, an unclassifiable file, or an empty/unavailable delta. The Copilot
round-cap path consumes it: at the cap, `request-copilot-review.mjs` fetches the delta since
the last Copilot-reviewed head (via a single `gh api .../compare`) and, when it is a provable
linear rename-free pure-doc bump, returns `suppressed_post_convergence_docs_only` instead of
forcing a fresh blocking round — even under `--force-rerequest-review`. The guard is
default-safe/fail-closed: a non-linear (rebased/amended) advance, any rename/copy, an
unavailable compare, or any non-doc/unclassifiable file re-opens the round exactly as before,
preserving the round cap and the significant-post-convergence-change exception
(`COPILOT-FOLLOWUP-ROUND-CAP` in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md)).

## Machine-parseable fields

The sub-loop execution shape can be referenced programmatically via these fields:

| Field | Value | Description |
|---|---|---|
| `subLoopPhases` | `[preamble, fanout, fanin, fix, repeat]` | Ordered sub-loop phases |
| `contextBuilderRequired` | `true` | Preamble phase must include fresh-context context-builder |
| `worktreeIsolationProhibited` | `true` | Per-angle reviewers must run in the PR's actual worktree/head, never an isolated worktree (#1135) |
| `fixRetryUntilClean` | `true` | Blocking-severity findings trigger fix → retry until synthesis is clean |
| `separateChains` | `true` | Each gate runs an independent chain with its own disposition ledger |

## Gate-specific configuration

Only the review angles and blocking severity policy differ per gate:

| Gate | Review angles | Blocking severities | Owned by |
|---|---|---|---|
| `draft_gate` | Resolved from config (`resolveGateAngles(config, "draft")`) | Resolved from config (`resolveGateConfig(config, "draft").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) |
| `pre_approval_gate` | Resolved from config (`resolveGateAngles(config, "preApproval")`) | Resolved from config (`resolveGateConfig(config, "preApproval").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) |

## Non-substitution rule

<!-- rule: GATE-EXEC-NON-SUBSTITUTION -->
`GATE-EXEC-NON-SUBSTITUTION`: A clean sub-loop pass for one gate does not satisfy the other gate.
Each gate MUST run its own complete sub-loop execution (`GATE-EXEC-SEPARATE-CHAINS`) with
its own visible checkpoint verdict comment on the PR for the reviewed head SHA.

## Disposition ledger and durable logging

<!-- rule: GATE-EXEC-DISPOSITION-LEDGER -->
`GATE-EXEC-DISPOSITION-LEDGER`: Every gate pass MUST write a durable final-findings log
via `write-gate-findings-log.mjs` **before** the visible PR comment is posted; the ledger
is the durable record of what the gate found and what was decided, and the visible
comment is a summary for auditability, not a replacement for it.

```sh
node scripts/github/write-gate-findings-log.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <sha> \
  --verdict <clean|findings_present|blocked> \
  --findings-file <path>   # or inline: --findings '[{"severity":"high","angle":"scope","summary":"...","files":["path.mjs"],"line":42,"disposition":"accepted-for-fix"}]'
```

`--findings-file` reads the same JSON array from a file (identical validation) —
use it for any non-trivial ledger so the array never rides a shell string;
`post-gate-findings.mjs` accepts the same flag. The `consolidate-fanin` CLI's
`--ledger-out <path>` writes exactly this shape — pass that path straight to
`--findings-file` on both tools, no hand extraction. A finding with severity
`low` or `nit` (or a legacy spelling, normalized on read) and no
`disposition` gets `deferred` derived automatically by both tools. A
`question` finding with no `disposition` is derived the same way: `needs-answer`
when the finding is locatable (names an in-diff `file:line`), `deferred`
otherwise. `write-gate-findings-log.mjs`'s entry shape can carry `line`, so it
can reach `needs-answer`; `post-gate-findings.mjs`'s entry shape never
carries `line`, so a question there always resolves `deferred`.

The log is written under `tmp/gate-findings/<repo-slug>/pr-<N>/<gate>-<headSha>.json`.
Each log entry records the full disposition: severity, angle, summary, affected files, optional
1-based `line` (drives inline-vs-body-filed placement in `GATE-EXEC-FINDING-THREADS` below), and
resolved-in SHA (for findings resolved in a later pass).

### Finding threads and disposition

<!-- rule: GATE-EXEC-FINDING-THREADS -->
`GATE-EXEC-FINDING-THREADS`: A gate round has exactly ONE visible surface: the PR review of type
COMMENT that `upsert-checkpoint-verdict.mjs` posts. Pass that round's ledger to it via
`--findings-ledger <path>` — the same durable log `write-gate-findings-log.mjs` just wrote — and
the verdict body and the round's findings land together on that one review. A locatable finding
(an in-diff `file:line`) becomes an inline comment on that review; every other finding is filed
in the review body, with every rendered content line blockquoted so it can never be mistaken for
a genuine gate verdict field by the line-start `gate:`/`head sha:`/`verdict:`/`summary:`
structured field parser. Each finding's TEXT appears exactly once across the round: in its inline
comment, or in the body-filed block. The per-angle breakdown in the body therefore degrades to
`angle → verdict (+ finding count)` one-liners; a round posted WITHOUT `--findings-ledger` keeps
the full per-angle breakdown, since that body is then the only place those findings would appear.

A finding anchored to unchanged code has no in-diff `file:line` and is therefore always
body-filed, tracked through the disposition ledger and its fingerprint rather than a review
thread; the thread-based force-fix guarantee `GATE-EXEC-THREAD-DISPOSITION` describes applies to
locatable findings only — a body-filed finding at any non-`high` severity is instead deferred
by construction, stamped `disposition=deferred` at the round it is first posted. Every posted
finding, inline or body-filed, carries a fingerprint marker on its first line (`<!--
dev-loops:finding <fp16> severity=<s> angle=<a> round=<n>[ disposition=deferred] -->`), and the
review body carries a `<!-- dev-loops:gate-findings-review <gate> <headSha> round=<n> -->` header
marker recording which round of THIS gate it is. That marker alone would flag the body as a
machine-authored gate artifact and hide it from the checkpoint-evidence scanner
(`detect-checkpoint-evidence.mjs`, via the shared `summarizeGateReviewComments`/
`summarizeGateReviewCommentMarkers` helpers every gate-evidence reader calls through); the
producer-owned verdict header (`### Gate review: \`<gate>\``) on the same body overrides that, so
the round's single surface stays readable AS the verdict. Only a marker-bearing body with no
genuine verdict header — a historical standalone findings review, a historical
`<!-- dev-loops:deferred-summary -->` comment, or the current opt-in findings comment
(`dev-loops:gate-findings gate=`, `GATE-COMMENT-IDENTITY-DISJOINT`) — stays excluded and can
never win the newest-gate-marker tie-break over a real verdict.

Before posting, a candidate finding is dropped when its fingerprint already matches an
OWN-AUTHORED (the authenticated `gh` viewer's own login) existing thread or review body on the
PR, resolved threads included — a foreign review/thread quoting or forging the same marker shape
never suppresses a real finding, since folding a fingerprint someone else could freely paste in
would be a forgery vector, not a provenance check; cross-author suppression (recognizing a finding
a foreign commenter has ALREADY discussed) is instead carried by the reviewer briefing's second,
prose suppression layer described below. Suppression is binding across every round of a gate's
chain AND across both gates, so a draft-gate deferral is never re-raised at pre-approval. On a
same-head rerun the existing review's BODY is corrected in place (GitHub exposes no endpoint to
add inline comments to a submitted review), so every still-unposted finding is body-filed on that
correction rather than dropped.

After the verdict post AND after the Phase 5 (Retry) fixer triage pass, at every gate close, run
`close-gate-findings.mjs --ledger <path>` against that same ledger. It posts NOTHING of its own —
it runs only the thread disposition pass (`GATE-EXEC-THREAD-DISPOSITION`). The defer-close for
low findings runs AFTER the fixer triages them (#1585): the fixer sees every gate-authored
finding first (fix-if-cheap-in-the-same-commit, else defer), then the disposition pass acts as
the closing sweep — stamping `disposition=deferred` for threads the fixer chose to defer and
REPORTING `unresolvedGateThreadCount` (gate-authored threads still unresolved after the defer
pass). The actual gate-close assertion is performed by the downstream callers
(`fetchDraftGateEvidence` / `ready-for-review.mjs` / `pre-pr-ready-gate.mjs`, and the
`draftGateSatisfied` fold in `detect-checkpoint-evidence.mjs`) on a non-zero count — the
disposition pass does not assert the gate-close decision itself; it only REPORTS
`unresolvedGateThreadCount` (its return always uses `ok:true`). It may still throw on gh or
resolve failures inside the defer sweep, which the conductor must treat as a failed gate-close
sweep (re-run); only the gate-close *decision* is not its role, so its role and the gate-close
assertion's role stay distinct.
`GATE-EXEC-POST-BEFORE-FIX` (findings visible on the PR before fixes) is unaffected: only the
defer-close timing moves to post-fix. That pass runs independently of
`gates.postFindingsComments`: that toggle governs only the opt-in consolidated
`GATE-EXEC-POST-BEFORE-FIX` comment. The reviewer briefing's second, prose suppression layer is
owned by the
[fan-out procedure](../copilot-pr-followup/SKILL.md#gate-fan-outfan-in-procedure-agent-orchestrated):
the orchestrator appends a known-findings block AFTER the angle-specific prompt in each
reviewer's briefing, never into the byte-identical prefix `GATE-EXEC-BRIEFING-PREFIX` hashes —
the prefix hash and the same-head-retry sentinel (`--same-head-retry`) stay untouched by a
findings post.

<!-- rule: GATE-EXEC-THREAD-DISPOSITION -->
`GATE-EXEC-THREAD-DISPOSITION`: A gate-authored thread's severity decides how it closes. A
high thread stays unresolved until the standard fix, reply-with-resolving-commit, resolve
loop (Step 7 of [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md)) closes it — no other
exit exists. High-if-present is the per-gate continuation default: an open high finding
forces another fix round for that gate, and an unfixable high finding escalates to the operator via
the existing gate round cap (`roundCapReached` in `packages/core/src/loop/pr-gate-coordination.mjs`)
plus the "Maximum retry cycles exhausted → escalate to operator" rule — never deferred (high
is exempt from the medium window). A medium thread stays unresolved and goes
through that SAME loop through this gate's configured medium fix window (default 3,
`gates.<gate>.mediumFixWindow`; #1581) of this gate's chain; from the next round on (round 4
under the default window), an open medium thread is instead
replied to and resolved by `close-gate-findings.mjs` itself, which stamps
`disposition=deferred` onto the thread's marker first so the deferral record
(`GATE-EXEC-DEFERRAL-RECORD`) tells a deferred thread apart from one the fix loop genuinely
resolved. A low finding is a fixer TRIAGE target, not a silent auto-defer (#1585): the
fixer receives it as a fix/triage target alongside high and medium, and may
fix-if-cheap-in-the-same-commit (free polish when already touching that code) or defer. Defer is
permitted from round 1 on for low findings — no forced fix window. A low finding the fixer
defers is still reply+resolved (stamped `disposition=deferred`) via an explicit fixer triage
decision by the disposition pass (`close-gate-findings.mjs`), which runs AFTER the fixer triage
— not a silent post-hoc pass that can skip threads. A question thread is never deferred: the
fixer replies with an answer (promoting the finding to a defect severity when the answer reveals
one, or escalating to the author when the fixer cannot answer it) and resolves the thread once
answered; an unanswered question stays unresolved through the same round cap/escalation path a
high finding uses, since `isDeferredAtRound` never selects it for auto-deferral (mechanically
enforced and tested). Which of the three replies a fixer sends — a plain answer, a
promoting-to-defect-severity answer, or an escalation to the author — is a per-thread fixer
judgment call, not a state machine this codebase drives or unit-tests; only the
never-auto-deferred invariant above is. A nit thread is
deferred immediately at round 1 by `close-gate-findings.mjs` — the fixer owes it no triage cycle
(unlike low, it is never handed to the fixer as a fix/triage target); the closing sweep
defer-closes it regardless of whether the fixer looked at it. GATE-CLOSE requires 0 unresolved
gate-authored threads: `draftGateSatisfied` / `ready-for-review` / `pre-pr-ready-gate` assert
that every gate-authored review thread (any severity: high, medium, low,
question, OR nit) is resolved before the gate is considered satisfied and before `ready-for-review`
— a clean verdict alone no longer satisfies the gate. The fixer triages EVERY gate-authored
defect finding (high, medium, AND low) on EVERY gate round (clean verdict or
not): fix-if-cheap-in-the-same-commit, else defer — defer is permitted from round 1 on for
low findings (#1585) — and answers every gate-authored question. Fix-close is the fixer's role; the disposition pass
(`close-gate-findings`) then defer-closes every still-open DEFERRABLE gate-authored thread
(low, nit, and out-of-window medium) as the closing sweep AFTER the fixer's
triage — it never fix-closes, and it deliberately leaves high, question, and in-window
medium threads unresolved (they keep `unresolvedGateThreadCount` non-zero, which
blocks gate close until the fixer/fix-loop resolves them). A thread left unresolved after the
sweep fails the gate closed (not silently satisfied); a low finding the fixer did not fix is
defer-close by the sweep (the fixer had its chance first), never a silent pre-fixer auto-defer. Because an unresolved review thread routes the PR to the
`unresolved_feedback_present` state ([Copilot Loop State Graph](./copilot-loop-state-graph.md))
and forbids the next pre-approval gate action, an in-window
medium thread forces a fix round even after the current round's severity set is
otherwise clean — this is the existing unresolved-feedback routing, not a new enforcement path.
A finding the fixer rejects under its triage authority is not left dangling: it is closed with
an explicit dispute reply and resolved, and its fingerprint keeps it suppressed, so no
gate-authored thread can deadlock the chain. Distinctness differs by what closed the thread: a
FIX-closing reply (the standard fix loop, or a dispute reply) follows
`COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER` and names the specific change that fixed that thread,
with the resolving commit — nothing was fixed for a thread the fix loop never touched, so this
requirement cannot apply verbatim there. An ANSWER reply to a question names the answer (and, when
the answer promotes the finding, the new severity and follow-up thread it becomes). A DEFERRAL
reply (`close-gate-findings.mjs` past the
medium window, or a low/nit finding the fixer triaged and chose to defer via
the post-fixer disposition sweep (#1585)) is instead distinct by
construction through the marker fields it stamps on the thread (fingerprint, severity, angle,
round) and states the window/disposition reason (see `dispositionMessage` in
`close-gate-findings.mjs`). Either way, a shared body across multiple threads is permitted only
when one named shared root cause genuinely closed them all.

<!-- rule: GATE-EXEC-DEFERRAL-RECORD -->
`GATE-EXEC-DEFERRAL-RECORD`: A deferred finding's record lives in exactly two places, never a
third summary comment: the finding's own posted surface — the resolving reply on its thread for a
locatable finding, or its body-filed entry on the round's review for a non-locatable one — and the
durable findings-log ledger under `tmp/gate-findings/...`. Both carry the finding marker's optional `disposition=deferred`
field (`<!-- dev-loops:finding <fp16> severity=<s> angle=<a> round=<n>[ disposition=deferred] -->`),
which is what tells a deferred thread apart from one the fix loop genuinely resolved with a
fixing commit. A THREAD marker is stamped `disposition=deferred` only when the disposition pass
defers it (a medium thread past the gate's configured medium fix window
(default 3, round 4 under the default; #1581), or a low/nit thread the fixer triaged (nit skips
the fixer entirely) and
chose to defer — closed by the post-fixer disposition sweep, never a silent pre-fixer auto-defer
(#1585)). A question thread is never stamped `disposition=deferred` — it is answered, not
deferred; its resolution is the answer reply itself. A
non-locatable (body-filed) marker is stamped `disposition=deferred` unconditionally, for any
severity other than `high`, at the round it is first posted — permanently deferred by
construction, since a body-filed finding has no code location and so can never become a
resolvable thread through which the standard fix loop could otherwise close it.

## Execution mode and fan-out evidence enforcement

Each gate verdict records an `executionMode` (`fanout_fanin` or `inline_single_agent`,
default `inline_single_agent`) via the [Gate comment command](../copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract); inline runs must declare an `--inline-reason`. A `fanout_fanin` verdict passes the structured per-angle review results via `--findings-json` (the per-angle `{angle, verdict, findings}` artifacts that feed `consolidateFanin`, or the flat `toFindingsLogShape` output grouped by `.angle`) so the comment renders a per-angle breakdown; `--findings-summary` is the `inline_single_agent` fallback, plus the one `fanout_fanin` exception — a round posted without `--findings-json` (the tier-4/withheld `consolidate-fanin` case is the motivating one, where `--out` was never written and `--findings-json` would fail closed with ENOENT), which instead proves mandatory-angle coverage from `--findings-ledger`'s provenance and is refused when neither artifact is supplied on a gate with mandatory angles configured — see [Phase 3 — Consolidation](#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger) for the full artifact/coverage rule; not restated here. Fan-out evidence enforcement is **ON by default** (`gates.requireFanoutEvidence`): a clean gate verdict requires the gate to run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA, and the pre-merge evidence check fails closed for a required gate otherwise. Repos can opt out with `gates.requireFanoutEvidence: false`. Live context-builder/fan-out execution (epic #867) is what makes `fanout_fanin` producible — distinct from this contract's own sub-loop phase numbering (preamble / fanout / fanin).

### Light-mode inline acceptance (under-threshold micro-PRs)

`lightMode` (`localImplementation.lightMode`, #1043) collapses the gate fan-out to a
single `inline_single_agent` check for genuinely small changes. Because
`requireFanoutEvidence` otherwise rejects any non-`fanout_fanin` verdict, the pre-merge
evidence check (`buildPreMergeGateCheck` in `detect-checkpoint-evidence.mjs`) is
**light-mode-aware** (#1174): it accepts a required gate's `inline_single_agent` verdict
**only** when **all** of the following hold, and **fails closed** on any one that does
not — leaving today's rejection byte-identical:

- `localImplementation.lightMode.enabled` is `true` in config;
- the reviewed head's scope is **re-derived fail-closed** at merge time via
  `detectMergeBaseScope` (the three-dot merge-base diff, `git diff <base>...<head>`) and
  is genuinely under the configured `maxFiles`/`maxLines`. This is deliberately NOT the
  two-dot `detectScope` that `resolve-gate-dispatch` uses at dispatch time: the merge-time
  check re-derives against the merge base so a non-fast-forward advance cannot understate
  scope. If scope cannot be derived (missing base ref, git failure), the inline verdict is
  rejected;
- the PR carries **no `gate:full` label** (the label always forces the full fan-out —
  scope is not even measured);
- the verdict records a non-empty `--inline-reason`.

<!-- rule: GATE-EXEC-LIGHT-ESCALATION -->
`GATE-EXEC-LIGHT-ESCALATION`: An inline pass surfacing a finding at a blocking severity MUST escalate to the full fan-out — escalation is two-trigger: the `gate:full` label override, and any finding at a severity in the gate's `blockCleanOnFindingSeverities`. The escalation goes to the full fan-out (`resolveGateDispatchMode` returns `mode: "full_fanout"` with `reason: "escalated"`) — the
inline verdict never absorbs a blocking finding. When `lightMode` is enabled without
explicit thresholds, the built-in defaults apply (`maxFiles: 3` / `maxLines: 200`); the
shipped default is `enabled: false`. Light mode changes HOW the gate runs (inline vs
fan-out), never WHETHER the draft boundary exists — `workflow.requireDraftFirst` is
honored regardless.

Evidence retention stays uniform: a light-accepted inline verdict **still requires a
findings-log ledger** for the reviewed head (the single-agent path's
`write-gate-findings-log.mjs` writes it). Finding posting is likewise uniform: the inline
verdict takes `--findings-ledger <path>` for that same ledger, so the reduced review path
never reduces what gets threaded, and the close afterwards runs
`close-gate-findings.mjs --ledger <path>` for the disposition pass exactly as
[Finding threads and disposition](#finding-threads-and-disposition) requires for a fan-out
close. `requireFanoutProvenance`, when enabled, is
enforced **only for `fanout_fanin` verdicts** — a light inline verdict is already
scope-bounded and carries no multi-reviewer provenance, so it is exempt. Any inline
verdict that is over threshold, labelled `gate:full`, produced while `lightMode` is
disabled, or whose scope is underivable remains rejected exactly as before.

### Diff-class angle tiers

<!-- rule: GATE-EXEC-DIFF-CLASS-TIER -->
`GATE-EXEC-DIFF-CLASS-TIER`: A gate MAY configure `gates.<gate>.tiers`, an ordered,
first-match-wins list of diff classes (`match: { kinds?, maxFiles?, maxLines? }`), each
naming a reduced angle set for the diffs it matches. A tier round is FANOUT-ONLY: it is a
normal `fanout_fanin` round with a smaller resolved angle set, produced by a real
per-angle fan-out, a real findings-log ledger, and real provenance; there is no separate
evidence path and no new `executionMode`. The resolver unions the gate's mandatory angles
into every matched tier's set, so `GATE-EXEC-ANGLE-COVERAGE` holds unchanged, and fails
closed to the untriered angle set on any uncertain input: the `gate:full` label, no
configured tiers, a changed file whose kind classifyFile cannot resolve, a changed file
that is a dev-loop config-source path, an unavailable diff/scope, or a tier naming an
angle outside the gate's resolved pool.

**Precedence.** `gate:full` label > lightMode inline (dispatch-level) > tier > dynamic
subtractive reduction > the full resolved pool. The tier is consulted first, and Phase 2's
carry-forward subtraction runs second, against whichever set (tiered or full) the tier
decision left in place. Subtractive reduction alone was insufficient for the diff classes a
tier targets: `dynamic.subtractive` reduces per CATEGORY, so it still keeps the full
per-category width for a triggered category (a docs change still runs every doc-inclusive
angle); a tier instead caps the whole set for a diff class known in advance to be small or
non-code, which subtractive reduction by category cannot express.

The handoff envelope built for the fan-out advertises the gate's UNTRIERED run-set; tier
reduction is applied when the per-round context artifact is built, not reflected back into
the envelope's own advertised angle set.

### Fan-out provenance (closing the self-produced-artifact loophole)

`requireFanoutEvidence` is artifact-based: it only proves a `fanout_fanin` verdict
carries a findings-log ledger. A single agent could self-produce every per-angle
artifact + the ledger and label the verdict `fanout_fanin`, satisfying the letter
of the gate while defeating independent parallel review. To close this, the
findings-log ledger can additionally record **fan-out provenance**:

```jsonc
"provenance": {
  "distinctReviewers": 2,               // count of distinct reviewer agents dispatched (<= distinct identities in perAngle)
  "perAngle": [                          // per-angle dispatch provenance
    { "angle": "scope",   "reviewer": "review-a", "dispatchId": "…", "model": "…", "group": "docs-surface" },
    { "angle": "docs",    "reviewer": "review-a", "dispatchId": "…", "model": "…", "group": "docs-surface" }, // "group" is REQUIRED whenever fresh angles share one reviewer identity (grouped dispatch, the shipped default) — see the grouped-dispatch exception below
    { "angle": "safety",  "reviewer": "review-b" }
  ]
}
```

Provenance is written via `write-gate-findings-log.mjs --provenance <json>` (validated
on write; malformed OR self-inconsistent provenance fails the write). It is **optional
and additive** — when omitted, the ledger is byte-identical to before and no enforcement
changes. **Internal-consistency rule** (enforced on both the write path and the
enforcement read path): `perAngle` must be non-empty when `distinctReviewers > 0`, and
`distinctReviewers` must be `<=` the count of DISTINCT reviewer identities actually
recorded in `perAngle` (distinct by `reviewer`, else `dispatchId`; a bare `{angle}` is
not a countable reviewer). You cannot claim more reviewers than you recorded dispatch
entries for — this closes the `{distinctReviewers: 2, perAngle: []}` loophole.

**One scoped reviewer per fresh dispatch unit (always-on write-time floor).** `fanout_fanin`
execution mandates one independent reviewer per resolved dispatch unit — one angle in
per-angle mode / under `gate:full`, one declared group in grouped mode — because
recording an internally-consistent `distinctReviewers` count is not enough on its own:
one reviewer could still cover two angles without that count ever going inconsistent. The
write path additionally rejects, unconditionally (not gated by `requireFanoutProvenance`),
any `perAngle` where two **fresh** angles (angles WITHOUT `carriedFromHead`) share one
reviewer identity, **and** any fresh angle recording no reviewer identity at all (a bare
`{angle}` entry is permitted only as a carried entry; a fresh entry must carry `reviewer`
or `dispatchId`) — the error names the colliding or anonymous angle(s). The check enforces
the per-identity relation itself, so a padded ledger (duplicate-angle entries inflating
the distinct-reviewer count) cannot slip one reviewer covering two fresh angles. A `carriedFromHead`
angle is exempt from this pairing check entirely (see
[Angle carry-forward](#angle-carry-forward-fail-closed)) — recording the prior head's
reviewer identity on the carried entry is preferred (honest attribution) but optional,
and reusing that identity on a carried angle is never a collision. The sanctioned
non-fan-out path for a single-reviewer run is `executionMode: inline_single_agent` with
a recorded `--inline-reason`, not a `fanout_fanin` ledger that pairs one reviewer across
angles. **Grouped fan-out dispatch** (`gates.fanout.mode: grouped`, the shipped default —
see `resolveFanoutGroups` in `@dev-loops/core/config`) is a second sanctioned exception: a
`perAngle` entry may declare a `group` name, and fresh angles sharing one reviewer identity
are valid exactly when every entry sharing that identity declares the SAME `group` name
**AND** — whenever the caller supplies the round's resolved dispatch groups (both call
sites do, `write-gate-findings-log.mjs` via its own `--full-label` flag threaded into
`resolveFanoutGroups` just like `write-gate-context.mjs`'s) — every one of those fresh
angles is a member of that SAME configured dispatch unit per `resolveFanoutGroups`. A
self-attested `group` label spanning angles the
configured table splits apart (or never groups together at all) fails closed even though
the label itself is internally consistent; `resolveFanoutGroups` emits one-angle-per-unit
singletons for `gates.fanout.mode: per-angle` (bypasses configured groups), so passing its
output here rejects ANY shared identity in that mode, with no separate mode flag needed.
As of #1601 (ADR 0048) `gate:full` dispatches GROUPED, so a shared identity within an
auto-chunked dispatch unit is honored exactly as for a configured group. Fresh angles sharing a reviewer under differing or missing
`group` values still violate the contract above. The shared helper is
`fanoutReviewerPairingError` (paired with `countFreshDispatchUnits`) in
`@dev-loops/core/loop/gate-fanin`.

Enforcement of the `distinctReviewers` floor itself is opt-in via
**`gates.requireFanoutProvenance`** (default **false**). When enabled, it layers ON TOP of
`requireFanoutEvidence` (it only takes effect while fan-out evidence enforcement is
active): each required `fanout_fanin` gate's ledger must record internally-consistent
provenance with `provenance.distinctReviewers >= max(2, <fresh DISPATCH UNIT count>)` — a
floor of **2** is the smallest count that is not a single agent, and the floor SCALES UP
with the number of fresh (non-carried) DISPATCH UNITS recorded in `perAngle`
(`countFreshDispatchUnits`: one unit per distinct declared `group` name among fresh
entries, plus one unit per fresh entry with no `group` at all) — NOT with the fresh-angle
count. For an ungrouped ledger the two counts are identical (today's one-reviewer-per-angle
shape); for a grouped ledger the unit count is <= the angle count, since one group of N
angles is one dispatch unit, not N — a compliant ledger can never have fewer distinct fresh
reviewers than fresh dispatch units. The read path also re-validates the per-identity
pairing itself (the same `fanoutReviewerPairingError` check as the write path, at both the
pre-merge enforcement and the cross-checkout ledger selector): the ledger is a
worktree-local file, so the reader never assumes the write-time floor produced it — a
hand-crafted padded ledger that meets the cardinality floor still fails. When the flag is
off, behavior is byte-identical to today (no new failures) — the Claude-Code path, which
already honors child fan-out, is a validated no-op.

**Honest caveat (this is NOT un-forgeable):** recorded provenance is self-reported — it is
written by the same agent whose independence it claims — so a determined single agent can
still forge an internally-consistent blob. This enforcement raises the bar (rejects
malformed/inconsistent provenance and requires distinct recorded dispatch entries) but
does NOT claim un-forgeable enforcement. Un-forgeable recording (the harness attesting who
actually ran each per-angle review) is the Pi-harness bridge — the subagent tool honored
at child depth (see #1084).

This provenance layer is distinct from the underlying gate verdict itself. The verdict
comment's clean `draft_gate`/`pre_approval_gate` presence on the current head is enforced
server-side by the `gate-evidence` check
(`.github/workflows/gate-evidence.yml`, [Merge preconditions](./merge-preconditions.md#items-3-and-4-apply-to-every-path-not-just-the-dev-loop-tooling)),
which re-runs `detect-checkpoint-evidence.mjs --skip-fanout-ledger-check` on GitHub's own
token so that — once branch protection on `main` requires it — an API-driven ready/merge
transition cannot skip it. (Until that operator step lands the check runs and reports but
does not yet block merge.) That flag deliberately
does NOT re-verify the findings-log ledger/provenance/angle-coverage layer described
above: the ledger is a gitignored, worktree-local `tmp/` file that only the machine
that ran the review has on disk, so a stateless CI runner can never see it. That
narrower gap is exactly what this caveat and the Pi-harness bridge remain scoped to.

### Angle-coverage enforcement (mandatory angles + pool membership)

<!-- rule: GATE-EXEC-ANGLE-COVERAGE -->
`GATE-EXEC-ANGLE-COVERAGE`: A `fanout_fanin` verdict's recorded per-angle results
(`provenance.perAngle` on the write path / merge-evidence read path, and the
`--findings-json` structured per-angle results on the verdict-comment path) MUST
cover every angle in the gate's effective mandatory angles (entries with
`mandatory: true`), and MUST NOT name an
angle outside the gate's effective pool unless `gates.rejectForeignAngles` is
explicitly set to `false`, in which case a foreign angle downgrades to a warning.
The effective contract is `resolveGateAngleContract` (`@dev-loops/core/config`),
the single resolver every consumer uses: the mandatory-angle set is filtered
through entries disabled via `enabled: false` (an excluded mandatory angle must
not deadlock every fanout write), and the pool is `resolveGateAngles` (configured
angles minus disabled entries), widened to the global lens catalog
(`resolveAnglePool`) when the gate enables `gates.<gate>.dynamic.additive` —
dynamic resolution may legitimately dispatch catalog angles then, with a
disabled entry still a hard ceiling. A delta-suffixed angle (`<angle>-delta-at-...`, e.g. a re-review scoped
to only the current head's delta) counts toward its base angle for both checks.
Fan-in synthetic angles (`FANIN_SYNTHETIC_ANGLES` from `@dev-loops/core/loop/gate-fanin`;
currently `pr-checklist-matrix`, the entry `consolidate-fanin --pr-checklist-matrix clean`
upserts) are always legal in the foreign-angle check, regardless of pool config,
`gates.rejectForeignAngles`, or an `enabled: false` entry for the angle. The entry is
minted by the fan-in itself, never dispatched from the pool, so a gate whose pool omits
the angle (e.g. the shipped draft pool) accepts it without listing it per-gate; the
disabled-entry ceiling above still governs pool WIDENING (dynamic dispatch), while this
exemption covers only the fan-in-minted recorded entry. The angle may additionally be
pool-configured where a gate wants it reviewed as a real angle — the shipped preApproval
pool lists `pr-checklist-matrix` as mandatory.
This is independent of `requireFanoutProvenance`, and is exempt for
`inline_single_agent` verdicts (light-mode inline runs carry no per-angle fan-out
data to validate). At merge-evidence time, when a gate configures any mandatory
angle, a `fanout_fanin` ledger MUST record internally-consistent provenance —
absent or invalid provenance fails closed, so a hand-edited or shadow ledger
cannot bypass mandatory-angle coverage by simply omitting provenance; gates with
no mandatory angles keep the previous behavior (absent provenance adds no
failure unless `requireFanoutProvenance` is on). Enforced identically by
`write-gate-findings-log.mjs` and `upsert-checkpoint-verdict.mjs` (write time)
and `detect-checkpoint-evidence.mjs` (merge-evidence time), sharing the same
pure coverage check (`checkFanoutAngleCoverage` in
`@dev-loops/core/loop/gate-fanin`).

### Fail-closed: fan-out unavailable → route to conductor

When a child/agent **cannot** perform real parallel fan-out (e.g. a harness that does not
honor the subagent tool at child depth), the flow MUST fail closed rather than silently
degrade to a single-agent inline review. The canonical, matchable signal is the exported
constant `FANOUT_UNAVAILABLE_MESSAGE` (`@dev-loops/core/loop/gate-fanin`):

> **fan-out unavailable — route to conductor**

`fanoutUnavailableError(detail)` builds an `Error` carrying this prefix plus
`{ routeToConductor: true, code: "FANOUT_UNAVAILABLE" }`. Callers throw it (or check
`err.routeToConductor === true`) to hand the gate review up to the conductor. The
`requireFanoutProvenance` pre-merge failure message references this same contract string.
The full end-to-end driving command that dispatches per-angle review subagents at child
depth is provided by the Pi-harness child (the bridge); this contract specifies only the
recording + enforcement + fail-closed signal that land independently.

## See also

- [Checkpoint Verdict Comment Contract](gate-review-comment-contract.md) — visible PR comment evidence format
- [PR Lifecycle Contract](./pr-lifecycle-contract.md) — broader lifecycle state machine
- [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Local Implementation](../local-implementation/SKILL.md) — uses chain pattern for local phase plan audits
- [Contract style guide](./contract-style-guide.md) — rule ID and RFC-2119 conventions
