import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  main,
  parseDuration,
  selectArchivable,
} from "../../scripts/projects/archive-done-items.mjs";

// ── Pure unit: parseDuration ──────────────────────────────────────────────

describe("archive-done — parseDuration", () => {
  it("parses days", () => {
    assert.strictEqual(parseDuration("30d"), 30 * 24 * 60 * 60 * 1000);
  });
  it("parses hours and weeks", () => {
    assert.strictEqual(parseDuration("12h"), 12 * 60 * 60 * 1000);
    assert.strictEqual(parseDuration("2w"), 2 * 7 * 24 * 60 * 60 * 1000);
  });
  it("rejects invalid duration", () => {
    assert.throws(() => parseDuration("abc"), (e) => e.code === "INVALID_DURATION");
    assert.throws(() => parseDuration("0d"), (e) => e.code === "INVALID_DURATION");
  });
});

// ── Pure unit: selectArchivable ──────────────────────────────────────────

function item(id, { number, typename = "Issue", closed = false, closedAt = null, status = "Done" }) {
  return {
    id,
    isArchived: false,
    status,
    content: {
      __typename: typename,
      number,
      closed,
      closedAt,
      repository: { nameWithOwner: "mfittko/dev-loops" },
    },
  };
}

describe("archive-done — selectArchivable", () => {
  const now = Date.parse("2026-06-24T00:00:00Z");
  const olderThanMs = 30 * 24 * 60 * 60 * 1000;

  it("selects items closed longer than the threshold", () => {
    const items = [
      item("A", { number: 1, closed: true, closedAt: "2026-05-01T00:00:00Z" }), // 54d ago
      item("B", { number: 2, closed: true, closedAt: "2026-06-20T00:00:00Z" }), // 4d ago
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.deepStrictEqual(selected.map((x) => x.id), ["A"]);
  });

  it("excludes open items even if in Done column", () => {
    const items = [
      item("C", { number: 3, closed: false, closedAt: null, status: "Done" }),
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.strictEqual(selected.length, 0);
  });

  it("excludes already-archived items", () => {
    const items = [
      { ...item("D", { number: 4, closed: true, closedAt: "2026-01-01T00:00:00Z" }), isArchived: true },
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.strictEqual(selected.length, 0);
  });

  it("selects closed PRs as well as issues", () => {
    const items = [
      item("E", { number: 5, typename: "PullRequest", closed: true, closedAt: "2026-01-01T00:00:00Z" }),
    ];
    const selected = selectArchivable(items, { now, olderThanMs });
    assert.deepStrictEqual(selected.map((x) => x.id), ["E"]);
  });
});

// ── Integration via mocked gh ─────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  const calls = [];
  const fn = async (_cmd, args) => {
    calls.push(args);
    if (callIndex >= responses.length) {
      throw new Error("Unexpected gh call #" + (callIndex + 1));
    }
    const resp = responses[callIndex++];
    if (resp.error) return { code: 1, stdout: "", stderr: resp.error };
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function userPayload() {
  return { data: { user: { id: "U_1" } } };
}
function listUserProjectsResponse(projects) {
  return { data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: projects } } } };
}
const PROJECT = { id: "PVT_proj1", number: 1, title: "Dev Loop Queue", url: "u" };

function itemsResponse(nodes) {
  return { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
}
function rawItemNode(id, number, { closed, closedAt, status = "Done", typename = "Issue", repo = "mfittko/dev-loops" }) {
  return {
    id,
    isArchived: false,
    fieldValues: { nodes: [{ field: { id: "f", name: "Status" }, name: status }] },
    content: { __typename: typename, number, closed, closedAt, repository: { nameWithOwner: repo } },
  };
}
function archiveResponse(id) {
  return { data: { archiveProjectV2Item: { item: { id } } } };
}

function countMutations(calls) {
  return calls.filter((args) =>
    args.some((a) => typeof a === "string" && a.startsWith("query=") && a.includes("mutation")),
  ).length;
}

describe("archive-done — integration", () => {
  it("archives items closed longer than the threshold and reports them", async () => {
    const nodes = [
      rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z" }),
      rawItemNode("B", 2, { closed: true, closedAt: "2026-06-23T00:00:00Z" }), // recent
    ];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
      { payload: archiveResponse("A") },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.archived.length, 1);
    assert.strictEqual(result.archived[0].itemId, "A");
    assert.strictEqual(result.archived[0].issueNumber, 1);
    assert.strictEqual(countMutations(runChild.calls), 1);
  });

  it("--dry-run lists intended archive mutations without executing", async () => {
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-01-01T00:00:00Z" })];
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", olderThan: "30d", dryRun: true, now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild },
    );

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.mutations.length, 1);
    assert.ok(result.mutations[0].query.includes("archiveProjectV2Item"));
    assert.strictEqual(result.mutations[0].variables.itemId, "A");
    assert.strictEqual(countMutations(runChild.calls), 0);
  });

  it("defaults to 30d when --older-than is omitted", async () => {
    const nodes = [rawItemNode("A", 1, { closed: true, closedAt: "2026-06-23T00:00:00Z" })]; // 1d ago
    const responses = [
      { payload: userPayload() },
      { payload: listUserProjectsResponse([PROJECT]) },
      { payload: itemsResponse(nodes) },
    ];
    const runChild = mockRunChild(responses);

    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", now: Date.parse("2026-06-24T00:00:00Z") },
      { runChild },
    );

    assert.ok(result.ok);
    assert.strictEqual(result.archived.length, 0);
    assert.strictEqual(result.olderThan, "30d");
  });
});
