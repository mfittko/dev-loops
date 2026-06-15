#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseIssueNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
export const LINKED_ISSUE_PR_QUERY = [
  "query($owner:String!, $name:String!, $issue:Int!, $after:String) {",
  "  repository(owner:$owner, name:$name) {",
  "    issue(number:$issue) {",
  "      timelineItems(first:100, after:$after, itemTypes:[CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {",
  "        pageInfo {",
  "          hasNextPage",
  "          endCursor",
  "        }",
  "        nodes {",
  "          __typename",
  "          ... on ConnectedEvent {",
  "            createdAt",
  "            subject {",
  "              __typename",
  "              ... on PullRequest {",
  "                number",
  "                state",
  "                url",
  "                repository { nameWithOwner }",
  "              }",
  "            }",
  "          }",
  "          ... on CrossReferencedEvent {",
  "            createdAt",
  "            source {",
  "              __typename",
  "              ... on PullRequest {",
  "                number",
  "                state",
  "                url",
  "                repository { nameWithOwner }",
  "              }",
  "            }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");
const USAGE = `Usage: detect-linked-issue-pr.mjs --repo <owner/name> --issue <number>
Detect whether an issue already has an open linked pull request in the same repository.
This helper owns linked-event query pagination and deterministic selection.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --issue <number>      Issue number
Success output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/name",
    "issue": 85,
    "hasOpenLinkedPr": true|false,
    "prNumber": 90|null,
    "prUrl": "..."|null,
    "selection"?: {
      "eventType": "CONNECTED_EVENT"|"CROSS_REFERENCED_EVENT",
      "eventCreatedAt": "..."
    },
    "hasPriorClosedUnmergedPr"?: true|false,
    "priorClosedUnmergedPrNumber"?: 149|null,
    "priorClosedUnmergedPrUrl"?: "..."|null
  }
When hasOpenLinkedPr is false, the output also includes hasPriorClosedUnmergedPr,
priorClosedUnmergedPrNumber, and priorClosedUnmergedPrUrl reflecting any same-repo
linked PR that was closed without merging.
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectLinkedIssuePrCliArgs(argv) {
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
    throw parseError("Linked PR detection requires both --repo <owner/name> and --issue <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function buildQueryArgs({ owner, name, issue, after }) {
  const args = [
    "api",
    "graphql",
    "--field",
    `owner=${owner}`,
    "--field",
    `name=${name}`,
    "-F",
    `issue=${issue}`,
    "--field",
    `query=${LINKED_ISSUE_PR_QUERY}`,
  ];
  if (typeof after === "string" && after.length > 0) {
    args.push("--field", `after=${after}`);
  }
  return args;
}
function readTimelineConnection(payload) {
  const connection = payload?.data?.repository?.issue?.timelineItems;
  if (!connection || typeof connection !== "object") {
    throw new Error("Invalid linked-PR GraphQL payload: missing data.repository.issue.timelineItems");
  }
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const pageInfo = connection.pageInfo ?? {};
  return {
    nodes,
    hasNextPage: Boolean(pageInfo.hasNextPage),
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
  };
}
function normalizeLinkedPrNode(node) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (node.__typename === "ConnectedEvent") {
    return {
      eventType: "CONNECTED_EVENT",
      eventCreatedAt: node.createdAt,
      pr: node.subject,
    };
  }
  if (node.__typename === "CrossReferencedEvent") {
    return {
      eventType: "CROSS_REFERENCED_EVENT",
      eventCreatedAt: node.createdAt,
      pr: node.source,
    };
  }
  return null;
}
function compareStableStrings(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
function normalizeRepoSlugForComparison(repo) {
  return typeof repo === "string" ? repo.trim().toLowerCase() : "";
}
function normalizeOpenSameRepoCandidate(candidate, repo) {
  const pr = candidate?.pr;
  const number = pr?.number;
  const state = pr?.state;
  const url = pr?.url;
  const nameWithOwner = pr?.repository?.nameWithOwner;
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  if (
    state !== "OPEN"
    || normalizeRepoSlugForComparison(nameWithOwner) !== normalizeRepoSlugForComparison(repo)
  ) {
    return null;
  }
  const createdAtMs = Date.parse(candidate.eventCreatedAt);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  return {
    prNumber: number,
    prUrl: typeof url === "string" ? url : null,
    eventType: candidate.eventType,
    eventCreatedAt: typeof candidate.eventCreatedAt === "string" ? candidate.eventCreatedAt : null,
    createdAtMs,
  };
}
function normalizeClosedUnmergedSameRepoCandidate(candidate, repo) {
  const pr = candidate?.pr;
  const number = pr?.number;
  const state = pr?.state;
  const url = pr?.url;
  const nameWithOwner = pr?.repository?.nameWithOwner;
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  if (
    state !== "CLOSED"
    || normalizeRepoSlugForComparison(nameWithOwner) !== normalizeRepoSlugForComparison(repo)
  ) {
    return null;
  }
  const createdAtMs = Date.parse(candidate.eventCreatedAt);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  return {
    prNumber: number,
    prUrl: typeof url === "string" ? url : null,
    eventType: candidate.eventType,
    eventCreatedAt: typeof candidate.eventCreatedAt === "string" ? candidate.eventCreatedAt : null,
    createdAtMs,
  };
}
export function selectLinkedIssuePr(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const sorted = [...candidates].sort((left, right) => {
    const leftPriority = left.eventType === "CONNECTED_EVENT" ? 0 : 1;
    const rightPriority = right.eventType === "CONNECTED_EVENT" ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.createdAtMs !== right.createdAtMs) {
      return right.createdAtMs - left.createdAtMs;
    }
    if (left.prNumber !== right.prNumber) {
      return right.prNumber - left.prNumber;
    }
    return compareStableStrings(String(left.prUrl ?? ""), String(right.prUrl ?? ""));
  });
  return sorted[0] ?? null;
}
export async function detectLinkedIssuePr({ repo, issue }, { env = process.env, ghCommand = "gh" } = {}) {
  const { owner, name } = parseRepoSlug(repo);
  const candidates = [];
  const closedUnmergedCandidates = [];
  let after = null;
  while (true) {
    const result = await runChild(
      ghCommand,
      buildQueryArgs({ owner, name, issue, after }),
      env,
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`gh command failed: ${detail}`);
    }
    const payload = parseJsonText(result.stdout);
    const { nodes, hasNextPage, endCursor } = readTimelineConnection(payload);
    for (const node of nodes) {
      const normalizedNode = normalizeLinkedPrNode(node);
      if (!normalizedNode) {
        continue;
      }
      const normalizedCandidate = normalizeOpenSameRepoCandidate(normalizedNode, repo);
      if (normalizedCandidate) {
        candidates.push(normalizedCandidate);
      }
      const closedUnmergedCandidate = normalizeClosedUnmergedSameRepoCandidate(normalizedNode, repo);
      if (closedUnmergedCandidate) {
        closedUnmergedCandidates.push(closedUnmergedCandidate);
      }
    }
    if (!hasNextPage) {
      break;
    }
    if (!endCursor) {
      throw new Error("Invalid linked-PR GraphQL payload: pageInfo.hasNextPage is true but endCursor is missing");
    }
    after = endCursor;
  }
  const selected = selectLinkedIssuePr(candidates);
  const selectedClosedUnmerged = selectLinkedIssuePr(closedUnmergedCandidates);
  if (!selected) {
    return {
      ok: true,
      repo,
      issue,
      hasOpenLinkedPr: false,
      prNumber: null,
      prUrl: null,
      hasPriorClosedUnmergedPr: selectedClosedUnmerged !== null,
      priorClosedUnmergedPrNumber: selectedClosedUnmerged?.prNumber ?? null,
      priorClosedUnmergedPrUrl: selectedClosedUnmerged?.prUrl ?? null,
    };
  }
  return {
    ok: true,
    repo,
    issue,
    hasOpenLinkedPr: true,
    prNumber: selected.prNumber,
    prUrl: selected.prUrl,
    selection: {
      eventType: selected.eventType,
      eventCreatedAt: selected.eventCreatedAt,
    },
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseDetectLinkedIssuePrCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await detectLinkedIssuePr(
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
