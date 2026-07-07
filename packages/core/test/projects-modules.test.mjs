// Package-local regression coverage for packages/core/src/projects/*.
//
// This is NOT a port of the exhaustive root suites (test/projects/*.test.mjs)
// — it exists so @dev-loops/core has direct test coverage for modules it now
// owns, independent of the monorepo-relative root tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseProjectRef,
  parseItemRef,
  resolveProjectSelector,
  findProject,
} from "../src/projects/resolve-project.mjs";
import { main as moveQueueItem } from "../src/projects/move-queue-item.mjs";
import { main as listQueueItems } from "../src/projects/list-queue-items.mjs";

// ── Shared stub helpers (mirrors test/projects/*.test.mjs stub pattern) ────

function mockRunChild(responses) {
  let callIndex = 0;
  return async (_cmd, _args, _env) => {
    if (callIndex >= responses.length) {
      throw new Error(`Unexpected gh call #${callIndex + 1} (only ${responses.length} mocked)`);
    }
    const resp = responses[callIndex++];
    if (resp.error) {
      return { code: 1, stdout: "", stderr: resp.error };
    }
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
}

function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}

function listUserProjectsResponse(projects) {
  return {
    data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: projects } } },
  };
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

const EXISTING_PROJECT = {
  id: "PVT_proj1",
  number: 1,
  title: "Dev Loop Queue",
  url: "https://github.com/users/mfittko/projects/1",
};

function makeItemNode(itemId, content, status) {
  const fieldValues = status != null
    ? { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: status }] }
    : { nodes: [] };
  return { id: itemId, fieldValues, content };
}

function makeContent(type, number, repo = "mfittko/dev-loops") {
  return { __typename: type === "PR" ? "PullRequest" : "Issue", number, repository: { nameWithOwner: repo } };
}

function getItemsByContentResponse(items) {
  return { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } } };
}

function getItemsResponse(items) {
  return { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } } };
}

function updateItemFieldResponse() {
  return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } };
}

function makeListItem(itemId, contentId, type, number, title, url, status) {
  const content = { __typename: type === "PullRequest" ? "PullRequest" : "Issue", id: contentId, number, title, url };
  const fieldValues = status
    ? { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: status }] }
    : { nodes: [] };
  return { id: itemId, fieldValues, content };
}

// ── resolve-project ─────────────────────────────────────────────────────

describe("resolve-project", () => {
  it("parseProjectRef: positive integer", () => {
    assert.deepStrictEqual(parseProjectRef("42"), { kind: "number", value: 42 });
  });

  it("parseProjectRef: node ID", () => {
    assert.deepStrictEqual(parseProjectRef("PVT_abc123"), { kind: "id", value: "PVT_abc123" });
  });

  it("parseProjectRef: user-scoped board URI", () => {
    assert.deepStrictEqual(
      parseProjectRef("https://github.com/users/mfittko/projects/3"),
      { kind: "uri", number: 3, owner: "mfittko", ownerKind: "user" },
    );
  });

  it("parseProjectRef: org-scoped board URI", () => {
    assert.deepStrictEqual(
      parseProjectRef("https://github.com/orgs/myorg/projects/7"),
      { kind: "uri", number: 7, owner: "myorg", ownerKind: "org" },
    );
  });

  it("parseProjectRef: rejects '0'/empty/garbage with INVALID_PROJECT", () => {
    for (const bad of ["", "   ", "0", "not/a/ref"]) {
      assert.throws(() => parseProjectRef(bad), (err) => err.code === "INVALID_PROJECT");
    }
  });

  it("parseItemRef: positive integer", () => {
    assert.deepStrictEqual(parseItemRef("10"), { kind: "number", value: 10 });
  });

  it("parseItemRef: node ID with hyphen payload", () => {
    const hyphenId = "PVTI_lAHOAAT8js4BaBePzgxz5-I";
    assert.deepStrictEqual(parseItemRef(hyphenId), { kind: "id", value: hyphenId });
  });

  it("parseItemRef: rejects '0'/empty with INVALID_ITEM", () => {
    for (const bad of ["", "   ", "0"]) {
      assert.throws(() => parseItemRef(bad), (err) => err.code === "INVALID_ITEM");
    }
  });

  it("resolveProjectSelector: fails closed when neither ref nor title given", () => {
    assert.throws(() => resolveProjectSelector({}), (err) => err.code === "INVALID_PROJECT");
  });

  it("findProject: throws PROJECT_NOT_FOUND when no match", () => {
    const projects = [{ id: "PVT_x", number: 1, title: "Alpha" }];
    assert.throws(
      () => findProject(projects, { projectRef: { kind: "number", value: 99 }, projectTitle: null }, "owner"),
      (err) => err.code === "PROJECT_NOT_FOUND",
    );
  });
});

// ── move-queue-item ──────────────────────────────────────────────────────

describe("move-queue-item", () => {
  it("main: INVALID_REPO on bad repo", async () => {
    await assert.rejects(
      () => moveQueueItem({ repo: "not-a-repo", project: "1", item: "10", toColumn: "Next Up" }),
      (err) => err.code === "INVALID_REPO",
    );
  });

  it("main: INVALID_COLUMN on missing --to-column", async () => {
    await assert.rejects(
      () => moveQueueItem({ repo: "mfittko/dev-loops", project: "1", item: "10" }),
      (err) => err.code === "INVALID_COLUMN",
    );
  });

  it("main: stubbed happy path moves item, returns previousColumn/newColumn", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([STATUS_FIELD]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog")]) },
      { payload: updateItemFieldResponse() },
    ];
    const result = await moveQueueItem(
      { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.item.previousColumn, "Backlog");
    assert.equal(result.item.newColumn, "Next Up");
  });

  it("main: stubbed same-column no-op returns unchanged:true", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([STATUS_FIELD]) },
      { payload: getItemsByContentResponse([makeItemNode("PVTI_1", makeContent("Issue", 10), "Next Up")]) },
    ];
    const result = await moveQueueItem(
      { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.item.unchanged, true);
  });

  it("main: ITEM_NOT_FOUND for an absent item", async () => {
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([STATUS_FIELD]) },
      { payload: getItemsByContentResponse([]) },
    ];
    await assert.rejects(
      () => moveQueueItem(
        { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      ),
      (err) => err.code === "ITEM_NOT_FOUND",
    );
  });
});

// ── list-queue-items ─────────────────────────────────────────────────────

describe("list-queue-items", () => {
  it("main: INVALID_ARGS on --summary+--column mutual exclusion", async () => {
    await assert.rejects(
      () => listQueueItems({ repo: "mfittko/dev-loops", project: "1", summary: true, column: "Backlog" }),
      (err) => err.code === "INVALID_ARGS",
    );
  });

  it("main: stubbed flat listing with a status filter", async () => {
    const items = [
      makeListItem("PVTI_1", "I_1", "Issue", 10, "Fix bug", "https://github.com/mfittko/repo/issues/10", "Backlog"),
      makeListItem("PVTI_2", "PR_2", "PullRequest", 20, "Add feature", "https://github.com/mfittko/repo/pull/20", "Next Up"),
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([STATUS_FIELD]) },
      { payload: getItemsResponse(items) },
    ];
    const result = await listQueueItems(
      { repo: "mfittko/dev-loops", project: "1", column: "Next Up" },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].prNumber, 20);
  });

  it("main: stubbed --summary grouping", async () => {
    const items = [
      makeListItem("PVTI_1", "I_1", "Issue", 10, "A", "https://github.com/mfittko/repo/issues/10", "Backlog"),
      makeListItem("PVTI_2", "I_2", "Issue", 20, "B", "https://github.com/mfittko/repo/issues/20", "Done"),
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
      { payload: getFieldsResponse([STATUS_FIELD]) },
      { payload: getItemsResponse(items) },
    ];
    const result = await listQueueItems(
      { repo: "mfittko/dev-loops", project: "1", summary: true },
      { env: {}, runChild: mockRunChild(responses) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.groups.Backlog.count, 1);
    assert.equal(result.groups.Done.count, 1);
    assert.equal(result.groups["Next Up"].count, 0);
  });
});
