import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { runChild as coreRunChild } from "../cli/primitives.mjs";
import { main as moveQueueItemMain } from "../../../../scripts/projects/move-queue-item.mjs";

const DEFAULT_NON_SUCCESS_COLUMN = "Backlog";

// ── State → board column mapping (AC1, AC3, AC5) ─────────────────────────
//
// The mapping is intentionally stateless: it is a pure function of the loop
// state. Because of that, a reverted loop state (e.g. a merged PR reopened, or
// a ready PR demoted back to draft) maps backward to the earlier column for
// free (AC5) — there is no persisted "furthest reached" column to unwind.

/** Logical board columns. Display names are config-driven (AC3). */
export const LOGICAL_COLUMN = Object.freeze({
  NEXT_UP: "next_up",
  IN_PROGRESS: "in_progress",
  READY_FOR_REVIEW: "ready_for_review",
  DONE: "done",
});

/** Allow-list of recognized logical column tokens (for config validation). */
const KNOWN_LOGICAL_COLUMNS = new Set(Object.values(LOGICAL_COLUMN));

/** Keys that must never be copied from untrusted config (prototype pollution). */
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Default display name for each logical column (AC1 values). */
export const DEFAULT_STATE_COLUMN_NAMES = Object.freeze({
  [LOGICAL_COLUMN.NEXT_UP]: "Next Up",
  [LOGICAL_COLUMN.IN_PROGRESS]: "In Progress",
  // Ready for Review is opt-in: by default it resolves to In Progress so that
  // final_approval_ready keeps "In Progress" unless a board configures it.
  [LOGICAL_COLUMN.READY_FOR_REVIEW]: "In Progress",
  [LOGICAL_COLUMN.DONE]: "Done",
});

/**
 * Default loop-state → logical-column map. Covers both the lifecycle states
 * (lifecycle-state.mjs) and the inner Copilot loop states (copilot-loop-state.mjs),
 * plus the conceptual names used by issue #793. Unknown states fall back to
 * IN_PROGRESS (a safe, visible "work is happening" column) rather than throwing.
 */
export const DEFAULT_STATE_LOGICAL_MAP = Object.freeze({
  // Next Up — work not yet actively in flight
  issue_opened: LOGICAL_COLUMN.NEXT_UP,
  issue_intake: LOGICAL_COLUMN.NEXT_UP,
  refinement: LOGICAL_COLUMN.NEXT_UP,
  no_pr: LOGICAL_COLUMN.NEXT_UP,
  pr_draft: LOGICAL_COLUMN.NEXT_UP,

  // In Progress — active implementation / review / feedback resolution
  implementation: LOGICAL_COLUMN.IN_PROGRESS,
  // Tolerated alias for `implementation` (conceptual name from issue #793);
  // the queue driver passes the real `implementation` lifecycle state.
  local_implementation_active: LOGICAL_COLUMN.IN_PROGRESS,
  draft_gate: LOGICAL_COLUMN.IN_PROGRESS,
  pr_ready_no_feedback: LOGICAL_COLUMN.IN_PROGRESS,
  feedback_resolution: LOGICAL_COLUMN.IN_PROGRESS,
  copilot_review: LOGICAL_COLUMN.IN_PROGRESS,
  waiting_for_copilot_review: LOGICAL_COLUMN.IN_PROGRESS,
  ready_to_rerequest_review: LOGICAL_COLUMN.IN_PROGRESS,
  unresolved_feedback_present: LOGICAL_COLUMN.IN_PROGRESS,
  already_fixed_needs_reply_resolve: LOGICAL_COLUMN.IN_PROGRESS,
  waiting_for_ci: LOGICAL_COLUMN.IN_PROGRESS,
  review_request_unavailable: LOGICAL_COLUMN.IN_PROGRESS,
  round_cap_reached: LOGICAL_COLUMN.IN_PROGRESS,
  round_cap_clean_fallback: LOGICAL_COLUMN.IN_PROGRESS,
  internal_tooling_direct_gate: LOGICAL_COLUMN.IN_PROGRESS,
  low_signal_converged: LOGICAL_COLUMN.IN_PROGRESS,
  blocked_needs_user_decision: LOGICAL_COLUMN.IN_PROGRESS,

  // Ready for Review — final approval gate. Resolves to In Progress unless a
  // board configures a distinct "Ready for Review" column name (AC1).
  pre_approval_gate: LOGICAL_COLUMN.READY_FOR_REVIEW,
  final_approval_ready: LOGICAL_COLUMN.READY_FOR_REVIEW,

  // Done — terminal (lifecycle MERGE = "merge", queue terminal = "done")
  merge: LOGICAL_COLUMN.DONE,
  done: LOGICAL_COLUMN.DONE,
  // Tolerated aliases (conceptual names from issue #793).
  merged: LOGICAL_COLUMN.DONE,
  issue_closed: LOGICAL_COLUMN.DONE,
});

/** Safe default logical column for any state we do not explicitly map. */
const DEFAULT_LOGICAL_COLUMN = LOGICAL_COLUMN.IN_PROGRESS;

/**
 * Pure mapping: loop state → board column display name.
 *
 * @param {string|null|undefined} loopState - a lifecycle or inner loop state
 *   name. `null`, `undefined`, and any unrecognized value fall through to the
 *   safe default logical column (IN_PROGRESS).
 * @param {{stateColumnMap?:Object, columnNames?:Object}} [mapping]
 *   Optional overrides. `stateColumnMap` overrides state→logical-column;
 *   `columnNames` overrides logical-column→display-name. Both fall back to
 *   the AC1 defaults.
 * @returns {string} the target board column display name.
 */
export function boardColumnForLoopState(loopState, mapping = {}) {
  const stateMap = { ...DEFAULT_STATE_LOGICAL_MAP, ...(mapping.stateColumnMap ?? {}) };
  const columnNames = { ...DEFAULT_STATE_COLUMN_NAMES, ...(mapping.columnNames ?? {}) };
  const logical = stateMap[loopState] ?? DEFAULT_LOGICAL_COLUMN;
  return columnNames[logical] ?? columnNames[DEFAULT_LOGICAL_COLUMN];
}

/**
 * Derive the board's target LOGICAL column for a queue item from live GitHub
 * facts (#1069). Returns LOGICAL_COLUMN.DONE, LOGICAL_COLUMN.IN_PROGRESS, or
 * null when the item should be left where it is (Backlog/Next Up untouched).
 *
 * facts: {
 *   itemKind: "issue" | "pr",
 *   issueState: "OPEN" | "CLOSED" | null,   // for issue items
 *   prState:    "OPEN" | "CLOSED" | "MERGED" | null, // item PR, or the issue's linked PR
 *   prIsDraft:  boolean | null,
 * }
 */
export function deriveReconcileColumn(facts = {}) {
  const { itemKind, issueState, prState, prIsDraft } = facts;
  // Merged PR (item is a PR, or issue's linked PR merged) => Done.
  if (prState === "MERGED") return LOGICAL_COLUMN.DONE;
  if (itemKind === "issue" && issueState === "CLOSED") return LOGICAL_COLUMN.DONE;
  // Open, ready (non-draft) PR => In Progress.
  if (prState === "OPEN" && prIsDraft === false) return LOGICAL_COLUMN.IN_PROGRESS;
  // Otherwise leave the item untouched (Backlog / Next Up ordering preserved).
  return null;
}

/**
 * Pure reconcile planner (#1069). Given listed board items, a map of live facts
 * keyed by the item's stable GraphQL node id (`item.itemId`), and the resolved
 * column display names, return the set of moves needed to converge the board and
 * a count of items left unchanged. Idempotent: when every item already sits in
 * its derived column, the moves array is empty.
 *
 * Keying by the stable `itemId` (not the bare issue/PR number) keeps reconcile
 * deterministic on a multi-repo GitHub Projects board, where two items can share
 * a number (repo-A PR #5 vs repo-B issue #5) — number-keying would collide and
 * make moves order-dependent.
 *
 * items: [{ itemId, issueNumber, prNumber, status, ... }]  (from list-queue-items)
 * factsByItemId: Map<itemId, factsObject>   (facts as consumed by deriveReconcileColumn)
 * columnNames: { in_progress, done, ... }   (LOGICAL_COLUMN -> display name)
 */
export function planReconcile(items = [], factsByItemId = new Map(), columnNames = {}) {
  const moves = [];
  let unchanged = 0;
  for (const item of items) {
    const facts = factsByItemId.get(item.itemId);
    const logical = facts ? deriveReconcileColumn(facts) : null;
    if (logical == null) { unchanged += 1; continue; }
    const target = columnNames[logical];
    if (!target || item.status === target) { unchanged += 1; continue; }
    // `number` is kept only for reporting; the move is applied by node id.
    const number = item.prNumber != null ? item.prNumber : item.issueNumber;
    moves.push({ itemId: item.itemId, number, from: item.status ?? null, to: target });
  }
  return { moves, unchanged };
}

// ── Local config loader ─────────────────────────────────────────────────

function readDevloopsSettings(repoRoot) {
  const base = path.join(repoRoot, ".devloops");
  const extensions = ["", ".yaml", ".yml", ".json"];
  let foundError = null;
  for (const ext of extensions) {
    try {
      const raw = readFileSync(base + ext, "utf8");
      const settings = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      return { settings: settings?.queue ?? null };
    } catch (err) {
      if (err?.code === "ENOENT") {
        // try next extension
      } else if (!foundError) {
        foundError = err;
      }
    }
  }
  if (foundError) {
    return { error: foundError.message };
  }
  return { settings: null };
}

export function loadBoardConfig(repoRoot) {
  const { settings: queue, error } = readDevloopsSettings(repoRoot);
  if (error) {
    return { enabled: false, reason: `config read/parse error: ${error}` };
  }
  if (!queue) return { enabled: false };
  if (typeof queue.projectNumber === "number" && queue.projectNumber > 0) {
    return { enabled: true, projectNumber: queue.projectNumber };
  }
  if (typeof queue.boardTitle === "string" && queue.boardTitle.trim().length > 0) {
    return { enabled: true, boardTitle: queue.boardTitle.trim() };
  }
  return { enabled: false };
}

/**
 * Load the config-driven state→column mapping from `.devloops` `queue` (AC3).
 *
 * Reads two optional config keys, both gated behind the same opt-in `queue`
 * section as `loadBoardConfig` (AC2/AC6):
 *   - `queue.statusColumns`  — logical-column → display-name overrides
 *     (keys: next_up, in_progress, ready_for_review, done)
 *   - `queue.stateColumnMap` — loop-state → logical-column overrides
 *
 * Returns a `{ stateColumnMap, columnNames }` shape consumable by
 * `boardColumnForLoopState`. Missing config yields the AC1 defaults.
 *
 * Hardened against untrusted `.devloops` input:
 *   - `statusColumns` keys are allow-listed to the known logical columns;
 *     unrecognized keys are ignored.
 *   - `stateColumnMap` entries whose value is not a known logical column are
 *     ignored.
 *   - Dangerous keys (`__proto__`, `prototype`, `constructor`) are skipped and
 *     results are built on null-prototype objects, so a malicious config key
 *     cannot pollute Object.prototype.
 */
export function loadStateColumnMap(repoRoot) {
  const { settings: queue } = readDevloopsSettings(repoRoot);
  // Null-prototype objects: untrusted keys can never reach Object.prototype.
  const columnNames = Object.assign(Object.create(null), DEFAULT_STATE_COLUMN_NAMES);
  const stateColumnMap = Object.create(null);

  const statusColumns = queue?.statusColumns;
  if (statusColumns && typeof statusColumns === "object") {
    for (const logical of Object.keys(statusColumns)) {
      if (DANGEROUS_KEYS.has(logical)) continue;
      // Allow-list: only recognized logical columns may be renamed.
      if (!KNOWN_LOGICAL_COLUMNS.has(logical)) continue;
      const name = statusColumns[logical];
      if (typeof name === "string" && name.trim().length > 0) {
        columnNames[logical] = name.trim();
      }
    }
  }

  const stateMap = queue?.stateColumnMap;
  if (stateMap && typeof stateMap === "object") {
    for (const state of Object.keys(stateMap)) {
      if (DANGEROUS_KEYS.has(state)) continue;
      const logical = stateMap[state];
      // Ignore values that are not a recognized logical column.
      if (typeof logical !== "string") continue;
      const trimmed = logical.trim();
      if (!KNOWN_LOGICAL_COLUMNS.has(trimmed)) continue;
      stateColumnMap[state] = trimmed;
    }
  }

  return { columnNames, stateColumnMap };
}

// ── Minimal project lookup (read-only, no create/repair) ────────────────

const GET_USER_ID = [
  "query($login:String!) {",
  "  user(login:$login) { id }",
  "}"
].join("\n");

const GET_ORG_ID = [
  "query($login:String!) {",
  "  organization(login:$login) { id }",
  "}"
].join("\n");

const LIST_USER_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  user(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes { id number title url }",
  "    }",
  "  }",
  "}"
].join("\n");

const LIST_ORG_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  organization(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes { id number title url }",
  "    }",
  "  }",
  "}"
].join("\n");

async function ghGraphql(query, vars, env, runChild) {
  const child = runChild ?? coreRunChild;
  const fieldArgs = [];
  for (const [key, value] of Object.entries(vars)) {
    fieldArgs.push("--field", `${key}=${value}`);
  }
  const result = await child(
    "gh",
    ["api", "graphql", "--field", `query=${query}`, ...fieldArgs],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw Object.assign(new Error(`gh api graphql failed: ${detail}`), { code: "GH_API_ERROR" });
  }
  const payload = JSON.parse(result.stdout);
  if (payload.errors && payload.errors.length > 0) {
    throw Object.assign(
      new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`),
      { code: "GRAPHQL_ERROR" },
    );
  }
  return payload;
}

async function resolveOwner(login, env, runChild) {
  const userPayload = await ghGraphql(GET_USER_ID, { login }, env, runChild);
  if (userPayload?.data?.user?.id) {
    return { id: userPayload.data.user.id, kind: "user" };
  }
  const orgPayload = await ghGraphql(GET_ORG_ID, { login }, env, runChild);
  if (orgPayload?.data?.organization?.id) {
    return { id: orgPayload.data.organization.id, kind: "org" };
  }
  throw Object.assign(
    new Error(`Could not resolve owner ID for "${login}"`),
    { code: "NO_USER_ID" },
  );
}

async function listAllProjects(login, kind, env, runChild) {
  const query = kind === "org" ? LIST_ORG_PROJECTS : LIST_USER_PROJECTS;
  const projects = [];
  let after = null;
  while (true) {
    const vars = { login };
    if (after) vars.after = after;
    const payload = await ghGraphql(query, vars, env, runChild);
    const connection = kind === "org"
      ? payload?.data?.organization?.projectsV2
      : payload?.data?.user?.projectsV2;
    const nodes = connection?.nodes ?? [];
    projects.push(...nodes.filter((n) => n != null));
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(
        new Error("Invalid projects list payload: hasNextPage is true but endCursor is missing"),
        { code: "GH_API_ERROR" },
      );
    }
    after = pageInfo.endCursor;
  }
  return projects;
}

const projectNumberCache = new Map();

function projectCacheKey(repo, boardTitle) {
  return `${repo}::${boardTitle}`;
}

export async function resolveProjectNumber(repo, config, env, runChild) {
  if (config.projectNumber) return config.projectNumber;
  if (config.boardTitle) {
    const key = projectCacheKey(repo, config.boardTitle);
    const cached = projectNumberCache.get(key);
    if (cached) return cached;

    const [owner] = repo.split("/");
    const { kind } = await resolveOwner(owner, env, runChild);
    const projects = await listAllProjects(owner, kind, env, runChild);
    const match = projects.find((p) => p.title === config.boardTitle);
    if (!match) {
      throw Object.assign(
        new Error(`Board title "${config.boardTitle}" not found under "${owner}"`),
        { code: "BOARD_NOT_FOUND" },
      );
    }
    projectNumberCache.set(key, match.number);
    return match.number;
  }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────

export async function syncBoardStatus(
  repo,
  repoRoot,
  itemNumber,
  targetColumn,
  env = process.env,
  dependencies = {},
) {
  // AC4: the not-on-board / fail-open path is a logged no-op. Default to
  // console.error so it logs in real runs; tests inject their own stub. The
  // log fires at most once per syncBoardStatus call (single catch, no internal
  // retry), so it cannot spam.
  const log = typeof dependencies.log === "function"
    ? dependencies.log
    : (msg) => console.error(msg);

  const config = loadBoardConfig(repoRoot);
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: config.reason ?? "board not configured" };
  }

  let projectNumber;
  try {
    projectNumber = await resolveProjectNumber(repo, config, env, dependencies.runChild);
  } catch (err) {
    return { ok: true, skipped: true, reason: err.message ?? "board lookup failed" };
  }
  if (!projectNumber) {
    return { ok: true, skipped: true, reason: "could not resolve board project" };
  }

  const moveItem = dependencies.moveQueueItem ?? moveQueueItemMain;
  try {
    const result = await moveItem(
      // move-queue-item validates project + item as string refs (CLI contract);
      // resolveProjectNumber yields a number and itemNumber is numeric, so
      // stringify both.
      { repo, project: String(projectNumber), item: String(itemNumber), toColumn: targetColumn },
      { env, runChild: dependencies.runChild },
    );
    return { ok: true, skipped: false, result };
  } catch (err) {
    // Fail-open: a board hiccup (rate limit, missing column, item not on board)
    // must never break the loop.
    const reason = err?.message ?? "board sync failed";
    // AC4: the explicit "item not on board" case is a clean, logged no-op.
    // Other fail-open failures (rate limit, missing column, etc.) get a
    // distinct, distinguishable message so they are not conflated with AC4.
    const notOnBoard = err?.code === "ITEM_NOT_FOUND" || err?.code === "ITEM_NOT_ON_BOARD";
    if (notOnBoard) {
      log(`[board-sync] no-op: item ${itemNumber} is not on the board (${reason})`);
    } else {
      log(`[board-sync] sync failed (fail-open) for item ${itemNumber} → "${targetColumn}": ${reason}`);
    }
    return { ok: true, skipped: true, reason };
  }
}

export function nonSuccessBoardColumn(repoRoot, fallback = DEFAULT_NON_SUCCESS_COLUMN) {
  const { settings: queue } = readDevloopsSettings(repoRoot);
  const configured = queue?.nonSuccessStatus;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : fallback;
}
