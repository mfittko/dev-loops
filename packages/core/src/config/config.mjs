import { readFile } from "node:fs/promises";
import { normalizeSeverity } from "../loop/gate-fanin.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { classifyFile } from "../analysis/diff-analyzer.mjs";
import { isDevLoopConfigSourcePath } from "../loop/gate-carry-forward.mjs";
import { trimmedOrNull } from "../loop/normalize.mjs";

// ============================================================================
// Sub-schemas
// ============================================================================

// `strategy` and `inputSource` are bare single-value enums.
//
// `github-first` is a deprecated accepted alias for the canonical
// `tracker-first`, normalized before this parse (the schema only validates the
// canonical value), with a load-time warning in loadDevLoopConfig.
const StrategyConfig = z.enum(["local-first", "tracker-first"]).describe("Work-intake strategy: local-first starts from a repo plan file, tracker-first from a tracked issue (\"github-first\" is a deprecated accepted alias).");

const InputSourceConfig = z.enum(["tracker", "phase-docs"]).describe("Where local-first work reads its spec: the tracker issue body, or repo phase docs.");

// Built-in tier aliases: a harness-neutral name (low/high) → a concrete
// per-harness model id; `null` means "inherit" (no model override, a genuine
// no-op on that harness). Pi ships null on every built-in tier, so zero-config
// resolution is a no-op on Pi until an operator sets concrete Pi ids.
export const BUILTIN_TIER_ALIASES = Object.freeze(["low", "high"]);

const BUILTIN_TIERS = Object.freeze({
  low: Object.freeze({ claude: "sonnet", pi: null }),
  high: Object.freeze({ claude: "opus", pi: null }),
});

// Built-in role→tier policy: routine subagents run on the low tier, planning
// (refiner) and critical review (review, incl. gate fan-out angles via their
// review persona) run high, and the conductor (dev-loop) inherits (no override).
const BUILTIN_ROLE_TIERS = Object.freeze({
  developer: "low",
  docs: "low",
  fixer: "low",
  quality: "low",
  refiner: "high",
  review: "high",
  "dev-loop": "inherit",
});

// A tier alias's per-harness concrete model. Either harness may be a concrete
// model id or `null` (inherit / no-op on that harness). strictObject rejects
// unknown harness keys.
const ModelTierMapping = z
  .strictObject({
    claude: z.string().trim().min(1).nullable().optional(),
    pi: z.string().trim().min(1).nullable().optional(),
  })
  // A tier mapping with both harnesses absent/null resolves to a null no-op on
  // every harness — a silent dead alias that roleTiers could reference. Require
  // at least one concrete harness model so an empty/all-null tier fails closed.
  .refine((m) => typeof m.claude === "string" || typeof m.pi === "string", {
    message: "tier mapping must set at least one of claude/pi to a non-null model id",
  });

/**
 * Reject `models.roleTiers` entries that reference a tier alias which is neither
 * a built-in alias (low/high), the literal "inherit", nor defined in this
 * config's own `models.tiers`. Applied to both the merged and file-level
 * ModelsConfig so a typo'd alias fails closed with a clear message.
 * @param {Record<string, unknown>|undefined} models
 * @param {z.RefinementCtx} ctx
 */
function refineRoleTiers(models, ctx) {
  const known = new Set([...BUILTIN_TIER_ALIASES, ...Object.keys(models?.tiers ?? {})]);
  for (const [role, tier] of Object.entries(models?.roleTiers ?? {})) {
    if (tier !== "inherit" && !known.has(tier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roleTiers", role],
        message: `unknown model tier alias "${tier}" — define it under models.tiers, use a built-in alias (${BUILTIN_TIER_ALIASES.join(", ")}), or "inherit"`,
      });
    }
  }
}

const ModelsConfigBase = z.strictObject({
  conductor: z.string().trim().min(1).describe("Model override for the conductor (dev-loop) session; absent = inherit the session model.").optional(),
  roles: z.record(z.string(), z.string().trim().min(1)).describe("Concrete per-role/angle model overrides (highest precedence, above tiers).").optional(),
  tiers: z.record(z.string().min(1), ModelTierMapping).describe("Tier alias → per-harness concrete model; null on a harness means inherit (no override).").optional(),
  roleTiers: z.record(z.string().min(1), z.string().trim().min(1)).describe("Role or gate angle → tier alias: a built-in alias (low, high), a custom models.tiers alias, or \"inherit\".").optional(),
});

const ModelsConfig = ModelsConfigBase.superRefine(refineRoleTiers);

const LowSignalConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Stop Copilot rounds early once they stop producing signal."),
  roundThreshold: z.number().int().nonnegative().default(3).describe("Rounds counted toward the low-signal stop decision."),
  maxComments: z.number().int().nonnegative().default(2).describe("A round with at most this many comments counts as low-signal."),
});

const RefinementConfig = z.strictObject({
  fanOut: z.number().int().min(1).max(10).describe("Parallel reviewers per refinement round."),
  mode: z.enum(["parallel", "sequential"]).describe("Whether refinement reviewers run in parallel or one after another."),
  maxCopilotRounds: z.number().int().nonnegative().default(5).describe("Automated Copilot review rounds before converging; 0 disables Copilot review."),
  lowSignal: LowSignalConfig.optional().describe("Early-stop policy for low-signal Copilot rounds."),
  roles: z.array(z.string().trim().min(1)).describe("Review lenses the refinement fan-out dispatches.").optional(),
});

// Per-angle surface scope: how much of the gate-context bundle an angle needs
// (see the `scope` describe on GateAngleEntry). resolveGateAngleScope fails
// open to "full" for an unknown/missing value — a narrow scope is an opt-in
// cost saving, never a silently-enforced information cut.
export const GATE_ANGLE_SCOPES = Object.freeze(["full", "changed-files", "docs-only"]);

// One review angle: a bare string is sugar for `{ name }`; the fields are
// documented on the schema below. mergeConfigLayers merges these arrays BY
// `name` across config layers, so a later layer can add or disable a single
// angle without restating the whole list. Preprocessing the string→object wrap
// BEFORE validation (rather than a z.union) means every malformed entry
// validates against this ONE object schema, so a bad field reports its own
// actionable path/message (`gates.draft.angles.1.mandatory: ...`) instead of
// zod's opaque invalid_union "Invalid input".
const GateAngleEntry = z.preprocess(
  (v) => (typeof v === "string" ? { name: v } : v),
  z.strictObject({
    name: z.string().trim().min(1),
    mandatory: z.boolean().optional().describe("Always run this angle, regardless of diff-based dynamic selection."),
    enabled: z.boolean().optional().describe("Set false to drop this angle from the resolved list (a later config layer disabling a base angle)."),
    persona: z.string().trim().min(1).optional().describe("Reviewer persona for this angle."),
    prompt: z.string().min(1).optional().describe("Short focused instruction for the reviewer agent — what to look for and how to judge this angle."),
    model: z.string().trim().min(1).optional().describe("Concrete model override for this angle (highest precedence)."),
    tier: z.string().trim().min(1).optional().describe("Model tier alias for this angle (used when `model` is absent)."),
    scope: z.enum(GATE_ANGLE_SCOPES).optional().describe("Surface scope this angle needs: full (default), changed-files (diff without the adjacent-code bundle or its changed-files/adjacent-file summary section), or docs-only (doc-file hunks only). Unknown/omitted resolves to full."),
  }),
);

// Diff-class kinds a tier's `match` can name — exactly classifyFile()'s
// output range (../analysis/diff-analyzer.mjs), so a tier config can never
// name a kind the classifier could not produce.
const GateTierMatchKind = z.enum(["code", "docs", "config", "test", "ci", "unknown"]);

// A tier's match conditions: EVERY changed file's kind must be in `kinds`
// (when set) AND the change must stay within `maxFiles`/`maxLines` (when
// set). At least one condition is required — a bare `{}` would match every
// diff unconditionally, which is never the intent of an explicit tier entry.
const GateTierMatch = z
  .strictObject({
    kinds: z.array(GateTierMatchKind).min(1).describe("Changed-file kinds this tier matches; every changed file's classifyFile() kind must be in this set.").optional(),
    maxFiles: z.number().int().min(1).describe("Match only when the change touches at most this many files.").optional(),
    maxLines: z.number().int().min(1).describe("Match only when the change stays within this many changed lines.").optional(),
  })
  .superRefine((match, ctx) => {
    if (match.kinds === undefined && match.maxFiles === undefined && match.maxLines === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "match must set at least one of kinds, maxFiles, maxLines",
      });
    }
  });

// One diff-class angle tier: a fixed angle set applied instead of dynamic
// subtractive/additive reduction when `match` holds. See resolveGateTier.
const GateTier = z.strictObject({
  name: z.string().trim().min(1).describe("Tier name; surfaces as the tier:<name> resolution reason."),
  match: GateTierMatch.describe("Diff-class conditions that select this tier."),
  angles: z.array(z.string().trim().min(1)).min(1).describe("Angle set this tier resolves to when matched; unioned with the gate's mandatory angles."),
});

const GateDynamicConfig = z.strictObject({
  // Diff-driven dynamic angle PRUNING, ON by default. mandatory:true
  // angles stay a hard always-run floor; fallbackToAll degrades to the full
  // static pool when classification is ambiguous.
  subtractive: z.boolean().default(true).describe("Enable diff-driven dynamic angle PRUNING for this gate (ON by default; set false to restore the full static angle pool). Was gates.<gate>.dynamicAngles."),
  // Additive counterpart to the subtractive path: when true, the
  // context-builder may also ADD catalog angles (from resolveAnglePool) that
  // change-category heuristics recommend. Default false preserves the
  // subtractive-only behavior.
  additive: z.boolean().default(false).describe("Allow diff-driven addition of catalog angles beyond this gate's configured pool (was gates.<gate>.additiveAngles)."),
});

// One unified gate schema for draft/preApproval/spike: for spike,
// blockCleanOnFindingSeverities and dynamic.additive are accepted but INERT
// (a findings-doc deliverable has no clean-verdict escalation or additive pool).
// Single source for the blockCleanOnFindingSeverities vocabulary: the schema
// enum consumes these spellings verbatim and resolveGateConfig's fail-closed
// guard exact-matches raw entries against the same list, so the guard's accept
// set is byte-identical to the schema's. Exported so the vocabulary contract
// test (test/contracts/gate-severity-vocabulary-contract.test.mjs) pins this
// list against SEVERITY_ORDER + LEGACY_SEVERITY_ALIASES (@dev-loops/core/loop/
// gate-fanin): a new defect severity or legacy alias that skips this trio must
// fail that test rather than leave the enum silently stale.
export const BLOCKING_SEVERITY_SPELLINGS = Object.freeze(["high", "medium", "low", "must-fix", "worth-fixing-now", "nice-to-have", "defer"]);
const BLOCKING_SEVERITY_SPELLING_SET = new Set(BLOCKING_SEVERITY_SPELLINGS);

// Render an offending config value for a refusal message without letting the
// renderer itself throw (JSON.stringify raises on BigInt/circular; String()
// can throw on exotic values) — an unrenderable value gets a literal
// placeholder so the refusal always surfaces as the refusal.
function formatConfigValue(value) {
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    try {
      return String(value);
    } catch {
      return "<unrenderable value>";
    }
  }
}

// The three GatesConfig keys whose value is a GateConfig (carries its own
// blockCleanOnFindingSeverities); a fourth would need both this and the gates
// object below updated.
const GATE_KEYS_WITH_BLOCKING_SEVERITIES = /** @type {const} */ (["draft", "preApproval", "spike"]);

const GateConfig = z.strictObject({
  angles: z.array(GateAngleEntry).optional().describe("Review lenses this gate fans out to. A bare string is sugar for { name }; an object may set mandatory/enabled/persona/prompt/model/tier."),
  dynamic: GateDynamicConfig.optional().describe("Diff-driven dynamic angle selection policy for this gate."),
  required: z.boolean().default(true).describe("Whether this gate must run."),
  requireCi: z.boolean().default(true).describe("Per-gate CI prerequisite (default true): the gate requires green CI on the current head; false opts this gate out of the CI precondition entirely, including a real failure."),
  // Defect severities only — "question"/"nit" are non-defect categories that
  // never block a clean verdict by severity (their own answered/defer
  // dispositions decide their fate).
  blockCleanOnFindingSeverities: z
    .array(z.enum(/** @type {[string, ...string[]]} */ (BLOCKING_SEVERITY_SPELLINGS)))
    .min(1)
    .default(["high"])
    .describe("Defect finding severities that block a clean gate verdict (high/medium/low only — \"question\"/\"nit\" are non-defect categories and never block by severity). \"must-fix\" is the deprecated legacy spelling of \"high\", \"worth-fixing-now\" of \"medium\", and \"nice-to-have\"/\"defer\" of \"low\"; consumers normalize them."),
  // No schema-level `.default()`: a default would fill this key on every config
  // LAYER independently (each is parsed before merging), permanently shadowing
  // a layer that sets only the deprecated `worthFixingNowFixWindow` alias.
  // resolveGateConfig applies the built-in fallback (3) after checking both.
  mediumFixWindow: z.number().int().nonnegative().optional().describe("Per-gate medium fix window: an open medium finding stays in the in-gate fix loop through this many rounds of this gate's chain before deferral. high is exempt (never defers). Default 3."),
  worthFixingNowFixWindow: z.number().int().nonnegative().optional().describe("Deprecated alias for mediumFixWindow (pre-rename key name); mediumFixWindow wins when both are set."),
  // Ordered, first-match-wins diff-class angle tiers (see resolveGateTier).
  // Absent/empty = tiers never apply.
  tiers: z.array(GateTier).min(1).describe("Ordered, first-match-wins diff-class angle tiers for this gate. When the first-matching tier's angle set is inside the gate's angle pool, it replaces dynamic angle reduction for that diff class.").optional(),
});

// One named group of angles dispatched together onto a single reviewer under
// grouped fan-out. `name` is recorded as the shared reviewer's
// provenance `group` (see resolveFanoutGroups / fanoutReviewerPairingError).
const FanoutGroup = z.strictObject({
  name: z.string().trim().min(1).describe("Group name; recorded as the shared reviewer's provenance `group` when this group dispatches."),
  angles: z.array(z.string().trim().min(1)).min(1).describe("Angle names batched onto one reviewer when this group resolves."),
});

// Angle-dispatch fan-out policy (two-knob dispatch bounds). grouped
// (default) batches related angles onto one reviewer per group; per-angle emits
// one reviewer per angle (bypasses configured groups). gate:full forces the full
// angle set upstream (resolveGateTier) and dispatches GROUPED here (ADR 0048).
//   maxAnglesPerGroup (N, default 3, min 1) — leftover ungrouped angles
//     auto-chunk into units of ≤N after configured groups match.
//   maxConcurrent (M, default 4, min 1) — at most M dispatch units per wave
//     (scheduleFanoutWaves).
// An angle in no configured group joins the auto-chunked leftover pool.
const FanoutConfig = z.strictObject({
  mode: z.enum(["grouped", "per-angle"]).default("grouped").describe("Angle dispatch mode: grouped batches related angles onto one reviewer each (default); per-angle bypasses the configured-groups table and emits one singleton unit per angle (the original full-scrutiny shape). per-angle is equivalent to maxAnglesPerGroup: 1 in dispatch unit size ONLY when no configured multi-angle group matches a resolved angle; otherwise per-angle bypasses configured groups while maxAnglesPerGroup: 1 honors them (matched first, never split)."),
  groups: z.array(FanoutGroup).optional().describe("Static named angle groups consulted in grouped mode. An angle absent from every group joins the auto-chunked leftover pool (chunked into units of ≤maxAnglesPerGroup)."),
  maxAnglesPerGroup: z.number().int().min(1).default(3).describe("Max angles per auto-chunked dispatch unit for leftover ungrouped angles (default 3, min 1). Configured groups are matched first and never split by this knob; mode: per-angle bypasses the table entirely (one singleton per angle)."),
  maxConcurrent: z.number().int().min(1).default(4).describe("Max dispatch units (groups) the conductor dispatches concurrently per wave (default 4, min 1). The wave plan is emitted by write-gate-context.mjs via scheduleFanoutWaves (scheduleParallelWaves). Ignored when sequential is true (which forces one unit per wave)."),
  sequential: z.boolean().default(false).describe("Dispatch heavy reviewers one at a time (serial) instead of wave-by-wave parallel (issue #1726). When true, effective fan-out concurrency is one dispatch unit per wave regardless of maxConcurrent, so each heavy reviewer completes and writes its evidence artifact before the next starts. Distinct reviewers, real fan-in/ledger, and provenance are unchanged — this only bounds dispatch concurrency. Default false keeps shipped behaviour unchanged for other harnesses/repos (cross-harness non-regression #1086); a repo sets it in .devloops to bound concurrency for all its PRs."),
});

/**
 * Two `gates.fanout.groups` entries sharing one `name` would resolve to two
 * dispatch units with the same reviewer-sentinel scope (resolveFanoutGroups
 * keys the scope by group name) — reject at config-validation time rather
 * than let it degrade silently at dispatch time. Applied via `.superRefine`
 * where `FanoutConfig` is used (zod v4 rejects `.partial()` on a schema that
 * already carries a refinement), not on `FanoutConfig` itself.
 * @param {{ groups?: Array<{ name: string }> }} val
 * @param {import("zod").RefinementCtx} ctx
 */
function rejectDuplicateFanoutGroupNames(val, ctx) {
  if (!Array.isArray(val.groups)) return;
  const seen = new Set();
  for (const [index, group] of val.groups.entries()) {
    if (seen.has(group.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", index, "name"],
        message: `duplicate gates.fanout.groups name "${group.name}"`,
      });
    }
    seen.add(group.name);
  }
}

// Fail-closed PR size budget (see check-size-budget.mjs's pure computation).
// `patterns` classifies a changed file into t1/t3 by path glob; the default
// tier is implicit (no `patterns`). `sliceHardLoc` (t1 only) caps the T1-slice
// LOC, not the whole-PR LOC. Per-tier softLoc/waiverLoc on t1/t3 and
// sliceHardLoc on t3 are not honored by computeSizeBudget yet, so they are
// parked OUT of the schema rather than shipped as inert accepted-but-ignored
// knobs; only the default tier's softLoc/waiverLoc and t1's sliceHardLoc drive
// the outcome.
const SizeTierConfig = z.strictObject({
  patterns: z.array(z.string().trim().min(1)).optional().describe("Glob-style path patterns; a changed file matching one resolves to this tier."),
  softLoc: z.number().int().positive().nullable().optional().describe("Escalate above this many logic LOC; null disables the soft threshold for this tier."),
  waiverLoc: z.number().int().positive().nullable().optional().describe("Block (waiver required) above this many logic LOC, up to absoluteHardLoc; null disables the waiver threshold for this tier."),
  sliceHardLoc: z.number().int().positive().optional().describe("T1 only: block above this many T1-slice logic LOC unless waived by a named human approver."),
});

const SizeTiersConfig = z.strictObject({
  default: SizeTierConfig.omit({ patterns: true, sliceHardLoc: true }).default({ softLoc: 400, waiverLoc: 1500 }).describe("Fallback tier applied to every changed file that matches no t1/t3 pattern."),
  t1: SizeTierConfig.omit({ softLoc: true, waiverLoc: true }).optional().describe("Risk-slice tier (money/auth/shared/ungated paths). Empty by default — a repo defines its own patterns; the T1 slice is computed separately from whole-PR LOC."),
  t3: SizeTierConfig.pick({ patterns: true }).optional().describe("Relaxed tier (e.g. scaffold/template clones). Empty by default — a repo defines its own patterns; the absolute ceiling still applies. Per-tier soft/waiver thresholds are not yet honored (Phase 1)."),
});

const SizeConfig = z.strictObject({
  testDiscount: z.number().min(0).max(1).default(0.25).describe("Weight applied to test LOC when computing logicLoc = code + testDiscount * test."),
  absoluteHardLoc: z.number().int().positive().default(2000).describe("Whole-PR logic-LOC ceiling; blocks with no waiver possible above this, for any tier."),
  tiers: SizeTiersConfig.default({}).describe("Per-tier soft/waiver/slice thresholds and path patterns."),
});

const GatesConfig = z.strictObject({
  draft: GateConfig.optional(),
  // Fail-closed PR size/tier budget (active by default); computation lives in
  // scripts/loop/check-size-budget.mjs.
  size: SizeConfig.optional(),
  // requireCi mirrors the draft gate: false ignores the CI verdict entirely at
  // this boundary, including a real failure (not merely "green optional").
  preApproval: GateConfig.optional(),
  // Relaxed spike gate profile: a findings-doc deliverable, resolved
  // through the same layering/resolveGateConfig path as draft/preApproval.
  spike: GateConfig.optional(),
  // Fail-closed enforcement that a gate verdict was produced by the
  // fan-out/fan-in review sub-loop (executionMode === "fanout_fanin" plus a
  // durable findings-log ledger), not an inline single-agent run. Default
  // true (opt-out): a clean gate verdict requires fan-out/fan-in evidence
  // unless explicitly disabled. See skills/docs/gate-review-sub-loop-contract.md.
  requireFanoutEvidence: z.boolean().default(true),
  // Fail-closed enforcement that a fanout_fanin verdict carries recorded,
  // internally-consistent fan-out provenance (distinct reviewer count +
  // per-angle dispatch). RAISES THE BAR against one agent self-producing every
  // artifact but does NOT prove independence — provenance is self-reported and
  // forgeable (honest caveat in skills/docs/gate-review-sub-loop-contract.md).
  // Layered on top of requireFanoutEvidence. Default false (opt-in).
  requireFanoutProvenance: z.boolean().default(false),
  // Accepted but inert: setting it has no dispatch effect. The active
  // concurrency cap is gates.fanout.maxConcurrent (ADR 0048).
  maxFanoutReviewers: z.number().int().min(1).max(64).default(8).describe("SUPERSEDED by gates.fanout.maxConcurrent (#1601, ADR 0048): no longer governs fan-out dispatch — the conductor dispatches wave-by-wave at most gates.fanout.maxConcurrent (M) dispatch units per wave via scheduleFanoutWaves (the wave plan emitted by write-gate-context.mjs). Kept for back-compat; setting it has no dispatch effect."),
  // GATE-EXEC-PRIME is MANDATORY: every gate fan-out primes the byte-identical
  // briefing prefix before reviewers read it.
  // postFindingsComments: opt-in duplicate findings surface; the disposition
  // ledger is written regardless.
  postFindingsComments: z.boolean().default(false),
  // Explicit GLOBAL (not per-gate) lens catalog override for additive angle
  // selection; resolveAnglePool falls back to persona registry ∪
  // configured angles when absent.
  anglePool: z.array(z.string().trim().min(1)).optional(),
  // Fail-closed: a fanout_fanin gate's per-angle provenance may name only
  // angles in the gate's configured pool; foreign labels are rejected. Default
  // true (reject); false warns instead. See resolveRejectForeignAngles.
  rejectForeignAngles: z.boolean().default(true),
  // Grouped vs per-angle fan-out dispatch policy + static grouping table.
  // GLOBAL, not per-gate — see resolveFanoutGroups.
  fanout: FanoutConfig.superRefine(rejectDuplicateFanoutGroupNames).optional(),
});

const AutonomyConfig = z.strictObject({
  // ponytail: stopAt kebab values ("draft-pr"/"pre-approval") vs camelCase gate
  // keys is DEFERRED — these are checkpoint/state-machine vocabulary shared far
  // beyond config (lifecycle-state, hook-decisions, the handoff-envelope
  // contract, ~20 more files); renaming here means renaming that shared
  // vocabulary, out of scope.
  stopAt: z.array(
    z.enum(["refinement", "draft-pr", "pre-approval", "merge"])
  ).describe("Checkpoints that require operator confirmation before the loop proceeds (default: [\"merge\"])."),
  // When true, merge is a fixed human-only action: the agent never runs
  // `gh pr merge`, resolveAutonomyStopAt always includes "merge", and any
  // per-run merge authorization is ignored (fails closed). See
  // resolveEffectiveMergeAuthorized.
  humanMergeOnly: z.boolean().describe("Merge stays a fixed human-only action: the agent never merges and any per-run merge authorization is ignored (fails closed).").optional(),
});

/**
 * Human-handoff config: at the pre-approval / merge-handoff boundary,
 * OFFER to assign the PR to a contributor reviewer/assignee. Opt-in (default
 * off). Pairs with autonomy.humanMergeOnly. `candidatesFrom` selects which
 * sources the resolver queries; `assignees` is a static highest-priority
 * candidate list. Absent/empty = disabled no-op.
 */
const ApprovalConfig = z.strictObject({
  enabled: z.boolean().default(false),
  candidatesFrom: z
    .array(z.enum(["codeowners", "recent-committers"]))
    .optional(),
  assignees: z.array(z.string().trim().min(1)).optional(),
});

const WorkflowConfig = z.strictObject({
  asyncStartMode: z.enum(["required", "allowed"]).default("required").describe("Whether the async start contract is required or merely allowed."),
  // ponytail: workflow.asyncStartMode -> asyncStartRequired is DEFERRED — the
  // string is echoed verbatim into the persisted handoff-envelope contract
  // field (workflow-handoff-contract.test.mjs / inspect-run viewer), so
  // renaming it means renaming a shipped artifact contract. Out of scope.
  requireRetrospective: z.boolean().describe("Require a retrospective checkpoint for the previous qualifying async completion before the next dev-loop start/resume."),
  requireDraftFirst: z.boolean().describe("Open pull requests as drafts and promote via the draft gate."),
  devModeDefault: z.boolean().describe("Default new loops to dev mode."),
  // Agent-level stall detection: a child with no turn progress for
  // thresholdMinutes and no pending request triggers a fresh-context recovery
  // dispatch. enabled:false restores the old wait behavior.
  stallDetection: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Enable agent-level stall -> auto-fresh-dispatch."),
      thresholdMinutes: z.number().int().min(1).default(5).describe("No-turn-progress window in minutes before a child is treated as stalled."),
    })
    .optional(),
  // No default here and absent from BUILT_IN_DEFAULTS — unset means "keep
  // auto-detecting the default branch" (see resolveBaseBranch), never a static
  // "main". Bare branch name; consumers add the `origin/` remote-ref prefix
  // where one is needed (worktree creation) and pass the bare name where one
  // is not (gh/PR base).
  baseBranch: z.string().trim().min(1).describe("Repo-level base/integration branch override (bare name, e.g. \"main\" or \"spike/foo\"). When set, worktree creation and PR targeting use it instead of the auto-detected default branch. Unset = auto-detect (origin/HEAD, else main/master).").optional(),
});

const LocalImplementationConfig = z.strictObject({
  /** Opt into light mode for small scoped changes */
  lightMode: z.strictObject({
    enabled: z.boolean().describe("Opt small scoped changes into the lightweight dispatch path."),
    maxFiles: z.number().int().min(1).describe("Light mode applies only when the change touches at most this many files."),
    maxLines: z.number().int().min(1).describe("Light mode applies only when the change stays within this many lines."),
    // Composes with (does not replace) refinement.maxCopilotRounds — see
    // resolveEffectiveCopilotRoundCap.
    maxCopilotRounds: z.number().int().nonnegative().default(1).describe("Copilot round cap for light-dispatched PRs; composes as min(this, refinement.maxCopilotRounds)."),
  }).optional(),
  /**
   * Opt into issue-less PR-first at ANY change scope. Decoupled from lightMode:
   * gate dispatch still resolves inline vs full_fanout from scope on its own.
   */
  issueless: z.boolean().describe("Opt into issue-less PR-first dispatch at any change scope; gate dispatch still resolves inline vs full fan-out from scope on its own.").optional(),
});

// GitHub Projects board identifier: exactly one of number/title. `ownerKey`
// names the config key in the refine failure message so each usage site gets
// an accurate message.
function boardRefConfig(ownerKey) {
  return z
    .strictObject({
      number: z.number().int().positive().describe("GitHub Projects board number.").optional(),
      title: z.string().trim().min(1).describe("GitHub Projects board title.").optional(),
    })
    .refine((v) => typeof v.number === "number" || typeof v.title === "string", {
      message: `${ownerKey} must set number or title`,
    });
}

/**
 * Logical board columns the queue status-column config recognizes. Mirrors
 * LOGICAL_COLUMN in loop/queue-board-sync.mjs; kept inline (a frozen 4-value
 * list) to avoid a config <-> queue-board-sync import cycle, since
 * queue-board-sync already imports readDevloopsSettings from this module.
 */
const QueueLogicalColumn = z.enum(["next_up", "in_progress", "ready_for_review", "done"]);

/** Queue mode config */
const QueueConfig = z.strictObject({
  maxParallel: z.number().int().min(1).max(10).default(3).describe("Maximum queue items worked in parallel."),
  maxAutoFiledIssues: z.number().int().min(0).max(100).default(10).describe("Cap on auto-filed issues per run."),
  reDispatchMaxRetries: z.number().int().min(0).max(10).default(1).describe("Retries when re-dispatching a failed queue item."),
  archiveOlderThanDays: z.number().int().positive().describe("Archive done board items older than this many days.").optional(),
  statusColumns: z
    .strictObject({
      next_up: z.string().trim().min(1).optional(),
      in_progress: z.string().trim().min(1).optional(),
      ready_for_review: z.string().trim().min(1).optional(),
      done: z.string().trim().min(1).optional(),
    })
    .describe("Logical-column -> board display-name overrides. Consumed by loadStateColumnMap (loop/queue-board-sync.mjs).")
    .optional(),
  stateColumnMap: z
    .record(z.string().trim().min(1), QueueLogicalColumn)
    .describe("Loop-state -> known logical column overrides. Consumed by loadStateColumnMap (loop/queue-board-sync.mjs).")
    .optional(),
});

/**
 * Tracker config (the tracker-agnostic seam). `provider` is a free-form
 * registry key (not a zod enum): an unknown provider fails closed at
 * `resolveTrackerAdapter` call time, not at parse time, so a consumer can
 * register an external provider post-1.0. No generic `fieldMappings` key: the
 * github provider's logical-column -> Status mapping IS the existing
 * `queue.statusColumns` (a second key would collide with it); a future external
 * provider defines its own mapping when implemented (YAGNI now).
 */
const TrackerConfig = z.strictObject({
  provider: z.string().trim().min(1).describe("Tracker provider registry key. Built-in: \"github\" (default).").optional(),
  plugin: z.string().trim().min(1).describe("Reserved: module specifier for an external tracker provider plugin (post-1.0, not implemented in this pass).").optional(),
  board: boardRefConfig("tracker.board").describe("Tracker board identifier.").optional(),
});

/**
 * Worktree lifecycle config: gitignored files/dirs provisioned into a
 * fresh worktree from the main checkout. Entries are repo-relative literal
 * paths or globs, each tagged copy or link. Empty/absent is a valid no-op.
 */
const WorktreeEntry = z.strictObject({
  path: z.string().trim().min(1).describe("Repo-relative path or glob."),
  mode: z.enum(["copy", "link"]).describe("copy = fs.cp into the worktree (isolated, mutable); link = absolute symlink to the main checkout (shared, read-only)."),
});

const WorktreeConfig = z.strictObject({
  entries: z.array(WorktreeEntry).optional().describe("Gitignored paths/globs provisioned into a fresh worktree."),
});

/**
 * Dev-DB migration sub-recipe for the ui-review run recipe. `statusCommand`
 * lists pending migrations; `applyCommand` applies them.
 *
 * Destructive detection is EXPLICIT and status-format-dependent: the
 * `destructivePattern` regex matches (case-insensitive, per line) against the
 * STATUS OUTPUT, not the migration files. The shipped default assumes
 * SQL-bearing status output; against non-SQL status output it matches nothing
 * and the guard is inert, so such a project MUST set a `destructivePattern`
 * matching its own status format (or make statusCommand emit the SQL/marker).
 */
const UiReviewMigrateConfig = z.strictObject({
  statusCommand: z.string().trim().min(1),
  applyCommand: z.string().trim().min(1),
  destructivePattern: z
    .string()
    .trim()
    .min(1)
    .refine((p) => {
      try {
        // Validate under the exact flags the runtime compile uses at the
        // destructive-migration safety boundary (inspectMigrations), so a
        // pattern valid bare but invalid under `u` is rejected at load time.
        new RegExp(p, "iu");
        return true;
      } catch {
        return false;
      }
    }, "destructivePattern must be a valid regex")
    .optional(),
});

/**
 * Per-project dev-DB row-teardown recipe (Stage 5). The drive stamps each
 * mutating step with a drive-session id; this `deleteCommand` deletes exactly
 * the rows the app tagged with that session (id in the UI_REVIEW_DRIVE_SESSION
 * env var; runs in the provisioned worktree, dev DB only). Runs only on
 * explicit confirmation.
 */
const UiReviewRowTeardownConfig = z.strictObject({
  deleteCommand: z.string().trim().min(1),
});

/**
 * Per-project boot recipe: a shell `command` that starts the branch's app and a
 * `readyUrl` an HTTP readiness probe polls until the app is up (never a fixed
 * sleep). No app is hard-coded — a project declares its own recipe. `cwd` is an
 * optional worktree-relative subdir to run in.
 */
const UiReviewRunConfig = z.strictObject({
  command: z.string().trim().min(1),
  readyUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => {
      try {
        const p = new URL(u).protocol;
        return p === "http:" || p === "https:";
      } catch {
        return false;
      }
    }, "readyUrl must be an http(s) URL"),
  readyTimeoutMs: z.number().int().min(1).max(600000).default(60000),
  readyIntervalMs: z.number().int().min(1).max(60000).default(1000),
  cwd: z.string().trim().min(1).optional(),
  migrate: UiReviewMigrateConfig.optional(),
  rowTeardown: UiReviewRowTeardownConfig.optional(),
});

/**
 * Per-project dev-login recipe (Stage 2). The drive stage obtains a session for
 * the change's target role by driving this login form in the browser. Nothing
 * is hard-coded here — a project declares its own login URL, field selectors,
 * and the shared dev credential (never a real user secret; a dev-only password
 * or role). `successSelector` is what proves the session was established;
 * without it the drive stage cannot confirm auth and fails closed.
 */
const UiReviewLoginConfig = z.strictObject({
  loginUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => {
      try {
        const p = new URL(u).protocol;
        return p === "http:" || p === "https:";
      } catch {
        return false;
      }
    }, "loginUrl must be an http(s) URL"),
  usernameSelector: z.string().trim().min(1).optional(),
  usernameValue: z.string().min(1).optional(),
  passwordSelector: z.string().trim().min(1).optional(),
  passwordValue: z.string().min(1).optional(),
  submitSelector: z.string().trim().min(1),
  successSelector: z.string().trim().min(1),
});

/** A config-declared interstitial (cookie consent etc.) dismissed ONCE per
 * browser context. */
const UiReviewInterstitialConfig = z.strictObject({
  selector: z.string().trim().min(1),
});

/** One driven step. The action set is deliberately small and maps 1:1 to a
 * Playwright page call in the harness — enough to render a page and exercise the
 * create/edit/reorder/upload/toggle interactions plus dispatch a real event. */
const UiReviewFlowStepConfig = z.strictObject({
  name: z.string().trim().min(1).optional(),
  action: z.enum(["goto", "click", "fill", "select", "upload", "dispatch"]),
  selector: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  value: z.string().optional(),
  event: z.string().trim().min(1).optional(),
  // A declared viewport resizes the page before the step and bakes into the
  // named-state slug, so distinct renders land in distinct reviewable dirs.
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  interactionState: z.enum(["none", "focus", "hover", "error"]).optional(),
}).superRefine((step, ctx) => {
  // Every action but `goto` targets an element, so a missing selector is a
  // config error, not a runtime step-failure. (`goto` uses `path`/url.)
  if (step.action !== "goto" && (step.selector == null || step.selector.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selector"], message: `step action "${step.action}" requires a selector` });
  }
  // Action-specific required fields. Rejecting these at parse time turns a silent
  // wrong drive into a clear config error: a missing `goto.path` would drive "/",
  // and a missing `upload.value` becomes setInputFiles(sel, "") which throws mid
  // walk as a step-failure rather than a config problem.
  if (step.action === "goto" && (step.path == null || step.path.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: `step action "goto" requires a path` });
  }
  if (step.action === "upload" && (step.value == null || step.value.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `step action "upload" requires a value (the file path to upload)` });
  }
});

/** An allowlisted changed flow. `pathPatterns` are plain substrings matched
 * against the PR's changed file paths to decide whether the flow is in scope
 * (the bounded changed-flow heuristic); a flow with none is always driven. */
const UiReviewFlowConfig = z.strictObject({
  name: z.string().trim().min(1),
  pathPatterns: z.array(z.string().trim().min(1)).optional(),
  steps: z.array(UiReviewFlowStepConfig).min(1),
});

/** Bounded drive caps (Stage 2). Every field is optional and clamped to a
 * ceiling at resolve time — a project may only tighten a cap, never loosen it. */
const UiReviewCapsConfig = z.strictObject({
  maxScreenshots: z.number().int().min(1).optional(),
  maxFlows: z.number().int().min(1).optional(),
  maxStepsPerFlow: z.number().int().min(1).optional(),
});

/**
 * UI-review route config: the generic, per-project provision+boot recipe (Stage
 * 1) plus the drive recipe (Stage 2: login, interstitials, changed-flow
 * allowlist, and an optional server-log path/pattern for tailing). Absent (the
 * default) means no recipe is declared — the corresponding stage stops with that
 * as a stated reason rather than guessing how to run or drive the app.
 */
const UiReviewConfig = z.strictObject({
  run: UiReviewRunConfig.optional(),
  login: UiReviewLoginConfig.optional(),
  interstitials: z.array(UiReviewInterstitialConfig).optional(),
  flows: z.array(UiReviewFlowConfig).optional(),
  caps: UiReviewCapsConfig.optional(),
  // Filesystem path (worktree-relative or absolute) to the project's server log.
  // The drive stage tails it so a swallowed 500 the UI hid is still recorded.
  serverLogPath: z.string().trim().min(1).optional(),
  serverLogExceptionPattern: z
    .string()
    .trim()
    .min(1)
    .refine((p) => {
      try {
        new RegExp(p, "iu");
        return true;
      } catch {
        return false;
      }
    }, "serverLogExceptionPattern must be a valid regex")
    .optional(),
});

// Default/ceiling bounds for a post-merge action's run/verify timing.
// The default keeps a config-declared action from hanging a harness hook
// forever when the author leaves timeoutMs unset; the ceiling caps how far a
// config CAN push it — a config can only tighten these, never loosen past the
// ceiling.
export const POST_MERGE_ACTION_DEFAULT_TIMEOUT_MS = 120000;
export const POST_MERGE_ACTION_TIMEOUT_CEILING_MS = 600000;
export const POST_MERGE_VERIFY_DEFAULT_TIMEOUT_MS = 60000;
export const POST_MERGE_VERIFY_TIMEOUT_CEILING_MS = 600000;
export const POST_MERGE_VERIFY_DEFAULT_INTERVAL_MS = 2000;
export const POST_MERGE_VERIFY_INTERVAL_CEILING_MS = 60000;

/**
 * One post-merge action (Stage: local consumer hook). `run` and `verify` are
 * executed VERBATIM as the operator wrote them — same trust level as
 * `uiReview.run.command` (this repo's own committed `.devloops`) — so callers
 * must never build these strings by interpolating untrusted runtime data
 * (PR titles, branch names, verify output) into them. `onlyIfChanged` is
 * matched as DATA (plain substrings against changed file paths), never
 * shelled out.
 */
const PostMergeActionConfig = z.strictObject({
  name: z.string().trim().min(1),
  run: z.string().trim().min(1),
  onlyIfChanged: z.array(z.string().trim().min(1)).optional(),
  verify: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(POST_MERGE_ACTION_TIMEOUT_CEILING_MS).default(POST_MERGE_ACTION_DEFAULT_TIMEOUT_MS),
  verifyTimeoutMs: z.number().int().min(1).max(POST_MERGE_VERIFY_TIMEOUT_CEILING_MS).default(POST_MERGE_VERIFY_DEFAULT_TIMEOUT_MS),
  verifyIntervalMs: z.number().int().min(1).max(POST_MERGE_VERIFY_INTERVAL_CEILING_MS).default(POST_MERGE_VERIFY_DEFAULT_INTERVAL_MS),
});

/**
 * `postMerge.actions`: consumer-declared local actions (sync checkout, restart
 * a local service, smoke check) run sequentially, in declared order, after the
 * dev-loop's merge succeeds. Mirrors `uiReview.run` as the config-shape,
 * validation, and command-execution precedent. Absent (the default) means no
 * action is declared — a repo without this family gets zero new hook commands.
 */
const PostMergeConfig = z.strictObject({
  actions: z.array(PostMergeActionConfig).optional(),
});

/** Internal path whitelist for internal-only PR detection — flat array of regex strings */
const InternalPatternsConfig = z.array(z.string().trim().min(1)).min(1);

// Partial nested gate entries for file-level config (allows overriding only
// requireCi/required/angles without restating the whole gate object).
const FileGatesConfig = z.strictObject({
  // Each gate gets its own GateConfig.partial() instance rather than three
  // .describe() clones of one shared partial, so no underlying def is shared
  // and per-gate metadata renders unambiguously.
  draft: GateConfig.partial().describe("Draft gate config (runs before a PR leaves draft).").optional(),
  preApproval: GateConfig.partial().describe("Pre-approval gate config (final re-review before the merge handoff).").optional(),
  spike: GateConfig.partial().describe("Relaxed spike gate profile; applies only to spike-mode work.").optional(),
  size: SizeConfig.partial().describe("Fail-closed PR size/tier budget: testDiscount, absoluteHardLoc, and per-tier soft/waiver/slice thresholds + patterns.").optional(),
  requireFanoutEvidence: z.boolean().describe("Require fan-out/fan-in review evidence on gate verdicts; inline single-agent verdicts are rejected except under the strict light-mode exception (under-threshold scope, no gate:full label, recorded inline reason).").optional(),
  requireFanoutProvenance: z.boolean().describe("Additionally require recorded, internally-consistent fan-out provenance (distinct reviewer count + per-angle dispatch).").optional(),
  maxFanoutReviewers: z.number().int().min(1).max(64).describe("SUPERSEDED by gates.fanout.maxConcurrent (#1601, ADR 0048): no longer governs fan-out dispatch — the conductor dispatches wave-by-wave at most gates.fanout.maxConcurrent (M) dispatch units per wave via scheduleFanoutWaves (the wave plan emitted by write-gate-context.mjs). Kept for back-compat; setting it has no dispatch effect.").optional(),
  postFindingsComments: z.boolean().describe("Also post consolidated gate findings as a second marker-tagged PR comment, duplicating the verdict review's own findings (default false).").optional(),
  anglePool: z.array(z.string().trim().min(1)).describe("Explicit global lens catalog for additive angle selection (global, not per-gate).").optional(),
  rejectForeignAngles: z.boolean().describe("Reject fan-out provenance naming angles outside the gate's configured pool (default true).").optional(),
  fanout: FanoutConfig.partial().superRefine(rejectDuplicateFanoutGroupNames).describe("Grouped vs per-angle fan-out dispatch policy + static grouping table (global, not per-gate).").optional(),
});

// ============================================================================
// Full schema — families are optional (BUILT_IN_DEFAULTS provides fallback)
// ============================================================================

/**
 * @typedef {z.infer<typeof DevLoopConfigSchema>} DevLoopConfig
 */

export const DevLoopConfigSchema = z.strictObject({
  version: z.literal(1),
  strategy: StrategyConfig.optional(),
  inputSource: InputSourceConfig.optional(),
  models: ModelsConfig.optional(),
  refinement: RefinementConfig.optional(),
  gates: GatesConfig.optional(),
  autonomy: AutonomyConfig.optional(),
  approval: ApprovalConfig.optional(),
  workflow: WorkflowConfig.optional(),
  localImplementation: LocalImplementationConfig.optional(),
  queue: QueueConfig.optional(),
  tracker: TrackerConfig.optional(),
  internalPathPatterns: InternalPatternsConfig.optional(),
  worktree: WorktreeConfig.optional(),
  uiReview: UiReviewConfig.optional(),
  postMerge: PostMergeConfig.optional(),
});

// ============================================================================
// Built-in defaults — frozen canonical single source of truth
// ============================================================================

export const BUILT_IN_DEFAULTS = Object.freeze({
  version: 1,
  strategy: "local-first",
  inputSource: "tracker",
  models: Object.freeze({}),
  refinement: Object.freeze({ fanOut: 3, mode: "parallel", maxCopilotRounds: 5, lowSignal: Object.freeze({ enabled: false, roundThreshold: 3, maxComments: 2 }) }),
  gates: Object.freeze({}),
  autonomy: Object.freeze({ stopAt: Object.freeze(["merge"]), humanMergeOnly: false }),
  approval: Object.freeze({
    enabled: false,
    candidatesFrom: Object.freeze([]),
    assignees: Object.freeze([]),
  }),
  workflow: Object.freeze({
    asyncStartMode: "required",
    requireRetrospective: false,
    requireDraftFirst: false,
    devModeDefault: false,
    stallDetection: Object.freeze({ enabled: true, thresholdMinutes: 5 }),
  }),
  localImplementation: Object.freeze({
    lightMode: Object.freeze({ enabled: false, maxFiles: 3, maxLines: 200, maxCopilotRounds: 1 }),
    issueless: false,
  }),
  queue: Object.freeze({
    maxParallel: 3,
    maxAutoFiledIssues: 10,
    reDispatchMaxRetries: 1,
  }),
  tracker: Object.freeze({
    provider: "github",
    // tracker.board is intentionally absent from defaults — setting it is an
    // explicit operator opt-in for Projects-based queue ordering. The logical-column ->
    // Status mapping is queue.statusColumns (see TrackerConfig above), not a
    // tracker-owned default.
  }),
  internalPathPatterns: Object.freeze([
    "^scripts/",
    "^docs/",
    "^skills/docs/",
    "^\\.pi/",
    "^\\.github/",
    "^test/",
  ]),
  worktree: Object.freeze({ entries: Object.freeze([]) }),
});

// ============================================================================
// File-level validation schema — allows partial family objects
// ============================================================================

export const FileConfigSchema = z.strictObject({
  version: z.literal(1).describe("Config format version; always 1."),
  strategy: StrategyConfig.optional().describe("Work-intake strategy default."),
  inputSource: InputSourceConfig.optional().describe("Spec source for local-first work."),
  models: ModelsConfigBase.partial().superRefine(refineRoleTiers).describe("Model routing: conductor override, per-role overrides, tier aliases, and role→tier policy.").optional(),
  refinement: RefinementConfig.partial().describe("Refinement fan-out and Copilot review-round behavior.").optional(),
  gates: FileGatesConfig.describe("Gate review configuration: per-gate angle sets plus fan-out enforcement knobs.").optional(),
  autonomy: AutonomyConfig.partial().describe("How far the loop proceeds without operator confirmation.").optional(),
  approval: ApprovalConfig.partial().describe("Approval / merge-handoff behavior (human-handoff offer).").optional(),
  workflow: WorkflowConfig.partial().describe("Workflow posture: draft-first, retrospectives, dev mode, async start.").optional(),
  localImplementation: LocalImplementationConfig.partial().describe("Local implementation dispatch (light mode for small scoped changes).").optional(),
  queue: QueueConfig.partial().describe("Queue mode: parallelism, auto-filing caps, and Projects board opt-in.").optional(),
  tracker: TrackerConfig.partial().describe("Tracker seam config: provider (default \"github\") and board. The github provider's logical-column->Status mapping is the existing queue.statusColumns; a future external provider defines its own.").optional(),
  internalPathPatterns: InternalPatternsConfig.describe("Regex whitelist for internal-only PR detection.").optional(),
  worktree: WorktreeConfig.partial().describe("Worktree provisioning: gitignored files/dirs copied or symlinked into fresh worktrees.").optional(),
  uiReview: UiReviewConfig.partial().describe("UI-review route recipes: per-project run/boot, dev-login, driven flows, and caps.").optional(),
  postMerge: PostMergeConfig.partial().describe("Post-merge local hook actions (postMerge.actions): consumer-declared commands run sequentially, in order, after a merge succeeds — optionally scoped to changed-file substrings (onlyIfChanged) and polled for readiness (verify).").optional(),
  // Unknown keys fail closed like any typo (strictObject).
});

// ============================================================================
// Built-in persona registry — fallback for gate-review angle → reviewer
// persona resolution. Only the persona name is defined here; prompts and
// per-angle model overrides live on the angle's own config entry (see
// resolveReviewerRole).
// ============================================================================

const BUILTIN_PERSONAS = Object.freeze({
  scope:       { persona: "review", defaultModel: null },
  coverage:    { persona: "review", defaultModel: null },
  correctness: { persona: "review", defaultModel: null },
  docs:        { persona: "docs", defaultModel: null },
  deep:        { persona: "review", defaultModel: null },
  dry:         { persona: "review", defaultModel: null },
  kiss:        { persona: "review", defaultModel: null },
  srp:         { persona: "review", defaultModel: null },
  ocp:         { persona: "review", defaultModel: null },
  lsp:         { persona: "review", defaultModel: null },
  isp:         { persona: "review", defaultModel: null },
  dip:         { persona: "review", defaultModel: null },
  soc:         { persona: "review", defaultModel: null },
  yagni:       { persona: "review", defaultModel: null },
  "contract-surface":  { persona: "review", defaultModel: null },
  "input-validation":  { persona: "review", defaultModel: null },
  "threat-model":      { persona: "review", defaultModel: null },
  "packaging-runtime": { persona: "review", defaultModel: null },
  "state-concurrency": { persona: "review", defaultModel: null },
  "renderer-security": { persona: "review", defaultModel: null },
  determinism:          { persona: "review", defaultModel: null },
  "acceptance-criteria": { persona: "review", defaultModel: null },
  "ac-dod":              { persona: "review", defaultModel: null },
  deslop:                { persona: "review", defaultModel: null },
});

const DEFAULT_REVIEWER_PERSONA = "default-reviewer";

// ============================================================================
// Role resolution
// ============================================================================

/**
 * @typedef {object} RoleResolutionResult
 * @property {string} persona - Agent persona name to use
 * @property {string|null} model - Effective model (null = use persona default)
 * @property {string|null} prompt - Focused review instruction for this angle (null when fallback)
 * @property {boolean} fallback - True when no specialized persona was found
 */

/**
 * Normalize one raw `gates.<gate>.angles[]` entry (string sugar or object,
 * possibly hand-built and never zod-validated — e.g. a test config object) to
 * `{ name, mandatory?, enabled?, persona?, prompt?, model?, tier?, scope? }`.
 * Returns null for a malformed/empty entry so callers can filter it out. An
 * invalid `scope` (not one of GATE_ANGLE_SCOPES) is dropped rather than
 * kept verbatim — resolveGateAngleScope's fail-open default only ever needs
 * to handle an ABSENT field, never a foreign value.
 * @param {unknown} a
 * @returns {{name: string, mandatory?: boolean, enabled?: boolean, persona?: string, prompt?: string, model?: string, tier?: string, scope?: string}|null}
 */
function normalizeAngleEntry(a) {
  if (typeof a === "string") {
    const name = a.trim();
    return name.length > 0 ? { name } : null;
  }
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (name.length === 0) return null;
    const entry = { name };
    if (a.mandatory === true) entry.mandatory = true;
    if (a.enabled === false) entry.enabled = false;
    if (typeof a.persona === "string" && a.persona.trim().length > 0) entry.persona = a.persona.trim();
    if (typeof a.prompt === "string" && a.prompt.length > 0) entry.prompt = a.prompt;
    if (typeof a.model === "string" && a.model.trim().length > 0) entry.model = a.model.trim();
    if (typeof a.tier === "string" && a.tier.trim().length > 0) entry.tier = a.tier.trim();
    if (typeof a.scope === "string" && GATE_ANGLE_SCOPES.includes(a.scope.trim())) entry.scope = a.scope.trim();
    return entry;
  }
  return null;
}

/**
 * Normalize a raw `gates.<gate>.angles` array into full entry objects,
 * dropping malformed entries.
 * @param {unknown} raw
 * @returns {Array<{name: string, mandatory?: boolean, enabled?: boolean, persona?: string, prompt?: string, model?: string, tier?: string, scope?: string}>}
 */
function normalizeAngleEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    const entry = normalizeAngleEntry(a);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Find a named angle's configured entry, searching this config's own gates in
 * a fixed priority order (draft, preApproval, spike) and returning the first
 * match. A DISABLED entry (`enabled: false`) is SKIPPED, never returned:
 * returning a bare `enabled:false` placeholder would shadow another gate's real
 * override of the same angle name. Both callers only ever look up a name
 * already present in some gate's enabled resolved list, so a name disabled
 * everywhere is never queried.
 * @param {DevLoopConfig} config
 * @param {string} name
 * @returns {{name: string, mandatory?: boolean, enabled?: boolean, persona?: string, prompt?: string, model?: string, tier?: string}|null}
 */
function findAngleEntry(config, name) {
  for (const gate of ["draft", "preApproval", "spike"]) {
    const entries = normalizeAngleEntries(config?.gates?.[gate]?.angles);
    const found = entries.find((e) => e.name === name && e.enabled !== false);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a gate angle's declared surface scope: see GATE_ANGLE_SCOPES.
 * Looks up the entry within the ONE named gate (scope is meaningful only for
 * that gate's briefing pass). Fails open to "full" for a missing/disabled entry
 * or an unknown/malformed `scope` — a narrow scope is an opt-in cost saving,
 * never a silently-enforced information cut.
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate
 * @param {string} name
 * @returns {"full"|"changed-files"|"docs-only"}
 */
export function resolveGateAngleScope(config, gate, name) {
  const entries = normalizeAngleEntries(config?.gates?.[gate]?.angles);
  const found = entries.find((e) => e.name === name && e.enabled !== false);
  return found?.scope ?? "full";
}

/**
 * Resolve a tier alias to its per-harness concrete model, or `null`
 * (`inherit`/unmapped/absent → no override). Deep-merges the alias mapping so
 * a partial config override (e.g. `{ pi: "..." }`) preserves the untouched
 * built-in harness key rather than erasing the whole `{claude,pi}` mapping.
 * @param {DevLoopConfig} config
 * @param {string|undefined} tierAlias
 * @param {"claude"|"pi"} harness
 * @returns {string|null}
 */
function resolveTierMapping(config, tierAlias, harness) {
  if (!tierAlias || tierAlias === "inherit") return null;
  const builtinMapping = BUILTIN_TIERS[tierAlias];
  const configMapping = config?.models?.tiers?.[tierAlias];
  if (!builtinMapping && !configMapping) return null;
  const mapping = { ...builtinMapping, ...configMapping };
  const model = mapping[harness];
  return trimmedOrNull(model);
}

/**
 * Resolve a gate angle name to a reviewer persona and model. Resolution:
 * the angle's own configured entry (findAngleEntry), else BUILTIN_PERSONAS,
 * applying any entry `model` override; an unknown angle falls back to the
 * default reviewer (still honoring a `model` override).
 * @param {object} config - DevLoopConfig (or a partial with gates)
 * @param {string|null|undefined} angle - Gate angle / lens name
 * @returns {RoleResolutionResult}
 */
export function resolveReviewerRole(config, angle) {
  if (angle == null || angle === "") {
    return {
      persona: DEFAULT_REVIEWER_PERSONA,
      model: null,
      prompt: null,
      fallback: true,
    };
  }

  const entry = findAngleEntry(config, angle);
  const builtinPersona = BUILTIN_PERSONAS[angle] ?? null;
  const personaName = entry?.persona ?? builtinPersona?.persona ?? null;
  const modelOverride = entry?.model ?? null;

  if (personaName) {
    return {
      persona: personaName,
      model: modelOverride || builtinPersona?.defaultModel || null,
      prompt: entry?.prompt ?? null,
      fallback: false,
    };
  }

  // Unknown angle — fall back to default reviewer, but still apply model override
  return {
    persona: DEFAULT_REVIEWER_PERSONA,
    model: modelOverride || null,
    prompt: null,
    fallback: true,
  };
}

/**
 * Resolve the concrete model for a subagent role/angle on a given harness, or
 * `null` (inherit → pass no model override).
 *
 * Precedence:
 *   1. `kind: "angle"` (gate review dispatch): the angle's own `model`, else its
 *      `tier`, else the built-in `review` tier — so a gate review runs at review
 *      quality even when the angle name collides with a routine role (e.g. the
 *      `docs` angle resolves high via `review`, not the `docs` writer's low tier).
 *   2. `kind: "role"`/absent (routine subagent): `models.roles[role]`, else
 *      `models.roleTiers[role]` (or the built-in role tier) mapped through
 *      `models.tiers`; `inherit`/absent/null → null. A non-role name falls back
 *      to its review persona's tier.
 *
 * Callers dispatching a gate angle whose name may collide with a routine role
 * (only `docs` today) MUST pass `kind: "angle"` to avoid the silent downgrade.
 *
 * @param {DevLoopConfig} config
 * @param {{ role: string, harness: "claude"|"pi", kind?: "role"|"angle" }} params
 * @returns {string|null}
 */
export function resolveRoleModel(config, { role, harness, kind } = {}) {
  if (!role || (harness !== "claude" && harness !== "pi")) return null;

  if (kind === "angle") {
    const entry = findAngleEntry(config, role);
    if (typeof entry?.model === "string" && entry.model.length > 0) return entry.model;
    const tierAlias = entry?.tier ?? BUILTIN_ROLE_TIERS.review;
    return resolveTierMapping(config, tierAlias, harness);
  }

  // Concrete per-role override wins outright over any tier (role-keyed only).
  const concrete = config?.models?.roles?.[role];
  if (typeof concrete === "string" && concrete.trim().length > 0) {
    return concrete.trim();
  }

  // 2. Resolve a tier alias for this role.
  const roleTiers = { ...BUILTIN_ROLE_TIERS, ...(config?.models?.roleTiers ?? {}) };
  let tierAlias = roleTiers[role];
  if (tierAlias === undefined) {
    // Not a named role — treat as a gate angle and inherit its review
    // persona's tier (critical angles resolve high via the `review` persona).
    const { persona } = resolveReviewerRole(config, role);
    tierAlias = roleTiers[persona];
  }
  return resolveTierMapping(config, tierAlias, harness);
}

// ============================================================================
// Error types
// ============================================================================

/**
 * @typedef {object} ConfigLoadError
 * @property {string} path - Human-readable file path or layer name
 * @property {string} message - Error description
 * @property {"extensionDefaults"|"defaults"|"devloops"|"merged"} layer - Which config layer failed
 */

// ============================================================================
// Helpers

/**
 * Resolve the base path (without extension) for extension-packaged defaults.
 * In normal use the file lives next to config.mjs inside the installed package.
 * Tests can override this via `options.extensionDefaultsBasePath`.
 * @param {{ extensionDefaultsBasePath?: string }} [options]
 * @returns {string}
 */
function resolveExtensionDefaultsPath(options = {}) {
  if (options.extensionDefaultsBasePath) return options.extensionDefaultsBasePath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, "extension-defaults");
}

// ============================================================================

/** True for a non-null, non-array plain object. */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge two config objects. Keys in `source` override keys in `target`.
 * Family objects merge at one level, except `gates`, which merges one extra
 * nested gate-object level so settings can override `draft.requireCi` without
 * restating the shipped draft angles (see {@link mergeGatesFamily}).
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function mergeConfigLayers(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key !== "version" && isPlainObject(source[key]) && isPlainObject(result[key])) {
      result[key] = key === "gates"
        ? mergeGatesFamily(result[key], source[key])
        : { ...(result[key] || {}), ...(source[key] || {}) };
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const MERGE_BY_NAME_GATE_KEYS = Object.freeze(["draft", "preApproval", "spike"]);

/** Merge the `gates` family: draft/preApproval/spike get the gate-object merge
 * ({@link mergeGateObject}, angle-array-by-name aware); every other `gates.*`
 * key (`anglePool`, `requireFanoutEvidence`, ...) merges shallowly as before. */
function mergeGatesFamily(target, source) {
  const result = { ...(target || {}) };
  for (const key of Object.keys(source || {})) {
    if (MERGE_BY_NAME_GATE_KEYS.includes(key) && isPlainObject(source[key]) && isPlainObject(result[key])) {
      result[key] = mergeGateObject(result[key], source[key]);
    } else if (isPlainObject(source[key]) && isPlainObject(result[key])) {
      result[key] = { ...(result[key] || {}), ...(source[key] || {}) };
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Merge one gate object (draft/preApproval/spike) across config layers.
 * `angles` merges BY NAME: a later layer can add a new angle, or override
 * an existing angle's flags (including `enabled: false` to drop it), without
 * restating the whole array. `dynamic` merges shallowly (its two booleans).
 * Every other key (`required`, `requireCi`, `blockCleanOnFindingSeverities`)
 * is replaced wholesale, same as any scalar/array config value.
 */
function mergeGateObject(target, source) {
  const result = { ...(target || {}) };
  for (const key of Object.keys(source || {})) {
    if (key === "angles") {
      result.angles = mergeAngleArrays(result.angles, source.angles);
    } else if (key === "dynamic" && isPlainObject(source.dynamic) && isPlainObject(result.dynamic)) {
      result.dynamic = { ...(result.dynamic || {}), ...(source.dynamic || {}) };
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Merge two `gates.<gate>.angles` arrays BY `name`: entries in `target`
 * keep their position; a `source` entry with a name already in `target`
 * overrides that entry's fields (shallow — e.g. `{ enabled: false }` drops it
 * without touching its `persona`/`prompt`); a `source` entry with a new name
 * is appended. This is what lets a later config layer add or disable a single
 * angle without restating the whole upstream list.
 * @param {unknown} targetRaw
 * @param {unknown} sourceRaw
 * @returns {Array<{name: string}>}
 */
function mergeAngleArrays(targetRaw, sourceRaw) {
  const targetEntries = normalizeAngleEntries(targetRaw);
  const sourceEntries = normalizeAngleEntries(sourceRaw);
  if (targetEntries.length === 0) return sourceEntries;
  const byName = new Map(targetEntries.map((e) => [e.name, e]));
  for (const entry of sourceEntries) {
    const existing = byName.get(entry.name);
    byName.set(entry.name, existing ? { ...existing, ...entry } : entry);
  }
  return [...byName.values()];
}

/**
 * Try to read and parse a config file (YAML preferred, JSON fallback).
 * Detects format from file extension: .yaml/.yml → YAML, .json → JSON.
 * Returns the parsed object or null if the file doesn't exist.
 * Throws on read errors other than ENOENT.
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
async function readConfigFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw configError(`Cannot read config file: ${err.message}`, err.code, filePath);
  }

  if (raw.trim() === "") {
    throw configError("Config file is empty", "EMPTY_FILE", filePath);
  }

  const hasExt = filePath.endsWith(".yaml") || filePath.endsWith(".yml") || filePath.endsWith(".json");
  const isYaml = filePath.endsWith(".yaml") || filePath.endsWith(".yml");
  let parsed;
  if (hasExt) {
    try {
      parsed = isYaml ? parseYaml(raw) : JSON.parse(raw);
    } catch (err) {
      const format = isYaml ? "YAML" : "JSON";
      throw configError(`Invalid ${format} in config file: ${err.message}`, `INVALID_${format.toUpperCase()}`, filePath);
    }
  } else {
    // Bare file (no recognized extension) — try YAML first, fallback JSON
    try {
      parsed = parseYaml(raw);
    } catch {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw configError(`Invalid config file (tried YAML and JSON): ${err.message}`, "INVALID_BARE_FILE", filePath);
      }
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configError("Config file must be an object", "NOT_AN_OBJECT", filePath);
  }

  return parsed;
}

/**
 * Find a config file by trying one or more base names in order.
 * Each base name prefers YAML (.yaml, then .yml) before JSON.
 * @param {string|string[]} basePaths - Path(s) without extension (e.g. .../defaults)
 * @returns {Promise<{ path: string, data: object|null }>}
 */
async function findConfigFile(basePaths) {
  const candidates = Array.isArray(basePaths) ? basePaths : [basePaths];

  for (const basePath of candidates) {
    // Try bare path first. ENOENT: try extension variants. Other errors
    // (EISDIR/EACCES) mean the bare file exists but is unreadable — try
    // extension variants, but surface the original error if none exists.
    let bareData = null;
    let bareError = null;
    try {
      bareData = await readConfigFile(basePath);
    } catch (err) {
      bareError = err;
    }
    if (bareData !== null) return { path: basePath, data: bareData };

    for (const ext of [".yaml", ".yml", ".json"]) {
      const filePath = basePath + ext;
      const data = await readConfigFile(filePath);
      if (data !== null) return { path: filePath, data };
    }

    // No extension variant found either — if the bare path exists but is
    // unreadable, surface that error rather than silently falling back.
    if (bareError) throw bareError;
  }

  return { path: candidates[0] + ".yaml", data: null };
}

/**
 * @param {string} message
 * @param {string} code
 * @param {string} filePath
 * @returns {Error & { code: string, path: string }}
 */
function configError(message, code, filePath) {
  return Object.assign(new Error(message), { code, path: filePath });
}

/**
 * Try to load and merge one config layer (extensionDefaults, defaults, or
 * devloops).
 * @param {Record<string, unknown>} merged - Current merged config
 * @param {string|string[]} basePaths - Config file base path(s) without extension
 * @param {"extensionDefaults"|"defaults"|"devloops"} layer - Layer name
 * @param {string[]} warnings
 * @param {ConfigLoadError[]} errors
 * @param {{ warnOnMissing?: boolean }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
async function applyLayer(merged, basePaths, layer, warnings, errors, options = {}) {
  let filePath, data = null;
  try {
    const found = await findConfigFile(basePaths);
    filePath = found.path;
    data = found.data;
  } catch (err) {
    const preferredBasePath = Array.isArray(basePaths) ? basePaths[0] : basePaths;
    const errorPath = err.path ?? preferredBasePath + ".yaml";
    errors.push({
      path: errorPath,
      message: `${path.basename(errorPath)}: ${err.message}`,
      layer,
    });
    return merged;
  }

  if (data === null) {
    if (options.warnOnMissing) {
      warnings.push(`${layer} config not found (tried .yaml, .yml, and .json), falling back to previously merged defaults`);
    }
    return merged;
  }

  // Deprecated `strategy: "github-first"` alias: normalized to
  // "tracker-first" BEFORE this layer's FileConfigSchema validation (the enum
  // only accepts the canonical value, else the whole layer drops as invalid).
  if (data.strategy === "github-first") {
    warnings.push(
      `strategy: "github-first" is a deprecated alias for "tracker-first" (issue #1408). ` +
      `Update ${path.basename(filePath)} to use "tracker-first"; the alias will be removed in a future version.`
    );
    data = { ...data, strategy: "tracker-first" };
  }

  // gates.primeSharedPrefix is not a knob (priming is always on). The schema is
  // strictObject, so strip this stale key before validation (with a deprecation
  // warning) rather than let it drop the whole gates layer.
  if (data?.gates && Object.prototype.hasOwnProperty.call(data.gates, "primeSharedPrefix")) {
    warnings.push(
      `gates.primeSharedPrefix is removed (#1462): cache priming is now mandatory, not configurable. ` +
      `Remove it from ${path.basename(filePath)}; the key is ignored.`
    );
    const { primeSharedPrefix: _removed, ...gatesRest } = data.gates;
    data = { ...data, gates: gatesRest };
  }

  // Validate the file's structure before merging: a schema violation ANYWHERE
  // in this layer drops the WHOLE layer (errors populated, `merged` returned
  // unchanged) rather than merging the file's other valid keys. errors[].message
  // names the offending path/field so the failure is actionable.
  const validation = FileConfigSchema.safeParse(data);
  if (!validation.success) {
    // Surface a visible WARNING (not just the structured error) so the
    // whole-layer drop is never silent: many consumers never read
    // `errors`, so a schema-rejected layer would vanish without a trace.
    const offendingKeys = validation.error.issues
      .flatMap((i) => {
        if (i.code === "unrecognized_keys" && Array.isArray(i.keys) && i.keys.length) {
          const prefix = i.path.length ? `${i.path.join(".")}.` : "";
          return i.keys.map((k) => `${prefix}${k}`);
        }
        return i.path.length ? [i.path.join(".")] : [];
      });
    // Only append the raw-key migration hint when the offending keys actually
    // include the raw mandatoryAngles/excludeAngles names, so an unrelated
    // failure does not get misleading guidance.
    const hasRawGateKey = offendingKeys.some((k) => /mandatoryAngles|excludeAngles/.test(k));
    const migrationHint = hasRawGateKey
      ? ` Migrate raw gates.<gate>.mandatoryAngles/excludeAngles to the canonical angle-entry shape ` +
        `(gates.<gate>.angles with { name, mandatory: true } / { name, enabled: false }).`
      : ` Fix or remove the offending key(s) to restore this config layer.`;
    warnings.push(
      `${path.basename(filePath)}: config layer rejected by schema — the whole layer was dropped, so this layer's overrides are not applied (previously merged layers remain in effect). ` +
      `Offending key(s): ${offendingKeys.length ? offendingKeys.join(", ") : "(unknown)"}.` +
      migrationHint
    );
    errors.push({
      path: filePath,
      message: `${path.basename(filePath)}: Schema validation failed: ${validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      layer,
    });
    return merged;
  }

  return mergeConfigLayers(merged, data);
}

// ============================================================================
// Loader
// ============================================================================

/**
 * @typedef {object} LoadResult
 * @property {DevLoopConfig} config
 * @property {string[]} warnings
 * @property {ConfigLoadError[]} errors
 */

/**
 * @typedef {object} LoadOptions
 * @property {string} [repoRoot] - Path to repository root (default: process.cwd())
 * @property {string} [extensionDefaultsBasePath] - Base path (no extension) to extension defaults; overrides the package-relative default
 */

/**
 * Load the dev-loop configuration with full precedence:
 *   repo .devloops > repo .pi/dev-loop/defaults.(yaml|yml|json) > extension defaults > built-in defaults
 *
 * Never throws for config-related problems.
 * Returns extension defaults (with built-in defaults as the final fallback) even when all repo-local config files are missing or broken.
 *
 * @param {LoadOptions} [options]
 * @returns {Promise<LoadResult>}
 */
export async function loadDevLoopConfig(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const configDir = path.join(repoRoot, ".pi", "dev-loop");
  const defaultsPath = path.join(configDir, "defaults");
  const devloopsPath = path.join(repoRoot, ".devloops");

  /** @type {string[]} */
  const warnings = [];
  /** @type {ConfigLoadError[]} */
  const errors = [];

  let merged = { ...BUILT_IN_DEFAULTS };
  merged = await applyLayer(merged, resolveExtensionDefaultsPath(options), "extensionDefaults", warnings, errors, { warnOnMissing: true });


  merged = await applyLayer(merged, defaultsPath, "defaults", warnings, errors, {
    warnOnMissing: true,
  });

  // .devloops (primary override) existence: only ENOENT means genuinely absent.
  // Any other error (EACCES/EISDIR) means it exists but is unreadable, so
  // select the .devloops path and let applyLayer record the structured error.
  let primaryExists = false;
  for (const ext of ["", ".yaml", ".yml", ".json"]) {
    try {
      await readFile(devloopsPath + ext, "utf8");
      primaryExists = true;
      break;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        primaryExists = true;
        break;
      }
      // ENOENT — genuinely absent, try next extension
    }
  }

  if (primaryExists) {
    merged = await applyLayer(merged, devloopsPath, "devloops", warnings, errors);
  }

  // Validate final merged config
  const result = DevLoopConfigSchema.safeParse(merged);
  if (!result.success) {
    errors.push({
      path: "<merged>",
      message: `Config validation failed: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      layer: "merged",
    });
    // Return merged as-is — caller gets validation errors but still has config with all layers applied
    return { config: /** @type {*} */ (merged), warnings, errors };
  }

  return { config: result.data, warnings, errors };
}

/**
 * Resolve the conductor model override from the merged config, or null when
 * unset (caller falls back to its own default).
 * @param {DevLoopConfig} config
 * @returns {string|null}
 */
export function resolveConductorModel(config) {
  const raw = config?.models?.conductor;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

/**
 * Resolve the autonomy stop-at list (gates that require operator confirmation)
 * from the merged config. Defaults to `["merge"]` when unset.
 * @param {DevLoopConfig} config
 * @returns {string[]}
 */
export function resolveAutonomyStopAt(config) {
  const base = (config?.autonomy?.stopAt && Array.isArray(config.autonomy.stopAt))
    ? [...config.autonomy.stopAt]
    : ["merge"];
  // Fail closed: humanMergeOnly forces a human stop at merge regardless of
  // what stopAt is configured (even an explicit []).
  if (resolveHumanMergeOnly(config) && !base.includes("merge")) {
    base.push("merge");
  }
  return base;
}

/**
 * True when `autonomy.humanMergeOnly` forces merge to be a human-only action
 * (the agent never merges; per-run authorization is ignored). Defaults false.
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveHumanMergeOnly(config) {
  return config?.autonomy?.humanMergeOnly === true;
}

/**
 * Authoritative gate: resolve the effective merge authorization for the agent.
 *
 * This is the single chokepoint that decides whether the agent is cleared to
 * run `gh pr merge`. When `humanMergeOnly` is set on the repo config, this
 * ALWAYS returns false — the per-run `mergeAuthorized` flag (envelope flag or
 * explicit "merge" instruction) cannot override the repo invariant. Fails
 * closed: a non-boolean `mergeAuthorized` is treated as not authorized.
 *
 * @param {boolean} mergeAuthorized per-run authorization signal
 * @param {DevLoopConfig} config merged dev-loop config
 * @returns {boolean}
 */
export function resolveEffectiveMergeAuthorized(mergeAuthorized, config) {
  if (resolveHumanMergeOnly(config)) return false;
  return mergeAuthorized === true;
}

/**
 * Authoritative gate for callers that load the config themselves and hold its
 * `{ config, errors }` load result. FAILS CLOSED on any config load/validation
 * error: `loadDevLoopConfig` never throws (it returns an `errors` array), so a
 * caller must not assume "no exception" means "config is safe". If the config
 * could not be loaded/validated, the `.devloops` file declaring `humanMergeOnly`
 * may be the very one that failed — so merge authorization is denied rather than
 * silently granted from a fallback config that lacks the invariant.
 *
 * @param {boolean} mergeAuthorized per-run authorization signal
 * @param {{ config?: DevLoopConfig, errors?: Array<unknown> }} loadResult result of `loadDevLoopConfig`
 * @returns {boolean}
 */
export function resolveEffectiveMergeAuthorizedFromLoad(mergeAuthorized, loadResult) {
  const errors = loadResult?.errors ?? [];
  if (errors.length > 0) return false;
  return resolveEffectiveMergeAuthorized(mergeAuthorized, loadResult?.config);
}

const DEFAULT_REFINEMENT_CONFIG = BUILT_IN_DEFAULTS.refinement;
const DEFAULT_WORKFLOW_CONFIG = BUILT_IN_DEFAULTS.workflow;

/**
 * Resolve one refinement config value, or its built-in default.
 * @param {DevLoopConfig} config
 * @param {"fanOut"|"mode"|"roles"|"maxCopilotRounds"|"stopOnLowSignal"|"lowSignalRoundThreshold"|"lowSignalMaxComments"} key
 * @returns {number|"parallel"|"sequential"|string[]|boolean|null}
 */
export function resolveRefinementConfig(config, key) {
  if (key === "roles") {
    return config?.refinement?.roles && Array.isArray(config.refinement.roles)
      ? [...config.refinement.roles]
      : null;
  }

  if (key === "fanOut") {
    return config?.refinement?.fanOut ?? DEFAULT_REFINEMENT_CONFIG.fanOut;
  }

  if (key === "mode") {
    return config?.refinement?.mode ?? DEFAULT_REFINEMENT_CONFIG.mode;
  }

  if (key === "maxCopilotRounds") {
    return config?.refinement?.maxCopilotRounds ?? DEFAULT_REFINEMENT_CONFIG.maxCopilotRounds;
  }

  if (key === "stopOnLowSignal") {
    return config?.refinement?.lowSignal?.enabled ?? DEFAULT_REFINEMENT_CONFIG.lowSignal.enabled;
  }

  if (key === "lowSignalRoundThreshold") {
    return config?.refinement?.lowSignal?.roundThreshold ?? DEFAULT_REFINEMENT_CONFIG.lowSignal.roundThreshold;
  }

  if (key === "lowSignalMaxComments") {
    return config?.refinement?.lowSignal?.maxComments ?? DEFAULT_REFINEMENT_CONFIG.lowSignal.maxComments;
  }

  throw new Error(`Unknown refinement config key: ${key}`);
}

/**
 * Resolve the full refinement config with built-in defaults (fanOut 3, mode
 * parallel, roles null, maxCopilotRounds 5, low-signal off/3/2), plus the
 * resolved preApproval requireCi.
 * @param {DevLoopConfig} config
 * @returns {{ fanOut: number, mode: "parallel"|"sequential", roles: string[]|null, maxCopilotRounds: number, stopOnLowSignal: boolean, lowSignalRoundThreshold: number, lowSignalMaxComments: number }}
 */
export function resolveRefinement(config) {
  const fanOut = /** @type {number} */ (resolveRefinementConfig(config, "fanOut"));
  const mode = /** @type {"parallel"|"sequential"} */ (resolveRefinementConfig(config, "mode"));
  const roles = /** @type {string[]|null} */ (resolveRefinementConfig(config, "roles"));
  const maxCopilotRounds = /** @type {number} */ (resolveRefinementConfig(config, "maxCopilotRounds"));
  const stopOnLowSignal = /** @type {boolean} */ (resolveRefinementConfig(config, "stopOnLowSignal"));
  const lowSignalRoundThreshold = /** @type {number} */ (resolveRefinementConfig(config, "lowSignalRoundThreshold"));
  const lowSignalMaxComments = /** @type {number} */ (resolveRefinementConfig(config, "lowSignalMaxComments"));
  // Centralize the pre-approval CI opt-out here so every caller building
  // its refinement config from resolveRefinement honors
  // gates.preApproval.requireCi: false.
  const preApprovalRequireCi = resolveGateConfig(config, "preApproval").requireCi;
  return { fanOut, mode, roles, maxCopilotRounds, stopOnLowSignal, lowSignalRoundThreshold, lowSignalMaxComments, preApprovalRequireCi };
}

/**
 * Resolve and validate ONE gate's raw `blockCleanOnFindingSeverities` value
 * against the schema's severity vocabulary, returning the normalized/deduped
 * list (or the ["high"] default when the key is absent). Shared by
 * resolveGateConfig, which calls this for every GateConfig-typed gate on
 * every invocation (see that function's @throws doc) so an invalid list on
 * any gate refuses eagerly, not only when that specific gate is requested.
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate
 * @returns {string[]}
 * @throws {Error} when `gate`'s PRESENT `blockCleanOnFindingSeverities` key
 *   is schema-invalid (non-array, empty, or containing an out-of-vocabulary
 *   entry).
 */
function resolveBlockingSeverities(config, gate) {
  const rawBlocking = config?.gates?.[gate]?.blockCleanOnFindingSeverities;
  if (rawBlocking === undefined) return ["high"];
  if (!Array.isArray(rawBlocking)) {
    throw new Error(
      `Config validation failed: gates.${gate}.blockCleanOnFindingSeverities must be an array ` +
      `of defect severities, got ${formatConfigValue(rawBlocking)}. ` +
      `Fix the config before gate operations can proceed.`
    );
  }
  if (rawBlocking.length === 0) {
    throw new Error(
      `Config validation failed: gates.${gate}.blockCleanOnFindingSeverities is empty; ` +
      `the schema requires at least one blocking severity, and an empty list would make the gate block on nothing. ` +
      `Fix the config before gate operations can proceed.`
    );
  }
  const invalid = rawBlocking.filter((s) => typeof s !== "string" || !BLOCKING_SEVERITY_SPELLING_SET.has(s));
  if (invalid.length > 0) {
    throw new Error(
      `Config validation failed: gates.${gate}.blockCleanOnFindingSeverities contains ` +
      `value(s) outside the schema's severity vocabulary: ${invalid.map((s) => formatConfigValue(s)).join(", ")}. ` +
      `Allowed (exact spellings): ${BLOCKING_SEVERITY_SPELLINGS.join(", ")} ` +
      `(the legacy spellings normalize to high/medium/low). ` +
      `Fix the config before gate operations can proceed.`
    );
  }
  return [...new Set(rawBlocking.map((s) => normalizeSeverity(s)))];
}

/**
 * Resolve one gate configuration object from the merged config.
 *
 * The returned shape is the STABLE, resolved view every other angle resolver
 * builds on: `mandatoryAngles`/`excludeAngles`/`dynamicAngles`/`additiveAngles`
 * are derived here from the unified `gates.<gate>.angles` array (`mandatory` /
 * `enabled: false` per entry) and `gates.<gate>.dynamic`, so downstream
 * consumers keep reading the flat field names. `angles: null` means the
 * key was absent (fall back to skill defaults); an empty array is a real
 * configured "no angles".
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate
 * @returns {{ angles: string[]|null, excludeAngles: string[], mandatoryAngles: string[], required: boolean, requireCi: boolean, blockCleanOnFindingSeverities: string[], dynamicAngles: boolean, additiveAngles: boolean, mediumFixWindow: number, tiers: Array<{name: string, match: object, angles: string[]}> }}
 * @throws {Error} when ANY gate's (not only the requested one's) PRESENT
 *   `blockCleanOnFindingSeverities` is schema-invalid (non-array, empty, or an
 *   out-of-vocabulary entry). Validated EAGERLY across all three gates on every
 *   call so a single-gate consumer can never produce a side effect while a
 *   DIFFERENT gate's severity list is invalid. Dispatch-ergonomics keys degrade
 *   quietly instead (resolveMaxAnglesPerGroup/resolveFanoutGroups); the key that
 *   decides what blocks a clean verdict refuses, fail-closed. An ABSENT key
 *   falls back to the default.
 */
export function resolveGateConfig(config, gate) {
  const gateConfig = config?.gates?.[gate];
  // Eagerly validate every gate's blockCleanOnFindingSeverities (not just the
  // requested one) so an invalid list on ANY gate refuses up front. See @throws.
  let blockCleanOnFindingSeverities = ["high"];
  for (const g of GATE_KEYS_WITH_BLOCKING_SEVERITIES) {
    const resolved = resolveBlockingSeverities(config, g);
    if (g === gate) blockCleanOnFindingSeverities = resolved;
  }
  const entries = normalizeAngleEntries(gateConfig?.angles);
  // An explicitly-empty array is a real configured "no angles" — distinct from
  // the key being absent (angles: null → fall back to skill defaults).
  const hasAngles = Array.isArray(gateConfig?.angles);
  return {
    angles: hasAngles ? entries.filter((e) => e.enabled !== false).map((e) => e.name) : null,
    excludeAngles: entries.filter((e) => e.enabled === false).map((e) => e.name),
    mandatoryAngles: entries.filter((e) => e.enabled !== false && e.mandatory === true).map((e) => e.name),
    required: gateConfig?.required ?? true,
    requireCi: gateConfig?.requireCi ?? true,
    dynamicAngles: gateConfig?.dynamic?.subtractive ?? true,
    additiveAngles: gateConfig?.dynamic?.additive ?? false,
    // Normalized + deduped at the resolve boundary so every consumer sees
    // canonical spellings only (anything outside the vocabulary already threw).
    blockCleanOnFindingSeverities,
    // mediumFixWindow wins; worthFixingNowFixWindow is the deprecated alias,
    // still honored so an unmigrated config keeps its window.
    mediumFixWindow: gateConfig?.mediumFixWindow ?? gateConfig?.worthFixingNowFixWindow ?? 3,
    tiers: gateConfig?.tiers ?? [],
  };
}

/**
 * Resolve whether fan-out/fan-in evidence is required for a gate verdict.
 * Default-on (opt-out): ON unless `gates.requireFanoutEvidence` is false. The
 * `!== false` test (not `=== true`) keeps the opt-out robust for
 * programmatically-built configs that bypass schema defaulting. See
 * skills/docs/gate-review-sub-loop-contract.md.
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveRequireFanoutEvidence(config) {
  return config?.gates?.requireFanoutEvidence !== false;
}

/**
 * ABSOLUTE minimum distinct reviewer count for a fanout_fanin ledger to
 * satisfy requireFanoutProvenance; the effective read-time floor scales to
 * max(this, the ledger's fresh-angle count). A floor of 2 is the smallest
 * count that is not a single agent; it raises the bar but does not prove
 * independence (provenance is self-reported — see the honest caveat in
 * skills/docs/gate-review-sub-loop-contract.md).
 */
export const FANOUT_PROVENANCE_MIN_REVIEWERS = 2;

/**
 * Resolve whether fan-out provenance is required for a fanout_fanin verdict.
 * Default-OFF (opt-in): a strict `=== true` test keeps behavior byte-identical
 * unless a repo sets `gates.requireFanoutProvenance: true`. Layered on top of
 * fan-out evidence enforcement. See skills/docs/gate-review-sub-loop-contract.md.
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveRequireFanoutProvenance(config) {
  return config?.gates?.requireFanoutProvenance === true;
}

/**
 * Resolve whether a fan-out provenance entry naming an angle outside the
 * gate's configured pool should FAIL (default) or only WARN.
 *
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveRejectForeignAngles(config) {
  return config?.gates?.rejectForeignAngles !== false;
}

/**
 * Resolve whether the consolidated gate findings should ALSO post as a second
 * marker-tagged PR comment. False unless `gates.postFindingsComments === true`
 * (opt-in duplication; the verdict review is already the findings surface). The
 * disposition ledger is written regardless.
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveGatePostFindingsComments(config) {
  return config?.gates?.postFindingsComments === true;
}

/**
 * Resolve local implementation light mode: null when disabled (absent or
 * enabled=false), else { maxFiles, maxLines }.
 * @param {DevLoopConfig} config
 * @returns {{ maxFiles: number, maxLines: number } | null}
 */
export function resolveLightMode(config) {
  const cfg = config?.localImplementation?.lightMode;
  if (!cfg || cfg.enabled === false) return null;
  return {
    maxFiles: typeof cfg.maxFiles === "number" && Number.isFinite(cfg.maxFiles) && cfg.maxFiles > 0
      ? cfg.maxFiles
      : 3,
    maxLines: typeof cfg.maxLines === "number" && Number.isFinite(cfg.maxLines) && cfg.maxLines > 0
      ? cfg.maxLines
      : 200,
  };
}

/**
 * Resolve the issue-less PR-first any-scope opt-in. True only when
 * `localImplementation.issueless` is exactly `true`; absent/false/malformed
 * resolve to false (fail closed).
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveIssuelessEnabled(config) {
  return config?.localImplementation?.issueless === true;
}

/**
 * Resolve the effective Copilot review round cap for a PR. Full PRs use
 * `refinement.maxCopilotRounds` (default 5); light-dispatched PRs compose as
 * min(lightMode.maxCopilotRounds ?? 1, refinement.maxCopilotRounds), so
 * `refinement.maxCopilotRounds: 0` disables Copilot rounds everywhere.
 * @param {DevLoopConfig} config
 * @param {{ lightweight?: boolean }} [options]
 * @returns {number}
 */
export function resolveEffectiveCopilotRoundCap(config, { lightweight = false } = {}) {
  // Clamp here, not only in the zod schema: programmatically-built config
  // objects bypass schema defaulting/validation, and a negative cap must never
  // reach round-cap comparisons.
  const maxCopilotRounds = Math.max(0, /** @type {number} */ (resolveRefinementConfig(config, "maxCopilotRounds")));
  if (!lightweight) return maxCopilotRounds;
  const lightMaxRounds = config?.localImplementation?.lightMode?.maxCopilotRounds;
  const effectiveLightCap = typeof lightMaxRounds === "number" && Number.isFinite(lightMaxRounds)
    ? Math.max(0, lightMaxRounds)
    : 1;
  return Math.min(effectiveLightCap, maxCopilotRounds);
}

/** Label that forces full fan-out regardless of change size. */
export const GATE_FULL_LABEL = "gate:full";

/**
 * Decide whether a gate runs as a single-agent inline check or full fan-out,
 * from light-mode config + authoritative PR facts.
 *
 * Precedence (first match wins):
 *   1. `gate:full` label present            → full_fanout
 *   2. light mode disabled / no threshold    → full_fanout
 *   3. scope over threshold (files OR lines) → full_fanout
 *   4. inline finding severity in the gate's blockCleanOnFindingSeverities set
 *                                            → full_fanout (escalated)
 *   5. otherwise                             → inline
 *
 * Pre-check omits `inlineFindingSeverities` (decides whether to run the inline
 * pass at all); escalation passes the inline pass's severities. Absent/partial
 * `facts.scope` fails safe to full_fanout (missing counts → Infinity).
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @param {object} facts
 * @param {{ filesChanged?: number, linesChanged?: number }} [facts.scope] PR scope; absent/partial fields fail safe to full_fanout
 * @param {boolean} [facts.hasFullLabel]           `gate:full` label present on the PR
 * @param {string[]} [facts.inlineFindingSeverities] severities from the inline pass (escalation phase)
 * @returns {{ mode: "inline"|"full_fanout", reason: string, threshold: {maxFiles:number,maxLines:number}|null }}
 */
export function resolveGateDispatchMode(config, gate, { scope, hasFullLabel = false, inlineFindingSeverities } = {}) {
  if (hasFullLabel) {
    return { mode: "full_fanout", reason: "gate_full_label", threshold: null };
  }
  const threshold = resolveLightMode(config);
  if (!threshold) {
    return { mode: "full_fanout", reason: "light_mode_disabled", threshold: null };
  }
  const filesChanged = Number(scope?.filesChanged ?? Infinity);
  const linesChanged = Number(scope?.linesChanged ?? Infinity);
  if (filesChanged > threshold.maxFiles || linesChanged > threshold.maxLines) {
    return { mode: "full_fanout", reason: "over_threshold", threshold };
  }
  if (Array.isArray(inlineFindingSeverities) && inlineFindingSeverities.length > 0) {
    // Both sides normalize legacy spellings so a "defer" finding still
    // compares against a "low" blocking entry and vice versa.
    const blocking = new Set(resolveGateConfig(config, gate).blockCleanOnFindingSeverities.map((s) => normalizeSeverity(s)));
    if (inlineFindingSeverities.some((s) => blocking.has(normalizeSeverity(s)))) {
      return { mode: "full_fanout", reason: "escalated", threshold };
    }
  }
  return { mode: "inline", reason: "under_threshold", threshold };
}

/**
 * Default auto-chunk size for ungrouped angles. Mirrors the
 * zod default on `gates.fanout.maxAnglesPerGroup`.
 */
export const DEFAULT_MAX_ANGLES_PER_GROUP = 3;

/**
 * Default concurrent-dispatch-unit cap per wave. Mirrors the
 * zod default on `gates.fanout.maxConcurrent`; consumed by
 * `scheduleFanoutWaves` (@dev-loops/core/loop/gate-fanin).
 */
export const DEFAULT_FANOUT_MAX_CONCURRENT = 4;
export const DEFAULT_FANOUT_SEQUENTIAL = false;

/**
 * Resolve `gates.fanout.sequential` (default false). Serial one-at-a-time
 * dispatch of heavy reviewers so each writes its evidence before the next
 * starts. Separate from `maxConcurrent`. The shipped default stays false for
 * cross-harness non-regression.
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveFanoutSequential(config) {
  const s = config?.gates?.fanout?.sequential;
  return s === true;
}

/**
 * Resolve the effective fan-out concurrency (dispatch units per wave): 1 when
 * `gates.fanout.sequential` is set, else `resolveFanoutMaxConcurrent`.
 * @param {DevLoopConfig} config
 * @returns {number}
 */
export function resolveFanoutEffectiveConcurrency(config) {
  if (resolveFanoutSequential(config)) return 1;
  return resolveFanoutMaxConcurrent(config);
}

/**
 * Resolve `gates.fanout.maxAnglesPerGroup` (default 3, min 1). Defensive,
 * independent of zod: a non-integer or sub-1 value falls back to the default so
 * a malformed raw merged config (which loadDevLoopConfig still returns) never
 * crashes Phase 2.
 * @param {DevLoopConfig} config
 * @returns {number}
 */
export function resolveMaxAnglesPerGroup(config) {
  const n = config?.gates?.fanout?.maxAnglesPerGroup;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return DEFAULT_MAX_ANGLES_PER_GROUP;
  return n;
}

/**
 * Resolve `gates.fanout.maxConcurrent` (default 4, min 1). The
 * max dispatch units (groups) the conductor dispatches concurrently per wave.
 * Defensive, independent of zod (same rationale as resolveMaxAnglesPerGroup).
 * @param {DevLoopConfig} config
 * @returns {number}
 */
export function resolveFanoutMaxConcurrent(config) {
  const m = config?.gates?.fanout?.maxConcurrent;
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1) return DEFAULT_FANOUT_MAX_CONCURRENT;
  return m;
}

/**
 * Resolve grouped fan-out dispatch: map a round's resolved angles onto the
 * dispatch units it dispatches.
 *
 * Precedence (first match wins):
 *   1. `gates.fanout.mode === "per-angle"` → bypasses configured groups; one
 *      singleton unit per angle (NOT equivalent to maxAnglesPerGroup: 1 when
 *      configured groups match)
 *   2. default `grouped` → configured `gates.fanout.groups` match first, then
 *      leftover ungrouped angles auto-chunk into units of ≤ `maxAnglesPerGroup`
 *
 * `gate:full` (`options.fullLabel`) does NOT restore per-angle dispatch: it
 * forces the full angle set upstream (resolveGateTier) and dispatches GROUPED
 * here (ADR 0048); `fullLabel` is a no-op, accepted for API stability.
 * Configured groups are NEVER split by `maxAnglesPerGroup` (only the leftover
 * pool is chunked). An unmatched group is dropped, never emitted empty.
 *
 * Defensive, independent of zod: a malformed `gates.fanout.groups` entry (from
 * a raw merged config that failed validation on any layer) is dropped (its
 * angles fall to the leftover pool), never thrown — this resolver degrades to a
 * smaller grouping table rather than crash Phase 2. `resolvedAngles` is
 * deduplicated up front so a duplicate never mints two units sharing one name.
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate unused today — fan-out grouping
 *   is a global policy, accepted for symmetry with the other resolvers.
 * @param {string[]} resolvedAngles this round's resolved angle names
 * @param {{ fullLabel?: boolean }} [options] — retained no-op (see above).
 * @returns {{ name: string, angles: string[] }[]}
 */
export function resolveFanoutGroups(config, gate, resolvedAngles, { fullLabel = false } = {}) {
  const angles = Array.isArray(resolvedAngles)
    ? [...new Set(resolvedAngles.filter((a) => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()))]
    : [];
  const perAngleGroups = () => angles.map((name) => ({ name, angles: [name] }));
  // per-angle: bypass configured groups, one singleton unit per angle. gate:full
  // does not take this branch (ADR 0048): fullLabel is a no-op here.
  const fanout = config?.gates?.fanout ?? {};
  if (fanout.mode === "per-angle") return perAngleGroups();
  const angleSet = new Set(angles);
  const rawGroups = Array.isArray(fanout.groups) ? fanout.groups : [];
  const configuredGroups = [];
  const seenGroupNames = new Set();
  for (const group of rawGroups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (name.length === 0 || seenGroupNames.has(name)) continue;
    const groupAngles = Array.isArray(group.angles)
      ? [...new Set(group.angles.filter((a) => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()))]
      : [];
    if (groupAngles.length === 0) continue;
    seenGroupNames.add(name);
    configuredGroups.push({ name, angles: groupAngles });
  }
  const grouped = new Set();
  const result = [];
  for (const group of configuredGroups) {
    const members = group.angles.filter((a) => angleSet.has(a) && !grouped.has(a));
    if (members.length === 0) continue;
    for (const a of members) grouped.add(a);
    result.push({ name: group.name, angles: members });
  }
  // Leftover ungrouped angles auto-chunk into units of ≤ maxAnglesPerGroup;
  // configured groups (matched above) are never split by this knob.
  // Deterministic input order + stable unit names.
  const usedNames = new Set(result.map((g) => g.name));
  const leftover = angles.filter((name) => !grouped.has(name));
  const maxAnglesPerGroup = resolveMaxAnglesPerGroup(config);
  for (let i = 0; i < leftover.length; i += maxAnglesPerGroup) {
    const chunk = leftover.slice(i, i + maxAnglesPerGroup);
    const unitName = stableAutoChunkUnitName(chunk, usedNames);
    usedNames.add(unitName);
    result.push({ name: unitName, angles: chunk });
  }
  return result;
}

/**
 * Deterministic, stable dispatch-unit name for an auto-chunked leftover unit.
 * A single-angle chunk uses the angle name (disambiguated to `angle:<name>` on
 * collision); a multi-angle chunk is `group:<a>+<b>+<c>` from its ordered
 * members (with a `#N` suffix on collision). Names key reviewer-sentinel scopes
 * and provenance, so they must be unique. Pure.
 * @param {string[]} chunk — non-empty, deterministically ordered
 * @param {Set<string>} usedNames — already-emitted unit names (mutated by caller)
 * @returns {string}
 */
function stableAutoChunkUnitName(chunk, usedNames) {
  if (chunk.length === 1) {
    const name = chunk[0];
    return usedNames.has(name) ? `angle:${name}` : name;
  }
  const base = `group:${chunk.join("+")}`;
  if (!usedNames.has(base)) return base;
  let k = 2;
  while (usedNames.has(`${base}#${k}`)) k++;
  return `${base}#${k}`;
}

/**
 * Resolve review angles for a gate: `mandatoryAngles ∪ angles − disabled`,
 * deduplicated. Returns null when the gate has no configured `angles` at all
 * (caller falls back to skill defaults); an explicitly-empty `angles: []`
 * returns `[]`.
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @returns {string[]|null}
 */
export function resolveGateAngles(config, gate) {
  const gateConfig = resolveGateConfig(config, gate);
  if (gateConfig.angles === null && gateConfig.mandatoryAngles.length === 0) return null;
  // gateConfig.angles is already exclude-filtered; the excludeAngles filter
  // below is a defensive no-op for hand-built config objects that set
  // excludeAngles/angles independently.
  const excluded = new Set(gateConfig.excludeAngles);
  const merged = [...new Set([...gateConfig.mandatoryAngles, ...(gateConfig.angles ?? [])])];
  return merged.filter(a => !excluded.has(a));
}

/**
 * Resolve the global lens catalog for additive angle selection: the explicit
 * `gates.anglePool` override when configured, else the union of the persona
 * registry's angle names and every angle configured across this config's own
 * gates. The persona registry alone omits pool angles with no dedicated
 * persona (e.g. ci-guard, link-check).
 * @param {DevLoopConfig} config
 * @returns {string[]}
 */
export function resolveAnglePool(config) {
  const explicit = config?.gates?.anglePool;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return [...new Set(explicit.map(a => (typeof a === "string" ? a.trim() : "")).filter(a => a.length > 0))];
  }
  const configured = ["draft", "preApproval", "spike"].flatMap((gate) => {
    const gateConfig = resolveGateConfig(config, gate);
    return [...(gateConfig.angles ?? []), ...gateConfig.mandatoryAngles];
  });
  return [...new Set([...Object.keys(BUILTIN_PERSONAS), ...configured])];
}

/**
 * Resolve a gate's ANGLE ENFORCEMENT CONTRACT: the mandatory angles a
 * fanout_fanin verdict must cover and the pool its recorded angles must stay
 * within. Single source of truth for every angle-coverage consumer.
 *
 * `mandatoryAngles` is filtered through `excludeAngles` so excluding a
 * mandatory angle cannot deadlock every fanout write (missing-mandatory if
 * omitted, foreign if recorded). `pool` is resolveGateAngles, widened to the
 * global catalog (resolveAnglePool) when `additiveAngles` is on, with
 * excludeAngles still a hard ceiling; a null pool skips the foreign check.
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate
 * @returns {{ mandatoryAngles: string[], pool: string[]|null }}
 */
export function resolveGateAngleContract(config, gate) {
  const gateConfig = resolveGateConfig(config, gate);
  const excluded = new Set(gateConfig.excludeAngles);
  const mandatoryAngles = gateConfig.mandatoryAngles.filter((a) => !excluded.has(a));
  let pool = resolveGateAngles(config, gate);
  if (gateConfig.additiveAngles && pool !== null) {
    pool = [...new Set([...pool, ...resolveAnglePool(config)])].filter((a) => !excluded.has(a));
  }
  return { mandatoryAngles, pool };
}

/**
 * Resolve the diff-class angle tier for a gate from its ordered
 * `gates.<gate>.tiers` (first-match-wins). Pure; the single source of truth for
 * tier selection, consulted at the top of resolveGateAnglesDynamic before any
 * dynamic reduction.
 *
 * FAIL CLOSED at every uncertain step: `gate:full`, no tiers, an
 * unavailable/malformed scope, a changed dev-loop config-source file, or an
 * unclassifiable file all resolve to `tier: null`. A matched tier's angle set
 * is validated against the gate's pool — ANY tier angle outside a non-null pool
 * voids the WHOLE match (a typo'd tier angle is caught here, not by silently
 * dropping reviewers at gate time).
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate
 * @param {object} facts
 * @param {string[]} [facts.changedFiles] — repo-relative changed file paths for this diff
 * @param {number} [facts.filesChanged] — count of changed files
 * @param {number} [facts.linesChanged] — count of changed lines (added + deleted)
 * @param {boolean} [facts.hasFullLabel] — `gate:full` label present on the PR
 * @returns {{ tier: string|null, angles: string[]|null, reason: string }}
 */
export function resolveGateTier(config, gate, { changedFiles, filesChanged, linesChanged, hasFullLabel = false } = {}) {
  if (hasFullLabel) {
    return { tier: null, angles: null, reason: "gate_full_label" };
  }
  const tiers = resolveGateConfig(config, gate).tiers;
  if (tiers.length === 0) {
    return { tier: null, angles: null, reason: "no_tiers_configured" };
  }
  if (
    !Array.isArray(changedFiles) || changedFiles.length === 0 ||
    !Number.isFinite(filesChanged) || !Number.isFinite(linesChanged)
  ) {
    return { tier: null, angles: null, reason: "scope_unavailable" };
  }
  if (changedFiles.some((f) => isDevLoopConfigSourcePath(f))) {
    return { tier: null, angles: null, reason: "config_source_delta" };
  }
  const kinds = changedFiles.map((f) => classifyFile(f));
  if (kinds.some((k) => k === "unknown")) {
    return { tier: null, angles: null, reason: "unclassifiable_file" };
  }
  const matched = tiers.find((t) => {
    const match = t.match ?? {};
    if (Array.isArray(match.kinds) && !kinds.every((k) => match.kinds.includes(k))) return false;
    if (typeof match.maxFiles === "number" && filesChanged > match.maxFiles) return false;
    if (typeof match.maxLines === "number" && linesChanged > match.maxLines) return false;
    return true;
  });
  if (!matched) {
    return { tier: null, angles: null, reason: "no_tier_match" };
  }
  const { mandatoryAngles, pool } = resolveGateAngleContract(config, gate);
  if (pool !== null && matched.angles.some((a) => !pool.includes(a))) {
    return { tier: null, angles: null, reason: "angle_outside_pool" };
  }
  return { tier: matched.name, angles: [...new Set([...mandatoryAngles, ...matched.angles])], reason: "tier_match" };
}

/**
 * Resolve gate angles dynamically when `dynamicAngles` is enabled.
 *
 * Diff analysis (../analysis/*) filters the configured angle list to angles
 * relevant to the change set. When `dynamic.subtractive: false` or no
 * diff is given, returns the full configured list. When `additiveAngles` is on,
 * catalog angles from resolveAnglePool may also be added, with
 * `excludeAngles` a hard ceiling.
 *
 * Diff-class tiers (resolveGateTier) are consulted FIRST: a tier match returns
 * that tier's angle set (unioned with mandatory) directly and skips the
 * subtractive/additive machinery.
 *
 * @param {import("./types.js").DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @param {object} [options]
 * @param {{ nameStatusOutput: string, diffOutput?: string }} [options.diff]
 * @param {boolean} [options.hasFullLabel] — `gate:full` label present on the PR (bypasses tier resolution)
 * @returns {{ recommendedAngles: string[] | null, skippedAngles: string[], reasons: Record<string,string>, fallbackToAll: boolean, dynamicAnglesActive: boolean, addedAngles: string[], addedReasons: Record<string,string> }}
 */
export async function resolveGateAnglesDynamic(config, gate, { diff, hasFullLabel = false } = {}) {
  // Tier scope facts: changedFiles/filesChanged from T0, linesChanged from T1's
  // real added+deleted count (analyzeDiff's inferred-category path reports a
  // fake 0 for an unambiguous docs-only diff — see analyzeT1/analyzeDiff).
  let changedFiles;
  let filesChanged;
  let linesChanged;
  let prosePresent = false;
  if (diff) {
    const { analyzeT0, analyzeT1 } = await import("../analysis/diff-analyzer.mjs");
    const t0 = analyzeT0(diff.nameStatusOutput);
    changedFiles = t0.files;
    filesChanged = changedFiles.length;
    prosePresent = t0.prosePresent; // gate deslop on the prose surface
    if (diff.diffOutput) {
      const lineStats = analyzeT1(diff.diffOutput, t0).lineStats;
      linesChanged = lineStats.added + lineStats.deleted;
    }
  }
  const tierResult = resolveGateTier(config, gate, { changedFiles, filesChanged, linesChanged, hasFullLabel });
  if (tierResult.tier) {
    const configuredAngles = resolveGateAngles(config, gate) ?? [];
    let recommendedAngles = tierResult.angles;
    // deslop is a prose-only angle. A docs-kind tier keeps it for prose
    // diffs, but that kind also matches exempt normative contracts
    // (skills/docs/**), so strip deslop when the diff touches no prose surface.
    if (recommendedAngles.includes("deslop") && prosePresent === false) {
      recommendedAngles = recommendedAngles.filter((a) => a !== "deslop");
    }
    const skippedAngles = configuredAngles.filter((a) => !recommendedAngles.includes(a));
    return {
      recommendedAngles,
      skippedAngles,
      reasons: Object.fromEntries(skippedAngles.map((a) => [a, `tier:${tierResult.tier}`])),
      fallbackToAll: false,
      dynamicAnglesActive: true,
      addedAngles: [],
      addedReasons: {},
    };
  }

  const gateConfig = resolveGateConfig(config, gate);
  const staticAngles = resolveGateAngles(config, gate);
  if (staticAngles === null) {
    return { recommendedAngles: null, skippedAngles: [], reasons: {}, fallbackToAll: false, dynamicAnglesActive: false, addedAngles: [], addedReasons: {} };
  }

  if (!gateConfig.dynamicAngles || !diff) {
    return {
      recommendedAngles: staticAngles,
      skippedAngles: [],
      reasons: {},
      fallbackToAll: false,
      dynamicAnglesActive: false,
      addedAngles: [],
      addedReasons: {},
    };
  }

  // Split into mandatory (always run) and candidate pool (dynamic selection)
  // staticAngles is already filtered by excludeAngles via resolveGateAngles
  const mandatory = new Set(gateConfig.mandatoryAngles);
  const candidatePool = staticAngles.filter(a => !mandatory.has(a));

  // Dynamic resolution
  const { analyzeDiff } = await import("../analysis/diff-analyzer.mjs");
  const analysis = analyzeDiff({
    nameStatusOutput: diff.nameStatusOutput,
    diffOutput: diff.diffOutput,
  });

  const categories = [...new Set(analysis.t1?.changeCategories ?? [])];

  // excludeAngles is a hard ceiling: computed once and reused both to cap the
  // additive anglePool and to filter mandatoryAngles below.
  const excluded = new Set(gateConfig.excludeAngles);
  const anglePool = gateConfig.additiveAngles
    ? resolveAnglePool(config).filter(a => !excluded.has(a))
    : undefined;

  const { resolveDynamicAngles: resolve } = await import("../analysis/change-classifier.mjs");
  const dynamicResult = resolve({
    configuredAngles: candidatePool,
    changeCategories: categories,
    ambiguous: analysis.ambiguous,
    anglePool,
  });

  // Merge: mandatory always included (filtered by excludeAngles) + dynamically-selected
  // candidates + additively-selected catalog angles
  const filteredMandatory = gateConfig.mandatoryAngles.filter(a => !excluded.has(a));

  // An angle both mandatory AND additively recommended stays attributed to the
  // mandatory floor, not reported as "added" (the resolver has no concept of
  // mandatory, so this caller filters its output).
  const addedAngles = (dynamicResult.addedAngles ?? []).filter(a => !mandatory.has(a));
  const addedReasons = Object.fromEntries(
    Object.entries(dynamicResult.addedReasons ?? {}).filter(([a]) => !mandatory.has(a))
  );

  const recommendedAngles = [...new Set([...filteredMandatory, ...dynamicResult.recommendedAngles, ...addedAngles])];

  return {
    recommendedAngles,
    skippedAngles: dynamicResult.skippedAngles,
    reasons: dynamicResult.reasons,
    fallbackToAll: dynamicResult.fallbackToAll,
    dynamicAnglesActive: true,
    addedAngles,
    addedReasons,
  };
}

/**
 * Resolve one workflow config value, or its built-in default.
 * @param {DevLoopConfig} config
 * @param {"asyncStartMode"|"requireRetrospective"|"requireDraftFirst"|"devModeDefault"} key
 * @returns {string|boolean}
 */
export function resolveWorkflowConfig(config, key) {
  if (key === "asyncStartMode") {
    return config?.workflow?.asyncStartMode ?? DEFAULT_WORKFLOW_CONFIG.asyncStartMode;
  }

  if (key === "requireRetrospective") {
    return config?.workflow?.requireRetrospective ?? DEFAULT_WORKFLOW_CONFIG.requireRetrospective;
  }

  if (key === "requireDraftFirst") {
    return config?.workflow?.requireDraftFirst ?? DEFAULT_WORKFLOW_CONFIG.requireDraftFirst;
  }

  if (key === "devModeDefault") {
    return config?.workflow?.devModeDefault ?? DEFAULT_WORKFLOW_CONFIG.devModeDefault;
  }

  if (key === "stallDetection") {
    const configured = config?.workflow?.stallDetection;
    const def = DEFAULT_WORKFLOW_CONFIG.stallDetection;
    return {
      enabled: configured?.enabled ?? def.enabled,
      thresholdMinutes: configured?.thresholdMinutes ?? def.thresholdMinutes,
    };
  }

  throw new Error(`Unknown workflow config key: ${key}`);
}

/** Best-effort `git` probe: stdout trimmed on success, `null` on any failure
 * (missing repo, missing ref, git not on PATH, etc.) — never throws. */
function tryGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// Last-resort literal when git auto-detection resolves nothing (e.g. no git
// repo at cwd).
const AUTO_DETECT_BASE_BRANCH_FALLBACK = "main";

/**
 * Auto-detect the repo's default branch (bare name) at `cwd`: prefer the
 * remote's advertised default (`origin/HEAD`, works for any branch name), else
 * probe `main`/`master` as a remote-tracking or local ref, else fall back to
 * the literal "main". Every probe is best-effort; a missing/unreadable repo
 * degrades to the literal fallback rather than throwing.
 * @param {string} cwd
 * @returns {string}
 */
function autoDetectDefaultBranch(cwd) {
  const originHead = tryGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
  if (originHead && originHead.startsWith("origin/")) {
    return originHead.slice("origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], cwd) !== null) return candidate;
    if (tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], cwd) !== null) return candidate;
  }
  return AUTO_DETECT_BASE_BRANCH_FALLBACK;
}

/**
 * Resolve the effective base/integration branch (bare name, never
 * `origin/`-prefixed) for worktree creation, PR targeting, and merge-base scope
 * `workflow.baseBranch` is the authoritative override; unset/malformed/
 * empty falls back to auto-detect (origin/HEAD, else main/master, else "main").
 * Never throws. Callers own the `origin/` prefix (worktree creation prepends it;
 * gh/PR base passes the bare name through).
 *
 * @param {DevLoopConfig|null|undefined} config
 * @param {{ cwd?: string }} [options]
 * @returns {string} bare branch name
 */
export function resolveBaseBranch(config, { cwd = process.cwd() } = {}) {
  const configured = config?.workflow?.baseBranch;
  if (typeof configured === "string" && configured.trim().length > 0) {
    // A prefix-only value (e.g. "origin/", "refs/heads/") normalizes to empty —
    // treat that as unset and fall through to auto-detect, never return "".
    const bare = normalizeToBareBranch(configured.trim());
    if (bare.length > 0) return bare;
  }
  return autoDetectDefaultBranch(cwd);
}

/**
 * Reduce a configured base value to a BARE branch name. Callers prepend
 * `origin/` for remote refs, so a configured `origin/main` /
 * `refs/remotes/origin/main` / `refs/heads/main` must be stripped to `main`
 * first — otherwise the worktree base double-prefixes to `origin/origin/main`.
 * A branch name that merely contains a slash (e.g. `spike/vite`) is left intact.
 */
export function normalizeToBareBranch(value) {
  return value
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
}

/**
 * Resolve the worktree lifecycle config into `{ copyOnInit, linkOnInit }` (split
 * by each entry's `mode`), empty-array defaults when `worktree.entries` is
 * absent/empty. Paths are trimmed, repo-relative literals or globs expanded
 * against the main checkout at provision time (scripts/loop/provision-worktree.mjs).
 * @param {DevLoopConfig} config
 * @returns {{ copyOnInit: string[], linkOnInit: string[] }}
 */
export function resolveWorktreeConfig(config) {
  const entries = Array.isArray(config?.worktree?.entries) ? config.worktree.entries : [];
  const pathsForMode = (mode) =>
    entries
      .filter((e) => e && typeof e === "object" && e.mode === mode)
      .map((e) => (typeof e.path === "string" ? e.path.trim() : ""))
      .filter((p) => p.length > 0);
  return { copyOnInit: pathsForMode("copy"), linkOnInit: pathsForMode("link") };
}

/**
 * Default destructive-migration signal: SQL that drops or wipes data, matched
 * (case-insensitive, per line) against the migration STATUS OUTPUT. Only detects
 * destructive intent when the status output is itself SQL-bearing; against a
 * status output of migration ids/filenames it matches nothing and the guard is
 * inert, so such a project MUST override `uiReview.run.migrate.destructivePattern`
 * (or emit the SQL/marker from `statusCommand`).
 */
export const DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN =
  "\\b(DROP\\s+(TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE|DELETE\\s+FROM|ALTER\\s+TABLE\\s+.*\\bDROP\\b)";

/**
 * Resolve the ui-review provision+boot run recipe. Returns null when no
 * `uiReview.run.command` is declared — a stated stop reason (no app is ever
 * guessed). Numeric probe bounds fall back to defaults defensively for
 * programmatically-built config objects that bypass schema defaulting.
 *
 * @param {DevLoopConfig} config
 * @returns {null | { command: string, readyUrl: string, readyTimeoutMs: number,
 *   readyIntervalMs: number, cwd: string|null,
 *   migrate: null | { statusCommand: string, applyCommand: string, destructivePattern: string },
 *   rowTeardown: null | { deleteCommand: string } }}
 */
export function resolveUiReviewRunRecipe(config) {
  const run = config?.uiReview?.run;
  if (!run || typeof run.command !== "string" || run.command.trim().length === 0) return null;
  if (typeof run.readyUrl !== "string" || run.readyUrl.trim().length === 0) return null;
  const migrate = run.migrate
    ? {
        statusCommand: run.migrate.statusCommand,
        applyCommand: run.migrate.applyCommand,
        destructivePattern: run.migrate.destructivePattern ?? DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN,
      }
    : null;
  const rowTeardown =
    run.rowTeardown && typeof run.rowTeardown.deleteCommand === "string" && run.rowTeardown.deleteCommand.trim().length > 0
      ? { deleteCommand: run.rowTeardown.deleteCommand.trim() }
      : null;
  return {
    command: run.command.trim(),
    readyUrl: run.readyUrl.trim(),
    readyTimeoutMs: Number.isInteger(run.readyTimeoutMs) ? run.readyTimeoutMs : 60000,
    readyIntervalMs: Number.isInteger(run.readyIntervalMs) ? run.readyIntervalMs : 1000,
    cwd: trimmedOrNull(run.cwd),
    migrate,
    rowTeardown,
  };
}

/**
 * Resolve `postMerge.actions` from the merged config into normalized, runner-ready
 * action objects. `run`/`verify` are trimmed but otherwise passed through
 * VERBATIM (never rebuilt by concatenation) — the runner executes them exactly
 * as declared. Returns `[]` when `postMerge` is absent — a `.devloops` without
 * this family produces zero actions (and so zero hook commands).
 *
 * @param {DevLoopConfig} config
 * @returns {{ name: string, run: string, onlyIfChanged: string[]|null, verify: string|null,
 *   timeoutMs: number, verifyTimeoutMs: number, verifyIntervalMs: number }[]}
 */
export function resolvePostMergeActions(config) {
  const actions = config?.postMerge?.actions;
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((a) => a && typeof a.name === "string" && a.name.trim().length > 0 && typeof a.run === "string" && a.run.trim().length > 0)
    .map((a) => ({
      name: a.name.trim(),
      run: a.run.trim(),
      onlyIfChanged: Array.isArray(a.onlyIfChanged)
        ? a.onlyIfChanged.filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
        : null,
      verify: trimmedOrNull(a.verify),
      timeoutMs: Number.isInteger(a.timeoutMs) ? a.timeoutMs : POST_MERGE_ACTION_DEFAULT_TIMEOUT_MS,
      verifyTimeoutMs: Number.isInteger(a.verifyTimeoutMs) ? a.verifyTimeoutMs : POST_MERGE_VERIFY_DEFAULT_TIMEOUT_MS,
      verifyIntervalMs: Number.isInteger(a.verifyIntervalMs) ? a.verifyIntervalMs : POST_MERGE_VERIFY_DEFAULT_INTERVAL_MS,
    }));
}

/**
 * Default server-log exception signal for the drive stage's log tail. Matched
 * (case-insensitive, per line) against the tailed server-log text. This is a
 * HEURISTIC default tuned for common framework logs (a 5xx status, an
 * uncaught/unhandled marker, an exception/traceback). A project whose log format
 * these miss MUST override `uiReview.serverLogExceptionPattern` to match its own
 * server log — the default cannot detect what its log never prints.
 */
export const DEFAULT_SERVER_LOG_EXCEPTION_PATTERN =
  "\\b(5\\d{2}\\b|Internal Server Error|Unhandled|Uncaught|Traceback|Exception|FATAL|\\bERROR\\b)";

/**
 * Resolve the ui-review drive recipe (Stage 2). Returns null when no
 * `uiReview.login` is declared — a stated stop reason (it cannot authenticate,
 * so it drives nothing). The server-log exception pattern falls back to the
 * shipped heuristic default when a `serverLogPath` is set without one.
 *
 * @param {DevLoopConfig} config
 * @returns {null | { login: object, interstitials: object[], flows: object[],
 *   caps: object, serverLogPath: string|null, serverLogExceptionPattern: string }}
 */
export function resolveUiReviewDriveRecipe(config) {
  const ui = config?.uiReview;
  const login = ui?.login;
  if (!login || typeof login.loginUrl !== "string" || login.loginUrl.trim().length === 0) return null;
  if (typeof login.submitSelector !== "string" || login.submitSelector.trim().length === 0) return null;
  if (typeof login.successSelector !== "string" || login.successSelector.trim().length === 0) return null;
  const serverLogPath = trimmedOrNull(ui.serverLogPath);
  return {
    login: {
      loginUrl: login.loginUrl.trim(),
      usernameSelector: login.usernameSelector ?? null,
      usernameValue: login.usernameValue ?? null,
      passwordSelector: login.passwordSelector ?? null,
      passwordValue: login.passwordValue ?? null,
      submitSelector: login.submitSelector.trim(),
      successSelector: login.successSelector.trim(),
    },
    interstitials: Array.isArray(ui.interstitials)
      ? ui.interstitials.map((i) => ({ selector: i.selector }))
      : [],
    flows: Array.isArray(ui.flows) ? ui.flows : [],
    caps: ui.caps ?? {},
    serverLogPath,
    serverLogExceptionPattern:
      typeof ui.serverLogExceptionPattern === "string" && ui.serverLogExceptionPattern.trim().length > 0
        ? ui.serverLogExceptionPattern.trim()
        : DEFAULT_SERVER_LOG_EXCEPTION_PATTERN,
  };
}

/**
 * Resolve the human-handoff config into a normalized
 * `{ enabled, candidatesFrom, assignees }`. Disabled with empty arrays when
 * `approval` is absent; when disabled (default) callers must not source or
 * assign anyone. Pairs with `autonomy.humanMergeOnly`.
 * @param {DevLoopConfig} config
 * @returns {{ enabled: boolean, candidatesFrom: ("codeowners"|"recent-committers")[], assignees: string[] }}
 */
export function resolveHumanHandoffConfig(config) {
  const hh = config?.approval;
  const enabled = hh?.enabled === true;
  const list = (v) =>
    Array.isArray(v)
      ? v.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0)
      : [];
  const candidatesFrom = list(hh?.candidatesFrom).filter(
    (s) => s === "codeowners" || s === "recent-committers"
  );
  // Normalize assignees: strip a leading `@`, trim, and drop empties so an empty
  // login (e.g. config value of `"@"` or `""`) can never leak downstream into
  // `gh pr edit --add-assignee ""`.
  const assignees = list(hh?.assignees)
    .map((s) => s.replace(/^@/, "").trim())
    .filter((s) => s.length > 0);
  return {
    enabled,
    candidatesFrom: enabled ? candidatesFrom : [],
    assignees: enabled ? assignees : [],
  };
}

/**
 * Resolve the tracker provider registry key. Defaults to
 * `"github"` — the only built-in provider in v1 — when unset. Callers pass
 * this to `resolveTrackerAdapter` (`@dev-loops/core/tracker`).
 *
 * @param {DevLoopConfig} config
 * @returns {string}
 */
export function resolveTrackerProvider(config) {
  const raw = config?.tracker?.provider;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "github";
}

/**
 * Resolve the effective tracker board identifier. `tracker.board` is the
 * canonical (and only) board config key.
 *
 * @param {DevLoopConfig} config
 * @returns {{ number?: number, title?: string } | null}
 */
export function resolveTrackerBoard(config) {
  if (isPlainObject(config?.tracker?.board)) return config.tracker.board;
  return null;
}
