import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { main, parseCliArgs, runCli } from "../../scripts/projects/add-queue-item.mjs";

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

function emptyItemsResponse() {
  return getItemsByContentResponse([]);
}

function resolveIssueResponse(issueId) {
  return {
    data: {
      repository: {
        issueOrPullRequest: {
          id: issueId,
          __typename: "Issue",
        },
      },
    },
  };
}

function resolvePrResponse(prId) {
  return {
    data: {
      repository: {
        issueOrPullRequest: {
          id: prId,
          __typename: "PullRequest",
        },
      },
    },
  };
}

function resolveBothResponse() {
  return {
    data: {
      repository: {
        issueOrPullRequest: {
          id: "I_kwDO_10",
          __typename: "Issue",
        },
      },
    },
  };
}

function addItemResponse(itemId) {
  return {
    data: {
      addProjectV2ItemById: { item: { id: itemId } },
    },
  };
}

function updateFieldResponse() {
  return {
    data: {
      updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } },
    },
  };
}

function makeItemNode(itemId, content, status) {
  const fieldValues = status != null
    ? { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: status }] }
    : { nodes: [] };
  return { id: itemId, fieldValues, content };
}

function makeContent(type, number) {
  const __typename = type === "PR" ? "PullRequest" : "Issue";
  return { __typename, number, repository: { nameWithOwner: "mfittko/dev-loops" } };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("add-queue-item", () => {
  describe("argument parsing", () => {
    it("requires --repo", async () => {
      await assert.rejects(
        () => main({ project: "1", item: 10 }),
        /--repo is required/,
      );
    });

    it("requires --project", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: 10 }),
        /--project is required/,
      );
    });

    it("requires --item", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "1" }),
        /--item is required/,
      );
    });

    it("rejects non-integer item", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "1", item: "not-a-number" }),
        /--item is required/,
      );
    });

    it("rejects invalid project format", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", project: "not-a-number", item: 10 }),
        /--project must be a positive integer/,
      );
    });

    it("accepts project node ID", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "PVT_proj1", item: 10 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });
  });

  describe("success path — add new item", () => {
    it("adds an issue with default Backlog status", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_new");
      assert.equal(result.item.issueNumber, 10);
      assert.equal(result.item.prNumber, null);
      assert.equal(result.item.status, "Backlog");
      assert.equal(result.item.alreadyPresent, false);
    });

    it("adds a PR to project", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolvePrResponse("PR_kwDO_20") },
        { payload: addItemResponse("PVTI_pr") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 20 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.prNumber, 20);
      assert.equal(result.item.issueNumber, null);
      assert.equal(result.item.status, "Backlog");
      assert.equal(result.item.alreadyPresent, false);
    });

    it("adds with custom --status", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10, status: "In Progress" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.status, "In Progress");
      assert.equal(result.item.alreadyPresent, false);
    });

    it("prefers issue over PR when both exist for same number", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveBothResponse() },
        { payload: addItemResponse("PVTI_both") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.issueNumber, 10);
      assert.equal(result.item.prNumber, null);
    });
  });

  describe("no-op when already present", () => {
    it("returns alreadyPresent:true when item already in project", async () => {
      const existingItem = makeItemNode("PVTI_existing", makeContent("Issue", 10), "Next Up");
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsByContentResponse([existingItem]) },
        // No resolve, add, or update calls expected
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_existing");
      assert.equal(result.item.issueNumber, 10);
      assert.equal(result.item.status, "Next Up");
      assert.equal(result.item.alreadyPresent, true);
    });

    it("returns alreadyPresent:true for PR already in project", async () => {
      const existingItem = makeItemNode("PVTI_existing_pr", makeContent("PR", 20), "Done");
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsByContentResponse([existingItem]) },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 20 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.prNumber, 20);
      assert.equal(result.item.alreadyPresent, true);
    });

    it("filters already-present check by repo", async () => {
      // Item from different repo should not match
      const otherRepoContent = { __typename: "Issue", number: 10, repository: { nameWithOwner: "other/repo" } };
      const otherItem = makeItemNode("PVTI_other", otherRepoContent, "Backlog");
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: getItemsByContentResponse([otherItem]) },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.alreadyPresent, false);
    });
  });

  describe("error paths — not found", () => {
    it("throws PROJECT_NOT_FOUND for missing project", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "999", item: 10 },
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
          { repo: "mfittko/dev-loops", project: "1", item: 10 },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "FIELD_NOT_FOUND");
      }
    });

    it("throws COLUMN_NOT_FOUND for unknown status", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: 10, status: "Icebox" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "COLUMN_NOT_FOUND");
      }
    });

    it("throws CONTENT_NOT_FOUND when issue/PR doesn't exist", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        {
          payload: { data: { repository: { issue: null, pr: null } } },
        },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: 999 },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "CONTENT_NOT_FOUND");
        assert.match(err.message, /not found/);
      }
    });

    it("throws CONTENT_NOT_FOUND when repo doesn't exist", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        {
          payload: { data: { repository: null } },
        },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: 10 },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "CONTENT_NOT_FOUND");
      }
    });
  });

  describe("error paths — API errors", () => {
    it("throws on gh CLI failure", async () => {
      const responses = [{ error: "gh: authentication required" }];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: 10 },
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
          { repo: "mfittko/dev-loops", project: "1", item: 10 },
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
      const responses = [
        { payload: noUserPayload() },
        { payload: orgPayload() },
        {
          payload: {
            data: { organization: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [orgProject] } } },
          },
        },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_org_10") },
        { payload: addItemResponse("PVTI_org_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "myorg/repo", project: "1", item: 10 },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });
  });

  describe("structured error output", () => {
    it("produces JSON error shape for CLI consumers", async () => {
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: 999 },
          { env: {}, runChild: mockRunChild([
            { payload: userPayload() },
            { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
            { payload: getFieldsResponse([STATUS_FIELD]) },
            { payload: emptyItemsResponse() },
            { payload: { data: { repository: { issue: null, pr: null } } } },
          ]) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "CONTENT_NOT_FOUND");
        const json = { ok: false, error: err.message, code: err.code };
        assert.equal(json.ok, false);
        assert.equal(json.code, "CONTENT_NOT_FOUND");
      }
    });
  });

  describe("--column / --status flag alias (issue #912)", () => {
    const base = ["--repo", "mfittko/dev-loops", "--project", "1", "--item", "42"];

    it("--column sets the target column", () => {
      const args = parseCliArgs([...base, "--column", "Next Up"]);
      assert.equal(args.column, "Next Up");
    });

    it("--status is accepted as a back-compat alias (parsed into args.status)", () => {
      const args = parseCliArgs([...base, "--status", "Next Up"]);
      assert.equal(args.status, "Next Up");
      assert.equal(args.column, undefined);
    });

    it("main() resolves the --status alias to the same target column as --column", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10, status: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.item.status, "Next Up");
    });

    it("main() rejects conflicting --column and --status values", async () => {
      await assert.rejects(
        () =>
          main(
            { repo: "mfittko/dev-loops", project: "1", item: 10, column: "Next Up", status: "Backlog" },
            { env: {}, runChild: mockRunChild([]) },
          ),
        /Conflicting --column .* and --status/,
      );
    });

    it("main() accepts --column and --status when they agree", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10, column: "Next Up", status: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.item.status, "Next Up");
    });
  });

  describe("--next-up flag (#1091)", () => {
    const base = ["--repo", "mfittko/dev-loops", "--project", "1", "--item", "42"];

    it("parses --next-up as a boolean", () => {
      const args = parseCliArgs([...base, "--next-up"]);
      assert.equal(args.nextUp, true);
    });

    it("main() lands the item in the Next Up column", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.status, "Next Up");
    });

    it("main() accepts --next-up together with an agreeing --column \"Next Up\"", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true, column: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.item.status, "Next Up");
    });

    it("main() rejects --next-up combined with a conflicting --column", async () => {
      await assert.rejects(
        () =>
          main(
            { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true, column: "Backlog" },
            { env: {}, runChild: mockRunChild([]) },
          ),
        /Conflicting --next-up and --column\/--status/,
      );
    });
  });

  describe("--next-up resolves the configured next_up column (#1098)", () => {
    const TODO_STATUS_FIELD = {
      id: "PVTSSF_status",
      name: "Status",
      options: [
        { id: "opt1", name: "Backlog" },
        { id: "opt2", name: "Todo" },
        { id: "opt3", name: "In Progress" },
        { id: "opt4", name: "Done" },
      ],
    };

    async function withTempCwd(contents, fn) {
      const dir = mkdtempSync(nodePath.join(tmpdir(), "add-queue-statuscol-"));
      try {
        if (contents !== null) writeFileSync(nodePath.join(dir, ".devloops"), contents, "utf-8");
        return await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("main() lands --next-up in the overridden statusColumns.next_up column (\"Todo\")", async () => {
      await withTempCwd('queue:\n  projectNumber: 1\n  statusColumns:\n    next_up: "Todo"\n', async (cwd) => {
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([TODO_STATUS_FIELD]) },
          { payload: emptyItemsResponse() },
          { payload: resolveIssueResponse("I_kwDO_10") },
          { payload: addItemResponse("PVTI_new") },
          { payload: updateFieldResponse() },
        ];
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true },
          { env: {}, runChild: mockRunChild(responses), cwd },
        );
        assert.equal(result.ok, true);
        assert.equal(result.item.status, "Todo");
      });
    });

    it("main() accepts --next-up together with an agreeing --column \"Todo\" under the same override", async () => {
      await withTempCwd('queue:\n  projectNumber: 1\n  statusColumns:\n    next_up: "Todo"\n', async (cwd) => {
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([TODO_STATUS_FIELD]) },
          { payload: emptyItemsResponse() },
          { payload: resolveIssueResponse("I_kwDO_10") },
          { payload: addItemResponse("PVTI_new") },
          { payload: updateFieldResponse() },
        ];
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true, column: "Todo" },
          { env: {}, runChild: mockRunChild(responses), cwd },
        );
        assert.equal(result.ok, true);
        assert.equal(result.item.status, "Todo");
      });
    });

    it("main() rejects --next-up + the OLD literal --column \"Next Up\" once next_up is renamed to \"Todo\"", async () => {
      await withTempCwd('queue:\n  projectNumber: 1\n  statusColumns:\n    next_up: "Todo"\n', async (cwd) => {
        await assert.rejects(
          () =>
            main(
              { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true, column: "Next Up" },
              { env: {}, runChild: mockRunChild([]), cwd },
            ),
          /Conflicting --next-up and --column\/--status/,
        );
      });
    });

    it("main() fails CLOSED on a malformed .devloops when --next-up drives the target (no literal fallback)", async () => {
      // Genuinely un-parseable YAML → loadStateColumnMap surfaces an error;
      // --next-up must throw rather than silently querying the literal "Next Up".
      await withTempCwd("queue: renamed\n- broken\n", async (cwd) => {
        await assert.rejects(
          () =>
            main(
              { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true },
              { env: {}, runChild: mockRunChild([]), cwd },
            ),
          /config read\/parse error/,
        );
      });
    });

    it("main() with an override-free .devloops still resolves --next-up to the default \"Next Up\" (hermetic cwd)", async () => {
      // Hermetic: explicit empty-config temp cwd so this can't break if the real
      // repo's .devloops ever gains a next_up override.
      await withTempCwd("queue:\n  projectNumber: 1\n", async (cwd) => {
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([STATUS_FIELD]) },
          { payload: emptyItemsResponse() },
          { payload: resolveIssueResponse("I_kwDO_10") },
          { payload: addItemResponse("PVTI_new") },
          { payload: updateFieldResponse() },
        ];
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: 10, nextUp: true },
          { env: {}, runChild: mockRunChild(responses), cwd },
        );
        assert.equal(result.ok, true);
        assert.equal(result.item.status, "Next Up");
      });
    });
  });

  describe("optional --project resolved from .devloops (#1035)", () => {
    function addResponses(project) {
      return [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([project]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        { payload: emptyItemsResponse() },
        { payload: resolveIssueResponse("I_kwDO_10") },
        { payload: addItemResponse("PVTI_new") },
        { payload: updateFieldResponse() },
      ];
    }

    async function withTempCwd(contents, fn) {
      const dir = mkdtempSync(nodePath.join(tmpdir(), "add-queue-cfg-"));
      try {
        if (contents !== null) writeFileSync(nodePath.join(dir, ".devloops"), contents, "utf-8");
        return await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    function noopStream() {
      return { write() {} };
    }

    it("main() resolves the board by title when --project is omitted (projectTitle)", async () => {
      const result = await main(
        { repo: "mfittko/dev-loops", projectTitle: "Dev Loop Queue", item: 10 },
        { env: {}, runChild: mockRunChild(addResponses(EXISTING_PROJECT)) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_new");
    });

    it("main() fails closed with INVALID_PROJECT when neither --project nor projectTitle given", async () => {
      await assert.rejects(
        () => main({ repo: "mfittko/dev-loops", item: 10 }, { env: {}, runChild: mockRunChild([]) }),
        (e) => e.code === "INVALID_PROJECT" && /queue\.projectNumber/.test(e.message),
      );
    });

    it("runCli resolves projectNumber from .devloops when --project omitted", async () => {
      await withTempCwd("queue:\n  projectNumber: 1\n", async (cwd) => {
        await runCli(["--repo", "mfittko/dev-loops", "--item", "10"], {
          env: {}, cwd, runChild: mockRunChild(addResponses(EXISTING_PROJECT)),
          stdout: noopStream(), stderr: noopStream(),
        });
        assert.equal(process.exitCode, 0);
      });
    });

    it("runCli resolves boardTitle from .devloops when --project omitted", async () => {
      await withTempCwd("queue:\n  boardTitle: \"Dev Loop Queue\"\n", async (cwd) => {
        await runCli(["--repo", "mfittko/dev-loops", "--item", "10"], {
          env: {}, cwd, runChild: mockRunChild(addResponses(EXISTING_PROJECT)),
          stdout: noopStream(), stderr: noopStream(),
        });
        assert.equal(process.exitCode, 0);
      });
    });

    it("runCli: explicit --project wins over .devloops", async () => {
      const other = { id: "PVT_flag", number: 9, title: "Flag Project", url: "u" };
      await withTempCwd("queue:\n  projectNumber: 1\n", async (cwd) => {
        // Only project #9 is returned; if .devloops (#1) had won, resolution would 404.
        await runCli(["--repo", "mfittko/dev-loops", "--project", "9", "--item", "10"], {
          env: {}, cwd, runChild: mockRunChild(addResponses(other)),
          stdout: noopStream(), stderr: noopStream(),
        });
        assert.equal(process.exitCode, 0);
      });
    });

    it("runCli fails closed (exit 1) when neither --project nor .devloops resolves", async () => {
      await withTempCwd(null, async (cwd) => {
        let err = "";
        await runCli(["--repo", "mfittko/dev-loops", "--item", "10"], {
          env: {}, cwd, runChild: mockRunChild([]),
          stdout: noopStream(), stderr: { write(s) { err += s; } },
        });
        assert.equal(process.exitCode, 1);
        assert.match(err, /INVALID_PROJECT/);
        process.exitCode = 0; // avoid leaking a failure code into the test runner
      });
    });
  });
});
