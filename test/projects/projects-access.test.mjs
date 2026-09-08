import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  validateProjectsRepo,
  paginateNodes,
  discoverProjects,
  listProjectFields,
  extractStatus,
} from "@dev-loops/core/projects/projects-access";

// Mock runChild: returns queued gh-graphql payloads in order, and records the
// `--field after=<cursor>` value seen on each call so cursor forwarding is
// observable. A response may carry { error } to simulate a non-zero gh exit.
function mockRunChild(responses) {
  const afterSeen = [];
  let i = 0;
  const runChild = async (_cmd, args) => {
    const idx = args.indexOf("--field");
    // Find the after=... field arg, if any.
    let after = null;
    for (let a = 0; a < args.length - 1; a++) {
      if (args[a] === "--field" && args[a + 1].startsWith("after=")) after = args[a + 1].slice("after=".length);
    }
    afterSeen.push(after);
    void idx;
    if (i >= responses.length) throw new Error(`Unexpected gh call #${i + 1} (only ${responses.length} mocked)`);
    const resp = responses[i++];
    if (resp.error) return { code: 1, stdout: "", stderr: resp.error };
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
  return { runChild, afterSeen };
}

const conn = (nodes, { hasNextPage = false, endCursor = null } = {}) => ({ nodes, pageInfo: { hasNextPage, endCursor } });

describe("validateProjectsRepo", () => {
  it("returns the input unchanged for a valid owner/name", () => {
    assert.equal(validateProjectsRepo("mfittko/dev-loops"), "mfittko/dev-loops");
    assert.equal(validateProjectsRepo("a/b"), "a/b");
    assert.equal(validateProjectsRepo("Org-1/repo.name_2"), "Org-1/repo.name_2");
  });

  for (const [label, value] of [
    ["empty", ""],
    ["missing", undefined],
    ["non-string", 5],
    ["leading whitespace", " a/b"],
    ["trailing whitespace", "a/b "],
    ["no slash", "owneronly"],
    ["empty owner", "/name"],
    ["empty name", "owner/"],
    ["owner ends with dash-only rule", "-owner/name"],
    ["name with slash", "owner/na/me"],
  ]) {
    it(`throws INVALID_REPO for ${label}`, () => {
      assert.throws(() => validateProjectsRepo(value), (err) => err.code === "INVALID_REPO");
    });
  }
});

describe("paginateNodes", () => {
  it("concatenates pages in order and forwards endCursor as the next after", async () => {
    const { runChild, afterSeen } = mockRunChild([
      { payload: { data: { c: conn([1, 2], { hasNextPage: true, endCursor: "CUR1" }) } } },
      { payload: { data: { c: conn([3, 4], { hasNextPage: true, endCursor: "CUR2" }) } } },
      { payload: { data: { c: conn([5], { hasNextPage: false }) } } },
    ]);
    const nodes = await paginateNodes({
      query: "q",
      variables: { projectId: "P" },
      selectConnection: (p) => p?.data?.c,
      env: {},
      runChild,
      entity: "items",
    });
    assert.deepEqual(nodes, [1, 2, 3, 4, 5]);
    // First call has no after; subsequent calls forward the prior endCursor.
    assert.deepEqual(afterSeen, [null, "CUR1", "CUR2"]);
  });

  it("returns a single page without setting after", async () => {
    const { runChild, afterSeen } = mockRunChild([
      { payload: { data: { c: conn([{ id: "x" }], { hasNextPage: false }) } } },
    ]);
    const nodes = await paginateNodes({ query: "q", selectConnection: (p) => p?.data?.c, env: {}, runChild });
    assert.deepEqual(nodes, [{ id: "x" }]);
    assert.deepEqual(afterSeen, [null]);
  });

  it("fails closed with GH_API_ERROR when hasNextPage is true but endCursor is missing", async () => {
    const { runChild } = mockRunChild([
      { payload: { data: { c: conn([1], { hasNextPage: true, endCursor: null }) } } },
    ]);
    await assert.rejects(
      paginateNodes({ query: "q", selectConnection: (p) => p?.data?.c, env: {}, runChild, entity: "items" }),
      (err) => err.code === "GH_API_ERROR" && /Invalid items payload/.test(err.message),
    );
  });

  it("treats a missing connection as an empty final page", async () => {
    const { runChild } = mockRunChild([{ payload: { data: {} } }]);
    const nodes = await paginateNodes({ query: "q", selectConnection: (p) => p?.data?.c, env: {}, runChild });
    assert.deepEqual(nodes, []);
  });
});

describe("discoverProjects", () => {
  it("selects the user root and traverses all pages when kind is not org", async () => {
    const { runChild } = mockRunChild([
      { payload: { data: { user: { projectsV2: conn([{ id: "a", number: 1 }], { hasNextPage: true, endCursor: "C" }) } } } },
      { payload: { data: { user: { projectsV2: conn([{ id: "b", number: 2 }], { hasNextPage: false }) } } } },
    ]);
    const projects = await discoverProjects("octocat", "user", {}, runChild);
    assert.deepEqual(projects.map((p) => p.number), [1, 2]);
  });

  it("selects the organization root when kind is org", async () => {
    const { runChild } = mockRunChild([
      { payload: { data: { organization: { projectsV2: conn([{ id: "o", number: 9 }], { hasNextPage: false }) } } } },
    ]);
    const projects = await discoverProjects("acme", "org", {}, runChild);
    assert.deepEqual(projects.map((p) => p.id), ["o"]);
  });
});

describe("listProjectFields", () => {
  it("traverses the single-select field connection to completion", async () => {
    const f = (name) => ({ id: name, name, options: [] });
    const { runChild } = mockRunChild([
      { payload: { data: { node: { fields: conn([f("Status")], { hasNextPage: true, endCursor: "C" }) } } } },
      { payload: { data: { node: { fields: conn([f("Priority")], { hasNextPage: false }) } } } },
    ]);
    const fields = await listProjectFields("P", {}, runChild);
    assert.deepEqual(fields.map((x) => x.name), ["Status", "Priority"]);
  });
});

describe("extractStatus", () => {
  it("returns the name of the first field value owned by the Status field", () => {
    const node = {
      fieldValues: {
        nodes: [
          { field: { name: "Priority" }, name: "High" },
          { field: { name: "Status" }, name: "In Progress" },
          { field: { name: "Status" }, name: "Done" },
        ],
      },
    };
    assert.equal(extractStatus(node), "In Progress");
  });

  it("returns null when no Status field value is present", () => {
    assert.equal(extractStatus({ fieldValues: { nodes: [{ field: { name: "Priority" }, name: "High" }] } }), null);
    assert.equal(extractStatus({ fieldValues: { nodes: [] } }), null);
    assert.equal(extractStatus({}), null);
    assert.equal(extractStatus(null), null);
  });

  it("skips malformed field-value entries without a field", () => {
    const node = { fieldValues: { nodes: [null, { name: "orphan" }, { field: { name: "Status" }, name: "Next Up" }] } };
    assert.equal(extractStatus(node), "Next Up");
  });
});
