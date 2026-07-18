import assert from "node:assert/strict";
import test from "node:test";

import {
  createTrackerAdapter,
  isTrackerAdapter,
  hasBoardCapability,
  REQUIRED_METHODS,
  BOARD_METHODS,
} from "../src/tracker/adapter.mjs";
import { createNoopTrackerAdapter } from "../src/tracker/noop-adapter.mjs";
import { createGithubTrackerAdapter } from "../src/tracker/github-adapter.mjs";
import { resolveTrackerAdapter } from "../src/tracker/index.mjs";

const NOOP_IMPL = {
  parseRef: () => ({ repo: "o/r", id: 1 }),
  getIssue: async () => ({ id: 1, title: "", body: "", url: "", state: "open", assignees: [] }),
  createIssue: async () => ({ id: 1, url: "" }),
  editIssue: async () => ({ edited: [] }),
  commentIssue: async () => ({ commentUrl: "" }),
  listIssues: async () => [],
  detectLinkedPr: async () => null,
};

test("createTrackerAdapter requires every Issues method", () => {
  for (const method of REQUIRED_METHODS) {
    const impl = { ...NOOP_IMPL };
    delete impl[method];
    assert.throws(() => createTrackerAdapter(impl), new RegExp(`missing required method "${method}"`));
  }
  assert.throws(() => createTrackerAdapter(null), /impl must be an object/);
  assert.throws(() => createTrackerAdapter("nope"), /impl must be an object/);
});

test("createTrackerAdapter freezes the result and copies through optional board methods", () => {
  const adapter = createTrackerAdapter({ ...NOOP_IMPL, listQueueItems: async () => [] });
  assert.throws(() => { adapter.getIssue = async () => ({}); }, TypeError);
  assert.equal(typeof adapter.listQueueItems, "function");
  assert.equal(adapter.reorderItem, undefined);
});

test("isTrackerAdapter recognizes a valid Issues-only adapter", () => {
  const adapter = createTrackerAdapter(NOOP_IMPL);
  assert.equal(isTrackerAdapter(adapter), true);
  assert.equal(isTrackerAdapter({ getIssue: () => {} }), false);
  assert.equal(isTrackerAdapter(null), false);
});

test("hasBoardCapability is false unless every Board method is present", () => {
  const issuesOnly = createTrackerAdapter(NOOP_IMPL);
  assert.equal(hasBoardCapability(issuesOnly), false);

  const boardImpl = { ...NOOP_IMPL };
  for (const method of BOARD_METHODS) boardImpl[method] = async () => {};
  const full = createTrackerAdapter(boardImpl);
  assert.equal(hasBoardCapability(full), true);
});

test("noop tracker adapter satisfies the Issues capability and is frozen", async () => {
  const adapter = createNoopTrackerAdapter();
  assert.equal(isTrackerAdapter(adapter), true);
  const issue = await adapter.getIssue({ repo: "o/r", id: 1 });
  assert.equal(issue.id, 1);
  assert.throws(() => { adapter.getIssue = async () => ({}); }, TypeError);
});

test("noop tracker adapter accepts overrides for targeted assertions", async () => {
  const adapter = createNoopTrackerAdapter({ getIssue: async () => ({ id: 7, title: "t", body: "b", url: "u", state: "open", assignees: [] }) });
  const issue = await adapter.getIssue({ repo: "o/r", id: 7 });
  assert.equal(issue.id, 7);
  assert.equal(issue.title, "t");
});

// ── GitHub adapter (injected run — no real gh) ──────────────────────────

function stubRun(handlers) {
  return async (_cmd, args) => {
    for (const [match, handler] of handlers) {
      if (match(args)) return handler(args);
    }
    throw new Error(`unexpected gh invocation: ${JSON.stringify(args)}`);
  };
}

test("github adapter satisfies isTrackerAdapter", () => {
  const adapter = createGithubTrackerAdapter({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.equal(isTrackerAdapter(adapter), true);
});

test("github adapter parseRef parses owner/repo#N and a github.com issue URL", () => {
  const adapter = createGithubTrackerAdapter();
  assert.deepEqual(adapter.parseRef("acme/widgets#42"), { repo: "acme/widgets", id: 42 });
  assert.deepEqual(
    adapter.parseRef("https://github.com/acme/widgets/issues/42"),
    { repo: "acme/widgets", id: 42 },
  );
  assert.throws(() => adapter.parseRef("not a ref"), /unrecognized issue reference/);
});

test("github adapter getIssue wraps gh issue view", async () => {
  const run = stubRun([
    [
      (args) => args[0] === "issue" && args[1] === "view",
      () => ({
        code: 0,
        stdout: JSON.stringify({
          number: 42,
          title: "Fix the thing",
          body: "body text",
          url: "https://github.com/acme/widgets/issues/42",
          state: "OPEN",
          assignees: [{ login: "alice" }],
        }),
        stderr: "",
      }),
    ],
  ]);
  const adapter = createGithubTrackerAdapter({ run });
  const issue = await adapter.getIssue({ repo: "acme/widgets", id: 42 });
  assert.deepEqual(issue, {
    id: 42,
    title: "Fix the thing",
    body: "body text",
    url: "https://github.com/acme/widgets/issues/42",
    state: "open",
    assignees: ["alice"],
  });
});

test("github adapter detectLinkedPr wraps detect-linked-issue-pr", async () => {
  const run = stubRun([
    [
      (args) => args[0] === "api" && args[1] === "graphql",
      () => ({
        code: 0,
        stdout: JSON.stringify({
          data: { repository: { issue: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
        }),
        stderr: "",
      }),
    ],
  ]);
  const adapter = createGithubTrackerAdapter({ run });
  const result = await adapter.detectLinkedPr({ repo: "acme/widgets", id: 42 });
  assert.deepEqual(result, { hasOpenLinkedPr: false, prNumber: null });
});

test("github adapter listIssues and commentIssue wrap the underlying gh calls", async () => {
  const run = stubRun([
    [
      (args) => args[0] === "issue" && args[1] === "list",
      () => ({ code: 0, stdout: JSON.stringify([{ number: 1, title: "A", state: "OPEN", labels: [] }]), stderr: "" }),
    ],
    [
      (args) => args[0] === "issue" && args[1] === "comment",
      () => ({ code: 0, stdout: "https://github.com/acme/widgets/issues/1#issuecomment-1\n", stderr: "" }),
    ],
  ]);
  const adapter = createGithubTrackerAdapter({ run });
  const issues = await adapter.listIssues({ repo: "acme/widgets" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].state, "open");
  const comment = await adapter.commentIssue({ repo: "acme/widgets", id: 1 }, "hi");
  assert.equal(comment.commentUrl, "https://github.com/acme/widgets/issues/1#issuecomment-1");
});

test("github adapter editIssue remaps the interface's flat assignees to gh's --add-assignee (load-bearing: claiming an issue)", async () => {
  let capturedArgs;
  const run = async (_cmd, args) => {
    capturedArgs = args;
    return { code: 0, stdout: "", stderr: "" };
  };
  const adapter = createGithubTrackerAdapter({ run });
  const result = await adapter.editIssue(
    { repo: "acme/widgets", id: 42 },
    { title: "New title", assignees: ["alice", "bob"] },
  );
  assert.deepEqual(capturedArgs, [
    "issue", "edit", "42", "--repo", "acme/widgets",
    "--title", "New title",
    "--add-assignee", "alice",
    "--add-assignee", "bob",
  ]);
  assert.deepEqual(result.edited, ["title", "add-assignee"]);
});

// ── GitHub adapter board facade (partial capability: listQueueItems/setItemStatus) ──

function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}
function listUserProjectsResponse(projects) {
  return { data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: projects } } } };
}
function getFieldsResponse(fields) {
  return { data: { node: { fields: { nodes: fields, pageInfo: { hasNextPage: false } } } } };
}
const STATUS_FIELD = {
  id: "PVTSSF_status",
  name: "Status",
  options: [
    { id: "opt1", name: "Backlog" },
    { id: "opt2", name: "Next Up" },
    { id: "opt3", name: "In Progress" },
    { id: "opt4", name: "Done" },
  ],
};
const EXISTING_PROJECT = { id: "PVT_proj1", number: 1, title: "Dev Loop Queue", url: "https://x" };
function getItemsByContentResponse(items) {
  return { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } } };
}
function makeItemNode(itemId, content, status) {
  const fieldValues = status != null ? { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: status }] } : { nodes: [] };
  return { id: itemId, fieldValues, content };
}
function makeContent(number, repo = "acme/widgets") {
  return { __typename: "Issue", number, repository: { nameWithOwner: repo } };
}

function sequentialRun(responses) {
  let i = 0;
  return async () => {
    if (i >= responses.length) throw new Error(`unexpected extra gh call #${i + 1}`);
    const resp = responses[i++];
    return { code: 0, stdout: JSON.stringify(resp), stderr: "" };
  };
}

test("github adapter setItemStatus maps a logical column to the configured Status display name and coerces item.itemId to a string ref", async () => {
  const run = sequentialRun([
    userPayload(),
    listUserProjectsResponse([EXISTING_PROJECT]),
    getFieldsResponse([STATUS_FIELD]),
    // The item is already at "In Progress" — the no-op/unchanged branch,
    // reached without needing a mutation-call stub.
    getItemsByContentResponse([makeItemNode("PVTI_1", makeContent(10), "In Progress")]),
  ]);
  const adapter = createGithubTrackerAdapter({ run });
  const board = { repo: "acme/widgets", project: "1", columnNames: { in_progress: "In Progress" } };
  // item.itemId is the identity setItemStatus coerces to the --item ref
  // (matches move-queue-item's stable-node-id contract); a bare issueNumber
  // fallback (item.number) exists for callers without a node id.
  await adapter.setItemStatus(board, { itemId: "PVTI_1", number: 10 }, "in_progress");
});

test("github adapter setItemStatus throws when the board has no display column for the logical column (reachable fail-closed branch)", async () => {
  const adapter = createGithubTrackerAdapter({ run: async () => { throw new Error("gh must not be called"); } });
  await assert.rejects(
    () => adapter.setItemStatus({ repo: "acme/widgets", project: "1", columnNames: {} }, { itemId: "PVTI_1" }, "not_a_real_column"),
    /no display column configured for logical column "not_a_real_column"/,
  );
});

// ── Registry ─────────────────────────────────────────────────────────────

test("resolveTrackerAdapter defaults to the github provider", () => {
  const adapter = resolveTrackerAdapter({});
  assert.equal(isTrackerAdapter(adapter), true);
});

test("resolveTrackerAdapter honors config.tracker.provider and fails closed on an unknown one", () => {
  const adapter = resolveTrackerAdapter({ tracker: { provider: "github" } });
  assert.equal(isTrackerAdapter(adapter), true);
  assert.throws(
    () => resolveTrackerAdapter({ tracker: { provider: "jira" } }),
    /unknown tracker provider "jira"/,
  );
});

test("resolveTrackerAdapter takes the effective config as a plain parameter (no global singleton)", () => {
  // Two independently-built configs resolve two independently-usable adapters;
  // nothing is cached/shared across the calls (the #1408 multi-tracker/
  // capability-split design constraint).
  let calls = 0;
  const providers = {
    noop: () => {
      calls += 1;
      return createNoopTrackerAdapter();
    },
  };
  resolveTrackerAdapter({ tracker: { provider: "noop" } }, { providers });
  resolveTrackerAdapter({ tracker: { provider: "noop" } }, { providers });
  assert.equal(calls, 2);
});
