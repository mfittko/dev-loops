import { loadBoardConfig, resolveProjectNumber } from "./queue-board-sync.mjs";
import { main as listQueueItemsMain } from "../../../../scripts/projects/list-queue-items.mjs";

export async function resolveNextUpOrder(
  repo,
  repoRoot,
  env = process.env,
  dependencies = {},
) {
  const config = loadBoardConfig(repoRoot);
  if (!config.enabled) {
    return { ok: true, order: [], reason: config.reason ?? "board not configured" };
  }

  let projectNumber;
  try {
    projectNumber = await resolveProjectNumber(repo, config, env, dependencies.runChild);
  } catch (err) {
    return { ok: true, order: [], reason: err.message ?? "board lookup failed" };
  }
  if (!projectNumber) {
    return { ok: true, order: [], reason: "could not resolve board project" };
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
    return { ok: true, order, reason: null };
  } catch (err) {
    return { ok: true, order: [], reason: err.message ?? "Next Up query failed" };
  }
}
