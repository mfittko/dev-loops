// Shared loop PR-aggregation helpers used by both conductor-monitor.mjs and
// run-conductor-cycle.mjs. Spawns `gh`, so this lives at the scripts level
// rather than in @dev-loops/core.
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseJsonText } from "../_core-helpers.mjs";

export const OPEN_PR_LIST_LIMIT = 1000;

export async function listOpenPrs({ repo }, { env, ghCommand, runChild = defaultRunChild }) {
  const result = await runChild(
    ghCommand,
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(OPEN_PR_LIST_LIMIT),
      "--json",
      "number,title,url,isDraft,headRefName,author",
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  if (!Array.isArray(payload)) {
    throw new Error("Invalid gh pr list payload: expected an array");
  }
  return payload
    .map((pr) => ({
      number: Number.isInteger(pr?.number) ? pr.number : null,
      title: typeof pr?.title === "string" ? pr.title : "",
      url: typeof pr?.url === "string" ? pr.url : null,
      isDraft: Boolean(pr?.isDraft),
      headRefName: typeof pr?.headRefName === "string" ? pr.headRefName : null,
      authorLogin: typeof pr?.author?.login === "string" ? pr.author.login : null,
    }))
    .filter((pr) => pr.number !== null)
    .sort((left, right) => left.number - right.number);
}
