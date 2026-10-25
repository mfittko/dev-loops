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
  DEV_LOOP_ISSUE_LINKAGE_RESOLUTION,
  INTERNAL_DEV_LOOP_STRATEGY,
} from "./public-dev-loop-routing-contract.mjs";
import { normalizeRepoSlug } from "../github/repo-slug.mjs";
import { COPILOT_REVIEW_WAIT_TIMEOUT_MS } from "./policy-constants.mjs";
import { posix as posixPath, win32 as win32Path } from "node:path";
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
  [INTERNAL_DEV_LOOP_STRATEGY.REVIEW]: [
    "read-only",
    "one-review-round",
    "no-lifecycle-gate-evidence",
  ],
});

const RECONCILIATION_ACCEPTANCE_TEMPLATE = deepFreeze({
  criteria: [
    { id: "reconcile", must: "Resolve the reported authoritative-state conflict before selecting or executing a strategy.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output"],
  maxFinalizationTurns: 1,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
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
    { id: "clean-verdict", must: "Pre-approval gate must return a clean verdict per GATE-COMMENT-VERDICT-VALUES (an empty judge act list on a fully judged round, and an empty judge act list and no finding at a blockCleanOnFindingSeverities severity on a round that is not fully judged).", severity: "required" },
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
    { id: "validation-green", must: "Targeted validation passes; any required local full validation uses `dev-loops gate resolve-validation`.", severity: "required" },
  ],
  evidence: ["commands-run", "validation-output", "changed-files"],
  maxFinalizationTurns: 6,
  needsAttentionAfterMs: DEFAULT_NEEDS_ATTENTION_MS,
  activeNoticeAfterMs: DEFAULT_ACTIVE_NOTICE_MS,
});

// local_implementation · spike run (SPIKE-RELAXED-GATE-PROFILE): a
// spike-mode spin resolves the relaxed `spike` gate profile instead of the
// default local-implementation gate. Kept as its own acceptance key so the
// generic default can stay approach-agnostic.
register(INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION, "spike", {
  criteria: [
    { id: "spike-recorded", must: "The spike exploration and its recommendation are recorded (spike file + summary).", severity: "required" },
    { id: "validation-green", must: "Targeted validation passes; any required local full validation uses `dev-loops gate resolve-validation`.", severity: "required" },
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

register(INTERNAL_DEV_LOOP_STRATEGY.REVIEW, "default", {
  criteria: [
    { id: "read-only", must: "Review the current PR without claiming it, pushing, fixing, committing, moving a board item, or changing lifecycle state.", severity: "required" },
    { id: "informational-only", must: "Run one informational review-gate round that never satisfies draft_gate or pre_approval_gate evidence.", severity: "required" },
  ],
  evidence: ["review-findings", "manual-notes"],
  maxFinalizationTurns: 1,
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
    // An issue target's PR arrives as `linkedPr`, never `pr`: the router refuses an issue
    // target carrying `pr` (and re-targets an issue with a linked PR to the PR kind), so a
    // forwarding of `artifact.pr` here would be an unreachable input with no AC row behind it.
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
// specSource derivation — lightweight PR-body-as-spec
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

/**
 * The one canonical spelling of a repo root: separators unified to `/` and
 * redundant segments folded away (a trailing `/`, a trailing `/.`, a doubled
 * separator inside the path) EXCEPT where the fold would destroy the root's own
 * shape — a network share's significant leading `//` and a drive-rooted prefix
 * survive, because the path they name cannot be re-derived from a root-relative
 * one. One logical repo state must yield one `cwd` byte sequence, because a
 * consumer exact-matches this path against the real worktree (issue 2532).
 */
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

function canonicalRepoRoot(root) {
  // Decide the root's SHAPE from the raw input BEFORE touching separators: `\` is a legal
  // POSIX filename character, so unifying it on a POSIX root names a DIFFERENT directory.
  const windowsShaped = WINDOWS_ROOT.test(root) || root.startsWith("//");
  const unified = windowsShaped ? root.replace(/\\/g, "/") : root;
  // Pick the normalizer from that shape. A drive-rooted or UNC root keeps Windows semantics:
  // `posix.normalize` folds a network share's significant leading `//` into a root-relative
  // POSIX path, and the suffix logic below cannot repair it afterwards. Every other root
  // normalizes as POSIX.
  const normalized = windowsShaped
    ? win32Path.normalize(unified).replace(/\\/g, "/")
    : posixPath.normalize(unified);
  // Both normalizers PRESERVE a trailing separator, which would defeat the suffix
  // comparison below, so strip it here while keeping the root separator itself.
  const stripped = normalized.replace(/\/+$/u, "");
  if (stripped.length === 0) return normalized;
  // A bare drive (`C:`) is drive-RELATIVE: it names the current directory on that drive,
  // not the drive root. Keep the separator that makes it absolute, or the join below emits
  // a path no consumer can exact-match against the real worktree.
  return /^[A-Za-z]:$/u.test(stripped) ? `${stripped}/` : stripped;
}

/**
 * Join segments under an already-canonical root through the path library for the root's
 * SHAPE, never string interpolation. A root that IS a separator (`/`) cannot double it, a
 * drive root (`C:/`) cannot degrade to the drive-relative `C:`, and a network share's
 * significant leading `//` survives. The unified `/` spelling this module emits is restored
 * afterwards, because `win32.join` reintroduces backslashes (issue 2532) — but ONLY for a
 * Windows-shaped root, since a POSIX root's literal `\` is part of the directory name.
 */
function joinUnderRoot(root, ...segments) {
  const windowsShaped = WINDOWS_ROOT.test(root) || root.startsWith("//");
  const joined = (windowsShaped ? win32Path : posixPath).join(root, ...segments);
  return windowsShaped ? joined.replace(/\\/g, "/") : joined;
}

/**
 * The canonical root when `root` IS already the loop-owned worktree for `relative`
 * (`<kind>-<number>` under the namespace, or the non-namespaced `<slug>` layout), else null.
 * A startup run from inside the target's own worktree reports that worktree as its repo root,
 * so appending the namespace again would name a worktree nested inside itself (issue 2532).
 */
function ownedWorktreeRootFor(canonicalRoot, relative) {
  const suffix = `${WORKTREE_NAMESPACE}/${relative}`;
  if (canonicalRoot === suffix || canonicalRoot.endsWith(`/${suffix}`)) return canonicalRoot;
  // AGENTS.md documents the mutating-work layout as `tmp/worktrees/<issue-or-branch-slug>/`, so
  // an existing worktree of that shape is the target's own root too. Recognise the DOCUMENTED
  // shape and nothing looser: the `<relative>` segment under a `worktrees` segment that is itself
  // under a `tmp` segment. Never by bare basename (`/repo/issue-42`) and never by a merely
  // `worktrees`-named ancestor (`/home/worktrees/issue-42`), or a main checkout is named as the
  // unit worktree while the envelope still promises one — the main-branch mutation the layout
  // exists to prevent. Every other root keeps the nested derivation below.
  const segments = canonicalRoot.split("/");
  const relativeSegment = segments.pop();
  const worktreesSegment = segments.pop();
  const tmpSegment = segments.pop();
  return relativeSegment === relative && worktreesSegment === "worktrees" && tmpSegment === "tmp"
    ? canonicalRoot
    : null;
}

function deriveCwd(bundle, options = {}) {
  if (options.worktreeCwd && typeof options.worktreeCwd === "string" && options.worktreeCwd.trim().length > 0) {
    // The sibling input channel gets the SAME canonicalization: one logical repo root keeps
    // one `cwd` spelling whichever option named it, or a consumer that exact-matches `cwd`
    // against the real worktree gets two answers for one root (issue 2532).
    return canonicalRepoRoot(options.worktreeCwd.trim());
  }

  const rawRoot = options.repoRoot && typeof options.repoRoot === "string"
    ? options.repoRoot.trim()
    : null;
  // Normalize ONCE, then hand the same value to every branch: an un-normalized but
  // equivalent root (`/repo//tmp/...`, a trailing `/.`) must never fall through to a
  // second appended namespace, and must never emit a `//`-joined path.
  const root = rawRoot ? canonicalRepoRoot(rawRoot) : null;

  const artifact = bundle?.activeArtifact ?? bundle?.canonicalState?.target ?? {};
  const kind = normalizeTargetKind(artifact.kind);

  if (root) {
    // Tracker-local routing synthesizes a phase without changing issue acquisition identity.
    const trackerLocalIssue = kind === DEV_LOOP_TARGET_KIND.LOCAL_PHASE
      && bundle.selectedStrategy === INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION
      && bundle.issueLinkageResolution === DEV_LOOP_ISSUE_LINKAGE_RESOLUTION.RESOLVED_NO_OPEN_PR
      && artifact.phase === `issue-${artifact.issue}`;
    if ((kind === DEV_LOOP_TARGET_KIND.ISSUE || trackerLocalIssue) && Number.isInteger(artifact.issue) && artifact.issue > 0) {
      return ownedWorktreeRootFor(root, `issue-${artifact.issue}`)
        ?? resolveWorktreePath({ repoRoot: root, kind: "issue", number: artifact.issue });
    }
    if (kind === DEV_LOOP_TARGET_KIND.PR && Number.isInteger(artifact.pr) && artifact.pr > 0) {
      return ownedWorktreeRootFor(root, `pr-${artifact.pr}`)
        ?? resolveWorktreePath({ repoRoot: root, kind: "pr", number: artifact.pr });
    }
    const slug = buildWorktreeSlug(artifact, kind);
    if (slug) {
      return ownedWorktreeRootFor(root, slug) ?? joinUnderRoot(root, WORKTREE_NAMESPACE, slug);
    }
  }

  return null;
}

/** Repo-relative root for loop-owned worktrees. The `dev-loops/` namespace */
/** marks them so cleanup can only ever remove its own. */
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
  return joinUnderRoot(canonicalRepoRoot(root), WORKTREE_NAMESPACE, `${k}-${number}`);
}

function flattenSlugSegment(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
}

function buildWorktreeSlug(artifact, kind) {
  // Canonical naming is namespaced + no branch suffix so the path
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
// unit-boundary derivation (issue 2532)
// ---------------------------------------------------------------------------

/**
 * Deterministic hand-back boundaries for one unit coordinator. A unit runs one
 * phase and stops at the next boundary; the orchestrator only emits and dispatches
 * the successor's work order, and the successor re-resolves startup against
 * authoritative state (never a brief authored by the predecessor).
 * The vocabulary is closed so a fixture can assert the exact set.
 */
export const UNIT_BOUNDARY = Object.freeze({
  DRAFT_PR_OPENED: "draft_pr_opened",
  GATE_VERDICT_POSTED: "gate_verdict_posted",
});

// Routes that own no phase to hand back from: `review` and `ui_review` run one
// read-only round and produce no lifecycle gate evidence, and `wait_watch`
// produces no unit at all. This is an explicit, named list — the same three
// read/observe strategies the routing contract's ownership map exempts
// (`STRATEGY_OWNERSHIP_GATE` in `scripts/loop/resolve-dev-loop-startup.mjs`) — not a
// derivation from that map, so adding a read-only route means adding it here too.
// A boundary for one of these routes would contradict its own stop rules.
// Exported so the contract test can assert this list stays in step with that classification
// (issue 2532): the hand-maintenance ADR 0181 accepts is only safe while drift is detectable.
export const STATELESS_UNIT_STRATEGIES = Object.freeze([
  INTERNAL_DEV_LOOP_STRATEGY.REVIEW,
  INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW,
  INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH,
]);

/**
 * Derive the unit coordinator's hand-back boundaries from the route the envelope
 * already carries. Nothing here comes from a predecessor: `resume` names the
 * sanctioned re-resolution a successor runs against authoritative state.
 * Returns undefined for a route that has no unit to hand back (terminal
 * reconciliation, read-only review or ui-review, wait) so the field never
 * contradicts the route's own stop rules.
 */
function deriveUnitBoundaries(strategy, target) {
  if (strategy === null || STATELESS_UNIT_STRATEGIES.includes(strategy)) return undefined;
  const boundaries = [];
  // A unit that owns no PR yet ends its phase by opening the draft PR. `target.pr` is
  // already the PR kind's identity, so the bound-PR arm needs no spelling out; the
  // only linked-PR source the envelope can carry is an issue artifact's `linkedPr`.
  // The local kinds forward no linked PR: no shipped producer puts one on their
  // artifacts, so every routed local unit stops at the draft PR it opens.
  const ownsPr = target.kind === DEV_LOOP_TARGET_KIND.PR
    || (Number.isInteger(target.linkedPr) && target.linkedPr > 0);
  if (!ownsPr) boundaries.push(UNIT_BOUNDARY.DRAFT_PR_OPENED);
  // Every unit that runs a gate round hands back after its verdict is posted.
  boundaries.push(UNIT_BOUNDARY.GATE_VERDICT_POSTED);
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    handBackAfter: boundaries,
    // A resume carries every identity the target carries, not an exclusive one: each field
    // below is copied independently, so the dominant issue-plus-linked-PR route emits both
    // `issue` and `pr` (the router re-targets that target to the PR route in
    // `toRoutableCanonicalState`, and `deriveTarget` above keeps the issue as the PR unit's
    // cross-link). There is no XOR here and no precedence rule to apply; the validator
    // requires only a non-empty, well-typed set. A phase label identifies the artifact — the
    // no-number case when the target carries no issue, pr or branch; which startup mode
    // re-resolves it (`--plan-file`, `--spike`, the lightweight path), like the single identity
    // flag a successor passes, is that successor's own route input, never something the
    // predecessor decides by writing this field.
    resume: {
      kind: "loop_startup",
      issue: Number.isInteger(target.issue) && target.issue > 0 ? target.issue : null,
      pr: Number.isInteger(target.pr) && target.pr > 0 ? target.pr : null,
      branch: text(target.branch),
      // A phase-only target carries no issue, PR or branch: the phase label IS the identity
      // of the artifact a successor re-resolves. A `local_phase` target may also keep an
      // issue (its label is then `issue-<n>`), so this field never implies the others are
      // unset.
      phase: text(target.phase),
    },
  };
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
 * Normalize the structured retrospective findings.
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

/** True when the resolver output identifies a spike-mode run. */
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

  const isWrapped = Object.hasOwn(resolverOutput, "bundle");
  if (isWrapped && (!resolverOutput.bundle || typeof resolverOutput.bundle !== "object")) {
    throw new Error("handoff-envelope: resolverOutput.bundle must be an object when present");
  }
  const bundle = isWrapped ? resolverOutput.bundle : resolverOutput;
  const strategy = bundle.selectedStrategy === null
    ? null
    : requireString(bundle.selectedStrategy, "resolverOutput.selectedStrategy");
  const routeKind = strategy === null
    ? requireString(bundle.routeKind, "resolverOutput.routeKind")
    : (trimmedOrNull(bundle.routeKind) ?? "route");
  const selectedGate = trimmedOrNull(bundle.selectedGate);
  const outerBundleKind = isWrapped ? trimmedOrNull(resolverOutput.bundleKind) : null;
  const nestedBundleKind = trimmedOrNull(bundle.bundleKind);
  if (outerBundleKind && nestedBundleKind && outerBundleKind !== nestedBundleKind) {
    throw new Error(`handoff-envelope: outer bundleKind (${outerBundleKind}) and inner bundleKind (${nestedBundleKind}) must agree`);
  }
  const bundleKind = outerBundleKind ?? nestedBundleKind;
  const isReconciliation = routeKind === "needs_reconcile"
    && strategy === null
    && selectedGate === "fail_closed_reconcile"
    && bundleKind === "needs_reconcile";
  if (isWrapped && isReconciliation && (
    resolverOutput.bundleKind !== "needs_reconcile"
    || bundle.bundleKind !== "needs_reconcile"
    || resolverOutput.selectedStrategy !== "none"
    || bundle.selectedStrategy !== null
  )) {
    throw new Error("handoff-envelope: wrapped needs_reconcile output requires exact outer and inner bundleKind needs_reconcile markers, outer selectedStrategy none, and inner selectedStrategy null");
  }
  if (bundleKind === "needs_reconcile" && !isReconciliation) {
    throw new Error("handoff-envelope: outer/inner bundleKind needs_reconcile requires inner routeKind needs_reconcile, selectedGate fail_closed_reconcile, and selectedStrategy null");
  }
  if (routeKind === "needs_reconcile" && !isReconciliation) {
    throw new Error("handoff-envelope: routeKind needs_reconcile requires outer bundleKind needs_reconcile, selectedGate fail_closed_reconcile, and selectedStrategy null");
  }
  if (strategy === null && !isReconciliation) {
    throw new Error("handoff-envelope: a null resolverOutput.selectedStrategy is allowed only for the canonical needs_reconcile/fail_closed_reconcile tuple");
  }
  const executionMode = requireString(bundle.executionMode, "resolverOutput.executionMode");
  const nextAction = requireString(bundle.nextAction, "resolverOutput.nextAction");

  const repo = normalizeRepo(options.repoSlug ?? bundle.repoSlug ?? bundle.repo);
  if (!repo) throw new Error("handoff-envelope: repo slug is required (owner/name)");

  const gs = normalizeGateState(gateState);
  // SPIKE-RELAXED-GATE-PROFILE: a spike-mode spin (startup resolver
  // result carrying `spikeIntakeState`) resolves the relaxed `spike` gate
  // profile instead of the default local-implementation gate. The spike
  // marker lives at the TOP level of the resolver output (the bundle does not
  // carry it), so it is read off `resolverOutput` directly.
  const subGate = isReconciliation
    ? selectedGate
    : (strategy === INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION && isSpikeRun(resolverOutput))
    ? "spike"
    : resolveSubGate(strategy, gs);
  // Normalize each source independently, then fall back on the normalized result
  // (not the raw value): a present-but-invalid gateState value must NOT shadow a
  // valid options.retrospectiveFindings fallback.
  const retrospectiveFindings = normalizeRetrospectiveFindings(gateState?.retrospectiveFindings)
    ?? normalizeRetrospectiveFindings(options.retrospectiveFindings);

  const target = deriveTarget(bundle, repo);
  const requiredReads = deriveRequiredReads(bundle, resolverOutput);
  const stopRules = isReconciliation
    ? ["reconcile", ...(resolveHumanMergeOnly(settings) ? ["merge"] : [])]
    : deriveStopRules(settings, strategy);
  const gateConfig = deriveGateConfig(settings, subGate);
  const derivedCwd = deriveCwd(bundle, { repoRoot: options.repoRoot, worktreeCwd: options.worktreeCwd });
  const template = isReconciliation
    ? RECONCILIATION_ACCEPTANCE_TEMPLATE
    : lookupAcceptanceTemplate(strategy, subGate);
  // Lightweight PR-body-as-spec: retarget the phase-doc criterion
  // text to the PR description. Null/phase_doc leaves the criteria untouched, so
  // the non-lightweight path stays byte-identical.
  const specSource = deriveSpecSource(bundle, resolverOutput);
  const acceptanceCriteria = applySpecSourceVariant(template.criteria, specSource);

  const overrides = options.overrides && typeof options.overrides === "object" && Object.keys(options.overrides).length > 0
    ? { ...options.overrides }
    : undefined;

  // Sanctioned operation → wrapper command map. Core is
  // consumer-agnostic: it carries whatever map the consumer supplies (the
  // `loop build-envelope` CLI injects this repo's scripts/... paths) so every
  // spawned subagent receives it by DEFAULT. Core defines the SHAPE only —
  // it never hardcodes repo-specific paths. A non-object is ignored.
  const sanctionedCommands = options.sanctionedCommands && typeof options.sanctionedCommands === "object" && !Array.isArray(options.sanctionedCommands)
    ? options.sanctionedCommands
    : undefined;

  // Surface the *effective* async-start posture alongside the *configured* one. The
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

    ...(isReconciliation ? { routeKind, selectedStrategy: null } : {}),

    nextAction,
    requiredReads,

    stopRules,
    asyncStartMode: configuredAsyncStartMode,
    asyncStartEffective: effectiveAsyncStartMode,
    asyncStartRelaxedBy,
    requireDraftFirst: settings?.workflow?.requireDraftFirst ?? false,

    cwd: derivedCwd,
    worktreeRequired: !isReconciliation,

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

  // Unit coordinator hand-back boundaries (issue 2532). Target+strategy derived,
  // so it is byte-stable across builds for the same route.
  const unitBoundaries = deriveUnitBoundaries(isReconciliation ? null : strategy, target);
  if (unitBoundaries) {
    envelope.unitBoundaries = unitBoundaries;
  }

  if (overrides) {
    envelope.overrides = overrides;
  }

  if (sanctionedCommands) {
    envelope.sanctionedCommands = sanctionedCommands;
  }

  // Advisory retrospective findings. Optional structured
  // field carrying the check-retro-tooling.mjs JSON output to the conductor. Never a
  // gate — the conductor surfaces these as an advisory PR comment, not a block.
  if (retrospectiveFindings) {
    envelope.retrospectiveFindings = retrospectiveFindings;
  }

  // Pending retrospectives: copied from the resolved bundle so the
  // orchestrator, which reads the envelope, can dispatch them. Present (even
  // empty) only when the resolver set the field.
  if (Array.isArray(bundle.pendingRetrospectives)) {
    envelope.pendingRetrospectives = bundle.pendingRetrospectives.map((e) => ({ ...e }));
  }

  // Canonical spec source. Optional: only set when the resolver
  // marks a lightweight PR-body-as-spec session, so the default (phase-doc) path
  // carries no specSource field and its envelope stays byte-identical.
  if (specSource) {
    envelope.specSource = specSource;
  }

  // The ONLY per-round-varying block, kept LAST. Every field here changes
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

  // ----- terminal reconciliation tuple -----
  // routeKind/selectedStrategy are omitted for ordinary routed envelopes to
  // preserve the v1 shape. If either is present, both must identify the one
  // supported no-strategy terminal envelope exactly; serialized/tampered
  // envelopes receive the same fail-closed enforcement as the builder.
  const hasRouteKind = Object.hasOwn(envelope, "routeKind");
  const hasSelectedStrategy = Object.hasOwn(envelope, "selectedStrategy");
  if (hasRouteKind || hasSelectedStrategy || envelope.currentGate === "fail_closed_reconcile") {
    const reconciliationStopRulesAreCanonical = Array.isArray(envelope.stopRules)
      && envelope.stopRules[0] === "reconcile"
      && (envelope.stopRules.length === 1
        || (envelope.stopRules.length === 2 && envelope.stopRules[1] === "merge"));
    // Routing invariants only: acceptance prose remains the resolver's
    // business, while nextAction must begin with one of the known fail-closed
    // directives rather than arbitrary non-empty text.
    const reconciliationCriterion = envelope.acceptance?.criteria;
    const reconciliationAcceptanceIsCanonical = Array.isArray(reconciliationCriterion)
      && reconciliationCriterion.some((criterion) => criterion?.id === "reconcile" && criterion?.severity === "required");
    const normalizedNextAction = typeof envelope.nextAction === "string" ? envelope.nextAction.trim() : "";
    const reconciliationNextActionIsActionable = [
      "Reconcile ",
      "Stop and reconcile ",
      "Complete or explicitly skip ",
      "Local implementation requires worktree isolation",
    ].some((directive) => normalizedNextAction.startsWith(directive));
    if (
      envelope.routeKind !== "needs_reconcile"
      || envelope.selectedStrategy !== null
      || envelope.currentGate !== "fail_closed_reconcile"
      || envelope.worktreeRequired !== false
      || !reconciliationStopRulesAreCanonical
      || !reconciliationAcceptanceIsCanonical
      || !reconciliationNextActionIsActionable
    ) {
      errors.push({
        field: "routeKind/selectedStrategy/currentGate/worktreeRequired/stopRules/acceptance.criteria",
        reason: "terminal reconciliation must use the exact needs_reconcile / null / fail_closed_reconcile tuple, require no worktree, instruct reconciliation, stop at reconcile (plus optional merge), and carry a required reconcile acceptance criterion",
        got: {
          routeKind: envelope.routeKind,
          selectedStrategy: envelope.selectedStrategy,
          currentGate: envelope.currentGate,
          worktreeRequired: envelope.worktreeRequired,
          stopRules: envelope.stopRules,
          nextAction: envelope.nextAction,
          acceptanceCriteria: envelope.acceptance?.criteria,
          acceptanceEvidence: envelope.acceptance?.evidence,
          maxFinalizationTurns: envelope.acceptance?.maxFinalizationTurns,
        },
      });
    }
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

  // ----- asyncStartEffective (required field; the harness-resolved posture) -----
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

  // ----- retrospectiveFindings (optional, advisory) -----
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

  // ----- pendingRetrospectives (optional) -----
  if (envelope.pendingRetrospectives !== undefined && envelope.pendingRetrospectives !== null) {
    if (!Array.isArray(envelope.pendingRetrospectives)) {
      errors.push({ field: "pendingRetrospectives", reason: "if present, must be an array", got: envelope.pendingRetrospectives });
    } else {
      envelope.pendingRetrospectives.forEach((e, i) => {
        if (!e || typeof e !== "object") {
          errors.push({ field: `pendingRetrospectives[${i}]`, reason: "must be an object", got: e });
          return;
        }
        if (e.pr !== null && !Number.isInteger(e.pr)) {
          errors.push({ field: `pendingRetrospectives[${i}].pr`, reason: "must be an integer or null", got: e.pr });
        }
        if (e.mergeCommit !== null && typeof e.mergeCommit !== "string") {
          errors.push({ field: `pendingRetrospectives[${i}].mergeCommit`, reason: "must be a string or null", got: e.mergeCommit });
        }
        if (e.reason !== undefined && typeof e.reason !== "string") {
          errors.push({ field: `pendingRetrospectives[${i}].reason`, reason: "must be a string when present", got: e.reason });
        }
      });
    }
  }

  // ----- specSource (optional — lightweight PR-body-as-spec) -----
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

  // ----- unitBoundaries (optional — coordinator hand-back boundaries, issue 2532) -----
  if (envelope.unitBoundaries !== undefined) {
    const ub = envelope.unitBoundaries;
    const boundaryNames = Object.values(UNIT_BOUNDARY);
    if (!ub || typeof ub !== "object" || Array.isArray(ub)) {
      errors.push({ field: "unitBoundaries", reason: "if present, must be a non-array object", got: ub });
    } else {
      if (!Array.isArray(ub.handBackAfter) || ub.handBackAfter.length === 0
        || ub.handBackAfter.some((b) => !boundaryNames.includes(b))
        || new Set(ub.handBackAfter).size !== ub.handBackAfter.length
        // The contract makes the list ordered and first-match, so a reversed list
        // would stop a unit at a boundary it cannot reach yet. Declaration order is
        // the canonical order.
        || ub.handBackAfter.some((b, i) => i > 0 && boundaryNames.indexOf(b) < boundaryNames.indexOf(ub.handBackAfter[i - 1]))) {
        errors.push({ field: "unitBoundaries.handBackAfter", reason: `must be a non-empty array of distinct boundaries in canonical order: ${boundaryNames.join(" then ")}`, got: ub.handBackAfter });
      }
      const resume = ub.resume;
      // The builder only ever emits a positive integer or null, so a present-but-invalid
      // identity (a string or a non-positive integer) is rejected even when another
      // identity is also present; otherwise the validator would be laxer than its producer.
      const invalidCount = [resume?.issue, resume?.pr].some((n) => n !== undefined && n !== null && !(Number.isInteger(n) && n > 0));
      // `branch`/`phase` get the same unconditional type check: testing them only inside the
      // "any identity at all" fallback below would skip it as soon as a valid issue or PR is
      // present, accepting `{issue: 42, branch: 99}` — malformed authoritative state on the
      // very resume path that must be authoritative (issue 2532).
      const invalidText = [resume?.branch, resume?.phase].some(
        (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim()),
      );
      if (!resume || typeof resume !== "object" || resume.kind !== "loop_startup") {
        errors.push({ field: "unitBoundaries.resume", reason: "must be an object with kind=loop_startup", got: resume });
      } else if (invalidCount || invalidText) {
        errors.push({ field: "unitBoundaries.resume", reason: "issue and pr must be a positive integer or null, and branch and phase a non-empty string or null", got: resume });
      } else if (![resume.issue, resume.pr].some((n) => Number.isInteger(n) && n > 0)
        && ![resume.branch, resume.phase].some((v) => typeof v === "string" && v.trim())) {
        errors.push({ field: "unitBoundaries.resume", reason: "must name an issue, pr, branch or phase to re-resolve", got: resume });
      }
      // A boundary set and a resume that contradict the envelope's OWN target are not
      // authoritative state: `deriveUnitBoundaries` derives both from that target, so a PR-less
      // unit whose list omits the draft PR stops nowhere (the snowball this field exists to
      // prevent), a PR-owning unit whose list carries the draft PR stops at a boundary it can
      // never reach, and a resume naming another issue or PR resumes a different unit (issue
      // 2532). Only well-typed identities are compared; the type errors above already cover a
      // malformed one, and a target error above already covers a missing/invalid target.
      const target = envelope.target;
      if (target && typeof target === "object" && !Array.isArray(target)) {
        const ownsPr = target.kind === DEV_LOOP_TARGET_KIND.PR
          || (Number.isInteger(target.linkedPr) && target.linkedPr > 0);
        if (Array.isArray(ub.handBackAfter) && ub.handBackAfter.length > 0) {
          if (!ownsPr && ub.handBackAfter[0] !== UNIT_BOUNDARY.DRAFT_PR_OPENED) {
            errors.push({
              field: "unitBoundaries.handBackAfter",
              reason: `a target that owns no PR must hand back at ${UNIT_BOUNDARY.DRAFT_PR_OPENED} first, because opening that draft PR ends its phase`,
              got: ub.handBackAfter,
            });
          }
          // The mirror arm of the partition `deriveUnitBoundaries` produces: a target that owns a
          // PR already has its draft, so it never opens one. A list carrying that boundary names
          // a stop the unit can never reach and, being first-match, would end the unit before its
          // gate round — so `gate_verdict_posted` is its only reachable boundary.
          if (ownsPr && ub.handBackAfter.includes(UNIT_BOUNDARY.DRAFT_PR_OPENED)) {
            errors.push({
              field: "unitBoundaries.handBackAfter",
              reason: `a target that already owns its PR must not hand back at ${UNIT_BOUNDARY.DRAFT_PR_OPENED}: that unit never opens a draft, so ${UNIT_BOUNDARY.GATE_VERDICT_POSTED} is its only boundary`,
              got: ub.handBackAfter,
            });
          }
        }
        const identityText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
        const resumeIssue = Number.isInteger(resume?.issue) && resume.issue > 0 ? resume.issue : null;
        const resumePr = Number.isInteger(resume?.pr) && resume.pr > 0 ? resume.pr : null;
        // Each resume identity must be one the target itself carries. An issue target's own PR
        // arrives as `linkedPr`, so that arm counts as an owned PR identity too.
        const foreign = [
          ["issue", resumeIssue, Number.isInteger(target.issue) && target.issue > 0 ? [target.issue] : []],
          ["pr", resumePr, [target.pr, target.linkedPr].filter((n) => Number.isInteger(n) && n > 0)],
          ["branch", identityText(resume?.branch), [identityText(target.branch)].filter(Boolean)],
          ["phase", identityText(resume?.phase), [identityText(target.phase)].filter(Boolean)],
        ].filter(([, named, owned]) => named !== null && !owned.includes(named)).map(([name]) => name);
        if (foreign.length > 0) {
          errors.push({
            field: "unitBoundaries.resume",
            reason: `every identity must be one this ${target.kind} target carries; target does not carry: ${foreign.join(", ")}`,
            got: resume,
          });
        }
      }
    }
  }

  // ----- gateState.derivedAt (informational, warn on missing) — the
  // volatile timestamp lives in the gateState tail so the rest stays byte-stable -----
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
