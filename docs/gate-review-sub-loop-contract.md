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
2. Each per-angle reviewer is an **independent fresh-context Agent** that is **seeded
   with that identical neutral bundle verbatim** plus its single review angle, and
   widens only when its angle genuinely needs more. Reviewers never inherit the main
   (orchestrating) agent's conversation or opinions — that independence is the
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
- the broader PR lifecycle sequencing (owned by the workflow skill and [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md))

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
  angle pool (`gates.<gate>.angles`) and, when `gates.<gate>.dynamicAngles` is enabled,
  narrows it to the angles relevant to the change at hand (configured pool → resolved
  set). Optional code-review lenses not triggered by the change (for example most code
  lenses for a docs-only change) are dropped, and the reason each angle was dropped is
  recorded as rationale. Angles in `gates.<gate>.mandatoryAngles` form a floor and are
  always included after dynamic selection (filtered only by `excludeAngles`); they are
  never dropped. When `dynamicAngles` is off (or no diff is available), the configured
  static pool is used unchanged. Symmetrically, when `gates.<gate>.additiveAngles` is
  enabled (default **off**), the resolver may also ADD catalog angles that
  change-category heuristics recommend but that are not already in the gate's
  configured pool, drawn from the global lens catalog (the explicit `gates.anglePool`
  override, or — when `anglePool` is not set or is empty — the union of the built-in persona
  registry's angle names and every angle actually configured across this config's
  own `gates.draft`/`gates.preApproval`/`gates.spike` `angles`/`mandatoryAngles`).
  `excludeAngles` remains a hard ceiling on additions — an excluded angle is
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
- reference the pi-subagents `parallel context-build` technique when applicable:
  run parallel `context-builder` agents from fresh context with distinct output paths
  (e.g. `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`,
  `context-build/validation-and-risks.md`) and synthesize the outputs into the review
  handoff artifacts

### Phase 2 — Fan-out: independent reviewers seeded with the neutral bundle

Fan out one fresh-context reviewer per gate-specific review angle. The reviewer is the scoped `review` agent ([review agent scoped angle-review mode](../agents/review.agent.md)), spawned once per resolved angle via the plain Agent tool. Reviewers are **independent and seeded with the identical neutral context bundle verbatim** (Phase 1's diff + `adjacentCode`); they do NOT fork from, or inherit the loaded context of, the main agent or a sibling reviewer. Parallelism is capped at `gates.maxFanoutReviewers` (default 8); when the resolved angle set exceeds the cap, the overflow runs in sequential batches (planned by `planFanoutBatches` from `@dev-loops/core/loop/gate-fanin`) and the degradation is recorded in the gate evidence. Each reviewer:

- starts in fresh context: run the mandatory `verify-fresh-review-context.mjs` invocation exactly as Phase 1 specifies. In the fan-out, `--scope` additionally keeps parallel reviewers in the same working directory from tripping false contamination on each other's sentinels, and `--context-path` (the Phase 1 artifact) fails a reviewer in the wrong/isolated checkout closed. The sentinel is keyed per review ROUND by the current head SHA, so a retry at a new head naturally gets a fresh sentinel — see [Sentinel lifecycle](#sentinel-lifecycle). Here "fresh" means the reviewer's context is the neutral builder artifact + its angle, and explicitly NOT the main agent's conversation/state or a prior reviewer session's state: the injected neutral bundle is the intended seed (allowed), while main-agent / cross-session state bleed fails closed.
- is seeded with the neutral context bundle verbatim (diff + `adjacentCode`) as its base, and widens (loads more files) only when its single angle genuinely needs more — it does not re-derive the whole diff/adjacent-code graph
- is scoped to exactly one review angle
- is **read-only**: inspects the diff and returns findings via output artifacts only; never edits files
- runs in the PR's actual worktree/head — **never an isolated worktree** (the Phase 1
  prohibition; `verify-fresh-review-context.mjs --context-path` enforces it mechanically —
  fails closed if the seeded artifact isn't present at the reviewer's cwd).
- produces a focused findings artifact with verdict (clean/findings_present) and file references
- completion is detected via the harness completion notification, or the reviewer's findings artifact at its deterministic output path; the orchestrator awaits fan-in on those paths and joins via `consolidateFanin` (Phase 3). The forbidden fan-in wait improvisations (transcript-tailing, `node -e`/`python3` tool-JSON parsing, `sleep`-poll loops) and this sanctioned wait are owned by `ANTIPATTERN-FANIN-WAIT` in [anti-patterns](../skills/docs/anti-patterns.md).

#### Briefing composition: invariant prefix first

<!-- rule: GATE-EXEC-BRIEFING-PREFIX -->
`GATE-EXEC-BRIEFING-PREFIX`: Every per-angle reviewer briefing MUST be composed as an
**invariant block** followed by an **angle-specific prompt**, in that order — never
angle-first. The invariant block MUST be byte-identical across every reviewer of the same
gate pass and MUST carry, at minimum: the repo, PR number, head SHA, and worktree path; the
`write-gate-context.mjs` gate-context artifact path (`GATE-EXEC-BUILD-ONCE-SEED`); and the
mandatory `verify-fresh-review-context.mjs` instruction above. Angle identity MUST appear
ONLY in the suffix (the angle-specific prompt, e.g.
`COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING`'s persona prompt) and the reviewer's `--scope` flag
— never inside the invariant block, or the byte-identity requirement is violated by
construction and the shared-prefix prompt-cache opportunity is destroyed byte one.

**Content inlining.** `write-gate-context.mjs` renders this invariant block as a
`<gate>-<headSha>.briefing-prefix.txt` file sibling to the JSON context artifact, in a
fixed section order: header (repo/PR/head/gate/worktree + the verify-fresh instruction),
PR body, linked-issue body (when present), the full diff at the reviewed head, and a
changed-files/adjacent-code summary. The diff SHOULD be inlined up to a size cap
(`BRIEFING_PREFIX_INLINE_DIFF_CAP_BYTES`, a fixed constant), carried inside a fenced
markdown block — the fence and surrounding framing are part of the rendered prefix bytes,
so "inline" means the diff content travels in the prefix, not that its raw bytes appear
unframed. Over the cap the prefix falls back to pointer mode: it references
`scope.diffPath` when the persisted `.diff` is present, and otherwise discloses that the
diff pointer is unavailable (reviewers re-derive via `git diff`). Either way the mode is
disclosed in both the artifact (`prefixMode: "inline"|"pointer"`) and the prefix text
itself. This is purely a
size/performance choice and a zero-semantic change to the byte-identity requirement above:
whichever mode ran, every reviewer of the same round still receives byte-identical prefix
bytes, and `verify-fresh-review-context.mjs --prefix-file`/`verify-briefing-prefixes.mjs`
hash and compare those bytes exactly as before, oblivious to which mode produced them.

**Enforcement.** Each reviewer passes `--prefix-hash <sha256>` (or `--prefix-file <path>`,
hashed by the tool) to `verify-fresh-review-context.mjs`, which persists the hash on the
reviewer's per-scope sentinel. Before Phase 3 consolidation, the fan-in MUST run
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
[GATE-EXEC-ANGLE-CARRY-FORWARD](#angle-carry-forward-fail-closed): re-run by
default, carry a previously-clean angle forward ONLY on proof its review surface
was not touched, and always re-run every mandatory / always-run angle. A clean
angle is re-reviewed whenever the new head's delta touches its surface or it
previously returned `findings_present`; it is spared only when the delta provably
cannot affect it.

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
  cross-session state bleed. (The one sanctioned same-head exception is the opt-in
  `--pr-body-fix-retry` overwrite documented below, gated on a matching prefix hash; it is
  not state bleed.)
- The orchestrator **MUST NOT** need to manually clear sentinels between rounds, and
  **MUST NOT** clear the sentinels of carried-forward clean angles (Phase 5's re-fan
  re-invokes the surface-touched angles, every angle that produced `findings_present`, and
  every mandatory / always-run angle; carried-forward clean angles are not re-invoked. Every
  re-invoked angle gets a distinct new-head key, so no cleanup is required).
- Stale pre-round sentinels (the old scope-only name) never collide with a head-keyed round
  and are simply ignored.

**Sanctioned same-head PR-body-fix retry.** A PR-body/description-only fix (e.g. adding a
missing acceptance-criteria matrix to satisfy `pr-checklist-matrix`) does not change the head
SHA, so it earns no new round key on its own — a plain re-invocation of the fixed angle
collides with its own pass-1 sentinel and fails closed exactly like genuine contamination
would. `verify-fresh-review-context.mjs --pr-body-fix-retry` is the sanctioned escape hatch
for exactly this case: it overwrites the existing sentinel for that scope+round, but **only**
when the given `--prefix-hash`/`--prefix-file` matches the existing sentinel's recorded prefix
hash **exactly**. An identical hash proves the seeded briefing bytes were NOT rebuilt, so the
byte-identity invariant (`GATE-EXEC-BRIEFING-PREFIX`) stays fully intact for every other
sentinel of the same round — the previously-clean angles' sentinels are left untouched and
still verify against the same on-disk record, so `verify-briefing-prefixes.mjs` needs no full
re-fan of clean angles and no manual sentinel deletion. A hash mismatch (the context-builder
genuinely rebuilt the briefing) or an existing sentinel recording no prefix hash still fails
closed — this flag is a narrow, auditable exception for one documented scenario, never a
general bypass of the contamination guard. Practically: re-brief the retried reviewer with the
UNCHANGED, byte-identical invariant prefix (do not re-run `write-gate-context.mjs`) plus an
angle-specific instruction to fetch the CURRENT PR body/description live (e.g. `gh pr view`)
rather than trust the prefix's now-stale inlined copy, since the point of the retry is to
re-check the just-edited description. See `verify-fresh-review-context.mjs --help` for the
flag's exact semantics and exit codes.

### Phase 3 — Consolidation: fan-in synthesis and disposition ledger

Before consolidating, run `scripts/github/verify-briefing-prefixes.mjs --head-sha <sha>`
(the `GATE-EXEC-BRIEFING-PREFIX` enforcement check); a fail-closed result (mismatched or
missing prefix hashes across this round's reviewer sentinels) MUST stop the pass rather
than proceed to consolidation.

Merge the parallel reviewer findings into one consolidated fix plan using the
pure `consolidateFanin` pass from `@dev-loops/core/loop/gate-fanin` (not manual
concatenation). It collates the per-angle artifacts, gates `clean` on
`blockCleanOnFindingSeverities`, returns `blocked` when any per-angle artifact is
malformed/missing, and `toFindingsLogShape` maps the result into the
`write-gate-findings-log.mjs` `--findings` shape:

- collate findings from all review angles
- classify each finding: `must-fix`, `worth-fixing-now`, `defer`
- write the disposition ledger: every finding receives a severity classification and a
  disposition (accepted-for-fix, deferred, disputed, or operator_acknowledged)
- produce a merged findings artifact
- determine the overall gate verdict:
  - `clean`: no findings with a severity in the gate's `blockCleanOnFindingSeverities` list remain
  - `findings_present`: one or more findings with a blocking severity remain
  - `blocked`: the gate could not complete or a hard blocker prevented a verdict

Ledger content and write-before-comment sequencing are owned by
`GATE-EXEC-DISPOSITION-LEDGER` below.

<!-- rule: GATE-EXEC-POST-BEFORE-FIX -->
`GATE-EXEC-POST-BEFORE-FIX`: The consolidated findings MUST be posted as a visible,
marker-tagged PR comment via `post-gate-findings.mjs` (a consolidated comment listing
each finding grouped by severity, with `file:line` refs) **before** the fix cycle in
Phase 4 begins, so the findings are auditable and Copilot/humans are aware of them.
Fixes MUST NOT be applied until the auditable trail exists on the PR. The helper is
idempotent per gate (exactly one comment per gate, updated in place on each run; the
reviewed head is shown in the body) and posts a brief "no findings" note when the set
is empty. This comment
is governed by `gates.postFindingsComments` (resolved via
`resolveGatePostFindingsComments(config)`, default true / opt-out): when it is `false`
the helper no-ops with a `skipped` result and the post step is skipped. The disposition
ledger is written regardless — the opt-out only suppresses the PR comment, never the
durable ledger.

### Phase 4 — Fix

If findings with a severity in the gate's `blockCleanOnFindingSeverities` list are present:

- apply only the accepted narrow fixes on the same branch
- do not broaden scope or touch unrelated files
- run the smallest honest validation for the accepted fix scope
- commit and push fixes on the branch
- the fix cycle covers **all** blocking severities, not only `must-fix`. If
  `blockCleanOnFindingSeverities` includes `worth-fixing-now`, then worth-fixing-now
  findings must also be fixed before the gate can reach `clean`.

### Phase 5 — Repeat until clean

After applying fixes and advancing the head SHA:

- <!-- rule: GATE-EXEC-REGATE-MANDATORY --> `GATE-EXEC-REGATE-MANDATORY`: **Re-gate is mandatory:** a new head SHA MUST always trigger a fresh full-chain gate pass; the gate MUST NOT be skipped because a previous head was clean. The `draft_gate` one-time skip is a narrow exemption from this rule that only applies after the PR has left draft ([GATE-COMMENT-DRAFT-REQUIREMENTS](./gate-review-comment-contract.md#draft-gate-draft_gate-comment-requirements)); while the PR is still draft, every new head is re-gated per this rule.
- rerun the sub-loop from Phase 1 (context-builder preamble for the new head SHA)
- continue the fix-then-retry cycle until the synthesis verdict is `clean`
- on retry, re-invoke every reviewer whose review surface the new head's delta touched (always including any angle that previously returned `findings_present`), and re-invoke every mandatory / always-run angle; the context-builder and consolidation always run fresh. A previously-clean angle whose surface the delta provably did NOT touch MAY instead be **carried forward** per [GATE-EXEC-ANGLE-CARRY-FORWARD](#angle-carry-forward-fail-closed) below — never skipped by guesswork
- a clean pass means all gate-specific review angles pass and no findings with a severity in `blockCleanOnFindingSeverities` remain

#### Angle carry-forward (fail-closed) {#angle-carry-forward-fail-closed}

<!-- rule: GATE-EXEC-ANGLE-CARRY-FORWARD --> `GATE-EXEC-ANGLE-CARRY-FORWARD`: On a head bump, a previously-**clean** angle verdict MAY be carried forward to the new head — reusing the prior reviewer's clean result instead of re-fanning that angle — ONLY when the delta between the prior reviewed head (A) and the new head (B) provably does not touch that angle's **review surface**. This is a narrow, fail-closed refinement of the re-fan step above, NOT an exemption from `GATE-EXEC-REGATE-MANDATORY`: the full gate chain still runs at head B (context-builder + consolidation always fresh, plus every angle whose surface changed and every mandatory angle); carry-forward only spares the reviewers that provably have nothing new to look at.

The decision is a pure, deterministic, fail-closed seam — `resolveAngleCarryForward` / `resolveCarryForwardAngles` in `@dev-loops/core/loop/gate-carry-forward` — driven by the CLI `scripts/github/resolve-angle-carry-forward.mjs --repo <r> --pr <n> --gate <g> --prev-head <A> --head-sha <B>` (run from the worktree at head B). It reads the prior CLEAN findings-log for head A, computes the delta as the direct two-dot tree diff `git diff A..B` (never three-dot — a two-dot diff never omits a file that differs between the reviewed head A and B, so a non-fast-forward advance cannot carry an angle whose surface changed), and returns per angle `carryForward: true|false` with a reason.

**Review-surface mapping.** An angle's review surface is the set of file "surface kinds" whose change could implicate it, derived from the single source of truth for change-category → angle relevance (`CATEGORY_ANGLE_MAP`) via each file's `classifyFile` kind (`code` | `docs` | `config` | `test` | `ci`):

- code-correctness angles whose surface excludes `docs` (`scope`, `correctness`, `coverage`, `determinism`, …) → their surfaces are derived per angle from `CATEGORY_ANGLE_MAP` and vary (e.g. `scope` → `code`/`config`/`ci`; `coverage`/`determinism` → `code`/`test`); across the group the surface kinds union to `code`/`test`/`config`/`ci` but exclude `docs`, so a pure doc delta touches none of them and they carry forward.
- doc-inclusive angles (`docs`, `link-check`, `contract-surface`, `dry`) → surface includes `docs` (they are all in `CATEGORY_ANGLE_MAP[DOCS_ONLY]`); a pure doc delta re-runs them. `contract-surface` and `dry` therefore do NOT carry forward on a doc-only delta.
- `config-drift` → `config`/`ci`; `ci-guard` → `ci`.
- always-run angles (`gate-evidence`, `pr-description`, `renderer-security`, and any configured mandatory angle) → **never carried** (their surface includes inputs the file delta cannot bound, e.g. the PR body).

**Fail-closed defaults (carry forward = false unless proven safe).** Must-re-run whenever: the prior verdict is not `clean`; the prior findings-log is missing / not clean; the delta is empty or unavailable; any changed file is unclassifiable (`unknown` kind); the angle has no declared surface (unmapped); the angle is a configured mandatory angle (the CLI loads the gate's `mandatoryAngles` and forces every one to re-run, never carried); or any changed file's kind is in the angle's surface.

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
`COPILOT-FOLLOWUP-ROUND-CAP` in [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md).

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
(`COPILOT-FOLLOWUP-ROUND-CAP` in [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md)).

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
| `draft_gate` | Resolved from config (`resolveGateAngles(config, "draft")`) | Resolved from config (`resolveGateConfig(config, "draft").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../skills/copilot-pr-followup/SKILL.md) |
| `pre_approval_gate` | Resolved from config (`resolveGateAngles(config, "preApproval")`) | Resolved from config (`resolveGateConfig(config, "preApproval").blockCleanOnFindingSeverities`) | [Copilot PR Follow-up Skill](../skills/copilot-pr-followup/SKILL.md) |

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
  --findings '[{"severity":"must-fix","angle":"scope","summary":"...","disposition":"accepted-for-fix"}]'
```

The log is written under `tmp/gate-findings/<repo-slug>/pr-<N>/<gate>-<headSha>.json`.
Each log entry records the full disposition: severity, angle, summary, affected files, and
resolved-in SHA (for findings resolved in a later pass).

## Execution mode and fan-out evidence enforcement

Each gate verdict records an `executionMode` (`fanout_fanin` or `inline_single_agent`,
default `inline_single_agent`) via the [Gate comment command](../skills/copilot-pr-followup/SKILL.md#mandatory-gate-comment-command-contract); inline runs must declare an `--inline-reason`. A `fanout_fanin` verdict passes the structured per-angle review results via `--findings-json` (the per-angle `{angle, verdict, findings}` artifacts that feed `consolidateFanin`, or the flat `toFindingsLogShape` output grouped by `.angle`) so the comment renders a per-angle breakdown; `--findings-summary` is the inline_single_agent fallback only. Fan-out evidence enforcement is **ON by default** (`gates.requireFanoutEvidence`): a clean gate verdict requires the gate to run via `--execution-mode fanout_fanin` with a findings-log ledger for the head SHA, and the pre-merge evidence check fails closed for a required gate otherwise. Repos can opt out with `gates.requireFanoutEvidence: false`. Live context-builder/fan-out execution (epic #867) is what makes `fanout_fanin` producible — distinct from this contract's own sub-loop phase numbering (preamble / fanout / fanin).

### Light-mode inline acceptance (under-threshold micro-PRs)

`lightMode` (`localImplementation.lightMode`, #1043) collapses the gate fan-out to a
single `inline_single_agent` check for genuinely small changes. Because
`requireFanoutEvidence` otherwise rejects any non-`fanout_fanin` verdict, the pre-merge
evidence check (`buildPreMergeGateCheck` in `detect-checkpoint-evidence.mjs`) is
**light-mode-aware** (#1174): it accepts a required gate's `inline_single_agent` verdict
**only** when **all** of the following hold, and **fails closed** on any one that does
not — leaving today's rejection byte-identical:

- `localImplementation.lightMode.enabled` is `true` in config;
- the reviewed head's scope is **re-derived fail-closed** at merge time — the merge-base
  diff (`git diff <base>...<head>`, the same scope resolution `resolve-gate-dispatch`
  uses) is genuinely under the configured `maxFiles`/`maxLines`. If scope cannot be
  derived (missing base ref, git failure), the inline verdict is rejected;
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
`write-gate-findings-log.mjs` writes it). `requireFanoutProvenance`, when enabled, is
enforced **only for `fanout_fanin` verdicts** — a light inline verdict is already
scope-bounded and carries no multi-reviewer provenance, so it is exempt. Any inline
verdict that is over threshold, labelled `gate:full`, produced while `lightMode` is
disabled, or whose scope is underivable remains rejected exactly as before.

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
    { "angle": "scope",   "reviewer": "review-a", "dispatchId": "…", "model": "…" },
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

Enforcement is opt-in via **`gates.requireFanoutProvenance`** (default **false**). When
enabled, it layers ON TOP of `requireFanoutEvidence` (it only takes effect while fan-out
evidence enforcement is active): each required `fanout_fanin` gate's ledger must record
internally-consistent provenance with `provenance.distinctReviewers >= 2` (a floor of
**2** is the smallest count that is not a single agent). When the flag is off, behavior is
byte-identical to today (no new failures) — the Claude-Code path, which already honors
child fan-out, is a validated no-op.

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
(`.github/workflows/gate-evidence.yml`, [Merge preconditions](../skills/docs/merge-preconditions.md#items-3-and-4-apply-to-every-path-not-just-the-dev-loop-tooling)),
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
cover every angle in the gate's effective `mandatoryAngles`, and MUST NOT name an
angle outside the gate's effective pool unless `gates.rejectForeignAngles` is
explicitly set to `false`, in which case a foreign angle downgrades to a warning.
The effective contract is `resolveGateAngleContract` (`@dev-loops/core/config`),
the single resolver every consumer uses: `mandatoryAngles` is filtered through
`excludeAngles` (an excluded mandatory angle must not deadlock every fanout
write), and the pool is `resolveGateAngles` (configured `angles` ∪
`mandatoryAngles`, minus `excludeAngles`), widened to the global lens catalog
(`resolveAnglePool`) when the gate enables `additiveAngles` — dynamic resolution
may legitimately dispatch catalog angles then, with `excludeAngles` still a hard
ceiling. A delta-suffixed angle (`<angle>-delta-at-...`, e.g. a re-review scoped
to only the current head's delta) counts toward its base angle for both checks.
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
- [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) — broader lifecycle state machine
- [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Local Implementation](../skills/local-implementation/SKILL.md) — uses chain pattern for local phase plan audits
- [Contract style guide](../skills/docs/contract-style-guide.md) — rule ID and RFC-2119 conventions
