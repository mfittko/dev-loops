import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { selectLinkedIssuePr } from "../../scripts/github/detect-linked-issue-pr.mjs";

const scriptPath = path.resolve("scripts/github/detect-linked-issue-pr.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return env;
}

function graphqlPayload({ hasNextPage, endCursor, nodes }) {
  return `${JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  })}\n`;
}

function connectedNode({ createdAt, number, state = "OPEN", repo = "owner/repo", url }) {
  return {
    __typename: "ConnectedEvent",
    createdAt,
    subject: {
      __typename: "PullRequest",
      number,
      state,
      url: url ?? `https://github.com/${repo}/pull/${number}`,
      repository: { nameWithOwner: repo },
    },
  };
}

function crossNode({ createdAt, number, state = "OPEN", repo = "owner/repo", url }) {
  return {
    __typename: "CrossReferencedEvent",
    createdAt,
    source: {
      __typename: "PullRequest",
      number,
      state,
      url: url ?? `https://github.com/${repo}/pull/${number}`,
      repository: { nameWithOwner: repo },
    },
  };
}

test("detect-linked-issue-pr paginates and applies deterministic event-type priority", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-page-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=85", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: true,
          endCursor: "cursor-1",
          nodes: [
            crossNode({ createdAt: "2026-05-01T10:00:00Z", number: 91 }),
          ],
        }),
      },
      {
        assertArgs: ["api", "graphql", "after=cursor-1"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-04-30T10:00:00Z", number: 90 }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "85"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      issue: 85,
      hasOpenLinkedPr: true,
      prNumber: 90,
      prUrl: "https://github.com/owner/repo/pull/90",
      selection: {
        eventType: "CONNECTED_EVENT",
        eventCreatedAt: "2026-04-30T10:00:00Z",
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr matches same-repo linked PRs case-insensitively", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-case-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=85", "owner=Owner", "name=Repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-05-12T10:00:00Z", number: 90, repo: "owner/repo" }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "Owner/Repo", "--issue", "85"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "Owner/Repo",
      issue: 85,
      hasOpenLinkedPr: true,
      prNumber: 90,
      prUrl: "https://github.com/owner/repo/pull/90",
      selection: {
        eventType: "CONNECTED_EVENT",
        eventCreatedAt: "2026-05-12T10:00:00Z",
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr tests fail fast on unexpected extra gh calls", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-overcall-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=85", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: true,
          endCursor: "cursor-1",
          nodes: [],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "85"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /unexpected extra gh call #2/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr filters cross-repo/closed candidates and picks newest createdAt within event type", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-filter-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=85", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-05-10T10:00:00Z", number: 120, repo: "other/repo" }),
            connectedNode({ createdAt: "2026-05-11T10:00:00Z", number: 121, state: "CLOSED" }),
            connectedNode({ createdAt: "2026-05-09T10:00:00Z", number: 88 }),
            connectedNode({ createdAt: "2026-05-12T10:00:00Z", number: 90 }),
            crossNode({ createdAt: "2026-05-13T10:00:00Z", number: 130 }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "85"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      issue: 85,
      hasOpenLinkedPr: true,
      prNumber: 90,
      prUrl: "https://github.com/owner/repo/pull/90",
      selection: {
        eventType: "CONNECTED_EVENT",
        eventCreatedAt: "2026-05-12T10:00:00Z",
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr returns no match when no open same-repo linked PR exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-none-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=85", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            crossNode({ createdAt: "2026-05-12T10:00:00Z", number: 90, repo: "other/repo" }),
            connectedNode({ createdAt: "2026-05-12T10:00:00Z", number: 91, state: "MERGED" }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "85"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      issue: 85,
      hasOpenLinkedPr: false,
      prNumber: null,
      prUrl: null,
      hasPriorClosedUnmergedPr: false,
      priorClosedUnmergedPrNumber: null,
      priorClosedUnmergedPrUrl: null,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr detects prior closed-unmerged same-repo PR when no open PR exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-closed-unmerged-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=130", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-05-01T10:00:00Z", number: 149, state: "CLOSED" }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "130"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      issue: 130,
      hasOpenLinkedPr: false,
      prNumber: null,
      prUrl: null,
      hasPriorClosedUnmergedPr: true,
      priorClosedUnmergedPrNumber: 149,
      priorClosedUnmergedPrUrl: "https://github.com/owner/repo/pull/149",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr does not surface merged same-repo PR as prior closed-unmerged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-merged-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=130", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-05-01T10:00:00Z", number: 149, state: "MERGED" }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "130"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      issue: 130,
      hasOpenLinkedPr: false,
      prNumber: null,
      prUrl: null,
      hasPriorClosedUnmergedPr: false,
      priorClosedUnmergedPrNumber: null,
      priorClosedUnmergedPrUrl: null,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr selects most recent closed-unmerged PR when multiple exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-multi-closed-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=130", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-04-01T10:00:00Z", number: 140, state: "CLOSED" }),
            connectedNode({ createdAt: "2026-05-01T10:00:00Z", number: 149, state: "CLOSED" }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "130"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hasPriorClosedUnmergedPr, true);
    assert.equal(parsed.priorClosedUnmergedPrNumber, 149);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-linked-issue-pr open PR takes precedence and closed-unmerged fields are absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-linked-pr-open-wins-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=130", "owner=owner", "name=repo"],
        stdout: graphqlPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [
            connectedNode({ createdAt: "2026-04-01T10:00:00Z", number: 140, state: "CLOSED" }),
            connectedNode({ createdAt: "2026-05-01T10:00:00Z", number: 150, state: "OPEN" }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--issue", "130"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hasOpenLinkedPr, true);
    assert.equal(parsed.prNumber, 150);
    assert.equal("hasPriorClosedUnmergedPr" in parsed, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("selectLinkedIssuePr uses locale-independent url fallback ordering", () => {
  const winner = selectLinkedIssuePr([
    {
      eventType: "CONNECTED_EVENT",
      createdAtMs: 123,
      prNumber: 90,
      prUrl: "https://github.com/owner/repo/pull/90?b=1",
    },
    {
      eventType: "CONNECTED_EVENT",
      createdAtMs: 123,
      prNumber: 90,
      prUrl: "https://github.com/owner/repo/pull/90?a=1",
    },
  ]);

  assert.equal(winner?.prUrl, "https://github.com/owner/repo/pull/90?a=1");
});

test("detect-linked-issue-pr rejects malformed arguments deterministically", async () => {
  const missingIssue = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingIssue.code, 1);
  assert.equal(missingIssue.stdout, "");
  const missingIssueErr = JSON.parse(missingIssue.stderr);
  assert.equal(missingIssueErr.ok, false);
  assert.equal(missingIssueErr.error, "Linked PR detection requires both --repo <owner/name> and --issue <number>");
  assert.equal(typeof missingIssueErr.usage, "string");
  assert(missingIssueErr.usage.length > 0);

  const badIssue = await runNode(["--repo", "owner/repo", "--issue", "0"]);
  assert.equal(badIssue.code, 1);
  assert.equal(badIssue.stdout, "");
  const badIssueErr = JSON.parse(badIssue.stderr);
  assert.equal(badIssueErr.ok, false);
  assert.equal(badIssueErr.error, "--issue must be a positive integer");
  assert.equal(typeof badIssueErr.usage, "string");
  assert(badIssueErr.usage.length > 0);
});

test("runNode rejects deterministically when the child process cannot spawn", async () => {
  await assert.rejects(
    runNode(["--help"], { execPath: path.join(os.tmpdir(), "missing-node-binary") }),
    /ENOENT/,
  );
});
