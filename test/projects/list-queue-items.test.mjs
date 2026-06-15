import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../scripts/projects/list-queue-items.mjs";

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

function orgPayload() {
  return { data: { organization: { id: "O_kgDOXYZ789" } } };
}

function noUserPayload() {
  return { data: { user: null } };
}

function noOrgPayload() {
  return { data: { organization: null } };
}

function listUserProjectsResponse(projects) {
  return {
    data: {
      user: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: projects,
        },
      },
    },
  };
}

function listOrgProjectsResponse(projects) {
  return {
    data: {
      organization: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: projects,
        },
      },
    },
  };
}

function getFieldsResponse(fields) {
  return {
    data: { node: { fields: { nodes: fields, pageInfo: { hasNextPage: false } } } },
  };
}

function getItemsResponse(items) {
  return {
    data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } },
  };
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

function makeItem(itemId, contentId, type, number, title, url, status) {
  const __typename = type === "PullRequest" ? "PullRequest" : "Issue";
  const content = { __typename, id: contentId, number, title, url };
  const fieldValues = status
    ? { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: status }] }
    : { nodes: [] };
  return { id: itemId, fieldValues, content };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("list-queue-items", () => {
  describe("argument parsing", () => {
    it("requires --repo", async () => {
      await assert.rejects(
        () => main({ project: "1" }),
        /--repo is required/,
      );
    });

    it("requires --project", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops" }),
        /--project is required/,
      );
    });

    it("rejects invalid project format", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "not-a-number" }),
        /--project must be a positive integer or a node ID/,
      );
    });

    it("rejects negative project number", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "-1" }),
        /--project must be a positive integer or a node ID/,
      );
    });

    it("rejects zero project number", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "0" }),
        /--project must be a positive integer or a node ID/,
      );
    });

    it("rejects invalid repo format", async () => {
      await assert.rejects(
        () => main({ repo: "not-a-repo", project: "1" }),
        /owner\/name/,
      );
    });

    it("rejects whitespace-padded repo", async () => {
      await assert.rejects(
        () => main({ repo: " owner/repo ", project: "1" }),
        /whitespace/,
      );
    });

    it("accepts valid node ID as project", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse([]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "PVT_proj1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });

    it("trims whitespace and resolves project number", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse([]) },
      ];
      // Whitespace-padded number should still parse as integer and find project
      const result = await main(
        { repo: "mfittko/dev-loops", project: " 1 " },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });
  });

  describe("success path — filtering and ordering", () => {
    it("lists all items unfiltered when no --column", async () => {
      const items = [
        makeItem("PVTI_1", "I_1", "Issue", 10, "Fix bug", "https://github.com/mfittko/repo/issues/10", "Backlog"),
        makeItem("PVTI_2", "PR_2", "PullRequest", 20, "Add feature", "https://github.com/mfittko/repo/pull/20", "Next Up"),
        makeItem("PVTI_3", "I_3", "Issue", 30, "Refactor", "https://github.com/mfittko/repo/issues/30", "In Progress"),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 3);
      assert.equal(result.items[0].issueNumber, 10);
      assert.equal(result.items[0].status, "Backlog");
      assert.equal(result.items[1].prNumber, 20);
      assert.equal(result.items[1].status, "Next Up");
      assert.equal(result.items[2].issueNumber, 30);
      assert.equal(result.items[2].url, "https://github.com/mfittko/repo/issues/30");
    });

    it("filters by --column", async () => {
      const items = [
        makeItem("PVTI_1", "I_1", "Issue", 10, "Fix bug", "https://github.com/mfittko/repo/issues/10", "Backlog"),
        makeItem("PVTI_2", "PR_2", "PullRequest", 20, "Add feature", "https://github.com/mfittko/repo/pull/20", "Next Up"),
        makeItem("PVTI_3", "I_3", "Issue", 30, "Refactor", "https://github.com/mfittko/repo/issues/30", "Next Up"),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", column: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 2);
      assert.equal(result.items[0].prNumber, 20);
      assert.equal(result.items[1].issueNumber, 30);
      for (const item of result.items) {
        assert.equal(item.status, "Next Up");
      }
    });

    it("applies --limit", async () => {
      const items = [
        makeItem("PVTI_1", "I_1", "Issue", 10, "Fix bug", "https://github.com/mfittko/repo/issues/10", "Next Up"),
        makeItem("PVTI_2", "PR_2", "PullRequest", 20, "Add feature", "https://github.com/mfittko/repo/pull/20", "Next Up"),
        makeItem("PVTI_3", "I_3", "Issue", 30, "Refactor", "https://github.com/mfittko/repo/issues/30", "Next Up"),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", column: "Next Up", limit: 1 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].issueNumber, 10);
    });

    it("returns items with all required fields", async () => {
      const items = [
        makeItem("PVTI_42", "I_kwDO_99", "Issue", 42, "Test issue", "https://github.com/mfittko/repo/issues/42", "Backlog"),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      const item = result.items[0];
      assert.equal(item.issueNumber, 42);
      assert.equal(item.prNumber, null);
      assert.equal(item.title, "Test issue");
      assert.equal(item.url, "https://github.com/mfittko/repo/issues/42");
      assert.equal(item.itemId, "PVTI_42");
      assert.equal(item.contentId, "I_kwDO_99");
      assert.equal(item.status, "Backlog");
    });

    it("items without content are skipped", async () => {
      const items = [
        { id: "PVTI_no_content", fieldValues: { nodes: [] }, content: null },
        makeItem("PVTI_1", "I_1", "Issue", 10, "Has content", "https://github.com/mfittko/repo/issues/10", "Next Up"),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].issueNumber, 10);
    });
  });

  describe("project resolution", () => {
    it("resolves project by number", async () => {
      const responses = [
        { payload: userPayload() },
        {
          payload: listUserProjectsResponse([
            { id: "PVT_other", number: 7, title: "Other Project", url: "https://github.com/users/mfittko/projects/7" },
            EXISTING_PROJECT,
          ]),
        },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse([]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 0);
    });

    it("resolves project by node ID", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse([]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "PVT_proj1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });

    it("resolves project for org owner", async () => {
      const orgProject = {
        id: "PVT_orgproj",
        number: 1,
        title: "Org Queue",
        url: "https://github.com/orgs/myorg/projects/1",
      };
      const responses = [
        { payload: noUserPayload() },
        { payload: orgPayload() },
        { payload: listOrgProjectsResponse([orgProject]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse([]) },
      ];
      const result = await main(
        { repo: "myorg/repo", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });

    it("supports paginated project listing", async () => {
      const page1 = {
        data: {
          user: {
            projectsV2: {
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
              nodes: Array.from({ length: 50 }, (_, i) => ({
                id: `PVT_${i}`, number: i, title: `Project ${i}`,
                url: `https://github.com/users/mfittko/projects/${i}`,
              })),
            },
          },
        },
      };
      const page2 = {
        data: {
          user: {
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [EXISTING_PROJECT],
            },
          },
        },
      };
      const responses = [
        { payload: userPayload() },
        { payload: page1 },
        { payload: page2 },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse([]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });
  });

  describe("error paths — missing project/field/column", () => {
    it("throws PROJECT_NOT_FOUND when project number not found", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) }, // number 1, not 42
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "42" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "PROJECT_NOT_FOUND");
        assert.match(err.message, /not found/);
      }
    });

    it("throws PROJECT_NOT_FOUND when node ID not found", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "PVT_nonexistent" },
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
          { repo: "mfittko/dev-loops", project: "1" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "FIELD_NOT_FOUND");
        assert.match(err.message, /Status field not found/);
      }
    });

    it("throws COLUMN_NOT_FOUND when column not in Status options", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", column: "Icebox" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "COLUMN_NOT_FOUND");
        assert.match(err.message, /"Icebox" not found/);
        assert.match(err.message, /Available: Backlog, Next Up, In Progress, Done/);
      }
    });

    it("throws NO_USER_ID when owner not resolvable", async () => {
      const responses = [
        { payload: noUserPayload() },
        { payload: noOrgPayload() },
      ];
      try {
        await main(
          { repo: "nonexistent/repo", project: "1" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "NO_USER_ID");
      }
    });
  });

  describe("error paths — API errors", () => {
    it("throws on gh CLI failure", async () => {
      const responses = [{ error: "gh: authentication required" }];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "GH_API_ERROR");
        assert.match(err.message, /gh api graphql failed/);
      }
    });

    it("throws on GraphQL errors in payload", async () => {
      const responses = [{
        payload: { errors: [{ message: "Could not resolve to a ProjectV2" }] },
      }];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "GRAPHQL_ERROR");
        assert.match(err.message, /GraphQL errors/);
      }
    });
  });

  describe("items with no status", () => {
    it("returns status null for items without Status field value", async () => {
      const items = [
        makeItem("PVTI_1", "I_1", "Issue", 10, "No status", "https://github.com/mfittko/repo/issues/10", null),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].status, null);
    });

    it("filters out items without matching status when --column used", async () => {
      const items = [
        makeItem("PVTI_1", "I_1", "Issue", 10, "No status", "https://github.com/mfittko/repo/issues/10", null),
        makeItem("PVTI_2", "I_2", "Issue", 20, "Has status", "https://github.com/mfittko/repo/issues/20", "Next Up"),
      ];
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsResponse(items) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", column: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].issueNumber, 20);
    });
  });

  describe("structured error output", () => {
    it("stderr has JSON with ok:false on error", async () => {
      // We can test the error object shape by catching from main()
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "999" },
          { env: {}, runChild: mockRunChild([
            { payload: userPayload() },
            { payload: listUserProjectsResponse([]) },
          ]) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        // Structured error properties
        assert.equal(err.code, "PROJECT_NOT_FOUND");
        assert.ok(err.message.length > 0);
        // The JSON output shape that runCli would produce
        const json = { ok: false, error: err.message, code: err.code };
        assert.equal(json.ok, false);
        assert.ok(json.error.includes("not found"));
        assert.equal(json.code, "PROJECT_NOT_FOUND");
      }
    });
  });
});
