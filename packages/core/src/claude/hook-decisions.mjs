/**
 * Pure decision logic for the Claude Code dev-loop hooks.
 *
 * The hook *scripts* are thin: they read the PreToolUse/PostToolUse stdin payload, gather facts
 * (git tracked/ignored status, gate-evidence result), and call these pure deciders. Keeping the
 * decisions here makes the deny/allow boundary fully unit-testable without spawning hooks, and
 * keeps the Claude-specific stdin/stdout IO at the edge.
 *
 * Pure and side-effect free.
 */

import { resolveRunId } from "../loop/run-context.mjs";
import { isUnderWorktreePath } from "../loop/worktree-guard.mjs";
import { DISPATCH_POINTER_MAX_BYTES, EXECUTION_IDENTITY_RE } from "../loop/work-order-digest.mjs";
import {
  COORDINATOR_AGENT_TYPES,
  DEV_LOOP_AGENT_TYPE,
  GATE_COORDINATOR_AGENT_TYPE,
  decideBashGateDeny,
  normalizeAgentType,
} from "../loop/bash-gate-decisions.mjs";

// The harness-neutral Bash-gate deny rules and the agent-name helpers live in
// ../loop/bash-gate-decisions.mjs so the Pi `tool_call` handler enforces the same list (issue
// #2965, decision record 0206). Re-exported here so this module's public surface is unchanged.
export { BASH_GATE_RULES, COORDINATOR_AGENT_TYPES, DEV_LOOP_AGENT_TYPE, GATE_COORDINATOR_AGENT_TYPE, decideBashGateDeny, normalizeAgentType } from "../loop/bash-gate-decisions.mjs";

/**
 * @typedef {Object} HookDecision
 * @property {"allow"|"deny"|"block"} decision — `block` is the SubagentStop vocabulary
 *   (exit 2 + stderr JSON), used by `decideSubagentStopGuard`; `allow`/`deny` are the PreToolUse
 *   vocabulary used by `decideBashGate`/`decideWriteGuard`.
 * @property {string} [reason] - Human-readable reason (shown to the agent on deny/block).
 */

const ALLOW = Object.freeze({ decision: "allow" });

/** Worker agents that keep write access to tracked worktree files under the main-agent read-only boundary. */
const WORKER_AGENT_TYPES = new Set(["developer", "fixer", "quality", "docs"]);
/** A worker by bare name or the `dev-loops:` plugin namespace only; `otherplugin:docs` is not a worker. */
const isWorkerAgentType = (agentType) =>
  typeof agentType === "string" && WORKER_AGENT_TYPES.has(agentType.startsWith("dev-loops:") ? agentType.slice("dev-loops:".length) : agentType);

/**
 * The read-only judge holds Bash only to pull its work order (ADR 0106) and run its decision check. The pull command
 * is the dispatch envelope's pull line with shell-inert values, so chaining, redirection and
 * substitution cannot match.
 */
export const JUDGE_AGENT_TYPE = "judge";
const IDENTITY_PATTERN = EXECUTION_IDENTITY_RE.source.slice(1, -1);
const PULL_VALUE = "[A-Za-z0-9][\\w.:/#-]*";
// The one sanctioned pull line: the short form (ADR 0115) or the 3-flag form that step 1 still
// emits (issue 2560 drops it).
const PULL_LINE = `dev-loops-run scripts/github/pull-work-order\\.mjs (?:(${IDENTITY_PATTERN})|--ref (${PULL_VALUE}) --digest (${PULL_VALUE}) --execution (${PULL_VALUE}))`;
const SANCTIONED_WORK_ORDER_PULL_RE = new RegExp(`^${PULL_LINE}$`);
// The judge's read-only check of its own decision file, run before it hands back.
const JUDGE_DECISION_CHECK_RE = /^dev-loops-run scripts\/loop\/check-judge-decision\.mjs --file [\w.\/#-]*tmp\/gate-judge\/[\w.\/#-]+\.json$/;
export const isJudgeDecisionCheckLine = (command) => typeof command === "string" && JUDGE_DECISION_CHECK_RE.test(command.trim()) && !command.includes("..");
const FIXER_IDENTITY_TOKEN_RE = /\bf\d+-[0-9a-f]{8}\b/;

/**
 * Of the exact trimmed sanctioned pull line: `{ executionIdentity }` for the short form,
 * `{ workOrderRef, workOrderDigest, executionIdentity }` for the 3-flag form; else null.
 */
export function parseSanctionedPullLine(command) {
  const match = typeof command === "string" ? SANCTIONED_WORK_ORDER_PULL_RE.exec(command.trim()) : null;
  if (!match) return null;
  return match[1] ? { executionIdentity: match[1] } : { workOrderRef: match[2], workOrderDigest: match[3], executionIdentity: match[4] };
}

/** True when `command` references pull-work-order and carries a fixer execution identity token, in any shell segment. */
export const isFixerPullAttempt = (command) => typeof command === "string" && command.includes("pull-work-order") && FIXER_IDENTITY_TOKEN_RE.test(command);

/**
 * Decide whether a PreToolUse Bash command must be blocked by a dev-loop gate boundary.
 *
 * The `judge` agent (plugin-namespaced or bare) may run ONLY the sanctioned work-order pull and the decision check;
 * every other command, including test/build entrypoints, is denied fail-closed.
 *
 * Gated commands on the target repo (each rationale sits inline at its check):
 *   - `gh pr create` — blocked outright; PR creation must flow through the canonical wrapper
 *     (`scripts/github/create-pr.mjs` / `dev-loops-run cli/index.mjs pr create`), which always drafts and self-assigns.
 *   - `gh pr ready` — blocked without clean draft_gate evidence.
 *   - `gh pr merge` — blocked outright; use scripts/github/merge-pr.mjs. Its gate evidence check
 *     requires a clean draft_gate transition record + current-head pre_approval_gate
 *     (GATE-COMMENT-DRAFT-REQUIREMENTS in skills/docs/gate-review-comment-contract.md).
 *   - raw `gh issue create` / `gh issue comment` / `gh issue edit` / `gh pr comment` — blocked ONLY
 *     from a SUBAGENT context (`agentType` non-null) on the target repo. Sanctioned external writes
 *     flow through node wrappers; the MAIN AGENT / operator (agentType null) retains direct access.
 *
 * The hook computes `gatePassed`/`gateError` from the gate script appropriate to the command kind.
 *
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null} [params.repoSlug] - Resolved owner/name of the cwd repo (null if unknown).
 * @param {string|null} [params.managedRepoSlug] - Resolved owner/name of the dev-loops-managed
 *   repo (the repo `inManagedContext` refers to), or null when the identity can't be resolved.
 * @param {boolean} [params.inManagedContext] - Whether the current repo is dev-loops-managed (a
 *   `.devloops` config exists at its root). Replaces the old hardcoded-slug `TARGET_REPO_SLUG`
 *   comparison so the guard suite applies in any managed consumer repo, not only mfittko/dev-loops.
 * @param {boolean} [params.gatePassed] - Whether the relevant gate evidence exists for the PR.
 * @param {string|null} [params.gateError] - Error detail when the gate guard could not run.
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload; non-null
 *   string inside a subagent, null in the main agent. Scopes the subagent-only predicates.
 * @param {boolean} [params.humanMergeOnly] - Effective repo `autonomy.humanMergeOnly` invariant
 *   (`resolveHumanMergeOnly`); when true, `gh pr merge` is refused actor-independently
 *   (STOP-HUMAN-MERGE-001), because the main agent is the actor that performs GitHub writes and a
 *   subagent-only deny would enforce nothing.
 * @param {boolean} [params.enforceCoordinator] - Strict mode for the COORDINATOR-VERIFY-BOUNDARY
 *   boundary, derived by the hook from `DEVLOOPS_COORDINATOR_READONLY=1` — the SAME flag that
 *   gates `decideCoordinatorWriteGuard`. Default fail-open (mirrors that boundary).
 * @returns {HookDecision}
 */
export function decideBashGate({
  command,
  repoSlug = null,
  managedRepoSlug = null,
  inManagedContext = false,
  gatePassed = false,
  gateError = null,
  agentType = null,
  humanMergeOnly = false,
  enforceCoordinator = false,
}) {
  if (normalizeAgentType(agentType) === JUDGE_AGENT_TYPE) {
    return parseSanctionedPullLine(command) || isJudgeDecisionCheckLine(command) ? ALLOW : {
      decision: "deny",
      reason:
        "Judge read-only boundary (agents/judge.agent.md, ADR 0106): the judge may run only its " +
        "dispatched `dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>` line (or its emitted 3-flag form), " +
        "alone, with no chaining, redirection or substitution, or `dev-loops-run scripts/loop/check-judge-decision.mjs --file tmp/gate-judge/<path>.json`. Read " +
        "files with Read/Grep/Glob; never run shell, test or build commands.",
    };
  }
  // The fixer's binding is recorded only for the exact pull line (ADR 0107), so a modified one denies with the fix.
  if (normalizeAgentType(agentType) === FIXER_AGENT_TYPE && isFixerPullAttempt(command) && !parseSanctionedPullLine(command)) {
    return {
      decision: "deny",
      reason:
        "Fixer pull boundary (agents/fixer.agent.md, ADR 0107): the fixer's grant binding is recorded only for the exact " +
        `dispatched pull line. Run it again exactly as dispatched: \`dev-loops-run scripts/github/pull-work-order.mjs ${command.match(FIXER_IDENTITY_TOKEN_RE)[0]}\`, ` +
        "or the emitted 3-flag line (`--ref`, `--digest`, `--execution`) when your dispatch carried that form, " +
        "alone, with no prefix, suffix, redirect, chaining or `cd`.",
    };
  }
  if (typeof command !== "string") {
    return ALLOW;
  }

  // The harness-neutral deny rules (COORDINATOR-VERIFY-BOUNDARY, the actor-independent guard
  // rules, the human-merge invariant and the raw `gh pr create`/`merge`/`ready` refusals) live
  // in ../loop/bash-gate-decisions.mjs so the Pi `tool_call` handler applies the identical
  // decision (issue #2965, decision record 0206). The judge and fixer checks above stay here:
  // they key on Claude role machinery with no Pi equivalent.
  const deny = decideBashGateDeny({
    command,
    role: agentType,
    repoSlug,
    managedRepoSlug,
    inManagedContext,
    humanMergeOnly,
    enforceCoordinator,
    readyGate: { passed: gatePassed, error: gateError },
  });
  return deny ? { decision: "deny", reason: deny.reason } : ALLOW;
}

/**
 * Decide whether a PreToolUse Write/Edit must be blocked by the main-agent read-only boundary.
 *
 * Denies a repo-mutation write from the main agent and from unknown subagents (Explore, Plan,
 * an arbitrary Task agent). A run id (`DEVLOOPS_RUN_ID`) or the dev-loop agent type is
 * authorized. Worker agents (developer, fixer, quality, docs; bare name or the `dev-loops:`
 * namespace only) are authorized only when the target is inside a linked worktree
 * (`inLinkedWorktree`). A repo mutation is a target inside a repository working tree and not
 * gitignored; any path under a `.git` segment is also a repo mutation. Non-repo / gitignored
 * paths are always allowed. Strict enforcement is opt-in via `enforce` (the hook
 * derives it from `DEVLOOPS_MAIN_AGENT_READONLY=1`) so adopting the harness does not
 * retroactively break a repo's own interactive dev; default is fail-open.
 *
 * @param {Object} params
 * @param {string} params.filePath - Target file path.
 * @param {boolean} params.isRepoMutation - True if inside the repo working tree AND not gitignored.
 * @param {boolean} [params.enforce] - Strict mode (DEVLOOPS_MAIN_AGENT_READONLY=1).
 * @param {Record<string,string|undefined>} [params.env] - Environment (for the CA2 run id).
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload, if any.
 * @param {boolean} [params.inLinkedWorktree] - True when the target's repo is a linked worktree
 *   (`git rev-parse --git-dir` differs from `--git-common-dir`); default false denies workers.
 * @returns {HookDecision}
 */
export function decideWriteGuard({ filePath, isRepoMutation, enforce = false, env = {}, agentType = null, inLinkedWorktree = false }) {
  if (!enforce) {
    return ALLOW; // strict enforcement not enabled — fail open
  }
  if (!isRepoMutation) {
    return ALLOW; // non-repo or gitignored path (e.g. /tmp, tmp/) — allowed by the contract
  }
  // Authorized only inside the dev-loop subagent context: CA2 run id, the dev-loop agent type, or
  // a worker agent (developer/fixer/quality/docs) writing inside a LINKED worktree. A worker
  // matches only by bare name or the `dev-loops:` namespace; a worker targeting the main checkout,
  // a foreign-plugin namesake and any other subagent type are treated like the main agent and denied.
  if (resolveRunId(env) || agentType === DEV_LOOP_AGENT_TYPE || (inLinkedWorktree && isWorkerAgentType(agentType))) {
    return ALLOW;
  }
  return {
    decision: "deny",
    reason:
      `Main-agent read-only boundary: refusing to mutate repository path "${filePath}". ` +
      "All repository mutations must flow through the dev-loop subagent. " +
      "See skills/docs/main-agent-contract.md.",
  };
}

/**
 * Decide whether a PreToolUse Write/Edit must be blocked by the coordinator→worker delegation
 * boundary — the INVERSE of `decideWriteGuard`, one level down. Under the Claude Code
 * harness a coordinator agent (Claude `agent_type` "dev-loop" or "gate-coordinator") acts as a delegating
 * COORDINATOR: it MUST NOT mutate TRACKED repo files directly — that work is delegated to a fresh
 * WORKER subagent (`developer`/`fixer`/`quality`/`docs`). `agent_type` is the only discriminator:
 * `DEVLOOPS_RUN_ID` does not distinguish coordinator from worker (the coordinator mints it and
 * propagates it to the workers it dispatches), so — unlike `decideWriteGuard` — this decider does
 * not key on run id at all.
 *
 * Denies only when ALL of: strict enforcement is on, the target is a tracked repo mutation, AND
 * the caller's `agent_type` is a coordinator's (`"dev-loop"` or `"gate-coordinator"`). Every other `agent_type` —
 * including `null` (the Pi main agent / an interactive Claude session with no subagent context,
 * which is `decideWriteGuard`'s boundary, not this one) and any worker role — is allowed here.
 * Strict enforcement is opt-in via `enforce` (the hook derives it from
 * `DEVLOOPS_COORDINATOR_READONLY=1`); default is fail-open, mirroring `decideWriteGuard`'s
 * adopt-safe precedent so enabling this boundary does not retroactively break a repo's own
 * interactive Claude Code dev.
 *
 * @param {Object} params
 * @param {string} params.filePath - Target file path.
 * @param {boolean} params.isRepoMutation - True if inside the repo working tree AND not gitignored.
 * @param {boolean} [params.enforce] - Strict mode (DEVLOOPS_COORDINATOR_READONLY=1).
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload, if any.
 * @returns {HookDecision}
 */
export function decideCoordinatorWriteGuard({ filePath, isRepoMutation, enforce = false, agentType = null }) {
  if (!enforce) {
    return ALLOW; // strict enforcement not enabled — fail open
  }
  if (!isRepoMutation) {
    return ALLOW; // non-repo or gitignored path (tmp/, the scratchpad, sanctioned ledger paths)
  }
  if (!COORDINATOR_AGENT_TYPES.has(normalizeAgentType(agentType))) {
    return ALLOW; // not the coordinator — a worker subagent, or the main agent (the other boundary)
  }
  const reason = normalizeAgentType(agentType) === GATE_COORDINATOR_AGENT_TYPE
    ? `Coordinator write boundary: refusing to mutate repository path "${filePath}" as the gate ` +
      "coordinator. Tracked-file edits belong to the dev-loop coordinator; write only round artifacts " +
      "under tmp/ and return a typed observation (GATE-EXEC-GATE-COORDINATOR). See skills/docs/main-agent-contract.md."
    : `Coordinator→worker delegation boundary: refusing to mutate repository path "${filePath}" as the ` +
      "dev-loop coordinator. Delegate this tracked-file edit to a fresh worker subagent (developer/fixer/" +
      "quality/docs) instead of writing it directly. See skills/docs/main-agent-contract.md.";
  return { decision: "deny", reason };
}

const JUDGE_VERDICT_FILES = new Set(["judge-verdict.json", "spec-authority-verdict.json"]);

/**
 * Decide whether a PreToolUse Write/Edit/NotebookEdit by the read-only `judge` agent must be
 * denied (ADR 0106, agents/judge.agent.md tool boundary). The judge may write only its two
 * verdict files in a round directory under one of `gateJudgeRoots`. Any other target could
 * plant code that the sanctioned `dev-loops-run` pull line then executes, or overwrite a
 * verdict outside the checkouts the pull scans.
 *
 * `targetPath` is the hook's realpath-normalized absolute target (symlinks, `..`, relative
 * paths and trailing slashes already resolved). `gateJudgeRoots` are the realpath-normalized
 * `<checkout>/tmp/gate-judge` roots of the repo's listed checkouts (the emitter's and pull's
 * tmp roots). `symlinked` is true when the literal target or an existing path between it and
 * its root is a symlink (a dangling one survives realpath). A missing, relative or unnormalized
 * path, an empty root list, or a symlinked target denies fail-closed. Every non-judge agent is
 * allowed here (the other boundaries apply).
 *
 * @param {Object} params
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload.
 * @param {string|null} [params.targetPath] - Realpath-normalized absolute target path.
 * @param {string[]} [params.gateJudgeRoots] - Realpath-normalized allowed gate-judge roots.
 * @param {boolean} [params.symlinked] - The target path crosses a symlink under its root.
 * @returns {HookDecision}
 */
export function decideJudgeWriteGuard({ agentType = null, targetPath = null, gateJudgeRoots = [], symlinked = false }) {
  if (normalizeAgentType(agentType) !== JUDGE_AGENT_TYPE) return ALLOW;
  const root = typeof targetPath === "string" && targetPath.startsWith("/")
    ? gateJudgeRoots.find((r) => typeof r === "string" && r.startsWith("/") && targetPath.startsWith(`${r}/`)) : undefined;
  const segments = root ? targetPath.slice(root.length + 1).split("/") : [];
  const allowed = !symlinked && segments.length >= 2 && !segments.some((s) => s === "" || s === "." || s === "..")
    && JUDGE_VERDICT_FILES.has(segments.at(-1));
  return allowed ? ALLOW : {
    decision: "deny",
    reason:
      `Judge write boundary (agents/judge.agent.md, ADR 0106): refusing to write ${JSON.stringify(targetPath)}. ` +
      "The judge writes only its judge-verdict.json and spec-authority-verdict.json at the outputRefs its " +
      "pulled work order names under a checkout's tmp/gate-judge/, never through a symlink.",
  };
}

/**
 * Env var that authorizes a deliberate main-checkout mutation while a worktree
 * cycle is active. Reuses the existing default-branch-guard override
 * (`DEVLOOPS_ALLOW_MAIN`, GUARD_OVERRIDE_ENV) — both mean "I intend to operate on
 * the primary checkout on purpose" — so the operator surface stays one flag.
 */
export const WORKTREE_CHECKOUT_GUARD_OVERRIDE_ENV = "DEVLOOPS_ALLOW_MAIN";

/**
 * Decide whether a PreToolUse Write/Edit is a WRONG-CHECKOUT mutation: the call
 * context is operating inside a linked worktree (the active cycle worktree) but
 * the target resolves to a TRACKED file in the MAIN checkout instead of that
 * worktree.
 *
 * After `ensure-worktree.mjs` establishes an isolated worktree for a cycle, an
 * absolute-path `Edit`/`Write` that names the main-checkout copy of a source
 * file lands the change on the wrong checkout — silently, until a `git status`
 * in the worktree turns up empty (observed in practice: six edits hit main
 * before a self-caught restore). This guard catches that before it reaches a commit.
 *
 * The "active worktree" is anchored to the CALL CONTEXT's cwd, not to a durable
 * marker: this repo accumulates many stale `tmp/worktrees/` worktrees, so "a
 * worktree exists" cannot mean "a cycle is active". The worktree that CONTAINS
 * cwd is the one this context is driving; a write escaping it into main is the
 * wrong-checkout mistake.
 *
 * The hook resolves the facts (via the shared `worktree-guard.mjs` primitives)
 * and passes booleans so this decider stays pure and unit-testable:
 * - `activeWorktreeRoot`: the listed worktree root containing cwd, or null when
 *   cwd is not inside any worktree (no active cycle context — AC3).
 * - `isTargetUnderActiveWorktree`: the target resolves inside that worktree (a
 *   legitimate in-worktree edit — AC2).
 * - `isMainCheckoutTracked`: the target resolves under the main checkout AND is
 *   a tracked (non-gitignored) file. The hook sets this true when the status is
 *   UNRESOLVABLE (e.g. `git check-ignore` errored) so an ambiguous context fails
 *   safe rather than silently allowing a wrong-checkout write (AC4).
 * - `allowMainCheckout`: the deliberate-override signal (`DEVLOOPS_ALLOW_MAIN=1`)
 *   for an intended main-checkout edit (AC3).
 *
 * @param {Object} params
 * @param {string} params.filePath - Target file path (as supplied to the tool).
 * @param {string|null} [params.activeWorktreeRoot] - Listed worktree root containing cwd, or null.
 * @param {boolean} [params.isTargetUnderActiveWorktree] - Target is inside the active worktree.
 * @param {boolean} [params.isMainCheckoutTracked] - Target is a tracked main-checkout file (or unresolvable).
 * @param {boolean} [params.allowMainCheckout] - Deliberate override (DEVLOOPS_ALLOW_MAIN=1).
 * @param {string|null} [params.suggestedWorktreePath] - The worktree-local path the write should target.
 * @returns {HookDecision}
 */
export function decideWorktreeCheckoutGuard({
  filePath,
  activeWorktreeRoot = null,
  isTargetUnderActiveWorktree = false,
  isMainCheckoutTracked = false,
  allowMainCheckout = false,
  suggestedWorktreePath = null,
}) {
  // No active worktree context — this is the main checkout / orchestrator / a
  // consumer repo's own interactive dev. A main-checkout edit is intended here
  // (AC3). Also the only path that runs for repos never using dev-loop worktrees.
  if (!activeWorktreeRoot) {
    return ALLOW;
  }
  // Deliberate, operator-authorized main-checkout write during an active cycle (AC3).
  if (allowMainCheckout) {
    return ALLOW;
  }
  // Legitimate in-worktree edit — no false positive (AC2).
  if (isTargetUnderActiveWorktree) {
    return ALLOW;
  }
  // Outside the active worktree AND not a tracked main-checkout file: a scratch
  // path (/tmp), a gitignored path, another worktree's file, or outside the repo
  // entirely — none is the wrong-checkout mistake this guard exists to catch.
  if (!isMainCheckoutTracked) {
    return ALLOW;
  }
  // A worktree cycle is active and the target is a tracked main-checkout file
  // (or an unresolvable/ambiguous context that fails safe — AC4). This is a
  // wrong-checkout mutation (AC1).
  const fix = suggestedWorktreePath
    ? ` Edit the worktree copy instead: "${suggestedWorktreePath}".`
    : "";
  return {
    decision: "deny",
    reason:
      `WORKTREE-WRONG-CHECKOUT-GUARD: wrong-checkout mutation blocked — a worktree cycle is active ` +
      `("${activeWorktreeRoot}") but this Write/Edit targets the MAIN checkout's non-gitignored file ` +
      `"${filePath}".${fix} A file mutation that lands on the main checkout while a worktree is ` +
      "active is silently lost from the branch. Set DEVLOOPS_ALLOW_MAIN=1 only for a deliberate " +
      "main-checkout edit. See skills/docs/worktree-guidance.md.",
  };
}

/**
 * Env var that exempts an interactive session awaiting commit authorization from the
 * SubagentStop uncommitted-work guard.
 *
 * An opt-in signal set by the operator or the interactive coordination path
 * (`DEVLOOPS_COMMIT_AUTH_PENDING=1`) when intentionally holding uncommitted work pending
 * operator commit authorization — consistent with the operator-set `DEVLOOPS_*` env vars in
 * this repo (`DEVLOOPS_MAIN_AGENT_READONLY`, `DEVLOOPS_ALLOW_MAIN`, `DEVLOOPS_SUBAGENT_AVAILABLE`),
 * which are environment/operator signals rather than values written by a code path. A
 * non-interactive (dispatched) subagent leaves it unset, so its commit-before-exit obligation
 * stays enforced.
 */
export const DEVLOOPS_COMMIT_AUTH_PENDING_VAR = "DEVLOOPS_COMMIT_AUTH_PENDING";

/**
 * Subagent roles whose contract forbids committing to the repository.
 *
 * The `judge` and `review` agents are read-only over the repository: the judge writes only its
 * own verdict artifact (under `tmp/`, gitignored) and the gate reviewer writes only its findings
 * artifact (also under `tmp/`) — neither ever authors a tracked-file edit. So any uncommitted
 * tracked change present in such a subagent's worktree is FOREIGN: it belongs to the orchestrator
 * that dispatched it (a pending orchestrator edit that was in the shared worktree when the
 * read-only pass ran), not to the read-only subagent. `LOCAL-COMMIT-BEFORE-EXIT` must not force
 * one of these roles to author a commit of that foreign work — doing so violates the verdict-only
 * contract (`agents/judge.agent.md`: "The only thing you write is your own verdict artifact").
 * The data-loss protection is enforced against the OWNER of the edit (the orchestrator) on its own
 * stop instead. This is intentionally scoped to read-only roles: editing roles (`developer`,
 * `fixer`, `docs`, `quality`) and the orchestrator stay enforced.
 */
export const READONLY_SUBAGENT_ROLES = Object.freeze(["judge", "review", "gate-coordinator"]);

/** Whether `agentType` (Claude `agent_type` from the SubagentStop payload) is a read-only role. */
export function isReadOnlySubagentRole(agentType) {
  return typeof agentType === "string" && READONLY_SUBAGENT_ROLES.includes(normalizeAgentType(agentType));
}

/**
 * Decide whether a SubagentStop must be blocked because the subagent's worktree has
 * uncommitted changes.
 *
 * `scripts/loop/cleanup-worktree.mjs` runs `git worktree remove --force` after a merge, so
 * uncommitted changes in a worktree are destroyed with no warning. `LOCAL-COMMIT-BEFORE-EXIT`
 * existed only as prose. This decider makes it mechanical: refuse the subagent stop when the
 * cwd is under `tmp/worktrees/` and `git status --porcelain` is non-empty, unless the session
 * is an interactive one awaiting commit authorization (exempt). A clean worktree, a cwd
 * outside `tmp/worktrees/`, and a git-error/empty-porcelain case all allow the stop.
 *
 * Editing roles (`developer`/`fixer`/`docs`/`quality`) stay fully enforced: an editing
 * sub-delegate commits its own work before exit (`LOCAL-COMMIT-BEFORE-EXIT`), so a dirty exit is
 * always a real defect, never a sanctioned "orchestrator owns the commit" split. The removed
 * `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT` env-var exemption deadlocked such a role under a
 * task-scoped no-commit instruction whenever the orchestrator could not set a per-dispatch env
 * var (the Claude harness): the hook demanded a commit the session then denied, then re-blocked
 * the exit. Disallowing the edit-here/commit-there split at the contract level makes the
 * guard the enforcer and the deadlock structurally impossible while preserving data-loss
 * protection. An orchestrator that wants one consolidated commit performs the edits itself.
 *
 * Pure and side-effect free. The hook script gathers `cwd` and the `git status --porcelain`
 * output and calls this; the block decision is surfaced via exit code 2 + stderr JSON by the
 * hook (the SubagentStop contract differs from PreToolUse's `permissionDecision` form).
 *
 * @param {Object} params
 * @param {string|undefined} params.cwd - Current working directory; a non-string value is
 *   treated as out of scope (allow) — the decider is fail-safe.
 * @param {string|undefined} params.porcelain - Raw `git status --porcelain` output; a non-string
 *   or empty value is treated as clean (allow) — the decider is fail-safe.
 * @param {boolean} [params.pendingCommitAuthorization] - True when the interactive session is
 *   awaiting commit authorization (exempt) — derived by the hook script from the
 *   `DEVLOOPS_COMMIT_AUTH_PENDING=1` opt-in env signal.
 * @param {string|null} [params.agentType] - Claude `agent_type` from the SubagentStop payload;
 *   a read-only role (`judge`/`review`/`gate-coordinator`, per `READONLY_SUBAGENT_ROLES`) is exempt — its
 *   contract forbids commits, so any dirty tracked edit in its worktree is foreign
 *   (orchestrator-owned) and must not be pinned on it.
 * @returns {HookDecision}
 */
export function decideSubagentStopGuard({ cwd, porcelain, pendingCommitAuthorization = false, agentType = null }) {
  if (typeof cwd !== "string" || !isUnderWorktreePath(cwd)) {
    return ALLOW;
  }
  if (pendingCommitAuthorization) {
    return ALLOW;
  }
  if (typeof porcelain !== "string" || porcelain.trim() === "") {
    return ALLOW;
  }
  // Read-only role exemption: the worktree is dirty, but a `judge`/`review` subagent's
  // contract forbids commits, so this pending tracked edit is foreign — it belongs to the
  // orchestrator that dispatched this pass. Do not force a verdict-only role to commit it; allow
  // the stop with an advisory naming the orchestrator as the actor responsible for the edit. The
  // data-loss guard still fires against the orchestrator on its own (editing) stop.
  if (isReadOnlySubagentRole(agentType)) {
    return {
      decision: "allow",
      advisory: true,
      reason:
        `LOCAL-COMMIT-BEFORE-EXIT exempt for read-only role "${agentType}": the worktree has ` +
        "uncommitted changes, but a verdict-only role must not author a commit of work it did not " +
        "create. This pending edit is foreign — the ORCHESTRATOR that dispatched this pass owns it " +
        "and is responsible for committing it before its own stop.",
    };
  }
  const dirty = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // The reason is fed back to the stopping subagent as context, so the path
  // enumeration is capped: an unbounded list on a very dirty worktree produces a
  // multi-megabyte reason that consumers truncate or choke on, burying the one
  // actionable line. The "Dirty paths (N):" header below always carries the full
  // dirty count; the trailing "… and X more" line (when present) carries the
  // remaining count past the cap, not the full total.
  const MAX_LISTED_DIRTY_PATHS = 50;
  const listed = dirty.slice(0, MAX_LISTED_DIRTY_PATHS).map((p) => "  " + p);
  if (dirty.length > MAX_LISTED_DIRTY_PATHS) {
    listed.push(`  … and ${dirty.length - MAX_LISTED_DIRTY_PATHS} more (run \`git status --porcelain\` for the full list)`);
  }
  return {
    decision: "block",
    reason:
      "LOCAL-COMMIT-BEFORE-EXIT: the worktree has uncommitted changes — refusing subagent exit " +
      "to prevent silent data loss from post-merge worktree cleanup (cleanup-worktree.mjs runs " +
      "`git worktree remove --force`). Commit your work before stopping. " +
      `Dirty paths (${dirty.length}):\n` +
      listed.join("\n"),
  };
}

/** The editing fixer agent: its repo mutations need a current pulled work order (ADR 0106, 0107). */
export const FIXER_AGENT_TYPE = "fixer";

const isInsidePath = (p, root) => p === root || p.startsWith(`${root}/`);
/** True when checkout-relative `rel` is under one of a grant's `allowedPaths` (segment prefix). */
const inAllowedPaths = (rel, allowedPaths) => Array.isArray(allowedPaths) && allowedPaths.some((p) => p === "." || rel === p || rel.startsWith(`${p}/`));

/**
 * Decide whether a PreToolUse Write/Edit by the `fixer` agent must be denied (ADR 0107,
 * agents/fixer.agent.md). A fixer mutates only inside the mutation authority of a CURRENT
 * work-order pull: its outputRef, or a file under one of the grant's `allowedPaths` in a
 * checkout of the grant's branch. A target outside every listed checkout is scratch space,
 * never a repo mutation. A valid pull never widens authority: another branch, another path
 * and every path under the main checkout's tmp/ except the outputRef stay denied.
 *
 * `targetPath` is the hook's realpath-normalized absolute target. `checkouts` are the repo's
 * listed checkouts `[{ root, branch }]` (realpath-normalized roots, bare branch names), main
 * checkout first. `grants` are `[{ branch, allowedPaths, outputRef }]` for current fixer pulls.
 * `symlinked` is true when the literal target crosses a dangling symlink or one that resolves
 * into a checkout. A missing or relative target, a symlinked target or an empty checkout list
 * denies fail-closed. Every non-fixer agent is allowed here (the other boundaries apply).
 *
 * @param {Object} params
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload.
 * @param {string|null} [params.targetPath] - Realpath-normalized absolute target path.
 * @param {boolean} [params.symlinked] - The literal target crosses a guarded symlink.
 * @param {{ root: string, branch: string|null }[]} [params.checkouts] - Listed checkouts, main first.
 * @param {{ branch: string, allowedPaths: string[], outputRef: string }[]} [params.grants] - Current pull grants.
 * @returns {HookDecision}
 */
export function decideFixerWriteGuard({ agentType = null, targetPath = null, symlinked = false, checkouts = [], grants = [] }) {
  if (normalizeAgentType(agentType) !== FIXER_AGENT_TYPE) return ALLOW;
  const deny = (why) => ({
    decision: "deny",
    reason:
      `Fixer mutation boundary (agents/fixer.agent.md, ADR 0107): refusing to write ${JSON.stringify(targetPath)}: ${why}. ` +
      "Run the dispatched `dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>` line (or its emitted 3-flag form) first. " +
      "A fixer writes only its work order's outputRef and files under mutationAuthority.allowedPaths in a checkout of mutationAuthority.branch.",
  });
  if (typeof targetPath !== "string" || !targetPath.startsWith("/")) return deny("the target path is missing or relative");
  if (symlinked) return deny("the target crosses a symlink");
  const roots = checkouts.filter((c) => typeof c?.root === "string" && c.root.startsWith("/"));
  if (roots.length === 0) return deny("no listed checkout could be resolved");
  if (grants.some((g) => g?.outputRef === targetPath)) return ALLOW;
  // The most specific checkout owns the target (linked worktrees nest under the main checkout).
  const checkout = roots.filter((c) => isInsidePath(targetPath, c.root)).sort((a, b) => b.root.length - a.root.length)[0];
  if (!checkout) return ALLOW;
  if (checkout === roots[0] && isInsidePath(targetPath, `${roots[0].root}/tmp`)) {
    return deny("the main checkout's tmp/ (work-order evidence and plans) is never fixer-writable beyond the outputRef");
  }
  const rel = targetPath === checkout.root ? "." : targetPath.slice(checkout.root.length + 1);
  const granted = grants.some((g) => typeof g?.branch === "string" && g.branch === checkout.branch && inAllowedPaths(rel, g.allowedPaths));
  if (granted) return ALLOW;
  return deny(grants.length === 0
    ? "no current fixer work-order pull grants a mutation authority. A pull line run with a prefix, suffix, redirect or `cd` records no grant; run the exact dispatched pull line again, alone"
    : `no current pull grants path ${JSON.stringify(rel)} on branch ${JSON.stringify(checkout.branch)}`);
}

const GATE_ROUND_CHILD_ROLES = new Set(["review", "judge"]);
// A gate unit is reachable only through its work-order ref or execution identity, so a dev-loop `review` prompt
// that names `pull-work-order` and carries either token marks a gate dispatch, whatever the flag order, `=` form,
// quoting or wrapping. A prose pre-PR or delta brief may quote a token but runs no pull. ponytail: a shape gate; a ref or identity assembled from
// shell variables at runtime evades it, and the digest-verified pull stays the integrity boundary.
const GATE_UNIT_TOKEN_RE = new RegExp(`\\b(?:review|judge|fixer):[\\w.-]+\\/[\\w.-]+#\\d+:|\\b${IDENTITY_PATTERN}\\b`);
// The exact `buildDispatchPointer` text (scripts/github/_work-order-protocol.mjs) around either pull line form;
// the identity prefix or the ref prefix names the role.
const DISPATCH_POINTER_RE = new RegExp(`^Run \`${PULL_LINE}\`; follow its printed work order exactly\\. Exit 1: report its JSON verbatim, stop\\.$`);
const IDENTITY_PREFIX = { review: "r", judge: "j" };
const isDispatchPointer = (prompt, role) => {
  const match = typeof prompt === "string" && Buffer.byteLength(prompt) <= DISPATCH_POINTER_MAX_BYTES ? DISPATCH_POINTER_RE.exec(prompt) : null;
  return Boolean(match) && (match[1] ? match[1][0] === IDENTITY_PREFIX[role] : match[2].startsWith(`${role}:`));
};

// The standalone `review` gate runs no gate-coordinator judge phase: the dev-loop agent itself dispatches that
// gate's judge (skills/review/SKILL.md Phase 3.5). Only an exact emitted judge pointer whose ref names gate `review`
// is exempt; lifecycle-gate judge dispatches stay denied.
const isStandaloneReviewJudgePointer = (prompt) =>
  isDispatchPointer(prompt, "judge") && /--ref judge:[^ ]+#\d+:review:/.test(prompt);

/**
 * Decide whether a PreToolUse Agent/Task dispatch must be denied (GATE-EXEC-GATE-COORDINATOR,
 * ADRs 0112 and 0116). The dev-loop coordinator dispatches no `judge` agent except the emitted standalone review-gate judge pointer, and never
 * dispatches a `review` agent whose prompt carries a `pull-work-order` invocation with a work-order ref or execution identity, in any flag order or wrapping; its prose-briefed pre-PR
 * and delta `review` dispatches are allowed. The `gate-coordinator` agent dispatches only
 * `review` and `judge`, each with the emitted `dispatchPrompt` byte for byte. Every other
 * caller, including the main session (no `agent_type`), is allowed.
 *
 * @param {Object} params
 * @param {string|null} [params.callerAgentType] - Hook payload `agent_type` of the caller.
 * @param {string|null} [params.targetAgentType] - `tool_input.subagent_type` of the dispatch.
 * @param {string|null} [params.prompt] - `tool_input.prompt` of the dispatch.
 * @param {string|null} [params.agentOverrides] - `DEVLOOPS_AGENT_OVERRIDES` (comma-separated roles rendered by the launcher).
 * @returns {HookDecision}
 */
export function decideAgentDispatch({ callerAgentType = null, targetAgentType = null, prompt = null, agentOverrides = null }) {
  // A launcher-rendered CLI agent replaces only the bare role name, so a namespaced dispatch would bypass it.
  if (typeof targetAgentType === "string" && targetAgentType.startsWith("dev-loops:") && typeof agentOverrides === "string") {
    const bare = normalizeAgentType(targetAgentType);
    if (agentOverrides.split(",").map((role) => role.trim()).includes(bare)) {
      return {
        decision: "deny",
        reason:
          `AGENT_OVERRIDE_NAMESPACED_DISPATCH: \`dev-loops-run cli/index.mjs loop claude-launch\` rendered \`${bare}\` with extraTools for this session. ` +
          `Dispatch the bare agent type \`${bare}\` instead of \`${targetAgentType}\`.`,
      };
    }
  }
  const caller = normalizeAgentType(callerAgentType);
  const target = normalizeAgentType(targetAgentType);
  const gateChild = GATE_ROUND_CHILD_ROLES.has(target);
  if (caller === DEV_LOOP_AGENT_TYPE && gateChild &&
    ((target === "judge" && !isStandaloneReviewJudgePointer(prompt)) || (typeof prompt === "string" && /pull-work-order/.test(prompt) && GATE_UNIT_TOKEN_RE.test(prompt) && target !== "judge"))) {
    return {
      decision: "deny",
      reason:
        `GATE_COORDINATOR_REQUIRED: GATE-EXEC-GATE-COORDINATOR denied this \`${target}\` dispatch from the dev-loop coordinator. ` +
        "Dispatch one `gate-coordinator` agent for the gate round; it dispatches the round's review and judge agents and returns the typed round result.",
    };
  }
  if (caller !== GATE_COORDINATOR_AGENT_TYPE) return ALLOW;
  if (!gateChild) {
    return {
      decision: "deny",
      reason:
        `GATE_COORDINATOR_DISPATCH_SCOPE: GATE-EXEC-GATE-COORDINATOR denied this ${JSON.stringify(targetAgentType ?? null)} dispatch from the gate coordinator. ` +
        "The gate coordinator dispatches only the round's `review` and `judge` agents; the dev-loop coordinator dispatches fixers and repeat rounds.",
    };
  }
  if (isDispatchPointer(prompt, target)) return ALLOW;
  return {
    decision: "deny",
    reason:
      `GATE_DISPATCH_NOT_VERBATIM: GATE-EXEC-GATE-COORDINATOR denied this \`${target}\` dispatch: the prompt is not an emitted \`${target}:\` dispatchPrompt. ` +
      "Relay the emitter's dispatchPrompt byte for byte, with no added prose, no `cd` wrapper and no extra flags. A same-head retry recovers through GATE-EXEC-ROUND-RETIREMENT and a fresh round.",
  };
}
