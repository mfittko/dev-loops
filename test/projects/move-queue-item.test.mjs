import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../scripts/projects/move-queue-item.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  return async (_cmd, args, _env) => {
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

// ── Fixtures ────────────────────────────────────────────────────────────

function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}

function noUserPayload() {
  return { data: { user: null } };
}

function orgPayload() {
  return { data: { organization: { id: "O_kgDOXYZ789" } } };
}

function noOrgPayload() {
  return { data: { organization: null } };
}

function listUserProjectsResponse(projects) {
  return {
    data: {
      user: {
        projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: projects },
      },
    },
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

function getItemsByContentResponse(items) {
  return {
    data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } },
  };
}

function getItemResponse(item) {
  return {
    data: { node: { item } },
  };
}

function updateItemFieldResponse() {
  return {
    data: {
      updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } },
    },
  };
}

function makeItemNode(itemId, content, status) {
  const fieldValues = status != null
    ? { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: status }] }
    : { nodes: [] };
  return { id: itemId, fieldValues, content };
}

function makeContent(type, number, repo = "mfittko/dev-loops") {
  const __typename = type === "PR" ? "PullRequest" : "Issue";
  return { __typename, number, repository: { nameWithOwner: repo } };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("move-queue-item", () => {
  describe("argument parsing", () => {
    it("requires --repo", async () => {
      await assert.rejects(
        () => main({ project: "1", item: "10", toColumn: "Next Up" }),
        /--repo is required/,
      );
    });

    it("requires --project", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: "10", toColumn: "Next Up" }),
        /--project is required/,
      );
    });

    it("requires --item", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "1", toColumn: "Next Up" }),
        /--item is required/,
      );
    });

    it("requires --to-column", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "1", item: "10" }),
        /--to-column is required/,
      );
    });

    it("rejects invalid project format", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "not-a-number", item: "10", toColumn: "Next Up" }),
        /--project must be a positive integer or a node ID/,
      );
    });

    it("rejects invalid item format", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "1", item: "not-a-number", toColumn: "Next Up" }),
        /--item must be a positive integer or an item node ID/,
      );
    });

    it("accepts project node ID", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: getItemsByContentResponse([
            makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
          ]),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "PVT_proj1", item: "10", toColumn: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.newColumn, "Next Up");
    });

    it("accepts item node ID", async () => {
      const itemNode = {
        id: "PVTI_42",
        fieldValues: { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: "Backlog" }] },
        content: { __typename: "Issue", number: 10, title: "Test", url: "https://github.com/mfittko/dev-loops/issues/10" },
      };
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemResponse(itemNode) },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "PVTI_42", toColumn: "In Progress" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.newColumn, "In Progress");
      assert.equal(result.item.issueNumber, 10);
    });
  });

  describe("success path — move by number", () => {
    it("moves an issue from Backlog to Next Up", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: getItemsByContentResponse([
            makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
          ]),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_1");
      assert.equal(result.item.issueNumber, 10);
      assert.equal(result.item.prNumber, null);
      assert.equal(result.item.previousColumn, "Backlog");
      assert.equal(result.item.newColumn, "Next Up");
      assert.equal(result.item.unchanged, false);
    });

    it("moves a PR between columns", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: getItemsByContentResponse([
            makeItemNode("PVTI_2", makeContent("PR", 20), "In Progress"),
          ]),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "20", toColumn: "Done" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.prNumber, 20);
      assert.equal(result.item.previousColumn, "In Progress");
      assert.equal(result.item.newColumn, "Done");
      assert.equal(result.item.unchanged, false);
    });
  });

  describe("no-op when already at target column", () => {
    it("returns unchanged when already at target", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: getItemsByContentResponse([
            makeItemNode("PVTI_1", makeContent("Issue", 10), "Next Up"),
          ]),
        },
        // No mutation call expected — unchanged
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.previousColumn, "Next Up");
      assert.equal(result.item.newColumn, "Next Up");
      assert.equal(result.item.unchanged, true);
    });

    it("returns unchanged when already at target via item ID lookup", async () => {
      const itemNode = {
        id: "PVTI_42",
        fieldValues: { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: "Done" }] },
        content: { __typename: "Issue", number: 10, title: "Test", url: "https://github.com/mfittko/dev-loops/issues/10" },
      };
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemResponse(itemNode) },
        // No mutation
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "PVTI_42", toColumn: "Done" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.unchanged, true);
    });
  });

  describe("supports all standard transitions", () => {
    const transitions = [
      ["Backlog", "Next Up"],
      ["Next Up", "In Progress"],
      ["In Progress", "Done"],
      ["Done", "Backlog"],
      ["Backlog", "In Progress"],
      ["Next Up", "Done"],
    ];
    for (const [from, to] of transitions) {
      it(`moves from "${from}" to "${to}"`, async () => {
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([STATUS_FIELD]) },
          {
            payload: getItemsByContentResponse([
              makeItemNode("PVTI_1", makeContent("Issue", 10), from),
            ]),
          },
          { payload: updateItemFieldResponse() },
        ];
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: to },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.equal(result.ok, true);
        assert.equal(result.item.previousColumn, from);
        assert.equal(result.item.newColumn, to);
        assert.equal(result.item.unchanged, false);
      });
    }
  });

  describe("error paths — not found", () => {
    it("throws PROJECT_NOT_FOUND for missing project number", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "999", item: "10", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "PROJECT_NOT_FOUND");
      }
    });

    it("throws FIELD_NOT_FOUND when Status field missing", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "FIELD_NOT_FOUND");
      }
    });

    it("throws COLUMN_NOT_FOUND for unknown target column", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Icebox" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "COLUMN_NOT_FOUND");
        assert.match(err.message, /"Icebox" not found/);
      }
    });

    it("throws ITEM_NOT_FOUND when item not in project (by number)", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsByContentResponse([]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "42", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "ITEM_NOT_FOUND");
      }
    });

    it("throws ITEM_NOT_FOUND when item ID not found", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemResponse(null) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "PVTI_nonexistent", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "ITEM_NOT_FOUND");
      }
    });
  });

  describe("error paths — API errors", () => {
    it("throws on gh CLI failure", async () => {
      const responses = [{ error: "gh: authentication required" }];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "GH_API_ERROR");
      }
    });

    it("throws on GraphQL errors", async () => {
      const responses = [{ payload: { errors: [{ message: "Could not resolve" }] } }];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "GRAPHQL_ERROR");
      }
    });
  });

  describe("owner resolution", () => {
    it("resolves org owner", async () => {
      const orgProject = { id: "PVT_org", number: 1, title: "Org Queue", url: "https://github.com/orgs/myorg/projects/1" };
      const orgStatusField = { ...STATUS_FIELD };
      const responses = [
        { payload: noUserPayload() },
        { payload: orgPayload() },
        {
          payload: {
            data: { organization: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [orgProject] } } },
          },
        },
        { payload: getFieldsResponse([orgStatusField]) },
        {
          payload: getItemsByContentResponse([
            makeItemNode("PVTI_org", makeContent("Issue", 10, "myorg/repo"), "Backlog"),
          ]),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "myorg/repo", project: "1", item: "10", toColumn: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });
  });

  describe("structured error output", () => {
    it("produces JSON error shape for CLI consumers", async () => {
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "42", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild([
            { payload: userPayload() },
            { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
            { payload: getFieldsResponse([STATUS_FIELD]) },
            { payload: getItemsByContentResponse([]) },
          ]) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "ITEM_NOT_FOUND");
        const json = { ok: false, error: err.message, code: err.code };
        assert.equal(json.ok, false);
        assert.equal(json.code, "ITEM_NOT_FOUND");
      }
    });
  });
});
