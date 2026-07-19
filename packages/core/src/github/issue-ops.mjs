import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { runChild as defaultRunChild } from "../cli/primitives.mjs";
import { parseJsonText } from "./review-threads.mjs";
import { parseRepoSlug } from "./repo-slug.mjs";

/**
 * Core `gh issue` operations, extracted from the thin CLI wrappers under
 * `scripts/github/*.mjs` (view/create/edit/comment/list-issue,
 * detect-linked-issue-pr) so both the CLI scripts and the GitHub tracker
 * adapter (`../tracker/github-adapter.mjs`) call one implementation instead
 * of duplicating gh-command construction. The CLI scripts keep their own
 * arg parsing/USAGE/runCli; this module owns the actual `gh` calls and output
 * shaping. Mirrors the existing `../projects/move-queue-item.mjs` /
 * `../projects/list-queue-items.mjs` split (core logic + thin CLI wrapper).
 */

const ISSUE_URL_NUMBER_PATTERN = /\/issues\/(\d+)(?:\D|$)/u;

// ── view-issue ──────────────────────────────────────────────────────────

export const VIEW_ISSUE_DEFAULT_FIELDS = "number,title,body,state,author,labels,url,createdAt,updatedAt";

export async function viewIssue(options, { env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  const fields = options.fields ?? VIEW_ISSUE_DEFAULT_FIELDS;
  const result = await run(
    ghCommand,
    ["issue", "view", String(options.issue), "--repo", options.repo, "--json", fields],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue view failed: ${detail}`);
  }
  const issue = parseJsonText(result.stdout, { label: "gh issue view" });
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
    throw new Error("gh issue view did not return a JSON object");
  }
  return { ok: true, issue };
}

// ── create-issue ────────────────────────────────────────────────────────

// Build the `gh issue create` args. A --body-file path is forwarded straight
// to gh so large bodies avoid command-length limits.
export function buildCreateArgs(options) {
  const args = ["issue", "create", "--repo", options.repo, "--title", options.title];
  if (options.body !== undefined) {
    args.push("--body", options.body);
  } else {
    args.push("--body-file", options.bodyFile);
  }
  if (options.milestone !== undefined) {
    args.push("--milestone", options.milestone);
  }
  for (const l of options.labels ?? []) {
    args.push("--label", l);
  }
  for (const u of options.assignees ?? []) {
    args.push("--assignee", u);
  }
  return args;
}

// Read (for validation only — the actual gh call still forwards the path, see
// buildCreateArgs) and reject an empty/whitespace-only body. This is the real
// guard behind the CLI's stdin-device rejection: `gh` is spawned with stdin
// ignored, so even a body resolved non-empty here can still reach `gh` as
// nothing if the path is some other unreadable/racy source — the substantive
// check is content, not path shape.
export async function resolveCreateBody(options) {
  return options.bodyFile === undefined ? options.body : await readFile(options.bodyFile, "utf8");
}

export async function createIssue(options, { env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  const body = await resolveCreateBody(options);
  if (typeof body !== "string" || body.trim().length === 0) {
    const source = options.bodyFile !== undefined ? `--body-file ${options.bodyFile}` : "--body";
    throw new Error(`issue body resolved empty from ${source} — refusing to create a bodyless issue`);
  }
  const args = buildCreateArgs(options);
  const result = await run(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue create failed: ${detail}`);
  }
  // gh prints the created issue URL to stdout.
  const url = (result.stdout ?? "").trim();
  const match = ISSUE_URL_NUMBER_PATTERN.exec(url);
  if (!match) {
    throw new Error(`gh issue create returned no parseable issue URL: ${url || "<empty>"}`);
  }
  return { ok: true, issueNumber: Number(match[1]), url };
}

// ── edit-issue ──────────────────────────────────────────────────────────

export async function resolveEditBody(options) {
  if (options.bodyFile === undefined) return options.body;
  // Stdin (fd 0): fs/promises readFile does NOT accept an integer fd, so read
  // it synchronously via the callback-style API (which does). A real path
  // stays on the async promise read.
  const body =
    options.bodyFile === "-" ? readFileSync(0, "utf8") : await readFile(options.bodyFile, "utf8");
  if (body.trim().length === 0) {
    throw new Error(`--body-file ${options.bodyFile} is empty`);
  }
  return body;
}

// Build the `gh issue edit` args and the parallel `edited` list (which fields
// were touched) so callers get a stable summary without re-reading the issue.
export async function buildEditArgs(options) {
  const args = ["issue", "edit", String(options.issue), "--repo", options.repo];
  const edited = [];
  if (options.title !== undefined) {
    args.push("--title", options.title);
    edited.push("title");
  }
  const body = await resolveEditBody(options);
  if (body !== undefined) {
    if (options.bodyFile !== undefined && options.bodyFile !== "-") {
      args.push("--body-file", options.bodyFile);
    } else {
      args.push("--body", body);
    }
    edited.push("body");
  }
  for (const u of options.addAssignees ?? []) {
    args.push("--add-assignee", u);
  }
  if ((options.addAssignees ?? []).length > 0) edited.push("add-assignee");
  for (const u of options.removeAssignees ?? []) {
    args.push("--remove-assignee", u);
  }
  if ((options.removeAssignees ?? []).length > 0) edited.push("remove-assignee");
  if (options.milestone !== undefined) {
    args.push("--milestone", options.milestone);
    edited.push("milestone");
  }
  return { args, edited };
}

// Build the `gh issue close`/`gh issue reopen` args for a --state change. Kept
// as a separate `gh` call from `gh issue edit` — that command has no --state
// flag, so a state change is its own invocation, run after the edit call.
export function buildStateChangeArgs(options) {
  if (options.state === "closed") {
    const args = ["issue", "close", String(options.issue), "--repo", options.repo];
    if (options.reason !== undefined) {
      args.push("--reason", options.reason);
    }
    return args;
  }
  return ["issue", "reopen", String(options.issue), "--repo", options.repo];
}

export async function editIssue(options, { env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  const { args, edited } = await buildEditArgs(options);
  // Skip the edit call entirely when --state is the only change requested —
  // `gh issue edit` with no field flags errors ("no changed fields").
  if (edited.length > 0) {
    const result = await run(ghCommand, args, env);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`gh issue edit failed: ${detail}`);
    }
  }
  if (options.state !== undefined) {
    const stateArgs = buildStateChangeArgs(options);
    const result = await run(ghCommand, stateArgs, env);
    if (result.code !== 0) {
      const verb = options.state === "closed" ? "close" : "reopen";
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`gh issue ${verb} failed: ${detail}`);
    }
    edited.push("state");
  }
  return { ok: true, repo: options.repo, issue: options.issue, edited };
}

// ── comment-issue ───────────────────────────────────────────────────────

export async function resolveCommentBody(options) {
  if (options.bodyFile === undefined) {
    if (options.body.trim().length === 0) {
      throw new Error("--body must not be empty");
    }
    return options.body;
  }
  const source = options.bodyFile === "-" ? 0 : options.bodyFile;
  const body = await readFile(source, "utf8");
  if (body.trim().length === 0) {
    throw new Error(`--body-file ${options.bodyFile} is empty`);
  }
  return body;
}

export async function commentIssue(options, { env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  const body = await resolveCommentBody(options);
  const result = await run(
    ghCommand,
    ["issue", "comment", String(options.issue), "--repo", options.repo, "--body", body],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue comment failed: ${detail}`);
  }
  const commentUrl = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop() ?? null;
  if (commentUrl === null || !/^https?:\/\//u.test(commentUrl)) {
    throw new Error(`gh issue comment did not return a comment URL (got: ${result.stdout.trim() || "<empty>"})`);
  }
  return { ok: true, repo: options.repo, issue: options.issue, commentUrl };
}

// ── list-issues ─────────────────────────────────────────────────────────

// Returns a well-typed issue, or null if the gh entry is missing/invalid in
// any required field.
export function normalizeIssue(raw) {
  if (!Number.isInteger(raw?.number) || typeof raw?.title !== "string" || typeof raw?.state !== "string") {
    return null;
  }
  return {
    number: raw.number,
    title: raw.title,
    // gh reports issue state UPPERCASE (OPEN/CLOSED); normalize to lowercase.
    state: raw.state.toLowerCase(),
    labels: Array.isArray(raw?.labels)
      ? raw.labels.map((l) => (typeof l?.name === "string" ? l.name : null)).filter((n) => n !== null)
      : [],
  };
}

export async function listIssues(options, { env = process.env, ghCommand = "gh", run = defaultRunChild } = {}) {
  const args = [
    "issue",
    "list",
    "--repo",
    options.repo,
    "--state",
    options.state ?? "open",
    "--limit",
    String(options.limit ?? 30),
    "--json",
    "number,title,state,labels",
  ];
  for (const label of options.labels ?? []) {
    args.push("--label", label);
  }
  const result = await run(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue list failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout, { label: "gh issue list" });
  if (!Array.isArray(payload)) {
    throw new Error("gh issue list did not return a JSON array");
  }
  return { ok: true, issues: payload.map(normalizeIssue).filter((issue) => issue !== null) };
}

// ── detect-linked-issue-pr ──────────────────────────────────────────────

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
  "            willCloseTarget",
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

function buildLinkedPrQueryArgs({ owner, name, issue, after }) {
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

function readLinkedPrTimelineConnection(payload) {
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
    // Only a cross-reference that will CLOSE this issue owns its board status.
    // A bare body-mention (willCloseTarget:false, e.g. "part of #X") must not
    // create board-ownership linkage (#1130).
    if (node.willCloseTarget !== true) {
      return null;
    }
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

export async function detectLinkedIssuePr({ repo, issue }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const { owner, name } = parseRepoSlug(repo);
  const candidates = [];
  const closedUnmergedCandidates = [];
  let after = null;
  while (true) {
    const result = await runChild(
      ghCommand,
      buildLinkedPrQueryArgs({ owner, name, issue, after }),
      env,
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`gh command failed: ${detail}`);
    }
    const payload = parseJsonText(result.stdout);
    const { nodes, hasNextPage, endCursor } = readLinkedPrTimelineConnection(payload);
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
