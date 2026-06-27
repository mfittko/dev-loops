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
  default: z.enum(["local-first", "github-first"]),
});

const InputSourceConfig = z.strictObject({
  default: z.enum(["tracker", "phase-docs"]),
});

const ModelsConfig = z.strictObject({
  conductor: z.string().trim().min(1).optional(),
  roles: z.record(z.string(), z.string().trim().min(1)).optional(),
});

const RefinementConfig = z.strictObject({
  fanOut: z.number().int().min(1).max(10),
  mode: z.enum(["parallel", "sequential"]),
  maxCopilotRounds: z.number().int().nonnegative().default(5),
  stopOnLowSignal: z.boolean().default(false),
  lowSignalRoundThreshold: z.number().int().nonnegative().default(3),
  lowSignalMaxComments: z.number().int().nonnegative().default(2),
  roles: z.array(z.string().trim().min(1)).optional(),
});

const GateConfig = z.strictObject({
  angles: z.array(z.string().trim().min(1)).optional(),
  excludeAngles: z.array(z.string().trim().min(1)).default([]),
  mandatoryAngles: z.array(z.string().trim().min(1)).default([]),
  required: z.boolean().default(true),
  requireCi: z.boolean().default(true),
  blockCleanOnFindingSeverities: z
    .array(z.enum(["must-fix", "worth-fixing-now", "defer"]))
    .min(1)
    .default(["must-fix"]),
  dynamicAngles: z.boolean().default(false),
});

const GatesConfig = z.strictObject({
  draft: GateConfig.optional(),
  // `requireCi` is only behaviorally configurable for the draft gate.
  // preApproval always requires CI even if config repeats `requireCi`.
  preApproval: GateConfig.optional(),
  // Fail-closed enforcement that a gate verdict was produced by the
  // fan-out/fan-in review sub-loop (executionMode === "fanout_fanin" plus a
  // durable findings-log ledger), not an inline single-agent run. Default
  // true (opt-out): a clean gate verdict requires fan-out/fan-in evidence
  // unless explicitly disabled. See docs/gate-review-sub-loop-contract.md.
  requireFanoutEvidence: z.boolean().default(true),
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
});

const AutonomyConfig = z.strictObject({
  stopAt: z.array(
    z.enum(["refinement", "draft-pr", "pre-approval", "merge"])
  ),
  // When true, merge is a fixed, non-overridable human action: the agent never
  // runs `gh pr merge`, `resolveAutonomyStopAt` always includes "merge", and
  // any per-run merge authorization (envelope flag / explicit instruction) is
  // ignored — it fails closed. See resolveHumanMergeOnly / resolveEffectiveMergeAuthorized.
  humanMergeOnly: z.boolean().optional(),
});

/**
 * Human-handoff config (#920, Request B of #910): at the pre-approval /
 * merge-handoff boundary, OFFER to assign the PR to a named human
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
  asyncStartMode: z.enum(["required", "allowed"]).default("required"),
  requireRetrospective: z.boolean(),
  requireRetrospectiveGate: z.boolean().default(false),
  requireDraftFirst: z.boolean(),
  devModeDefault: z.boolean(),
});

const LocalImplementationConfig = z.strictObject({
  /** Opt into light mode for small scoped changes */
  lightMode: z.strictObject({
    enabled: z.boolean(),
    maxFiles: z.number().int().min(1),
    maxLines: z.number().int().min(1),
  }).optional(),
});

/** Queue mode config */
const QueueConfig = z.strictObject({
  maxParallel: z.number().int().min(1).max(10).default(3),
  maxAutoFiledIssues: z.number().int().min(0).max(100).default(10),
  reDispatchMaxRetries: z.number().int().min(0).max(10).default(1),
  projectNumber: z.number().int().positive().optional(),
  boardTitle: z.string().trim().min(1).optional(),
  archiveOlderThanDays: z.number().int().positive().optional(),
});

/**
 * Worktree lifecycle config (#909): which gitignored files/dirs to provision
 * into a fresh worktree from the main checkout. Entries are repo-relative
 * literal paths OR glob patterns. `copyOnInit` → `fs.cp` (isolated per
 * worktree); `linkOnInit` → absolute symlink into the main checkout (read-only
 * data). Both optional; empty/absent is a valid no-op.
 */
const WorktreeConfig = z.strictObject({
  copyOnInit: z.array(z.string().trim().min(1)).optional(),
  linkOnInit: z.array(z.string().trim().min(1)).optional(),
});

/**
 * Local-planning config (#949): where persisted markdown plan files (phase-doc
 * format) live when work originates from a plan file rather than a tracker
 * issue. `plansDir` is a repo-relative directory; defaults to the existing
 * phase-docs directory. See skills/docs/plan-file-contract.md.
 */
const LocalPlanningConfig = z.strictObject({
  plansDir: z.string().trim().min(1).optional(),
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
  draft: FileGateConfig.optional(),
  preApproval: FileGateConfig.optional(),
  requireFanoutEvidence: z.boolean().optional(),
  maxFanoutReviewers: z.number().int().min(1).max(64).optional(),
  postFindingsComments: z.boolean().optional(),
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
  localPlanning: LocalPlanningConfig.optional(),
});

// ============================================================================
// Built-in defaults — frozen canonical single source of truth
// ============================================================================

export const BUILT_IN_DEFAULTS = Object.freeze({
  version: 1,
  strategy: Object.freeze({ default: "github-first" }),
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
    requireRetrospectiveGate: false,
    requireDraftFirst: false,
    devModeDefault: false,
  }),
  localImplementation: Object.freeze({
    lightMode: Object.freeze({ enabled: false, maxFiles: 3, maxLines: 200 }),
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
  localPlanning: Object.freeze({ plansDir: "docs/phases/" }),
});

// ============================================================================
// File-level validation schema — allows partial family objects
// ============================================================================

export const FileConfigSchema = z.strictObject({
  version: z.literal(1),
  strategy: StrategyConfig.partial().optional(),
  inputSource: InputSourceConfig.partial().optional(),
  models: ModelsConfig.partial().optional(),
  refinement: RefinementConfig.partial().optional(),
  gates: FileGatesConfig.optional(),
  autonomy: AutonomyConfig.partial().optional(),
  approval: ApprovalConfig.partial().optional(),
  workflow: WorkflowConfig.partial().optional(),
  localImplementation: LocalImplementationConfig.partial().optional(),
  queue: QueueConfig.partial().optional(),
  personas: FilePersonasConfig.optional(),
  internalPathPatterns: InternalPatternsConfig.optional(),
  worktree: WorktreeConfig.partial().optional(),
  localPlanning: LocalPlanningConfig.partial().optional(),
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
  return { fanOut, mode, roles, maxCopilotRounds, stopOnLowSignal, lowSignalRoundThreshold, lowSignalMaxComments };
}

/**
 * Resolve one gate configuration object from the merged dev-loop config.
 *
 * Returns the configured gate angles when present, or null for angles when the
 * config omits them (caller falls back to skill-defined defaults). Boolean gate
 * flags always resolve to stable defaults.
 *
 * @param {DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @returns {{ angles: string[]|null, excludeAngles: string[], mandatoryAngles: string[], required: boolean, requireCi: boolean, blockCleanOnFindingSeverities: string[], dynamicAngles: boolean }}
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

/** Default parallel fan-out reviewer cap (mirrors GatesConfig.maxFanoutReviewers). */
export const DEFAULT_MAX_FANOUT_REVIEWERS = 8;

/**
 * Resolve the parallel fan-out reviewer cap for the gate sub-loop.
 *
 * Returns the configured `gates.maxFanoutReviewers` when it is an integer in
 * the schema-bounded range 1..64; otherwise the built-in default (8). Clamping
 * here (not just the Zod schema) keeps programmatically-constructed config
 * objects that bypass schema validation within the same bound. The fan-out
 * spawns at most this many scoped `review` reviewers in parallel; overflow runs
 * sequentially.
 *
 * @param {DevLoopConfig} config
 * @returns {number}
 */
export function resolveMaxFanoutReviewers(config) {
  const raw = config?.gates?.maxFanoutReviewers;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 64) {
    return raw;
  }
  return DEFAULT_MAX_FANOUT_REVIEWERS;
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
 * Resolve gate angles dynamically when `dynamicAngles` is enabled in config.
 *
 * Uses diff analysis helpers (from ../analysis/*) to filter the
 * configured angle list down to only angles relevant to the change set.
 *
 * When `dynamicAngles` is disabled (default), returns the full configured
 * angle list (same as `resolveGateAngles`).
 *
 * @param {import("./types.js").DevLoopConfig} config
 * @param {"draft"|"preApproval"} gate
 * @param {object} [options]
 * @param {{ nameStatusOutput: string, diffOutput?: string }} [options.diff]
 * @returns {{ recommendedAngles: string[] | null, skippedAngles: string[], reasons: Record<string,string>, fallbackToAll: boolean, dynamicAnglesActive: boolean }}
 */
export async function resolveGateAnglesDynamic(config, gate, { diff } = {}) {
  const gateConfig = resolveGateConfig(config, gate);
  const staticAngles = resolveGateAngles(config, gate);
  if (staticAngles === null) {
    return { recommendedAngles: null, skippedAngles: [], reasons: {}, fallbackToAll: false, dynamicAnglesActive: false };
  }

  if (!gateConfig.dynamicAngles || !diff) {
    return {
      recommendedAngles: staticAngles,
      skippedAngles: [],
      reasons: {},
      fallbackToAll: false,
      dynamicAnglesActive: false,
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

  const { resolveDynamicAngles: resolve } = await import("../analysis/change-classifier.mjs");
  const dynamicResult = resolve({
    configuredAngles: candidatePool,
    changeCategories: categories,
    ambiguous: analysis.ambiguous,
  });

  // Merge: mandatory always included (filtered by excludeAngles) + dynamically-selected candidates
  const excluded = new Set(gateConfig.excludeAngles);
  const filteredMandatory = gateConfig.mandatoryAngles.filter(a => !excluded.has(a));
  const recommendedAngles = [...new Set([...filteredMandatory, ...dynamicResult.recommendedAngles])];

  return {
    recommendedAngles,
    skippedAngles: dynamicResult.skippedAngles,
    reasons: dynamicResult.reasons,
    fallbackToAll: dynamicResult.fallbackToAll,
    dynamicAnglesActive: true,
  };
}

/**
 * Resolve one workflow configuration value from the merged dev-loop config.
 *
 * Returns the configured workflow value when present, or the built-in default
 * for the requested key.
 *
 * @param {DevLoopConfig} config
 * @param {"asyncStartMode"|"requireRetrospective"|"requireRetrospectiveGate"|"requireDraftFirst"|"devModeDefault"} key
 * @returns {string|boolean}
 */
export function resolveWorkflowConfig(config, key) {
  if (key === "asyncStartMode") {
    return config?.workflow?.asyncStartMode ?? DEFAULT_WORKFLOW_CONFIG.asyncStartMode;
  }

  if (key === "requireRetrospective") {
    return config?.workflow?.requireRetrospective ?? DEFAULT_WORKFLOW_CONFIG.requireRetrospective;
  }

  if (key === "requireRetrospectiveGate") {
    return config?.workflow?.requireRetrospectiveGate ?? DEFAULT_WORKFLOW_CONFIG.requireRetrospectiveGate;
  }

  if (key === "requireDraftFirst") {
    return config?.workflow?.requireDraftFirst ?? DEFAULT_WORKFLOW_CONFIG.requireDraftFirst;
  }

  if (key === "devModeDefault") {
    return config?.workflow?.devModeDefault ?? DEFAULT_WORKFLOW_CONFIG.devModeDefault;
  }

  throw new Error(`Unknown workflow config key: ${key}`);
}

const DEFAULT_INTERNAL_PATH_PATTERNS = BUILT_IN_DEFAULTS.internalPathPatterns;

/**
 * Resolve the internal path patterns from the merged dev-loop config.
 *
 * Returns an array of regex pattern strings used by detect-internal-only-pr.mjs
 * to classify files as internal tooling (vs consumer-facing). When the config
 * omits this section, returns the built-in shipped defaults.
 *
 * Consumers can override these in .devloops at repo root.
 *
 * @param {DevLoopConfig} config
 * @returns {string[]}
 */
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
 * Resolve the local-planning plans directory from the merged dev-loop config.
 *
 * Returns the configured `localPlanning.plansDir` (trimmed) when present and
 * non-empty, otherwise the built-in default (`docs/phases/`) — the existing
 * phase-docs directory. See skills/docs/plan-file-contract.md.
 *
 * @param {DevLoopConfig} config
 * @returns {string}
 */
export function resolvePlansDir(config) {
  const raw = config?.localPlanning?.plansDir;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return BUILT_IN_DEFAULTS.localPlanning.plansDir;
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

export function resolveInternalPathPatterns(config) {
  if (
    config?.internalPathPatterns &&
    Array.isArray(config.internalPathPatterns) &&
    config.internalPathPatterns.length > 0
  ) {
    return [...config.internalPathPatterns];
  }
  return [...DEFAULT_INTERNAL_PATH_PATTERNS];
}
