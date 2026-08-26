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
import { trimmedOrNull } from "./normalize.mjs";
import { resolveEffectiveAsyncStartMode } from "./async-start-contract.mjs";
import { resolveGateAngleContract, resolveGateAngles, resolveGateConfig, resolveHumanMergeOnly } from "../config/config.mjs";

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
  [INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW]: [
    "no-product-code-writes",
    "worktree-only",
    "outward-review-pending",
    "ack-destructive-migrations",
    "merge",
  ],
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
    { id: "clean-verdict", must: "Pre-approval gate must return clean verdict (no findings at a severity in the gate's configured blockCleanOnFindingSeverities, high by default).", severity: "required" },
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

// local_implementation · spike run (SPIKE-RELAXED-GATE-PROFILE, #1628): a
// spike-mode spin resolves the relaxed `spike` gate profile instead of the
// default local-implementation gate. Kept as its own acceptance key so the
// generic default can stay approach-agnostic.
register(INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION, "spike", {
  criteria: [
    { id: "spike-recorded", must: "The spike exploration and its recommendation are recorded (spike file + summary).", severity: "required" },
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

// ui_review — running-app review sibling of reviewer/fixer. Scaffold slice:
// self-validation only, no drive/report/provision/boot logic. The criteria
// capture the route-specific review boundaries (no product-code writes,
// worktree isolation, outward review stays pending/draft, destructive
// migrations acknowledged before running) so the dispatched agent self-checks
// them; the generic finalization stop rules (e.g. merge) are layered on
// separately and are not restated here.
register(INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW, "default", {
  criteria: [
    { id: "no-product-code-writes", must: "No product code is written; the UI-review route only observes and reports on the running app.", severity: "required" },
    { id: "worktree-only", must: "All work stays inside the isolated worktree; nothing is written outside it.", severity: "required" },
    { id: "outward-review-pending", must: "Any outward review stays pending/draft; no approval or merge is emitted from the UI-review route.", severity: "required" },
    { id: "ack-destructive-migrations", must: "Destructive migrations are explicitly acknowledged before they are run.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output"],
  maxFinalizationTurns: 4,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
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

function requireString(v, label) {
  const s = trimmedOrNull(v);
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
    const branch = trimmedOrNull(artifact.branch);
    if (!branch) throw new Error("handoff-envelope: local_branch target must include a non-empty branch name");
    target.branch = branch;
    if (Number.isInteger(artifact.issue) && artifact.issue > 0) target.issue = artifact.issue;
  } else if (kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE) {
    const phase = trimmedOrNull(artifact.phase);
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
  const base = (settings?.autonomy?.stopAt && Array.isArray(settings.autonomy.stopAt))
    ? [...settings.autonomy.stopAt]
    : [...(STRATEGY_DEFAULT_STOP_RULES[strategy] ?? [])];
  // Fail closed: humanMergeOnly forces "merge" into the dispatched agent's
  // stopRules regardless of configured stopAt, mirroring the authoritative
  // resolveAutonomyStopAt(config) invariant. Without this, a custom
  // stopAt that omits "merge" (e.g. [] or ["draft-pr"]) would tell the agent
  // NOT to stop at merge — a direct humanMergeOnly bypass.
  if (resolveHumanMergeOnly(settings) && !base.includes("merge")) {
    base.push("merge");
  }
  return base;
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
// specSource derivation (issue #1025 — lightweight PR-body-as-spec)
// ---------------------------------------------------------------------------

/**
 * The LOCAL-FIRST spec-source subset the envelope distinguishes: phase_doc vs
 * pr_body. This is NOT the full `canonicalSpecSource` value space — the same
 * field name also carries "tracker_issue" in the tracker-backed mode
 * (scripts/github/resolve-tracker-local-spec.mjs), which the envelope does not
 * model (deriveSpecSource coerces it to null).
 */
// Distinct from refinementArtifact.specSource (linked_issue|pr_body|plan_file,
// REFINEMENT_ARTIFACT_SPEC_SOURCE in packages/core/src/loop/pr-gate-coordination.mjs):
// same field name, different object, different value space — intentionally separate enums.
export const CANONICAL_SPEC_SOURCE = Object.freeze({
  PHASE_DOC: "phase_doc",
  PR_BODY: "pr_body",
});

/**
 * Derive the canonical spec source. Prefer the resolver-output-level field,
 * fall back to bundle-level (mirrors deriveRequiredReads). Returns null when
 * absent so the default (phase-doc) path carries no specSource field and stays
 * byte-identical. Any value outside the local-first subset {phase_doc, pr_body}
 * — e.g. the tracker-backed "tracker_issue" carried by the same field name — is
 * coerced to null so the envelope can never set a specSource that
 * validateHandoffEnvelope would then reject.
 */
function deriveSpecSource(bundle, resolverOutput) {
  const raw = trimmedOrNull(resolverOutput?.canonicalSpecSource)
    ?? trimmedOrNull(bundle?.canonicalSpecSource);
  return raw === CANONICAL_SPEC_SOURCE.PHASE_DOC || raw === CANONICAL_SPEC_SOURCE.PR_BODY ? raw : null;
}

/**
 * Apply the spec-source variant to acceptance criteria. Under the lightweight
 * PR-body-as-spec path the phase-doc criterion text is retargeted to the PR
 * description; the default (null/phase_doc) path returns the criteria verbatim
 * so the phase-doc template text stays identical.
 */
function applySpecSourceVariant(criteria, specSource) {
  // ponytail: free-text substring retarget is a no-op for any strategy whose
  // criteria lack the phase-doc phrase — fine while lightweight only composes
  // with local_implementation; make it a structured criterion-id lookup if
  // lightweight is ever extended to another strategy.
  if (specSource !== CANONICAL_SPEC_SOURCE.PR_BODY) return [...criteria];
  return criteria.map((c) => ({
    ...c,
    must: c.must.replace("from the active phase doc", "from the PR description"),
  }));
}

// ---------------------------------------------------------------------------
// Gate config derivation
// ---------------------------------------------------------------------------

function deriveGateConfig(settings, subGate) {
  const gateKey = subGate === "pre-approval" ? "preApproval" : subGate;
  if (!settings?.gates?.[gateKey]) return undefined;

  // Route through the canonical resolvers rather than re-parsing
  // gates.<gate>.angles by hand: resolveGateConfig folds the unified
  // angle-entry shape (mandatory/enabled per-entry, D3) into excludeAngles/
  // blockCleanOnFindingSeverities/requireCi, the envelope contract's
  // long-standing shape. `angles` is the RUN-set (the configured angles the
  // orchestrator is told to dispatch) with every validator-MANDATORY angle
  // merged in — never resolveGateAngleContract's `pool`, which is the
  // enforcement CEILING and deliberately widens to the whole lens catalog
  // under gates.<gate>.dynamic.additive (advertising that as the run-set
  // would tell the orchestrator to dispatch 20+ angles). The parity contract
  // (test/contracts/envelope-validator-angle-parity.test.mjs) pins both
  // invariants: everything advertised is within the validator pool, and
  // every mandatory angle is advertised.
  const resolved = resolveGateConfig(settings, gateKey);
  const { mandatoryAngles } = resolveGateAngleContract(settings, gateKey);
  const runSet = resolveGateAngles(settings, gateKey) ?? [];
  const angles = [...new Set([...runSet, ...mandatoryAngles])];
  return {
    angles,
    excludeAngles: resolved.excludeAngles.length > 0 ? resolved.excludeAngles : undefined,
    blockCleanOnFindingSeverities: resolved.blockCleanOnFindingSeverities,
    requireCi: resolved.requireCi,
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
    // issue/pr go through the single source of truth (resolveWorktreePath); other
    // slug kinds (local_branch/local_phase) still use the namespace + slug.
    if (kind === DEV_LOOP_TARGET_KIND.ISSUE && Number.isInteger(artifact.issue) && artifact.issue > 0) {
      return resolveWorktreePath({ repoRoot: root, kind: "issue", number: artifact.issue });
    }
    if (kind === DEV_LOOP_TARGET_KIND.PR && Number.isInteger(artifact.pr) && artifact.pr > 0) {
      return resolveWorktreePath({ repoRoot: root, kind: "pr", number: artifact.pr });
    }
    const slug = buildWorktreeSlug(artifact, kind);
    if (slug) {
      return `${root}/${WORKTREE_NAMESPACE}/${slug}`;
    }
  }

  return null;
}

/** Repo-relative root for loop-owned worktrees. The `dev-loops/` namespace */
/** marks them so cleanup can only ever remove its own (issue #909). */
export const WORKTREE_NAMESPACE = "tmp/worktrees/dev-loops";

/**
 * Resolve the canonical, namespaced worktree path for an issue/PR. Sole source
 * of truth shared by create, provision, and cleanup. No branch suffix, so the
 * path is recomputable from the issue/PR number alone.
 *
 * @param {{ repoRoot: string, kind: "issue"|"pr", number: number }} args
 * @returns {string} Absolute path `<repoRoot>/tmp/worktrees/dev-loops/<kind>-<number>`
 */
export function resolveWorktreePath({ repoRoot, kind, number } = {}) {
  const root = trimmedOrNull(repoRoot);
  if (!root) throw new Error("resolveWorktreePath: repoRoot is required and must be a non-empty string");
  const k = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  if (k !== DEV_LOOP_TARGET_KIND.ISSUE && k !== DEV_LOOP_TARGET_KIND.PR) {
    throw new Error(`resolveWorktreePath: kind must be "issue" or "pr", got "${kind}"`);
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`resolveWorktreePath: number must be a positive integer, got ${number}`);
  }
  return `${root}/${WORKTREE_NAMESPACE}/${k}-${number}`;
}

function flattenSlugSegment(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
}

function buildWorktreeSlug(artifact, kind) {
  // Canonical naming is namespaced + no branch suffix (issue #909) so the path
  // is recomputable from the issue/PR number alone (cleanup can find it).
  if (kind === DEV_LOOP_TARGET_KIND.ISSUE && Number.isInteger(artifact.issue) && artifact.issue > 0) {
    return `issue-${artifact.issue}`;
  }
  if (kind === DEV_LOOP_TARGET_KIND.PR && Number.isInteger(artifact.pr) && artifact.pr > 0) {
    return `pr-${artifact.pr}`;
  }
  if (kind === DEV_LOOP_TARGET_KIND.LOCAL_BRANCH) {
    const branch = trimmedOrNull(artifact.branch);
    return branch ? flattenSlugSegment(branch) : null;
  }
  if (kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE) {
    const phase = trimmedOrNull(artifact.phase);
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
    currentHeadSha: trimmedOrNull(gs.currentHeadSha) ?? null,
    ciStatus: trimmedOrNull(gs.ciStatus) ?? null,
    unresolvedThreadCount: normalizePositiveInt(gs.unresolvedThreadCount) ?? 0,
    copilotRoundCount: normalizePositiveInt(gs.copilotRoundCount) ?? 0,
    currentSubGate: trimmedOrNull(gs.currentSubGate) ?? undefined,
  };
}


/**
 * Normalize the structured retrospective findings (issue #1077, Reading B).
 *
 * The retrospective is advisory: it never blocks merge or any lifecycle
 * transition. Its findings travel in the handoff envelope (the conductor's
 * decision input) and in an advisory PR comment — never on disk as a gate.
 *
 * The source is the `check-retro-tooling.mjs` JSON output shape:
 *   { ok, internalToolingOnly, rawCallViolations, allowedWriteOps }
 *
 * Returns a normalized object carrying the substantive fields, or null when no
 * findings were supplied (the field is optional — present only when the loop
 * subagent ran the retrospective tooling).
 */
function normalizeRetrospectiveFindings(findings) {
  if (findings === null || findings === undefined) return null;
  if (typeof findings !== "object" || Array.isArray(findings)) return null;

  const toStrArray = (v) => Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : String(x)).trim()).filter((x) => x.length > 0)
    : [];

  const internalToolingOnly = findings.internalToolingOnly === true;
  return {
    internalToolingOnly,
    rawCallViolations: toStrArray(findings.rawCallViolations),
    allowedWriteOps: toStrArray(findings.allowedWriteOps),
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

/** True when the resolver output identifies a spike-mode run (#1628). */
function isSpikeRun(resolverOutput) {
  return Boolean(resolverOutput && resolverOutput.spikeIntakeState);
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
  // SPIKE-RELAXED-GATE-PROFILE (#1628): a spike-mode spin (startup resolver
  // result carrying `spikeIntakeState`) resolves the relaxed `spike` gate
  // profile instead of the default local-implementation gate. The spike
  // marker lives at the TOP level of the resolver output (the bundle does not
  // carry it), so it is read off `resolverOutput` directly.
  const subGate = (strategy === INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION && isSpikeRun(resolverOutput))
    ? "spike"
    : resolveSubGate(strategy, gs);
  // Normalize each source independently, then fall back on the normalized result
  // (not the raw value): a present-but-invalid gateState value must NOT shadow a
  // valid options.retrospectiveFindings fallback (issue #1077 review finding).
  const retrospectiveFindings = normalizeRetrospectiveFindings(gateState?.retrospectiveFindings)
    ?? normalizeRetrospectiveFindings(options.retrospectiveFindings);

  const target = deriveTarget(bundle, repo);
  const requiredReads = deriveRequiredReads(bundle, resolverOutput);
  const stopRules = deriveStopRules(settings, strategy);
  const gateConfig = deriveGateConfig(settings, subGate);
  const derivedCwd = deriveCwd(bundle, { repoRoot: options.repoRoot, worktreeCwd: options.worktreeCwd });
  const template = lookupAcceptanceTemplate(strategy, subGate);
  // Lightweight PR-body-as-spec (issue #1025): retarget the phase-doc criterion
  // text to the PR description. Null/phase_doc leaves the criteria untouched, so
  // the non-lightweight path stays byte-identical.
  const specSource = deriveSpecSource(bundle, resolverOutput);
  const acceptanceCriteria = applySpecSourceVariant(template.criteria, specSource);

  const overrides = options.overrides && typeof options.overrides === "object" && Object.keys(options.overrides).length > 0
    ? { ...options.overrides }
    : undefined;

  // Sanctioned operation → wrapper command map (issue #1081). Core is
  // consumer-agnostic: it carries whatever map the consumer supplies (the
  // `loop build-envelope` CLI injects this repo's scripts/... paths) so every
  // spawned subagent receives it by DEFAULT. Core defines the SHAPE only —
  // it never hardcodes repo-specific paths. A non-object is ignored.
  const sanctionedCommands = options.sanctionedCommands && typeof options.sanctionedCommands === "object" && !Array.isArray(options.sanctionedCommands)
    ? options.sanctionedCommands
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

    target,
    currentGate: subGate,
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
      criteria: acceptanceCriteria,
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

  if (sanctionedCommands) {
    envelope.sanctionedCommands = sanctionedCommands;
  }

  // Advisory retrospective findings (issue #1077, Reading B). Optional structured
  // field carrying the check-retro-tooling.mjs JSON output to the conductor. Never a
  // gate — the conductor surfaces these as an advisory PR comment, not a block.
  if (retrospectiveFindings) {
    envelope.retrospectiveFindings = retrospectiveFindings;
  }

  // Canonical spec source (issue #1025). Optional: only set when the resolver
  // marks a lightweight PR-body-as-spec session, so the default (phase-doc) path
  // carries no specSource field and its envelope stays byte-identical.
  if (specSource) {
    envelope.specSource = specSource;
  }

  // #1462: the ONLY per-round-varying block, kept LAST. Every field here changes
  // between builds/rounds (the timestamp, the head SHA, CI status, thread/round
  // counts); isolating them as the envelope's tail keeps everything above a
  // byte-stable prefix that a fresh reviewer spawn can cache-READ instead of
  // re-billing the full contract scaffolding each round. Consumers must treat
  // gateState as volatile — read it last, or re-derive it fresh via detectors.
  envelope.gateState = {
    derivedAt: (now ?? new Date()).toISOString(),
    currentHeadSha: gs.currentHeadSha,
    ciStatus: gs.ciStatus,
    unresolvedThreadCount: gs.unresolvedThreadCount,
    copilotRoundCount: gs.copilotRoundCount,
  };

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

  // ----- retrospectiveFindings (optional, advisory — issue #1077) -----
  if (envelope.retrospectiveFindings !== undefined && envelope.retrospectiveFindings !== null) {
    const rf = envelope.retrospectiveFindings;
    if (typeof rf !== "object" || Array.isArray(rf)) {
      errors.push({
        field: "retrospectiveFindings",
        reason: "if present, must be a non-array object { internalToolingOnly, rawCallViolations, allowedWriteOps }",
        got: rf,
      });
    } else {
      if (typeof rf.internalToolingOnly !== "boolean") {
        errors.push({ field: "retrospectiveFindings.internalToolingOnly", reason: "must be a boolean", got: rf.internalToolingOnly });
      }
      if (!Array.isArray(rf.rawCallViolations) || rf.rawCallViolations.some((v) => typeof v !== "string")) {
        errors.push({ field: "retrospectiveFindings.rawCallViolations", reason: "must be an array of strings", got: rf.rawCallViolations });
      }
      if (!Array.isArray(rf.allowedWriteOps) || rf.allowedWriteOps.some((v) => typeof v !== "string")) {
        errors.push({ field: "retrospectiveFindings.allowedWriteOps", reason: "must be an array of strings", got: rf.allowedWriteOps });
      }
    }
  }

  // ----- specSource (optional — issue #1025, lightweight PR-body-as-spec) -----
  if (envelope.specSource !== undefined && envelope.specSource !== null) {
    const validSources = [CANONICAL_SPEC_SOURCE.PHASE_DOC, CANONICAL_SPEC_SOURCE.PR_BODY];
    if (typeof envelope.specSource !== "string" || !validSources.includes(envelope.specSource)) {
      errors.push({
        field: "specSource",
        reason: `if present, must be one of ${validSources.join(", ")}`,
        got: envelope.specSource,
      });
    }
  }

  // ----- gateState.derivedAt (informational, warn on missing) — #1462 moved the
  // volatile timestamp into the gateState tail so the rest stays byte-stable -----
  if (typeof envelope.gateState?.derivedAt !== "string" || !envelope.gateState.derivedAt.trim()) {
    warnings.push({ field: "gateState.derivedAt", reason: "should be an ISO 8601 timestamp" });
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
  normalizeRetrospectiveFindings,
  resolveSubGate,
  lookupAcceptanceTemplate,
  buildWorktreeSlug,
  flattenSlugSegment,
};
