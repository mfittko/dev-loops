import { loadBoardConfig, resolveProjectNumber, loadStateColumnMap, LOGICAL_COLUMN } from "./queue-board-sync.mjs";
import { main as listQueueItemsMain } from "../projects/list-queue-items.mjs";

// Canonical fail-closed Next Up tokens — the SINGLE source of truth so the reason
// codes and the empty-queue message stay byte-identical across every layer that
// detects them (queue-driver, run-queue, resolve-active-board-item). These strings
// drifted twice before centralization (#1091); import them, never re-inline them.
export const REASON_NEXT_UP_EMPTY = "next-up-empty";
export const REASON_BOARD_QUERY_ERROR = "board-query-error";
export const REASON_NEXT_UP_TARGET_MISSING_LOCALLY = "next-up-target-missing-locally";
export const EMPTY_NEXT_UP_MESSAGE = "queue empty — prioritize Backlog items into Next Up";

/**
 * Resolve the board's "Next Up" pickup order (issue #1091).
 *
 * Next Up is the NORMATIVE, fail-closed pickup source. This resolver reports
 * enough to let the driver distinguish three cases cleanly (it never silently
 * collapses them):
 *
 *   - Board NOT configured → `{ ok:true, configured:false, order:[] }`. The
 *     Next Up concept does not exist; the driver keeps its legacy local order.
 *   - Board configured, Next Up query SUCCEEDS → `{ ok:true, configured:true,
 *     order:[…], reason:null }`. `order` may be empty (a genuinely empty Next
 *     Up → the driver fails closed / idles, it MUST NOT fall back to Backlog).
 *   - Board configured, query ERRORS (unreachable / project unresolvable / API
 *     failure) → `{ ok:false, configured:true, order:[], reason:<msg> }`. The
 *     driver surfaces the error and stops; it MUST NOT fall back to Backlog.
 *
 * `order` and `reason` are always present so the fail-open membership layer
 * (queue-membership.mjs), which predates the `ok`/`configured` fields, keeps
 * working unchanged (it reads `order`/`reason` only).
 */
export async function resolveNextUpOrder(
  repo,
  repoRoot,
  env = process.env,
  dependencies = {},
) {
  const config = loadBoardConfig(repoRoot);
  if (!config.enabled) {
    return { ok: true, configured: false, order: [], reason: config.reason ?? "board not configured" };
  }

  let projectNumber;
  try {
    projectNumber = await resolveProjectNumber(repo, config, env, dependencies.runChild);
  } catch (err) {
    // Board IS configured but we cannot resolve/reach it: this is a query ERROR,
    // not an empty Next Up. Fail closed at the driver, never Backlog fallback.
    return { ok: false, configured: true, order: [], reason: err.message ?? "board lookup failed" };
  }
  if (!projectNumber) {
    return { ok: false, configured: true, order: [], reason: "could not resolve board project" };
  }

  // Resolve the logical next_up column through the SAME statusColumns mapping
  // board-sync uses (#1098), so a renamed Next Up column (e.g. "Todo") is
  // queried by its configured display name instead of the literal default.
  // No config-error guard here: loadBoardConfig above already short-circuits any
  // `.devloops` read/parse error to `enabled:false` (early return at the top of
  // this function), so a malformed config never reaches this point. The
  // fail-closed-on-config-error guard lives on the direct-read pickup path
  // (resolve-active-board-item), which does NOT go through loadBoardConfig.
  const { columnNames } = loadStateColumnMap(repoRoot);
  const nextUpColumn = columnNames[LOGICAL_COLUMN.NEXT_UP];

  const listItems = dependencies.listQueueItems ?? listQueueItemsMain;
  try {
    const result = await listItems(
      // list-queue-items validates `project` as a string ref (CLI contract);
      // resolveProjectNumber yields a number, so stringify it. Passing the raw
      // number trips parseProjectRef's `typeof raw !== "string"` guard, which
      // surfaces as a misleading "--project is required" (#901).
      { repo, project: String(projectNumber), column: nextUpColumn },
      { env, runChild: dependencies.runChild },
    );
    const order = (result?.items ?? [])
      .map((it) => it.issueNumber ?? it.prNumber)
      .filter((n) => typeof n === "number");
    // Successful query — order may be empty (genuinely empty Next Up).
    return { ok: true, configured: true, order, reason: null };
  } catch (err) {
    // Query ERROR — surface it; the driver stops and never falls back.
    return { ok: false, configured: true, order: [], reason: err.message ?? "Next Up query failed" };
  }
}
