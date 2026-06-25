/**
 * Deterministic handoff envelope — machine-generated JSON contract for
 * `dev-loop` subagent dispatch.
 *
 * Replaces dispatch prose with a purely derived envelope from three
 * authoritative sources:
 *   1. Resolver output (bundle)  → target, gate, nextAction, requiredReads, executionMode
 *   2. Settings (DevLoopConfig)  → gateConfig, stopRules, asyncStartMode, requireDraftFirst, maxCopilotRounds
 *   3. Gate state (detectors)    → head SHA, CI status, thread count, round count
 *
 * Acceptance criteria, evidence lists, maxFinalizationTurns, and control
 * params are derived from a static strategy+gate mapping table.
 *
 * Unknown strategy/gate combos throw explicit errors.
 */

import {
  DEV_LOOP_TARGET_KIND,
  INTERNAL_DEV_LOOP_STRATEGY,
} from "./public-dev-loop-routing-contract.mjs";
import { normalizeRepoSlug } from "../github/repo-slug.mjs";
import { COPILOT_REVIEW_WAIT_TIMEOUT_MS } from "./policy-constants.mjs";
import { resolveEffectiveAsyncStartMode } from "./async-start-contract.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const H_VER = 1;
const ENVELOPE_HANDOFF_VERSION = H_VER;

const WATCH_NEEDS_ATTENTION_MS = COPILOT_REVIEW_WAIT_TIMEOUT_MS; // matches external healthy wait budget (policy-constants)
const WATCH_ACTIVE_NOTICE_MS = COPILOT_REVIEW_WAIT_TIMEOUT_MS; // matches external healthy wait budget (policy-constants)
const DEFAULT_NEEDS_ATTENTION_MS = 300_000; // 5 minutes
const DEFAULT_ACTIVE_NOTICE_MS = 300_000;

/** Maps normalized strategy name to its default stop rules */
const STRATEGY_DEFAULT_STOP_RULES = Object.freeze({
  [INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP]: ["draft-pr", "merge"],
  [INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE]: ["merge"],
  [INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP]: ["merge"],
  [INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER]: ["merge"],
  [INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH]: ["merge"],
  [INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL]: ["merge"],
  [INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION]: [],
});

// ---------------------------------------------------------------------------
// Acceptance template table
// ---------------------------------------------------------------------------

const ACCEPTANCE_TEMPLATES = new Map();

function acceptanceKey(strategy, gate) {
  return `${strategy}::${gate}`;
}

function register(strategy, gate, template) {
  ACCEPTANCE_TEMPLATES.set(acceptanceKey(strategy, gate), deepFreeze({ ...template }));
}

// copilot_pr_followup sub-gates
register(INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, "draft", {
  criteria: [
    { id: "ac-check", must: "Verify all acceptance criteria from linked issue are met or tracked.", severity: "required" },
    { id: "scope", must: "Every changed file belongs in this PR; no unrelated or out-of-scope changes.", severity: "required" },
    { id: "coverage", must: "Tests cover changed behavior including edge cases and error paths.", severity: "required" },
    { id: "dod-alignment", must: "Implementation aligns with the issue's definition of done.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output", "review-findings"],
  maxFinalizationTurns: 4,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
});

register(INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, "watch", {
  criteria: [
    { id: "copilot-activity", must: "Detect new Copilot review activity (comments, threads, review submissions).", severity: "required" },
    { id: "no-stuck-watch", must: "Watch cycle must not stall; timeout or activity triggers follow-up.", severity: "required" },
  ],
  evidence: ["commands-run"],
  maxFinalizationTurns: 2,
  needsAttentionAfterMs: WATCH_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: WATCH_ACTIVE_NOTICE_MS,
});

register(INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP, "pre-approval", {
  criteria: [
    { id: "full-gate-chain", must: "Complete pre-approval gate chain with all configured review angles.", severity: "required" },
    { id: "clean-verdict", must: "Pre-approval gate must return clean verdict (no must-fix or worth-fixing-now findings).", severity: "required" },
    { id: "unresolved-threads", must: "All review threads must be resolved before pre-approval gate runs.", severity: "required" },
    { id: "ci-green", must: "CI must be green on the current head SHA.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output", "review-findings", "residual-risks"],
  maxFinalizationTurns: 6,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
});

// final_approval
register(INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL, "default", {
  criteria: [
    { id: "gate-evidence", must: "All required gate evidence (draft_gate, pre_approval_gate) is present and visible.", severity: "required" },
    { id: "human-confirmation", must: "Human operator must explicitly confirm merge readiness.", severity: "required" },
    { id: "ci-green", must: "CI must be green on the current head SHA.", severity: "required" },
  ],
  evidence: ["validation-output", "manual-notes"],
  maxFinalizationTurns: 2,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
});

// local_implementation
register(INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION, "default", {
  criteria: [
    { id: "phase-ac", must: "All phase acceptance criteria from the active phase doc are satisfied.", severity: "required" },
    { id: "verify-green", must: "`npm run verify` passes with no failures.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output", "changed-files"],
  maxFinalizationTurns: 6,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
});

// wait_watch — dedicated window matching external healthy wait budget (policy-constants)
register(INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH, "default", {
  criteria: [
    { id: "contract-compliance", must: "Implementation complies with the governing contract and acceptance criteria.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output"],
  maxFinalizationTurns: 4,
  needsAttentionAfterMs: WATCH_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: WATCH_ACTIVE_NOTICE_MS,
});

// Remaining strategies get a generic acceptance template
function registerGeneric(strategy) {
  register(strategy, "default", {
    criteria: [
      { id: "contract-compliance", must: "Implementation complies with the governing contract and acceptance criteria.", severity: "required" },
    ],
    evidence: ["commands-run", "validation-output"],
    maxFinalizationTurns: 4,
    needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
    activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
  });
}

for (const s of [
  INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE,
  INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP,
  INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER,
]) {
  if (![...ACCEPTANCE_TEMPLATES.keys()].some((k) => k.startsWith(`${s}::`))) {
    registerGeneric(s);
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeRepo(repo) {
  try {
    return normalizeRepoSlug(repo);
  } catch {
    return null;
  }
}

function normalizeTargetKind(kind) {
  if (typeof kind !== "string") return null;
  const normalized = kind.trim().toLowerCase();
  return Object.values(DEV_LOOP_TARGET_KIND).includes(normalized) ? normalized : null;
}

function normalizePositiveInt(v) {
  if (!Number.isInteger(v) || v < 0) return null;
  return v;
}

function normalizeString(v) {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function normalizeStringOrNull(v) {
  return v === null || v === undefined ? null : normalizeString(v);
}

function requireString(v, label) {
  const s = normalizeString(v);
  if (s === null) throw new Error(`handoff-envelope: ${label} is required and must be a non-empty string`);
  return s;
}

// ---------------------------------------------------------------------------
// Target derivation
// ---------------------------------------------------------------------------

function deriveTarget(bundle, repo) {
  const artifact = bundle?.activeArtifact ?? bundle?.canonicalState?.target ?? {};

  const kind = normalizeTargetKind(artifact.kind);
  if (!kind) throw new Error("handoff-envelope: resolver output must include a valid target kind");

  const target = { kind, repo };

  if (kind === DEV_LOOP_TARGET_KIND.ISSUE) {
    const issue = artifact.issue;
    if (!Number.isInteger(issue) || issue < 1) {
      throw new Error("handoff-envelope: issue target must include a valid positive issue number");
    }
    target.issue = issue;
    if (Number.isInteger(artifact.pr) && artifact.pr > 0) target.pr = artifact.pr;
    if (Number.isInteger(artifact.linkedPr) && artifact.linkedPr > 0) target.linkedPr = artifact.linkedPr;
  } else if (kind === DEV_LOOP_TARGET_KIND.PR) {
    const pr = artifact.pr;
    if (!Number.isInteger(pr) || pr < 1) {
      throw new Error("handoff-envelope: PR target must include a valid positive PR number");
    }
    target.pr = pr;
    if (Number.isInteger(artifact.issue) && artifact.issue > 0) target.issue = artifact.issue;
  } else if (kind === DEV_LOOP_TARGET_KIND.LOCAL_BRANCH) {
    const branch = normalizeString(artifact.branch);
    if (!branch) throw new Error("handoff-envelope: local_branch target must include a non-empty branch name");
    target.branch = branch;
    if (Number.isInteger(artifact.issue) && artifact.issue > 0) target.issue = artifact.issue;
  } else if (kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE) {
    const phase = normalizeString(artifact.phase);
    const validIssue = Number.isInteger(artifact.issue) && artifact.issue > 0;
    if (!phase && !validIssue) {
      throw new Error("handoff-envelope: local_phase target must include a non-empty phase or a valid positive issue number");
    }
    if (phase) target.phase = phase;
    if (validIssue) target.issue = artifact.issue;
  }

  return target;
}

// ---------------------------------------------------------------------------
// Stop rules derivation
// ---------------------------------------------------------------------------

function deriveStopRules(settings, strategy) {
  if (settings?.autonomy?.stopAt && Array.isArray(settings.autonomy.stopAt)) {
    return [...settings.autonomy.stopAt];
  }
  return [...(STRATEGY_DEFAULT_STOP_RULES[strategy] ?? [])];
}

// ---------------------------------------------------------------------------
// requiredReads derivation
// ---------------------------------------------------------------------------

function deriveRequiredReads(bundle, resolverOutput) {
  const topReads = resolverOutput?.requiredReads;
  if (Array.isArray(topReads) && topReads.length > 0) return [...topReads];
  const reads = bundle?.requiredReads;
  return Array.isArray(reads) ? [...reads] : [];
}

// ---------------------------------------------------------------------------
// Gate config derivation
// ---------------------------------------------------------------------------

function deriveGateConfig(settings, subGate) {
  const gateKey = subGate === "pre-approval" ? "preApproval" : subGate;
  const gateSettings = settings?.gates?.[gateKey];
  if (!gateSettings) return undefined;

  const angles = Array.isArray(gateSettings.angles) ? [...gateSettings.angles] : [];
  const excludeAngles = Array.isArray(gateSettings.excludeAngles) ? [...gateSettings.excludeAngles] : [];
  const filteredAngles = angles.filter((a) => !excludeAngles.includes(a));

  return {
    angles: filteredAngles,
    excludeAngles: excludeAngles.length > 0 ? excludeAngles : undefined,
    blockCleanOnFindingSeverities: Array.isArray(gateSettings.blockCleanOnFindingSeverities)
      ? [...gateSettings.blockCleanOnFindingSeverities]
      : ["must-fix"],
    requireCi: gateSettings.requireCi ?? true,
  };
}

// ---------------------------------------------------------------------------
// Acceptance template lookup
// ---------------------------------------------------------------------------

function lookupAcceptanceTemplate(strategy, gate) {
  const key = acceptanceKey(strategy, gate);
  const template = ACCEPTANCE_TEMPLATES.get(key);
  if (!template) {
    throw new Error(
      `handoff-envelope: no acceptance template for strategy "${strategy}" + gate "${gate}". ` +
      `Known combos: ${[...ACCEPTANCE_TEMPLATES.keys()].join(", ")}`
    );
  }
  return template;
}

// ---------------------------------------------------------------------------
// cwd derivation
// ---------------------------------------------------------------------------

function deriveCwd(bundle, options = {}) {
  if (options.worktreeCwd && typeof options.worktreeCwd === "string" && options.worktreeCwd.trim().length > 0) {
    return options.worktreeCwd.trim();
  }

  const root = options.repoRoot && typeof options.repoRoot === "string"
    ? options.repoRoot.trim()
    : null;

  const artifact = bundle?.activeArtifact ?? bundle?.canonicalState?.target ?? {};
  const kind = normalizeTargetKind(artifact.kind);

  if (root) {
    const slug = buildWorktreeSlug(artifact, kind);
    if (slug) {
      return `${root}/tmp/worktrees/${slug}`;
    }
  }

  return null;
}

function flattenSlugSegment(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
}

function buildWorktreeSlug(artifact, kind) {
  if (kind === DEV_LOOP_TARGET_KIND.ISSUE && Number.isInteger(artifact.issue) && artifact.issue > 0) {
    const branch = normalizeString(artifact.branch);
    return branch ? `issue-${artifact.issue}-${flattenSlugSegment(branch)}` : `issue-${artifact.issue}`;
  }
  if (kind === DEV_LOOP_TARGET_KIND.PR && Number.isInteger(artifact.pr) && artifact.pr > 0) {
    const branch = normalizeString(artifact.branch);
    return branch ? `pr-${artifact.pr}-${flattenSlugSegment(branch)}` : `pr-${artifact.pr}`;
  }
  if (kind === DEV_LOOP_TARGET_KIND.LOCAL_BRANCH) {
    const branch = normalizeString(artifact.branch);
    return branch ? flattenSlugSegment(branch) : null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE) {
    const phase = normalizeString(artifact.phase);
    const issue = Number.isInteger(artifact.issue) && artifact.issue > 0 ? artifact.issue : null;
    if (phase && issue) return `phase-${issue}-${flattenSlugSegment(phase)}`;
    if (phase) return `phase-${flattenSlugSegment(phase)}`;
    if (issue) return `issue-${issue}`;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// gateState normalization
// ---------------------------------------------------------------------------

function normalizeGateState(gateState) {
  const gs = gateState ?? {};

  return {
    currentHeadSha: normalizeStringOrNull(gs.currentHeadSha) ?? null,
    ciStatus: normalizeStringOrNull(gs.ciStatus) ?? null,
    unresolvedThreadCount: normalizePositiveInt(gs.unresolvedThreadCount) ?? 0,
    copilotRoundCount: normalizePositiveInt(gs.copilotRoundCount) ?? 0,
    currentSubGate: normalizeString(gs.currentSubGate) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Sub-gate resolution
// ---------------------------------------------------------------------------

function resolveSubGate(strategy, gateState) {
  if (strategy === INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP) {
    const sub = gateState.currentSubGate;
    if (sub === "draft" || sub === "watch" || sub === "pre-approval") return sub;
    return "draft";
  }
  return "default";
}


// ---------------------------------------------------------------------------
// Deep freeze helper
// ---------------------------------------------------------------------------

function deepFreeze(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic handoff envelope from resolver output + settings + gate state.
 */
export function buildDevLoopHandoffEnvelope(resolverOutput, settings, gateState = {}, options = {}, now = null) {
  if (!resolverOutput || typeof resolverOutput !== "object") {
    throw new Error("handoff-envelope: resolverOutput is required and must be an object");
  }

  const bundle = resolverOutput.bundle ?? resolverOutput;
  const strategy = requireString(bundle.selectedStrategy, "resolverOutput.selectedStrategy");
  const executionMode = requireString(bundle.executionMode, "resolverOutput.executionMode");
  const nextAction = requireString(bundle.nextAction, "resolverOutput.nextAction");

  const repo = normalizeRepo(options.repoSlug ?? bundle.repoSlug ?? bundle.repo);
  if (!repo) throw new Error("handoff-envelope: repo slug is required (owner/name)");

  const gs = normalizeGateState(gateState);
  const subGate = resolveSubGate(strategy, gs);

  const target = deriveTarget(bundle, repo);
  const requiredReads = deriveRequiredReads(bundle, resolverOutput);
  const stopRules = deriveStopRules(settings, strategy);
  const gateConfig = deriveGateConfig(settings, subGate);
  const derivedCwd = deriveCwd(bundle, { repoRoot: options.repoRoot, worktreeCwd: options.worktreeCwd });
  const template = lookupAcceptanceTemplate(strategy, subGate);

  const overrides = options.overrides && typeof options.overrides === "object" && Object.keys(options.overrides).length > 0
    ? { ...options.overrides }
    : undefined;

  // Surface the *effective* async-start posture alongside the *configured* one (#834). The
  // configured `asyncStartMode` is echoed verbatim from settings (back-compat), but the contract
  // is relaxed at validation time under the Claude harness (resolveEffectiveAsyncStartMode →
  // "allowed" when CLAUDECODE=1). Without surfacing the effective value, a `required` envelope
  // reads as if it should still block even though the resolver correctly proceeds.
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const configuredAsyncStartMode = settings?.workflow?.asyncStartMode ?? "required";
  const effectiveAsyncStartMode = resolveEffectiveAsyncStartMode(configuredAsyncStartMode, env);
  const asyncStartRelaxedBy = effectiveAsyncStartMode !== configuredAsyncStartMode ? "claude-harness" : null;

  const envelope = {
    handoffVersion: ENVELOPE_HANDOFF_VERSION,
    derivedAt: (now ?? new Date()).toISOString(),

    target,
    currentGate: subGate,
    currentHeadSha: gs.currentHeadSha,
    ciStatus: gs.ciStatus,
    unresolvedThreadCount: gs.unresolvedThreadCount,
    copilotRoundCount: gs.copilotRoundCount,
    maxCopilotRounds: settings?.refinement?.maxCopilotRounds ?? 5,
    executionMode,

    nextAction,
    requiredReads,

    stopRules,
    asyncStartMode: configuredAsyncStartMode,
    asyncStartEffective: effectiveAsyncStartMode,
    asyncStartRelaxedBy,
    requireDraftFirst: settings?.workflow?.requireDraftFirst ?? false,

    cwd: derivedCwd,
    worktreeRequired: true,

    acceptance: {
      criteria: [...template.criteria],
      evidence: [...template.evidence],
      maxFinalizationTurns: template.maxFinalizationTurns,
    },

    control: {
      needsAttentionAfterMs: template.needsAttentionAfterMs,
      activeNoticeAfterMs: template.activeNoticeAfterMs,
    },
  };

  if (gateConfig) {
    envelope.gateConfig = gateConfig;
  }

  if (overrides) {
    envelope.overrides = overrides;
  }

  // Optional refinement contract (AC/DoD matrix) from the refiner.
  // Set via options.refinementContract, bundle.refinementContract, or resolverOutput.refinementContract.
  const refinementContract = options.refinementContract ?? bundle.refinementContract ?? resolverOutput.refinementContract ?? null;
  if (refinementContract != null) {
    envelope.refinementContract = refinementContract;
  }

  return deepFreeze(envelope);
}

// ---------------------------------------------------------------------------
// Consumer-side validation
// ---------------------------------------------------------------------------

const VALID_TARGET_KINDS = Object.freeze(["issue", "pr", "local_branch", "local_phase"]);
const VALID_EXECUTION_MODES = Object.freeze(["bounded_handoff", "durable_auto"]);
const VALID_ASYNC_START_MODES = Object.freeze(["required", "allowed"]);

/**
 * Validate a handoff envelope on the consumer side before reading requiredReads
 * or executing nextAction. Returns `{ ok: true, errors: [], warnings?: [...] }` for valid envelopes, or
 * `{ ok: false, errors, warnings? }` with structured field-level error details
 * for malformed envelopes.
 *
 * Rejects envelopes with:
 *   - Missing or wrong-type root fields (handoffVersion, target, nextAction,
 *     requiredReads, acceptance, stopRules)
 *   - Missing required sub-fields (target.kind, target.repo, acceptance.criteria)
 *   - Malformed acceptance criteria entries
 *   - Wrong handoffVersion (negative/non-integer; version mismatch produces a warning)
 *   - Type errors in requiredReads, stopRules, etc.
 *
 * Does not throw — always returns a structured result.
 */
export function validateHandoffEnvelope(envelope) {
  const errors = [];
  const warnings = [];

  // ----- structural check -----
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return {
      ok: false,
      errors: [{ field: "_root", reason: "envelope must be a non-null, non-array object", got: envelope }],
    };
  }

  // ----- handoffVersion -----
  if (!Number.isInteger(envelope.handoffVersion) || envelope.handoffVersion < 1) {
    errors.push({
      field: "handoffVersion",
      reason: `must be a positive integer (current: ${ENVELOPE_HANDOFF_VERSION})`,
      got: envelope.handoffVersion,
    });
  } else if (envelope.handoffVersion !== ENVELOPE_HANDOFF_VERSION) {
    warnings.push({
      field: "handoffVersion",
      reason: `expected version ${ENVELOPE_HANDOFF_VERSION}, got ${envelope.handoffVersion}`,
    });
  }

  // ----- target -----
  if (!envelope.target || typeof envelope.target !== "object" || Array.isArray(envelope.target)) {
    errors.push({ field: "target", reason: "must be a non-array object with kind and repo", got: envelope.target });
  } else {
    if (!envelope.target.kind || !VALID_TARGET_KINDS.includes(envelope.target.kind)) {
      errors.push({
        field: "target.kind",
        reason: `must be one of: ${VALID_TARGET_KINDS.join(", ")}`,
        got: envelope.target.kind,
      });
    }
    if (typeof envelope.target.repo !== "string" || !envelope.target.repo.includes("/")) {
      errors.push({
        field: "target.repo",
        reason: "must be a non-empty owner/name string",
        got: envelope.target.repo,
      });
    } else {
      let normalized;
      try {
        normalized = normalizeRepoSlug(envelope.target.repo);
      } catch (_e) {
        normalized = null;
      }
      if (!normalized || normalized !== envelope.target.repo) {
        errors.push({
          field: "target.repo",
          reason: "must be a valid normalized repo slug (owner/name)",
          got: envelope.target.repo,
        });
      }
    }
    // target-kind specific required fields
    const kind = envelope.target.kind;
    if (kind === "issue") {
      if (!Number.isInteger(envelope.target.issue) || envelope.target.issue < 1) {
        errors.push({ field: "target.issue", reason: "must be a positive integer", got: envelope.target.issue });
      }
    }
    if (kind === "pr") {
      if (!Number.isInteger(envelope.target.pr) || envelope.target.pr < 1) {
        errors.push({ field: "target.pr", reason: "must be a positive integer", got: envelope.target.pr });
      }
    }
    if (kind === "local_branch" && (typeof envelope.target.branch !== "string" || !envelope.target.branch.trim())) {
      errors.push({ field: "target.branch", reason: "required for local_branch target kind", got: envelope.target.branch });
    }
    if (kind === "local_phase") {
      if (!Number.isInteger(envelope.target.issue) || envelope.target.issue < 1) {
        if (typeof envelope.target.phase !== "string" || !envelope.target.phase.trim()) {
          errors.push({ field: "target.phase", reason: "required for local_phase target kind", got: envelope.target.phase });
        }
      }
    }
  }

  // ----- nextAction -----
  if (typeof envelope.nextAction !== "string" || !envelope.nextAction.trim()) {
    errors.push({
      field: "nextAction",
      reason: "must be a non-empty string",
      got: envelope.nextAction,
    });
  }

  // ----- requiredReads -----
  if (!Array.isArray(envelope.requiredReads)) {
    errors.push({ field: "requiredReads", reason: "must be an array", got: envelope.requiredReads });
  } else if (envelope.requiredReads.length === 0) {
    warnings.push({ field: "requiredReads", reason: "array is empty — no files to load" });
  } else {
    const bad = [];
    for (let i = 0; i < envelope.requiredReads.length; i++) {
      if (typeof envelope.requiredReads[i] !== "string" || !envelope.requiredReads[i].trim()) {
        bad.push(i);
      }
    }
    if (bad.length > 0) {
      errors.push({
        field: "requiredReads",
        reason: `entries at indices [${bad.join(",")}] must be non-empty strings`,
        got: envelope.requiredReads,
      });
    }
  }

  // ----- acceptance -----
  if (!envelope.acceptance || typeof envelope.acceptance !== "object" || Array.isArray(envelope.acceptance)) {
    errors.push({ field: "acceptance", reason: "must be a non-array object with criteria array", got: envelope.acceptance });
  } else {
    if (!Array.isArray(envelope.acceptance.criteria)) {
      errors.push({ field: "acceptance.criteria", reason: "must be an array", got: envelope.acceptance.criteria });
    } else if (envelope.acceptance.criteria.length === 0) {
      errors.push({ field: "acceptance.criteria", reason: "must not be empty", got: envelope.acceptance.criteria });
    } else {
      const VALID_SEVERITIES = ["required", "recommended"];
      const bad = [];
      for (let i = 0; i < envelope.acceptance.criteria.length; i++) {
        const c = envelope.acceptance.criteria[i];
        if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id.trim() ||
            typeof c.must !== "string" || !c.must.trim() ||
            typeof c.severity !== "string" || !VALID_SEVERITIES.includes(c.severity)) {
          bad.push(i);
        }
      }
      if (bad.length > 0) {
        errors.push({
          field: "acceptance.criteria",
          reason: `entries at indices [${bad.join(",")}] must have valid id, must, and severity fields`,
          got: envelope.acceptance.criteria,
        });
      }
    }
  }

  // ----- stopRules -----
  if (!Array.isArray(envelope.stopRules)) {
    errors.push({ field: "stopRules", reason: "must be an array", got: envelope.stopRules });
  } else {
    const bad = [];
    for (let i = 0; i < envelope.stopRules.length; i++) {
      if (typeof envelope.stopRules[i] !== "string") {
        bad.push(i);
      }
    }
    if (bad.length > 0) {
      errors.push({
        field: "stopRules",
        reason: `entries at indices [${bad.join(",")}] must be strings`,
        got: envelope.stopRules,
      });
    }
  }

  // ----- executionMode (required field) -----
  if (envelope.executionMode === undefined || envelope.executionMode === null) {
    errors.push({
      field: "executionMode",
      reason: "must be present",
      got: envelope.executionMode,
    });
  } else if (!VALID_EXECUTION_MODES.includes(envelope.executionMode)) {
    errors.push({
      field: "executionMode",
      reason: `must be one of: ${VALID_EXECUTION_MODES.join(", ")}`,
      got: envelope.executionMode,
    });
  }

  // ----- asyncStartMode (required field) -----
  if (envelope.asyncStartMode === undefined || envelope.asyncStartMode === null) {
    errors.push({
      field: "asyncStartMode",
      reason: "must be present",
      got: envelope.asyncStartMode,
    });
  } else if (!VALID_ASYNC_START_MODES.includes(envelope.asyncStartMode)) {
    errors.push({
      field: "asyncStartMode",
      reason: `must be one of: ${VALID_ASYNC_START_MODES.join(", ")}`,
      got: envelope.asyncStartMode,
    });
  }

  // ----- asyncStartEffective (required field; the harness-resolved posture, #834) -----
  if (envelope.asyncStartEffective === undefined || envelope.asyncStartEffective === null) {
    errors.push({
      field: "asyncStartEffective",
      reason: "must be present",
      got: envelope.asyncStartEffective,
    });
  } else if (!VALID_ASYNC_START_MODES.includes(envelope.asyncStartEffective)) {
    errors.push({
      field: "asyncStartEffective",
      reason: `must be one of: ${VALID_ASYNC_START_MODES.join(", ")}`,
      got: envelope.asyncStartEffective,
    });
  }

  // ----- refinementContract (optional) -----
  if (envelope.refinementContract !== undefined && envelope.refinementContract !== null) {
    if (typeof envelope.refinementContract !== "object" || Array.isArray(envelope.refinementContract)) {
      errors.push({
        field: "refinementContract",
        reason: "if present, must be a non-array object with schema, items, generatedAt, and isComplete",
        got: envelope.refinementContract,
      });
    } else {
      if (envelope.refinementContract.schema !== "ac-dod-matrix/v1") {
        warnings.push({
          field: "refinementContract.schema",
          reason: "expected 'ac-dod-matrix/v1'",
          got: envelope.refinementContract.schema,
        });
      }
      if (!Array.isArray(envelope.refinementContract.items) || envelope.refinementContract.items.length === 0) {
        errors.push({
          field: "refinementContract.items",
          reason: "must be a non-empty array of AC/DoD matrix items",
          got: envelope.refinementContract.items,
        });
      } else {
        const bad = [];
        for (let i = 0; i < envelope.refinementContract.items.length; i++) {
          const item = envelope.refinementContract.items[i];
          if (
            !item || typeof item !== "object" ||
            typeof item.item !== "string" || !item.item.trim() ||
            !["AC", "DoD", "Non-goal"].includes(item.type) ||
            !["Met", "Partial", "Unmet", "Unverified"].includes(item.status) ||
            typeof item.evidence !== "string" ||
            typeof item.notes !== "string"
          ) {
            bad.push(i);
          }
        }
        if (bad.length > 0) {
          errors.push({
            field: "refinementContract.items",
            reason: `entries at indices [${bad.join(",")}] must have valid item, type, status, evidence, and notes fields`,
            got: envelope.refinementContract.items,
          });
        }
      }
      if (typeof envelope.refinementContract.generatedAt !== "string" || isNaN(Date.parse(envelope.refinementContract.generatedAt))) {
        errors.push({
          field: "refinementContract.generatedAt",
          reason: "must be a valid ISO 8601 timestamp",
          got: envelope.refinementContract.generatedAt,
        });
      }
      if (typeof envelope.refinementContract.isComplete !== "boolean") {
        errors.push({
          field: "refinementContract.isComplete",
          reason: "must be a boolean",
          got: envelope.refinementContract.isComplete,
        });
      } else if (envelope.refinementContract.items && Array.isArray(envelope.refinementContract.items)) {
        const allMet = envelope.refinementContract.items.every(
          (item) => item && typeof item === "object" && item.status === "Met"
        );
        if (envelope.refinementContract.isComplete !== allMet) {
          errors.push({
            field: "refinementContract.isComplete",
            reason: "must match items status (true iff every item has status 'Met')",
            got: { isComplete: envelope.refinementContract.isComplete, allItemsMet: allMet },
          });
        }
      }
    }
  }

  // ----- derivedAt (informational, warn on missing) -----
  if (typeof envelope.derivedAt !== "string" || !envelope.derivedAt.trim()) {
    warnings.push({ field: "derivedAt", reason: "should be an ISO 8601 timestamp" });
  }

  return {
    ok: errors.length === 0,
    errors,
    ...(warnings.length > 0 && { warnings }),
  };
}

export {
  ACCEPTANCE_TEMPLATES,
  ENVELOPE_HANDOFF_VERSION,
  STRATEGY_DEFAULT_STOP_RULES,
  acceptanceKey,
  deriveTarget,
  deriveStopRules,
  deriveGateConfig,
  deriveCwd,
  deriveRequiredReads,
  normalizeGateState,
  resolveSubGate,
  lookupAcceptanceTemplate,
  buildWorktreeSlug,
  flattenSlugSegment,
};
