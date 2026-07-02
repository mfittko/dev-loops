import { loadBoardConfig, resolveProjectNumber } from "./queue-board-sync.mjs";
import { main as listQueueItemsMain } from "../../../../scripts/projects/list-queue-items.mjs";

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

  const listItems = dependencies.listQueueItems ?? listQueueItemsMain;
  try {
    const result = await listItems(
      // list-queue-items validates `project` as a string ref (CLI contract);
      // resolveProjectNumber yields a number, so stringify it. Passing the raw
      // number trips parseProjectRef's `typeof raw !== "string"` guard, which
      // surfaces as a misleading "--project is required" (#901).
      { repo, project: String(projectNumber), column: "Next Up" },
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
