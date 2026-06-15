#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseIssueNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { detectLinkedIssuePr } from "../github/detect-linked-issue-pr.mjs";
import { detectCopilotSessionActivity } from "./detect-copilot-session-activity.mjs";
const USAGE = `Usage: detect-initial-copilot-pr-state.mjs --repo <owner/name> --issue <number>
Detect whether an assigned issue is still on the bootstrap-only Copilot draft PR
or has moved into normal linked-PR follow-up.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --issue <number>      Issue number
States:
  no_linked_pr
  prior_linked_pr_closed_unmerged
  copilot_session_active
  waiting_for_initial_copilot_implementation
  linked_pr_ready_for_followup
Success output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/name",
    "issue": 59,
    "state": "no_linked_pr"|"prior_linked_pr_closed_unmerged"|"copilot_session_active"|"waiting_for_initial_copilot_implementation"|"linked_pr_ready_for_followup",
    "prNumber": 79|null,
    "prUrl": "..."|null,
    "headBranch": "..."|null,
    "authorLogin": "Copilot"|null,
    "isDraft": true|false|null,
    "changedFiles": 0|null,
    "commitCount": 1|null,
    "soleCommitHeadline": "Initial plan"|null,
    "sessionActivity": "active"|"concluded"|"idle"|null,
    "sessionRunId": 123|null,
    "sessionRunName": "..."|null,
    "sessionRunStatus": "..."|null,
    "sessionRunConclusion": string|null,
    "sessionRunCreatedAt": "..."|null,
    "sessionConfidence": "high"|null
  }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }`.trim();
export const LINKED_PR_STATE = Object.freeze({
  NO_LINKED_PR: "no_linked_pr",
  PRIOR_LINKED_PR_CLOSED_UNMERGED: "prior_linked_pr_closed_unmerged",
  COPILOT_SESSION_ACTIVE: "copilot_session_active",
  WAITING_FOR_INITIAL_COPILOT_IMPLEMENTATION: "waiting_for_initial_copilot_implementation",
  LINKED_PR_READY_FOR_FOLLOWUP: "linked_pr_ready_for_followup",
});
const INITIAL_COPILOT_PR_FACTS_QUERY = [
  "query($owner:String!, $name:String!, $pr:Int!) {",
  "  repository(owner:$owner, name:$name) {",
  "    pullRequest(number:$pr) {",
  "      number",
  "      url",
  "      headRefName",
  "      state",
  "      isDraft",
  "      changedFiles",
  "      repository { nameWithOwner }",
  "      author {",
  "        __typename",
  "        login",
  "      }",
  "      commits(first: 2) {",
  "        totalCount",
  "        nodes {",
  "          commit {",
  "            messageHeadline",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");
const parseError = buildParseError(USAGE);
export function parseDetectInitialCopilotPrStateCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    issue: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--issue") {
      options.issue = parseIssueNumber(requireOptionValue(args, "--issue", parseError), parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("detect-initial-copilot-pr-state requires both --repo <owner/name> and --issue <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function buildQueryArgs({ owner, name, pr }) {
  return [
    "api",
    "graphql",
    "--field",
    `owner=${owner}`,
    "--field",
    `name=${name}`,
    "-F",
    `pr=${pr}`,
    "--field",
    `query=${INITIAL_COPILOT_PR_FACTS_QUERY}`,
  ];
}
function getRequiredString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required PR facts: ${fieldName}`);
  }
  return value;
}
function getRequiredBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new Error(`Missing required PR facts: ${fieldName}`);
  }
  return value;
}
function getRequiredNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Missing required PR facts: ${fieldName}`);
  }
  return value;
}
function getRequiredPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Missing required PR facts: ${fieldName}`);
  }
  return value;
}
function normalizeRepoForComparison(repo) {
  return typeof repo === "string" ? repo.trim().toLowerCase() : "";
}
function isCopilotAuthored(authorLogin) {
  const normalized = String(authorLogin).trim().toLowerCase();
  return normalized === "copilot"
    || normalized === "copilot-swe-agent"
    || normalized === "app/copilot-swe-agent"
    || normalized === "copilot-swe-agent[bot]";
}
function classifyInitialCopilotPrState({ repo, facts }) {
  const isBootstrapOnly = facts.state === "OPEN"
    && normalizeRepoForComparison(facts.repository) === normalizeRepoForComparison(repo)
    && facts.isDraft
    && isCopilotAuthored(facts.authorLogin)
    && facts.commitCount === 1
    && facts.changedFiles === 0
    && facts.soleCommitHeadline === "Initial plan";
  if (facts.sessionActivity === "active") {
    return LINKED_PR_STATE.COPILOT_SESSION_ACTIVE;
  }
  return isBootstrapOnly
    ? LINKED_PR_STATE.WAITING_FOR_INITIAL_COPILOT_IMPLEMENTATION
    : LINKED_PR_STATE.LINKED_PR_READY_FOR_FOLLOWUP;
}
async function fetchLinkedPrFacts({ repo, prNumber }, { env, ghCommand }) {
  const { owner, name } = parseRepoSlug(repo);
  const result = await runChild(
    ghCommand,
    buildQueryArgs({ owner, name, pr: prNumber }),
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== "object") {
    throw new Error(`Missing required PR facts: data.repository.pullRequest for linked PR #${prNumber}`);
  }
  const commitCount = getRequiredNonNegativeInteger(pr?.commits?.totalCount, "pullRequest.commits.totalCount");
  const commitNode = Array.isArray(pr?.commits?.nodes) ? pr.commits.nodes[0] : null;
  const soleCommitHeadline = commitCount === 1
    ? getRequiredString(commitNode?.commit?.messageHeadline, "pullRequest.commits.nodes[0].commit.messageHeadline")
    : null;
  return {
    number: getRequiredPositiveInteger(pr.number, "pullRequest.number"),
    url: getRequiredString(pr.url, "pullRequest.url"),
    headBranch: getRequiredString(pr.headRefName, "pullRequest.headRefName"),
    state: getRequiredString(pr.state, "pullRequest.state"),
    isDraft: getRequiredBoolean(pr.isDraft, "pullRequest.isDraft"),
    changedFiles: getRequiredNonNegativeInteger(pr.changedFiles, "pullRequest.changedFiles"),
    repository: getRequiredString(pr?.repository?.nameWithOwner, "pullRequest.repository.nameWithOwner"),
    authorLogin: getRequiredString(pr?.author?.login, "pullRequest.author.login"),
    commitCount,
    soleCommitHeadline,
  };
}
export async function detectInitialCopilotPrState({ repo, issue }, { env = process.env, ghCommand = "gh" } = {}) {
  const linked = await detectLinkedIssuePr({ repo, issue }, { env, ghCommand });
  if (!linked.hasOpenLinkedPr || linked.prNumber === null) {
    if (linked.hasPriorClosedUnmergedPr) {
      return {
        ok: true,
        repo,
        issue,
        state: LINKED_PR_STATE.PRIOR_LINKED_PR_CLOSED_UNMERGED,
        prNumber: linked.priorClosedUnmergedPrNumber ?? null,
        prUrl: linked.priorClosedUnmergedPrUrl ?? null,
        headBranch: null,
        authorLogin: null,
        isDraft: null,
        changedFiles: null,
        commitCount: null,
        soleCommitHeadline: null,
        sessionActivity: null,
        sessionRunId: null,
        sessionRunName: null,
        sessionRunStatus: null,
        sessionRunConclusion: null,
        sessionRunCreatedAt: null,
        sessionConfidence: null,
      };
    }
    return {
      ok: true,
      repo,
      issue,
      state: LINKED_PR_STATE.NO_LINKED_PR,
      prNumber: null,
      prUrl: null,
      headBranch: null,
      authorLogin: null,
      isDraft: null,
      changedFiles: null,
      commitCount: null,
      soleCommitHeadline: null,
      sessionActivity: null,
      sessionRunId: null,
      sessionRunName: null,
      sessionRunStatus: null,
      sessionRunConclusion: null,
      sessionRunCreatedAt: null,
      sessionConfidence: null,
    };
  }
  const facts = await fetchLinkedPrFacts({ repo, prNumber: linked.prNumber }, { env, ghCommand });
  let sessionActivity = null;
  if (facts.isDraft && isCopilotAuthored(facts.authorLogin)) {
    sessionActivity = await detectCopilotSessionActivity(
      {
        repo,
        branch: facts.headBranch,
      },
      { env, ghCommand },
    );
  }
  return {
    ok: true,
    repo,
    issue,
    state: classifyInitialCopilotPrState({
      repo,
      facts: {
        ...facts,
        sessionActivity: sessionActivity?.activity ?? null,
      },
    }),
    prNumber: facts.number,
    prUrl: facts.url,
    headBranch: facts.headBranch,
    authorLogin: facts.authorLogin,
    isDraft: facts.isDraft,
    changedFiles: facts.changedFiles,
    commitCount: facts.commitCount,
    soleCommitHeadline: facts.soleCommitHeadline,
    sessionActivity: sessionActivity?.activity ?? null,
    sessionRunId: sessionActivity?.runId ?? null,
    sessionRunName: sessionActivity?.runName ?? null,
    sessionRunStatus: sessionActivity?.runStatus ?? null,
    sessionRunConclusion: sessionActivity?.runConclusion ?? null,
    sessionRunCreatedAt: sessionActivity?.runCreatedAt ?? null,
    sessionConfidence: sessionActivity?.confidence ?? null,
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseDetectInitialCopilotPrStateCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await detectInitialCopilotPrState(
    { repo: options.repo, issue: options.issue },
    { env, ghCommand },
  );
  stdout.write(`${JSON.stringify(result)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
