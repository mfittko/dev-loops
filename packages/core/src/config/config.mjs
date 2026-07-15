import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ============================================================================
// Sub-schemas
//
// BUILT_IN_DEFAULTS remains the canonical shipped default surface for loader
// fallbacks. Select field-level defaults may still exist where merged-schema
// callers need a stable value even when they construct config objects directly.
// ============================================================================

const StrategyConfig = z.strictObject({
  default: z.enum(["local-first", "github-first"]).describe("Default work-intake strategy: local-first starts from a repo plan file, github-first from a tracked issue."),
});

const InputSourceConfig = z.strictObject({
  default: z.enum(["tracker", "phase-docs"]).describe("Where local-first work reads its spec: the tracker issue body, or repo phase docs."),
});

// Built-in tier aliases shipped with zero config. A tier alias maps a
// harness-neutral name (low/high) to a concrete per-harness model id; `null`
// means "inherit" (pass no model override → genuine no-op on that harness).
// Pi ships null on every built-in tier, so zero-config resolution is a no-op on
// Pi until an operator sets concrete Pi ids.
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
  // Tier alias → per-harness concrete model (null = inherit / no-op).
  tiers: z.record(z.string().min(1), ModelTierMapping).describe("Tier alias → per-harness concrete model; null on a harness means inherit (no override).").optional(),
  // Role / angle → tier alias (a built-in/custom alias or "inherit").
  roleTiers: z.record(z.string().min(1), z.string().trim().min(1)).describe("Role or gate angle → tier alias: a built-in alias (low, high), a custom models.tiers alias, or \"inherit\".").optional(),
});

const ModelsConfig = ModelsConfigBase.superRefine(refineRoleTiers);

const RefinementConfig = z.strictObject({
  fanOut: z.number().int().min(1).max(10).describe("Parallel reviewers per refinement round."),
  mode: z.enum(["parallel", "sequential"]).describe("Whether refinement reviewers run in parallel or one after another."),
  maxCopilotRounds: z.number().int().nonnegative().default(5).describe("Automated Copilot review rounds before converging; 0 disables Copilot review."),
  stopOnLowSignal: z.boolean().default(false).describe("Stop Copilot rounds early once they stop producing signal."),
  lowSignalRoundThreshold: z.number().int().nonnegative().default(3).describe("Rounds counted toward the low-signal stop decision."),
  lowSignalMaxComments: z.number().int().nonnegative().default(2).describe("A round with at most this many comments counts as low-signal."),
  roles: z.array(z.string().trim().min(1)).describe("Review lenses the refinement fan-out dispatches.").optional(),
});

const GateConfig = z.strictObject({
  angles: z.array(z.string().trim().min(1)).describe("Review lenses this gate fans out to.").optional(),
  excludeAngles: z.array(z.string().trim().min(1)).default([]).describe("Angles removed from the resolved angle list."),
  mandatoryAngles: z.array(z.string().trim().min(1)).default([]).describe("Angles that always run, regardless of diff-based dynamic selection."),
  required: z.boolean().default(true).describe("Whether this gate must run."),
  requireCi: z.boolean().default(true).describe("Per-gate CI prerequisite (default true): the gate requires green CI on the current head; false opts this gate out of the CI precondition entirely, including a real failure."),
  blockCleanOnFindingSeverities: z
    .array(z.enum(["must-fix", "worth-fixing-now", "defer"]))
    .min(1)
    .default(["must-fix"])
    .describe("Finding severities that block a clean gate verdict."),
  dynamicAngles: z.boolean().default(false).describe("Enable diff-driven dynamic angle resolution for this gate."),
  // Additive counterpart to the subtractive dynamicAngles path (#1048): when
  // true, the context-builder may also ADD catalog angles — from
  // resolveAnglePool() (gates.anglePool, or else the union of the persona
  // registry and this config's own configured angles) — that change-category
  // heuristics recommend but that are not already in this gate's configured
  // pool. Default false preserves today's subtractive-only behavior exactly.
  additiveAngles: z.boolean().default(false).describe("Allow diff-driven addition of catalog angles beyond this gate's configured pool."),
});

const GatesConfig = z.strictObject({
  draft: GateConfig.optional(),
  // `requireCi` is honored on both gates: default true keeps CI a precondition,
  // false is an opt-out escape hatch so a repo with no CI is not held at the
  // gate. The pre-approval gate mirrors the draft gate's `requireCi` semantics —
  // when false the CI verdict is ignored entirely at that boundary, including a
  // real failure (not merely "green optional").
  preApproval: GateConfig.optional(),
  // Relaxed spike gate profile (#965). A spike's deliverable is a findings doc,
  // not production code, so it should not carry the full draft → pre-approval →
  // Copilot production set. Resolved through the same config-merge layering and
  // the same resolveGateConfig path as draft/preApproval — no new strategy→knob
  // resolver. Absent for non-spike work, so production gates are unaffected.
  spike: GateConfig.optional(),
  // Fail-closed enforcement that a gate verdict was produced by the
  // fan-out/fan-in review sub-loop (executionMode === "fanout_fanin" plus a
  // durable findings-log ledger), not an inline single-agent run. Default
  // true (opt-out): a clean gate verdict requires fan-out/fan-in evidence
  // unless explicitly disabled. See docs/gate-review-sub-loop-contract.md.
  requireFanoutEvidence: z.boolean().default(true),
  // Fail-closed enforcement that a fanout_fanin gate verdict carries recorded,
  // internally-consistent fan-out *provenance* (distinct reviewer count +
  // per-angle dispatch). This RAISES THE BAR against a single agent self-producing
  // every artifact but does NOT prove independence — provenance is self-reported,
  // so it remains forgeable; un-forgeable recording is the Pi-harness bridge (see
  // the honest caveat in docs/gate-review-sub-loop-contract.md). Layered ON TOP of
  // requireFanoutEvidence — only takes effect when fan-out evidence enforcement
  // is active. Default false (opt-in): closing this loophole is additive and
  // does not change behavior for existing ledgers that carry no provenance.
  requireFanoutProvenance: z.boolean().default(false),
  // Cap on how many scoped `review` reviewers the gate fan-out spawns in
  // parallel. When the resolved angle set exceeds this cap, the overflow runs
  // in sequential batches and the degradation is recorded in the gate evidence.
  maxFanoutReviewers: z.number().int().min(1).max(64).default(8),
  // Post the consolidated gate fan-out findings as a visible, marker-tagged PR
  // comment so they are auditable and Copilot/humans are aware of them. Default
  // true (opt-out). The disposition ledger is written regardless; this flag only
  // suppresses the PR comment when explicitly false. See
  // docs/gate-review-sub-loop-contract.md.
  postFindingsComments: z.boolean().default(true),
  // Explicit global lens catalog override for additive angle selection
  // (gates.<gate>.additiveAngles, #1048). When absent, resolveAnglePool()
  // falls back to the union of the built-in persona registry's angle names
  // and every angle configured across this config's own draft/preApproval/
  // spike gates (angles + mandatoryAngles).
  anglePool: z.array(z.string().trim().min(1)).optional(),
  // Fail-closed enforcement that a fanout_fanin gate's recorded per-angle
  // provenance names only angles in the gate's configured pool (angles +
  // mandatoryAngles) — ad-hoc/foreign angle labels are rejected rather than
  // silently accepted. Default true (reject); set false to warn instead of
  // fail. See resolveRejectForeignAngles / docs/gate-review-sub-loop-contract.md.
  rejectForeignAngles: z.boolean().default(true),
});

const AutonomyConfig = z.strictObject({
  stopAt: z.array(
    z.enum(["refinement", "draft-pr", "pre-approval", "merge"])
  ).describe("Checkpoints that require operator confirmation before the loop proceeds (default: [\"merge\"])."),
  // When true, merge is a fixed, non-overridable human action: the agent never
  // runs `gh pr merge`, `resolveAutonomyStopAt` always includes "merge", and
  // any per-run merge authorization (envelope flag / explicit instruction) is
  // ignored — it fails closed. See resolveHumanMergeOnly / resolveEffectiveMergeAuthorized.
  humanMergeOnly: z.boolean().describe("Merge stays a fixed human-only action: the agent never merges and any per-run merge authorization is ignored (fails closed).").optional(),
});

/**
 * Human-handoff config (#920, Request B of #910): at the pre-approval /
 * merge-handoff boundary, OFFER to assign the PR to a contributor
 * reviewer/assignee. Opt-in (default off). Pairs with autonomy.humanMergeOnly.
 * `candidatesFrom` selects which sources the resolver queries; `assignees` is a
 * static highest-priority candidate list. Absent/empty = disabled no-op.
 */
const HumanHandoffConfig = z.strictObject({
  enabled: z.boolean().default(false),
  candidatesFrom: z
    .array(z.enum(["codeowners", "recent-committers"]))
    .optional(),
  assignees: z.array(z.string().trim().min(1)).optional(),
});

const ApprovalConfig = z.strictObject({
  humanHandoff: HumanHandoffConfig.optional(),
});

const WorkflowConfig = z.strictObject({
  asyncStartMode: z.enum(["required", "allowed"]).default("required").describe("Whether the async start contract is required or merely allowed."),
  requireRetrospective: z.boolean().describe("Require a retrospective checkpoint before a loop completes."),
  requireDraftFirst: z.boolean().describe("Open pull requests as drafts and promote via the draft gate."),
  devModeDefault: z.boolean().describe("Default new loops to dev mode."),
});

const LocalImplementationConfig = z.strictObject({
  /** Opt into light mode for small scoped changes */
  lightMode: z.strictObject({
    enabled: z.boolean().describe("Opt small scoped changes into the lightweight dispatch path."),
    maxFiles: z.number().int().min(1).describe("Light mode applies only when the change touches at most this many files."),
    maxLines: z.number().int().min(1).describe("Light mode applies only when the change stays within this many lines."),
    // Copilot review round cap for light-dispatched PRs (#1210). Composes with
    // (does not replace) refinement.maxCopilotRounds — see
    // resolveEffectiveCopilotRoundCap.
    maxCopilotRounds: z.number().int().nonnegative().default(1).describe("Copilot round cap for light-dispatched PRs; composes as min(this, refinement.maxCopilotRounds)."),
  }).optional(),
  /**
   * Opt into issue-less PR-first (`--lightweight` with no --issue) at ANY
   * change scope. Decoupled from lightMode: gate dispatch still resolves
   * inline vs full_fanout from scope on its own, so over-threshold issue-less
   * PRs get the full fan-out and the full-PR Copilot round cap.
   */
  issueless: z.strictObject({
    enabled: z.boolean(),
  }).optional(),
});

/** Queue mode config */
const QueueConfig = z.strictObject({
  maxParallel: z.number().int().min(1).max(10).default(3).describe("Maximum queue items worked in parallel."),
  maxAutoFiledIssues: z.number().int().min(0).max(100).default(10).describe("Cap on auto-filed issues per run."),
  reDispatchMaxRetries: z.number().int().min(0).max(10).default(1).describe("Retries when re-dispatching a failed queue item."),
  projectNumber: z.number().int().positive().describe("GitHub Projects board number (explicit opt-in to Projects-based queue ordering).").optional(),
  boardTitle: z.string().trim().min(1).describe("GitHub Projects board title (explicit opt-in to Projects-based queue ordering).").optional(),
  archiveOlderThanDays: z.number().int().positive().describe("Archive done board items older than this many days.").optional(),
});

/**
 * Worktree lifecycle config (#909): which gitignored files/dirs to provision
 * into a fresh worktree from the main checkout. Entries are repo-relative
 * literal paths OR glob patterns. `copyOnInit` → `fs.cp` (isolated per
 * worktree); `linkOnInit` → absolute symlink into the main checkout (read-only
 * data). Both optional; empty/absent is a valid no-op.
 */
const WorktreeConfig = z.strictObject({
  copyOnInit: z.array(z.string().trim().min(1)).describe("Repo-relative paths/globs copied into a fresh worktree (isolated per worktree — use for mutable files).").optional(),
  linkOnInit: z.array(z.string().trim().min(1)).describe("Repo-relative paths/globs symlinked to the main checkout (shared — read-only data only).").optional(),
});

/**
 * Dev-DB migration sub-recipe for the ui-review run recipe. `statusCommand`
 * lists pending migrations (one per line); `applyCommand` applies them.
 *
 * Destructive detection is EXPLICIT and status-format-dependent: the
 * `destructivePattern` regex is matched (case-insensitive, per line) against the
 * STATUS OUTPUT — not against the migration files. The shipped default
 * (DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN) assumes SQL-bearing status output
 * (DROP/TRUNCATE/DELETE FROM ...); against a status command that emits migration
 * identifiers or filenames instead, it matches nothing and the destructive guard
 * is inert. A project whose status output is NOT SQL therefore MUST set a
 * `destructivePattern` that matches its own status format (e.g. a `destructive`/
 * `down` marker), or make `statusCommand` emit the destructive SQL/marker — the
 * default cannot detect what its status output never prints.
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
 * mutating step it drives with a drive-session id (advertised to the app on the
 * DRIVE_SESSION_HEADER request header); this `deleteCommand` deletes exactly the
 * rows the app tagged with that session — the id is passed in the
 * UI_REVIEW_DRIVE_SESSION env var and the command runs in the provisioned
 * worktree (dev DB only). Teardown runs it only on explicit confirmation.
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
  // Responsive/stateful captures: a declared viewport resizes the page before the
  // step and bakes into the named-state slug, so the mobile vs desktop (or
  // default vs error) render lands in a distinct reviewable directory. The route
  // NAMES its interaction states — the drive never enumerates them itself.
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

/** Internal path whitelist for internal-only PR detection — flat array of regex strings */
const InternalPatternsConfig = z.array(z.string().trim().min(1)).min(1);

const PersonaEntry = z.strictObject({
  persona: z.string().min(1),
  // Optional in the merged/full schema so consumer overrides can replace
  // only persona/defaultModel without having to restate the inherited prompt.
  prompt: z.string().min(1).optional().describe("Short focused instruction for the reviewer agent — what to look for and how to judge this angle"),
  defaultModel: z.string().trim().min(1).nullable().default(null),
});

const PersonasConfig = z.record(z.string().min(1), PersonaEntry);

// Partial nested gate entries for file-level config (allows overriding only
// requireCi/required/angles without restating the whole gate object).
const FileGateConfig = GateConfig.partial();
const FileGatesConfig = z.strictObject({
  draft: FileGateConfig.describe("Draft gate config (runs before a PR leaves draft).").optional(),
  preApproval: FileGateConfig.describe("Pre-approval gate config (final re-review before the merge handoff).").optional(),
  spike: FileGateConfig.describe("Relaxed spike gate profile; applies only to spike-mode work.").optional(),
  requireFanoutEvidence: z.boolean().describe("Require fan-out/fan-in review evidence on gate verdicts (rejects inline single-agent runs).").optional(),
  requireFanoutProvenance: z.boolean().describe("Additionally require recorded, internally-consistent fan-out provenance (distinct reviewer count + per-angle dispatch).").optional(),
  maxFanoutReviewers: z.number().int().min(1).max(64).describe("Cap on parallel gate fan-out reviewers; overflow runs in sequential batches.").optional(),
  postFindingsComments: z.boolean().describe("Post consolidated gate findings as a marker-tagged PR comment (default true).").optional(),
  anglePool: z.array(z.string().trim().min(1)).describe("Explicit global lens catalog for additive angle selection.").optional(),
  rejectForeignAngles: z.boolean().describe("Reject fan-out provenance naming angles outside the gate's configured pool (default true).").optional(),
});

// Partial persona entries for file-level config (allows omitting fields)
const FilePersonasConfig = z.record(z.string().min(1), PersonaEntry.partial());

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
  personas: PersonasConfig.optional(),
  internalPathPatterns: InternalPatternsConfig.optional(),
  worktree: WorktreeConfig.optional(),
  uiReview: UiReviewConfig.optional(),
  // Deprecated (removed in #1088): tolerated so consumer .devloops files that
  // still carry a localPlanning block keep parsing. Accepted, never read.
  localPlanning: z.unknown().optional(),
});

// ============================================================================
// Built-in defaults — frozen canonical single source of truth
// ============================================================================

export const BUILT_IN_DEFAULTS = Object.freeze({
  version: 1,
  strategy: Object.freeze({ default: "local-first" }),
  inputSource: Object.freeze({ default: "tracker" }),
  models: Object.freeze({}),
  refinement: Object.freeze({ fanOut: 3, mode: "parallel", maxCopilotRounds: 5, stopOnLowSignal: false, lowSignalRoundThreshold: 3, lowSignalMaxComments: 2 }),
  gates: Object.freeze({}),
  autonomy: Object.freeze({ stopAt: Object.freeze(["merge"]), humanMergeOnly: false }),
  approval: Object.freeze({
    humanHandoff: Object.freeze({
      enabled: false,
      candidatesFrom: Object.freeze([]),
      assignees: Object.freeze([]),
    }),
  }),
  workflow: Object.freeze({
    asyncStartMode: "required",
    requireRetrospective: false,
    requireDraftFirst: false,
    devModeDefault: false,
  }),
  localImplementation: Object.freeze({
    lightMode: Object.freeze({ enabled: false, maxFiles: 3, maxLines: 200, maxCopilotRounds: 1 }),
    issueless: Object.freeze({ enabled: false }),
  }),
  queue: Object.freeze({
    maxParallel: 3,
    maxAutoFiledIssues: 10,
    reDispatchMaxRetries: 1,
    // projectNumber and boardTitle are intentionally absent from defaults
    // — setting either is an explicit operator opt-in for Projects-based
    // queue ordering.
  }),
  personas: Object.freeze({}),
  internalPathPatterns: Object.freeze([
    "^scripts/",
    "^docs/",
    "^skills/docs/",
    "^\\.pi/",
    "^\\.github/",
    "^test/",
  ]),
  worktree: Object.freeze({ copyOnInit: Object.freeze([]), linkOnInit: Object.freeze([]) }),
});

// ============================================================================
// File-level validation schema — allows partial family objects
// ============================================================================

export const FileConfigSchema = z.strictObject({
  version: z.literal(1).describe("Config format version; always 1."),
  strategy: StrategyConfig.partial().describe("Work-intake strategy defaults.").optional(),
  inputSource: InputSourceConfig.partial().describe("Spec source for local-first work.").optional(),
  models: ModelsConfigBase.partial().superRefine(refineRoleTiers).describe("Model routing: conductor override, per-role/angle overrides, tier aliases, and role→tier policy.").optional(),
  refinement: RefinementConfig.partial().describe("Refinement fan-out and Copilot review-round behavior.").optional(),
  gates: FileGatesConfig.describe("Gate review configuration: per-gate angle sets plus fan-out enforcement knobs.").optional(),
  autonomy: AutonomyConfig.partial().describe("How far the loop proceeds without operator confirmation.").optional(),
  approval: ApprovalConfig.partial().describe("Approval / merge-handoff behavior (human-handoff offer).").optional(),
  workflow: WorkflowConfig.partial().describe("Workflow posture: draft-first, retrospectives, dev mode, async start.").optional(),
  localImplementation: LocalImplementationConfig.partial().describe("Local implementation dispatch (light mode for small scoped changes).").optional(),
  queue: QueueConfig.partial().describe("Queue mode: parallelism, auto-filing caps, and Projects board opt-in.").optional(),
  personas: FilePersonasConfig.describe("Gate-angle → reviewer persona registry overrides (angle name → persona, prompt, default model).").optional(),
  internalPathPatterns: InternalPatternsConfig.describe("Regex whitelist for internal-only PR detection.").optional(),
  worktree: WorktreeConfig.partial().describe("Worktree provisioning: gitignored files/dirs copied or symlinked into fresh worktrees.").optional(),
  uiReview: UiReviewConfig.partial().describe("UI-review route recipes: per-project run/boot, dev-login, driven flows, and caps.").optional(),
  // Deprecated (removed in #1088): tolerated so consumer .devloops files that
  // still carry a localPlanning block keep parsing. Accepted, never read.
  localPlanning: z.unknown().optional(),
});

// ============================================================================
// Built-in persona registry — fallback when config.personas is absent
//
// Maps gate-review angle names to reviewer personas. Only the persona name
// is defined here; prompts and per-angle model defaults live in the config
// (.pi/dev-loop/defaults.yaml personas section).
//
// Consumers can extend or override these by adding personas entries to
// their .pi/dev-loop/defaults.* or settings.* config files (with legacy overrides.* fallback). Config-resolved
// personas take priority over this built-in registry.
//
// Angle names come from the gate-angle config (gates.draft.angles /
// gates.preApproval.angles in .pi/dev-loop/defaults.yaml).
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
 * Resolve a gate angle name to a reviewer persona and model.
 *
 * Resolution order:
 * 1. Look up angle in config.personas[angle] (consumer overrides)
 * 2. If not found in config, look up in BUILTIN_PERSONAS
 * 3. If found in either, apply model override from config.models.roles[angle] if present
 * 4. If not found anywhere, fall back to default reviewer with angle as focus lens,
 *    still applying any model override from config
 *
 * @param {object} config - DevLoopConfig (or partial with personas, models.roles)
 * @param {string|null|undefined} angle - Gate angle / lens name
 * @returns {RoleResolutionResult}
 */
export function resolveReviewerRole(config, angle) {
  // Null/undefined/empty angle → fallback
  if (angle == null || angle === "") {
    return {
      persona: DEFAULT_REVIEWER_PERSONA,
      model: null,
      prompt: null,
      fallback: true,
    };
  }

  // Resolution: config.personas > BUILTIN_PERSONAS > default-reviewer
  const configPersona = config?.personas?.[angle] ?? null;
  const builtinPersona = BUILTIN_PERSONAS[angle] ?? null;
  const persona = configPersona ?? builtinPersona;
  const modelOverride = config?.models?.roles?.[angle] || null;

  if (persona) {
    return {
      persona: persona.persona,
      model: modelOverride || persona.defaultModel || null,
      prompt: persona.prompt || null,
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
 *   1. `models.roles[role]` — concrete per-role/angle override (highest).
 *   2. Tier alias, mapped through `models.tiers[tier][harness]` (or built-in
 *      tiers); `inherit`/absent/null → `null`. The alias depends on `kind`:
 *      - `kind: "angle"` (gate review dispatch): an explicit
 *        `models.roleTiers[role]` override, else the `review` tier. A gate
 *        review runs at review quality even when the angle's name collides with
 *        a routine role — e.g. the `docs` angle resolves via the `review` tier
 *        (high), not the `docs` writer role's low tier. (Its persona/agent still
 *        comes from `resolveReviewerRole`; only the tier is forced to review.)
 *      - `kind: "role"`/absent (routine subagent): `models.roleTiers[role]` (or
 *        the built-in role tier), else — when the name is not a named role — the
 *        tier for its review persona (so a non-colliding gate angle passed
 *        without `kind` still resolves high via `review`).
 *
 * Callers dispatching a gate review angle whose name may collide with a routine
 * role (only `docs` today) MUST pass `kind: "angle"` to avoid the silent
 * downgrade; role dispatch leaves `kind` unset.
 *
 * Zero-config is a genuine no-op on Pi (built-in tiers are null for pi) and
 * reproduces the standing policy on Claude (routine=low, refiner/review=high,
 * dev-loop=inherit).
 *
 * @param {DevLoopConfig} config
 * @param {{ role: string, harness: "claude"|"pi", kind?: "role"|"angle" }} params
 * @returns {string|null}
 */
export function resolveRoleModel(config, { role, harness, kind } = {}) {
  if (!role || (harness !== "claude" && harness !== "pi")) return null;

  // 1. Concrete per-role/angle override wins outright (over any tier).
  const concrete = config?.models?.roles?.[role];
  if (typeof concrete === "string" && concrete.trim().length > 0) {
    return concrete.trim();
  }

  // 2. Resolve a tier alias for this role/angle.
  const roleTiers = { ...BUILTIN_ROLE_TIERS, ...(config?.models?.roleTiers ?? {}) };
  let tierAlias;
  if (kind === "angle") {
    // Gate review angle: an explicit per-angle override wins, else the review
    // tier — a gate review is review-quality regardless of a coincidental
    // routine-role persona name (the `docs` angle must not inherit `docs`→low).
    tierAlias = config?.models?.roleTiers?.[role] ?? roleTiers.review;
  } else {
    tierAlias = roleTiers[role];
    if (tierAlias === undefined) {
      // Not a named role — treat as a gate angle and inherit its review
      // persona's tier (critical angles resolve high via the `review` persona).
      const { persona } = resolveReviewerRole(config, role);
      tierAlias = roleTiers[persona];
    }
  }
  if (!tierAlias || tierAlias === "inherit") return null;

  // Deep-merge the alias mapping so a partial override (e.g. `{ pi: "..." }`,
  // which the schema allows) preserves the untouched built-in harness key rather
  // than erasing the whole {claude,pi} mapping and resolving null for that harness.
  const builtinMapping = BUILTIN_TIERS[tierAlias];
  const configMapping = config?.models?.tiers?.[tierAlias];
  if (!builtinMapping && !configMapping) return null;
  const mapping = { ...builtinMapping, ...configMapping };
  const model = mapping[harness];
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
}

// ============================================================================
// Error types
// ============================================================================

/**
 * @typedef {object} ConfigLoadError
 * @property {string} path - Human-readable file path or layer name
 * @property {string} message - Error description
 * @property {"defaults"|"settings"|"extensionDefaults"|"merged"} layer - Which config layer failed
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

/**
 * Merge two config objects. Keys in `source` override keys in `target`.
 * Family objects merge at one level, except `gates`, which merges one extra
 * nested gate-object level so settings can override `draft.requireCi` without
 * restating the shipped draft angles.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function mergeConfigLayers(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      key !== "version" &&
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = key === "gates"
        ? mergeNestedObject(result[key], source[key])
        : { ...(result[key] || {}), ...(source[key] || {}) };
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function mergeNestedObject(target, source) {
  const result = { ...(target || {}) };

  for (const key of Object.keys(source || {})) {
    if (
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = { ...(result[key] || {}), ...(source[key] || {}) };
    } else {
      result[key] = source[key];
    }
  }

  return result;
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
    // Try bare path first (e.g., .devloops without extension).
    // Success returns immediately.
    // ENOENT: file genuinely absent — try extension variants.
    // Other errors (EISDIR, EACCES): file exists but is unreadable —
    // try extension variants as fallback, but surface the original
    // error if no extension variant exists.
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
 * Try to load and merge one config layer (defaults or settings).
 * @param {Record<string, unknown>} merged - Current merged config
 * @param {string|string[]} basePaths - Config file base path(s) without extension
 * @param {"defaults"|"settings"} layer - Layer name
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

  // Validate the file's structure before merging
  const validation = FileConfigSchema.safeParse(data);
  if (!validation.success) {
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
 *   settings.(yaml|yml|json) > legacy overrides.(yaml|yml|json) > repo .pi/dev-loop/defaults.(yaml|yml|json) > extension defaults > built-in defaults
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
  const settingsPaths = [path.join(configDir, "settings"), path.join(configDir, "overrides")];

  /** @type {string[]} */
  const warnings = [];
  /** @type {ConfigLoadError[]} */
  const errors = [];

  let merged = { ...BUILT_IN_DEFAULTS };
  merged = await applyLayer(merged, resolveExtensionDefaultsPath(options), "extensionDefaults", warnings, errors, { warnOnMissing: true });


  merged = await applyLayer(merged, defaultsPath, "defaults", warnings, errors, {
    warnOnMissing: true,
  });

  // Check if .devloops exists (primary consumer override)
  // Only ENOENT means the file is genuinely absent; any other error
  // (EACCES, EISDIR, etc.) means the file exists but is unreadable,
  // so we must select the .devloops path so applyLayer can record the
  // structured error.
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
    // .devloops is the primary override — apply it
    merged = await applyLayer(merged, devloopsPath, "settings", warnings, errors);

    // Warn if legacy files still exist alongside .devloops (but don't load them —
    // .devloops is authoritative; legacy must not override it)
    let legacyAlongside = false;
    for (const legacyPath of settingsPaths) {
      for (const ext of [".yaml", ".yml", ".json"]) {
        try {
          await readFile(legacyPath + ext, "utf8");
          legacyAlongside = true;
          break;
        } catch (err) {
          if (err?.code !== "ENOENT") {
            // File exists but is unreadable — treat as "found" so the
            // deprecation warning fires (applyLayer is not called for legacy
            // paths when .devloops is present, so the flag only controls the warning).
            legacyAlongside = true;
            break;
          }
        }
      }
      if (legacyAlongside) break;
    }
    if (legacyAlongside) {
      warnings.push(
        `Deprecated config path(s) found under .pi/dev-loop/settings.* or .pi/dev-loop/overrides.*. ` +
        `Migrate to .devloops (or .devloops.yaml/.devloops.yml/.devloops.json) at repo root. ` +
        `Legacy paths will be removed in a future version.`
      );
    }
  } else {
    // No .devloops — fall back to legacy .pi/dev-loop/settings.* or overrides.* (deprecated)
    let legacyFound = false;
    for (const legacyPath of settingsPaths) {
      for (const ext of [".yaml", ".yml", ".json"]) {
        try {
          await readFile(legacyPath + ext, "utf8");
          legacyFound = true;
          break;
        } catch (err) {
          if (err?.code !== "ENOENT") {
            // File exists but is unreadable — treat as "found" so the
            // deprecation warning fires and applyLayer can surface the error
            // (legacy applyLayer runs in this branch).
            legacyFound = true;
            break;
          }
        }
      }
      if (legacyFound) break;
    }
    if (legacyFound) {
      warnings.push(
        `Deprecated config path(s) found under .pi/dev-loop/settings.* or .pi/dev-loop/overrides.*. ` +
        `Migrate to .devloops (or .devloops.yaml/.devloops.yml/.devloops.json) at repo root. ` +
        `Legacy paths will be removed in a future version.`
      );
      merged = await applyLayer(merged, settingsPaths, "settings", warnings, errors);
    }
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
 * Resolve the conductor model from the merged dev-loop config.
 *
 * Returns the configured model string if present, or null when the config
 * does not specify a conductor model override (caller falls back to its
 * own built-in default).
 *
 * Accepts the validated DevLoopConfig from {@link loadDevLoopConfig}.
 *
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
 * Resolve the autonomy stop-at list from the merged dev-loop config.
 *
 * Returns the set of gates that require operator confirmation. Gates not in
 * the returned list may proceed automatically once their review conditions
 * are satisfied.
 *
 * Defaults to `["merge"]` when the config does not specify `autonomy.stopAt`
 * (the conservative built-in posture: everything auto-continues until merge).
 *
 * Accepts the validated DevLoopConfig from {@link loadDevLoopConfig}.
 *
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
 * Resolve the fixed human-merge-only invariant from the merged dev-loop config.
 *
 * When true, the agent must never perform the merge itself: `gh pr merge` is a
 * human-only action and any per-run merge authorization is ignored. Defaults to
 * false (the agent may merge once authorized).
 *
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
 * Resolve one refinement configuration value from the merged dev-loop config.
 *
 * Returns the configured value when present, or the built-in default for the
 * requested key.
 *
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
    return config?.refinement?.stopOnLowSignal ?? DEFAULT_REFINEMENT_CONFIG.stopOnLowSignal;
  }

  if (key === "lowSignalRoundThreshold") {
    return config?.refinement?.lowSignalRoundThreshold ?? DEFAULT_REFINEMENT_CONFIG.lowSignalRoundThreshold;
  }

  if (key === "lowSignalMaxComments") {
    return config?.refinement?.lowSignalMaxComments ?? DEFAULT_REFINEMENT_CONFIG.lowSignalMaxComments;
  }

  throw new Error(`Unknown refinement config key: ${key}`);
}

/**
 * Resolve the refinement configuration from the merged dev-loop config.
 *
 * Returns `{ fanOut, mode, roles, maxCopilotRounds, stopOnLowSignal, lowSignalRoundThreshold, lowSignalMaxComments }` with sensible built-in
 * defaults (`fanOut: 3`, `mode: "parallel"`, `roles: null`,
 * `maxCopilotRounds: 5`, `stopOnLowSignal: false`, `lowSignalRoundThreshold: 3`,
 * `lowSignalMaxComments: 2`).
 *
 * Accepts the validated DevLoopConfig from {@link loadDevLoopConfig}.
 *
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
  // #1337: centralize the pre-approval CI opt-out here so every caller that
  // builds its interpreter refinement config from `resolveRefinement(config)`
  // (detect-copilot-loop-state, copilot-pr-handoff, gate coordination, etc.)
  // reliably honors `gates.preApproval.requireCi: false` — otherwise a CI-less
  // repo would still be interpreted as waiting_for_ci / blocked in those tools.
  const preApprovalRequireCi = resolveGateConfig(config, "preApproval").requireCi;
  return { fanOut, mode, roles, maxCopilotRounds, stopOnLowSignal, lowSignalRoundThreshold, lowSignalMaxComments, preApprovalRequireCi };
}

/**
 * Resolve one gate configuration object from the merged dev-loop config.
 *
 * Returns the configured gate angles when present, or null for angles when the
 * config omits them (caller falls back to skill-defined defaults). Boolean gate
 * flags always resolve to stable defaults.
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"|"spike"} gate
 * @returns {{ angles: string[]|null, excludeAngles: string[], mandatoryAngles: string[], required: boolean, requireCi: boolean, blockCleanOnFindingSeverities: string[], dynamicAngles: boolean, additiveAngles: boolean }}
 */
export function resolveGateConfig(config, gate) {
  const gateConfig = config?.gates?.[gate];
  return {
    angles: gateConfig?.angles && Array.isArray(gateConfig.angles)
      ? gateConfig.angles.map(a => (typeof a === "string" ? a.trim() : "")).filter(a => a.length > 0)
      : null,
    excludeAngles: gateConfig?.excludeAngles && Array.isArray(gateConfig.excludeAngles)
      ? gateConfig.excludeAngles.map(a => (typeof a === "string" ? a.trim() : "")).filter(a => a.length > 0)
      : [],
    mandatoryAngles: gateConfig?.mandatoryAngles && Array.isArray(gateConfig.mandatoryAngles)
      ? gateConfig.mandatoryAngles.map(a => (typeof a === "string" ? a.trim() : "")).filter(a => a.length > 0)
      : [],
    required: gateConfig?.required ?? true,
    requireCi: gateConfig?.requireCi ?? true,
    dynamicAngles: gateConfig?.dynamicAngles ?? false,
    additiveAngles: gateConfig?.additiveAngles ?? false,
    blockCleanOnFindingSeverities: gateConfig?.blockCleanOnFindingSeverities && Array.isArray(gateConfig.blockCleanOnFindingSeverities)
      ? [...gateConfig.blockCleanOnFindingSeverities]
      : ["must-fix"],
  };
}

/**
 * Resolve whether fan-out/fan-in review evidence is required for a gate verdict.
 *
 * Default-on (opt-out): enforcement is ON unless `gates.requireFanoutEvidence`
 * is explicitly set to false. When ON, the pre-merge evidence check fails
 * closed unless a required gate's recorded executionMode is "fanout_fanin" and
 * a durable findings-log ledger exists for that gate + head SHA. Using a
 * `!== false` test (rather than `=== true`) keeps the opt-out semantics robust
 * for programmatically-built config objects that bypass schema defaulting. See
 * docs/gate-review-sub-loop-contract.md.
 *
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveRequireFanoutEvidence(config) {
  return config?.gates?.requireFanoutEvidence !== false;
}

/**
 * Minimum distinct reviewer count for a fanout_fanin ledger to satisfy
 * requireFanoutProvenance. A floor of 2 is the smallest count that is not a
 * single agent; it raises the bar but does not prove independence (provenance
 * is self-reported — see the honest caveat in
 * docs/gate-review-sub-loop-contract.md).
 */
export const FANOUT_PROVENANCE_MIN_REVIEWERS = 2;

/**
 * Resolve whether fan-out *provenance* is required for a fanout_fanin gate
 * verdict (distinct reviewer count + per-angle dispatch recorded in the ledger).
 *
 * Default-OFF (opt-in): unlike resolveRequireFanoutEvidence, this uses a strict
 * `=== true` test so behavior is byte-identical to today unless a repo
 * explicitly opts in via `gates.requireFanoutProvenance: true`. Layered on top
 * of fan-out evidence enforcement (see buildFanoutEnforcement). See
 * docs/gate-review-sub-loop-contract.md.
 *
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
 * Resolve whether the consolidated gate fan-out findings should be posted as a
 * visible, marker-tagged PR comment.
 *
 * Returns true (post the comment) unless `gates.postFindingsComments` is
 * explicitly set to false. Using a `!== false` test (rather than `=== true`)
 * keeps the opt-out semantics robust for programmatically-built config objects
 * that bypass schema defaulting. The disposition ledger is written regardless;
 * this flag only suppresses the auditable PR comment. See
 * docs/gate-review-sub-loop-contract.md.
 *
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveGatePostFindingsComments(config) {
  return config?.gates?.postFindingsComments !== false;
}

/**
 * Resolve local implementation light mode config.
 *
 * Returns null when light mode is disabled (config absent or enabled=false).
 * Returns { maxFiles, maxLines } when enabled.
 *
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
 * Resolve the issue-less PR-first any-scope opt-in (#1349).
 *
 * True only when `localImplementation.issueless.enabled` is exactly `true`;
 * absent, false, or malformed values resolve to false (fail closed).
 *
 * @param {DevLoopConfig} config
 * @returns {boolean}
 */
export function resolveIssuelessEnabled(config) {
  return config?.localImplementation?.issueless?.enabled === true;
}

/**
 * Resolve the effective Copilot review round cap for a PR (#1210).
 *
 * Full PRs (lightweight=false) use `refinement.maxCopilotRounds` unchanged
 * (default 5). Light-dispatched PRs compose with it rather than replacing it:
 * `effective = min(localImplementation.lightMode.maxCopilotRounds ?? 1,
 * refinement.maxCopilotRounds)` — so setting `refinement.maxCopilotRounds: 0`
 * disables Copilot rounds everywhere, including lightweight, with that one
 * setting.
 *
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
 * Decide whether a gate should run as a single-agent inline check or the full
 * fan-out, from light-mode config + authoritative PR facts.
 *
 * Precedence (first match wins):
 *   1. `gate:full` label present            → full_fanout (label override)
 *   2. light mode disabled / no threshold    → full_fanout (light mode off)
 *   3. scope over threshold (files OR lines) → full_fanout (over threshold)
 *   4. inline check produced a finding whose severity is in the gate's
 *      blockCleanOnFindingSeverities set     → full_fanout (escalated)
 *   5. otherwise                             → inline
 *
 * Two call phases share this one function:
 *   - pre-check: omit `inlineFindingSeverities` (undefined) → decides whether to
 *     run the inline pass at all.
 *   - escalation: pass the inline pass's finding severities → auto-escalates when
 *     the inline check surfaced anything worth fixing.
 *
 * Absent or partial `facts.scope` fails safe to full_fanout (missing
 * filesChanged/linesChanged are treated as `Infinity` → over threshold).
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
    const blocking = new Set(resolveGateConfig(config, gate).blockCleanOnFindingSeverities);
    if (inlineFindingSeverities.some((s) => blocking.has(s))) {
      return { mode: "full_fanout", reason: "escalated", threshold };
    }
  }
  return { mode: "inline", reason: "under_threshold", threshold };
}

/**
 * Resolve review angles for a specific gate from the merged dev-loop config.
 *
 * Merges mandatoryAngles with the configured candidate angles, filters
 * through excludeAngles, and deduplicates. Returns null only when both
 * angles and mandatoryAngles are absent/empty for the given gate (caller
 * falls back to skill-defined defaults).
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @returns {string[]|null}
 */
export function resolveGateAngles(config, gate) {
  const gateConfig = resolveGateConfig(config, gate);
  if (gateConfig.angles === null && gateConfig.mandatoryAngles.length === 0) return null;
  const excluded = new Set(gateConfig.excludeAngles);
  const merged = [...new Set([...gateConfig.mandatoryAngles, ...(gateConfig.angles ?? [])])];
  return merged.filter(a => !excluded.has(a));
}

/**
 * Resolve the global lens catalog available for additive angle selection.
 *
 * Returns the explicit `gates.anglePool` override when configured (non-empty
 * array of trimmed strings). Otherwise falls back to the union of all known
 * review angles: the built-in persona registry's angle names, plus every
 * angle actually configured across this config's own draft/preApproval/spike
 * gates (angles + mandatoryAngles). The persona registry alone omits angles
 * that ship in extension-defaults.yaml gate pools but have no dedicated
 * persona (e.g. ci-guard, link-check) — see #1048.
 *
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
 * within. Single source of truth for all angle-coverage enforcement consumers
 * (ledger write, verdict-comment write, merge-evidence read) so they agree.
 *
 * - `mandatoryAngles` is filtered through `excludeAngles`: a config that
 *   excludes a mandatory angle must not deadlock every fanout write (the
 *   angle would be missing-mandatory if omitted yet foreign if recorded).
 * - `pool` is `resolveGateAngles` (configured angles ∪ mandatoryAngles, minus
 *   excludeAngles); when `additiveAngles` is enabled it widens to the global
 *   lens catalog (`resolveAnglePool`) too — dynamic resolution may
 *   legitimately dispatch catalog angles then — with `excludeAngles` still a
 *   hard ceiling. A null pool skips the foreign-angle check entirely.
 *
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
 * Resolve gate angles dynamically when `dynamicAngles` is enabled in config.
 *
 * Uses diff analysis helpers (from ../analysis/*) to filter the
 * configured angle list down to only angles relevant to the change set.
 *
 * When `dynamicAngles` is disabled (default), returns the full configured
 * angle list (same as `resolveGateAngles`).
 *
 * When `additiveAngles` is also enabled (default off, see #1048), catalog
 * angles from `resolveAnglePool()` (`gates.anglePool`, or else the union of
 * the persona registry and this config's own configured angles) recommended
 * by change-category heuristics but absent from the gate's configured pool
 * may also be added; `excludeAngles` remains a hard ceiling on additions.
 *
 * @param {import("./types.js").DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @param {object} [options]
 * @param {{ nameStatusOutput: string, diffOutput?: string }} [options.diff]
 * @returns {{ recommendedAngles: string[] | null, skippedAngles: string[], reasons: Record<string,string>, fallbackToAll: boolean, dynamicAnglesActive: boolean, addedAngles: string[], addedReasons: Record<string,string> }}
 */
export async function resolveGateAnglesDynamic(config, gate, { diff } = {}) {
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
  // candidates + additively-selected catalog angles (#1048)
  const filteredMandatory = gateConfig.mandatoryAngles.filter(a => !excluded.has(a));

  // An angle that is both mandatory AND additively recommended must stay
  // attributed to the mandatory floor, not be reported as "added" — the
  // resolver has no concept of "mandatory", so the caller (this function,
  // which already owns the mandatory Set) filters its output.
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
 * Resolve one workflow configuration value from the merged dev-loop config.
 *
 * Returns the configured workflow value when present, or the built-in default
 * for the requested key.
 *
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

  throw new Error(`Unknown workflow config key: ${key}`);
}

/**
 * Resolve the worktree lifecycle config from the merged dev-loop config.
 *
 * Returns `{ copyOnInit, linkOnInit }` with empty-array defaults when the
 * config omits the `worktree` section or either list. Entries are trimmed,
 * repo-relative literal paths or glob patterns expanded against the main
 * checkout at provision time. See scripts/loop/provision-worktree.mjs.
 *
 * @param {DevLoopConfig} config
 * @returns {{ copyOnInit: string[], linkOnInit: string[] }}
 */
export function resolveWorktreeConfig(config) {
  const wt = config?.worktree;
  const list = (v) =>
    Array.isArray(v)
      ? v.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0)
      : [];
  return { copyOnInit: list(wt?.copyOnInit), linkOnInit: list(wt?.linkOnInit) };
}

/**
 * Default destructive-migration signal: SQL statements that drop or wipe data.
 * Matched (case-insensitive, per line) against the migration STATUS OUTPUT. This
 * default only detects destructive intent when the status output is itself
 * SQL-bearing; against status output that lists migration identifiers/filenames
 * it matches nothing and the guard is inert (no false positives, but also no
 * protection). Such a project MUST override via
 * `uiReview.run.migrate.destructivePattern` to match its own status format (or
 * emit the destructive SQL/marker from `statusCommand`).
 */
export const DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN =
  "\\b(DROP\\s+(TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE|DELETE\\s+FROM|ALTER\\s+TABLE\\s+.*\\bDROP\\b)";

/**
 * Resolve the ui-review provision+boot run recipe from the merged config.
 *
 * Returns null when no `uiReview.run.command` is declared — the provision+boot
 * stage treats that as a stated stop reason (no app is ever guessed). Numeric
 * probe bounds fall back to sane defaults defensively: zod `.partial()` is
 * shallow (it does not drop nested numeric defaults), so a schema-validated
 * config already carries them — the fallback covers programmatically-built
 * config objects that bypass schema defaulting, not the `.partial()` path.
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
    cwd: typeof run.cwd === "string" && run.cwd.trim().length > 0 ? run.cwd.trim() : null,
    migrate,
    rowTeardown,
  };
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
 * Resolve the ui-review drive recipe (Stage 2) from the merged config.
 *
 * Returns null when no `uiReview.login` is declared — the drive stage treats
 * that as a stated stop reason (it cannot authenticate, so it drives nothing).
 * The server-log exception pattern falls back to the shipped heuristic default
 * when a `serverLogPath` is set without an explicit pattern.
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
  const serverLogPath = typeof ui.serverLogPath === "string" && ui.serverLogPath.trim().length > 0 ? ui.serverLogPath.trim() : null;
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
 * Resolve the human-handoff config from the merged dev-loop config (#920).
 *
 * Returns a normalized `{ enabled, candidatesFrom, assignees }`. Defaults to
 * disabled with empty arrays when the `approval.humanHandoff` section is absent.
 * When disabled (default), this is a no-op: callers must not source candidates
 * or assign anyone. Pairs with `autonomy.humanMergeOnly`: when human-merge is
 * enforced, this names who should take the merge.
 *
 * @param {DevLoopConfig} config
 * @returns {{ enabled: boolean, candidatesFrom: ("codeowners"|"recent-committers")[], assignees: string[] }}
 */
export function resolveHumanHandoffConfig(config) {
  const hh = config?.approval?.humanHandoff;
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
