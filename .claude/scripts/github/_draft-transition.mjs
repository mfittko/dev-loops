// Shared draft<->ready GraphQL/CLI mutations used by both reconcile-draft-gate.mjs
// (the manual/CI recovery CLI) and upsert-checkpoint-verdict.mjs's in-process
// self-heal transition (postDraftGateViaDraftTransition, #891).
//
// Deliberately its own module with NO dependency on either caller: previously
// upsert-checkpoint-verdict.mjs reached these via a dynamic `import("./reconcile-
// draft-gate.mjs")`, and reconcile-draft-gate.mjs statically imports
// upsertCheckpointVerdict from upsert-checkpoint-verdict.mjs — a circular module
// reference. When upsert-checkpoint-verdict.mjs is the CLI entry point (running
// under its own top-level `await main()`), that dynamic import of a module which
// circularly re-imports the still-evaluating entry module deadlocks Node's ESM
// module linker: the import() promise never settles, main() never returns, and
// the process eventually exits 13 with "Detected unsettled top-level await"
// (issue #1455) — silently, without posting the gate verdict. Breaking the cycle
// by extracting the shared mutations here (imported statically by both callers,
// with no back-reference) removes the deadlock at its source instead of working
// around it with retries or a load timeout.
import { parseJsonText } from "../_core-helpers.mjs";
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
const CONVERT_TO_DRAFT_MUTATION = [
  "mutation($pullRequestId:ID!) {",
  "  convertPullRequestToDraft(input: {pullRequestId: $pullRequestId}) {",
  "    pullRequest {",
  "      id",
  "      isDraft",
  "    }",
  "  }",
  "}",
].join("\n");
const PR_ID_QUERY = [
  "query($owner:String!, $name:String!, $number:Int!) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $number) {",
  "      id",
  "      isDraft",
  "    }",
  "  }",
  "}",
].join("\n");
async function resolvePrNodeId({ repo, pr }, { env, ghCommand, runChild = defaultRunChild }) {
  const [owner, name] = repo.split("/");
  const result = await runChild(ghCommand, [
    "api", "graphql",
    "-f", "query=" + PR_ID_QUERY,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${pr}`,
  ], env);
  if (result.code !== 0) {
    throw new Error(
      `Failed to resolve PR node ID for #${pr}: ${result.stderr.trim() || `exit code ${result.code}`}`
    );
  }
  const payload = parseJsonText(result.stdout, {
    label: `gh api graphql (resolvePrNodeId for #${pr})`,
  });
  const prData = payload?.data?.repository?.pullRequest;
  if (!prData?.id) {
    throw new Error(`Could not resolve PR node ID for #${pr}`);
  }
  return { id: prData.id, isDraft: prData.isDraft };
}
export async function convertPrToDraft({ repo, pr }, { env, ghCommand, runChild = defaultRunChild }) {
  const resolvedPr = await resolvePrNodeId({ repo, pr }, { env, ghCommand, runChild });
  if (resolvedPr.isDraft === true) {
    return {
      ...resolvedPr,
      alreadyDraft: true,
    };
  }
  const result = await runChild(ghCommand, [
    "api", "graphql",
    "-f", "query=" + CONVERT_TO_DRAFT_MUTATION,
    "-F", `pullRequestId=${resolvedPr.id}`,
  ], env);
  if (result.code !== 0) {
    throw new Error(
      `Failed to convert PR #${pr} to draft: ${result.stderr.trim() || `exit code ${result.code}`}`
    );
  }
  const payload = parseJsonText(result.stdout, {
    label: `gh api graphql (convertPullRequestToDraft #${pr})`,
  });
  const converted = payload?.data?.convertPullRequestToDraft?.pullRequest;
  if (converted?.isDraft !== true) {
    throw new Error(`PR #${pr} was not set to draft state after mutation`);
  }
  return {
    ...converted,
    alreadyDraft: false,
  };
}
export async function markPrReady({ repo, pr }, { env, ghCommand, runChild = defaultRunChild }) {
  const result = await runChild(ghCommand, [
    "pr", "ready", String(pr),
    "--repo", repo,
  ], env);
  if (result.code !== 0) {
    throw new Error(
      `Failed to mark PR #${pr} ready: ${result.stderr.trim() || `exit code ${result.code}`}`
    );
  }
  return true;
}
