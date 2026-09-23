import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { main } from "../../scripts/projects/move-queue-item.mjs";
import {
  userPayload,
  noUserPayload,
  orgPayload,
  statusField,
  existingProject,
  fieldsResponse as getFieldsResponse,
  issueSideItemsResponse,
  itemNodeResponse,
} from "./_fixtures.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────

function mockRunChild(responses) {
  let callIndex = 0;
  return async (_cmd, args, _env) => {
    if (callIndex >= responses.length) {
      throw new Error(`Unexpected gh call #${callIndex + 1} (only ${responses.length} mocked)`);
    }
    const resp = responses[callIndex++];
    if (resp.raw) return resp.raw;
    if (resp.error) {
      return { code: 1, stdout: "", stderr: resp.error };
    }
    return { code: 0, stdout: JSON.stringify(resp.payload), stderr: "" };
  };
}

// Real `gh api graphql` exits 1 when the response has GraphQL errors, but
// still prints the JSON payload on stdout.
function ghNotFound(payload, stderr) {
  return { raw: { code: 1, stdout: JSON.stringify(payload), stderr: `gh: ${stderr}` } };
}

// Variant of mockRunChild that records every gh invocation so tests can assert
// on the exact GraphQL query/variables sent to `gh api graphql`.
function recordingRunChild(responses, calls) {
  let callIndex = 0;
  return async (cmd, args, _env) => {
    // Reconstruct the query + variables from the `--field key=value` args.
    const fields = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--field" && typeof args[i + 1] === "string") {
        const eq = args[i + 1].indexOf("=");
        if (eq !== -1) fields[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
      }
    }
    calls.push({ cmd, args, query: fields.query, variables: fields });
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
// Shared shapes come from ./_fixtures.mjs; suite-specific fixtures stay local.

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

const STATUS_FIELD = statusField();

const EXISTING_PROJECT = existingProject();

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
        /--project must be a positive integer/,
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
          payload: issueSideItemsResponse([
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
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: itemNodeResponse(
            makeItemNode("PVTI_42", makeContent("Issue", 10), "Backlog"),
          ),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "PVTI_42", toColumn: "In Progress" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_42");
      assert.equal(result.item.newColumn, "In Progress");
      assert.equal(result.item.issueNumber, 10);
    });

    // Regression (#1227): a real project item node ID whose base64url payload
    // contains a hyphen was rejected by an [A-Za-z0-9_] validator that never
    // accounted for the full node-ID alphabet.
    it("accepts an item node ID containing a hyphen", async () => {
      const hyphenId = "PVTI_lAHOAAT8js4BaBePzgxz5-I";
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: itemNodeResponse(
            makeItemNode(hyphenId, makeContent("Issue", 10), "In Progress"),
          ),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: hyphenId, toColumn: "Done" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, hyphenId);
      assert.equal(result.item.newColumn, "Done");
    });
  });

  describe("success path — move by number", () => {
    it("moves an issue from Backlog to Next Up", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: issueSideItemsResponse([
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
          payload: issueSideItemsResponse([
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
          payload: issueSideItemsResponse([
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
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: itemNodeResponse(
            makeItemNode("PVTI_42", makeContent("Issue", 10), "Done"),
          ),
        },
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
            payload: issueSideItemsResponse([
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
        { payload: issueSideItemsResponse([]) },
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
        { payload: itemNodeResponse(null) },
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
    // A gh CLI/GraphQL failure on the user probe now falls through to the org
    // probe (#1949); when both fail the same way (e.g. a systemic auth
    // failure), resolveOwner fails closed with NO_USER_ID and preserves the
    // underlying org-probe error via `cause`.
    it("throws on gh CLI failure", async () => {
      const responses = [
        { error: "gh: authentication required" },
        { error: "gh: authentication required" },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "NO_USER_ID");
        assert.equal(err.cause.code, "GH_API_ERROR");
      }
    });

    it("throws on GraphQL errors", async () => {
      const responses = [
        { payload: { errors: [{ message: "Could not resolve" }] } },
        { payload: { errors: [{ message: "Could not resolve" }] } },
      ];
      try {
        await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses) },
        );
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.code, "NO_USER_ID");
        assert.equal(err.cause.code, "GRAPHQL_ERROR");
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
          payload: issueSideItemsResponse([
            makeItemNode("PVTI_org", makeContent("Issue", 10, "myorg/repo"), "Backlog"),
          ], "PVT_org"),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        { repo: "myorg/repo", project: "1", item: "10", toColumn: "Next Up" },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
    });

    it("resolves a user-scoped board URI without a resolveOwner round-trip", async () => {
      // URI path: ownerKind and owner come from the URI; no user/org lookup response needed
      const responses = [
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: issueSideItemsResponse([
            makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
          ]),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        {
          repo: "mfittko/dev-loops",
          project: "https://github.com/users/mfittko/projects/1",
          item: "10",
          toColumn: "Next Up",
        },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.newColumn, "Next Up");
    });

    it("main() resolves the board by title when --project is omitted (projectTitle)", async () => {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: issueSideItemsResponse([
            makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
          ]),
        },
        { payload: updateItemFieldResponse() },
      ];
      const result = await main(
        {
          repo: "mfittko/dev-loops",
          projectTitle: "Dev Loop Queue",
          item: "10",
          toColumn: "Next Up",
        },
        { env: {}, runChild: mockRunChild(responses) },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.newColumn, "Next Up");
    });
  });

  describe("regression — lookup does not depend on the lagging board listing", () => {
    // GitHub's ProjectV2.items listing can lag by hours and omit newly added
    // items. The move must find them from the issue side or by node, so the
    // listing is never queried.
    const listingQueries = (calls) => calls.filter((c) => c.query && c.query.includes("orderBy:{field:POSITION"));

    function responsesWith(itemPayload, extra = [{ payload: updateItemFieldResponse() }]) {
      return [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        itemPayload.raw ? itemPayload : { payload: itemPayload },
        ...extra,
      ];
    }

    it("moves by number an item the listing omits but projectItems returns", async () => {
      const calls = [];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "2392", toColumn: "Next Up" },
        {
          env: {},
          runChild: recordingRunChild(
            responsesWith(issueSideItemsResponse([
              makeItemNode("PVTI_other_board", makeContent("Issue", 2392), "Done"),
              makeItemNode("PVTI_new", makeContent("Issue", 2392), "Backlog"),
            ].map((n, i) => (i === 0 ? { ...n, project: { id: "PVT_other" } } : n)))),
            calls,
          ),
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_new");
      assert.equal(result.item.issueNumber, 2392);
      assert.equal(result.item.previousColumn, "Backlog");
      assert.equal(listingQueries(calls).length, 0, "the board listing must not be queried");
      const lookup = calls.find((c) => c.query && c.query.includes("issueOrPullRequest"));
      assert.ok(lookup.query.includes("projectItems(first:100, includeArchived:false)"));
      assert.ok(lookup.query.includes("__typename"));
      assert.equal(lookup.variables.owner, "mfittko");
      assert.equal(lookup.variables.name, "dev-loops");
      assert.equal(lookup.variables.number, "2392");
    });

    it("skips an archived item on the target project", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "2392", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(responsesWith(issueSideItemsResponse([
              { ...makeItemNode("PVTI_old", makeContent("Issue", 2392), "Done"), isArchived: true },
            ]), [])),
          },
        ),
        (err) => err.code === "ITEM_NOT_FOUND",
      );
    });

    it("moves by node ID an item the listing omits", async () => {
      const calls = [];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "PVTI_new", toColumn: "Next Up" },
        {
          env: {},
          runChild: recordingRunChild(
            responsesWith(itemNodeResponse(makeItemNode("PVTI_new", makeContent("Issue", 2392), "Backlog"))),
            calls,
          ),
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_new");
      assert.equal(result.item.issueNumber, 2392);
      assert.equal(listingQueries(calls).length, 0, "the board listing must not be queried");
      const lookup = calls.find((c) => c.query && c.query.includes("... on ProjectV2Item"));
      assert.equal(lookup.variables.id, "PVTI_new");
    });

    it("fails closed for a node ID on another project", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "PVTI_new", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(responsesWith(
              itemNodeResponse(makeItemNode("PVTI_new", makeContent("Issue", 2392), "Backlog"), "PVT_other"),
              [],
            )),
          },
        ),
        (err) => err.code === "ITEM_NOT_FOUND" && /belongs to project "PVT_other", not "PVT_proj1"/.test(err.message),
      );
    });

    it("fails closed for a node ID whose issue is in another repo", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "PVTI_new", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(responsesWith(
              itemNodeResponse(makeItemNode("PVTI_new", makeContent("Issue", 7, "other/repo"), "Backlog")),
              [],
            )),
          },
        ),
        (err) => err.code === "ITEM_NOT_FOUND" && /is for repo "other\/repo", not "mfittko\/dev-loops"/.test(err.message),
      );
    });

    it("returns ITEM_NOT_FOUND when the issue has no project items", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "2392", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responsesWith(issueSideItemsResponse([]), [])) },
        ),
        (err) => err.code === "ITEM_NOT_FOUND"
          && err.message === 'Item #2392 not found in project "Dev Loop Queue" for repo "mfittko/dev-loops"',
      );
    });

    it("maps a GraphQL NOT_FOUND on the issue number (gh exit 1) to ITEM_NOT_FOUND", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "99999", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(responsesWith(ghNotFound({
              data: { repository: { issueOrPullRequest: null } },
              errors: [{ type: "NOT_FOUND", message: "Could not resolve to an issue or pull request with the number of 99999." }],
            }, "Could not resolve to an issue or pull request with the number of 99999."), [])),
          },
        ),
        (err) => err.code === "ITEM_NOT_FOUND" && /project "Dev Loop Queue"/.test(err.message),
      );
    });

    it("maps a GraphQL NOT_FOUND on an unknown node ID (gh exit 1) to ITEM_NOT_FOUND", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "PVTI_bogus", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(responsesWith(ghNotFound({
              data: { node: null },
              errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'PVTI_bogus'" }],
            }, "Could not resolve to a node with the global id of 'PVTI_bogus'"), [])),
          },
        ),
        (err) => err.code === "ITEM_NOT_FOUND"
          && err.message === 'Item "PVTI_bogus" not found in project "Dev Loop Queue" for repo "mfittko/dev-loops"',
      );
    });

    it("keeps other GraphQL errors as GRAPHQL_ERROR", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "2392", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(responsesWith({ errors: [{ type: "FORBIDDEN", message: "nope" }] }, [])),
          },
        ),
        (err) => err.code === "GRAPHQL_ERROR",
      );
    });

    it("fails closed for an archived item node ID without a mutation", async () => {
      const calls = [];
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "PVTI_new", toColumn: "Next Up" },
          {
            env: {},
            runChild: recordingRunChild(responsesWith(
              itemNodeResponse({ ...makeItemNode("PVTI_new", makeContent("Issue", 2392), "Backlog"), isArchived: true }),
              [],
            ), calls),
          },
        ),
        (err) => err.code === "ITEM_NOT_FOUND",
      );
      assert.equal(calls.filter((c) => c.query && c.query.includes("mutation")).length, 0);
    });

    // A partial response: the token cannot read another board the issue is on.
    function partialForbidden(nodes) {
      const payload = issueSideItemsResponse(nodes);
      payload.errors = [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }];
      return { raw: { code: 1, stdout: JSON.stringify(payload), stderr: "gh: Resource not accessible by integration" } };
    }

    it("resolves a match on the configured board despite a FORBIDDEN error for another board", async () => {
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "2392", toColumn: "Next Up" },
        {
          env: {},
          runChild: mockRunChild(responsesWith(partialForbidden([
            makeItemNode("PVTI_new", makeContent("Issue", 2392), "Backlog"),
          ]))),
        },
      );
      assert.equal(result.item.itemId, "PVTI_new");
    });

    it("keeps a FORBIDDEN error as GRAPHQL_ERROR when no match exists", async () => {
      await assert.rejects(
        () => main(
          { repo: "mfittko/dev-loops", project: "1", item: "2392", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responsesWith(partialForbidden([]), [])) },
        ),
        (err) => err.code === "GRAPHQL_ERROR" && /Resource not accessible/.test(err.message),
      );
    });

    it("item lookup query requests __typename and never references ProjectV2.item or an unused $itemId", async () => {
      const calls = [];
      await main(
        { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
        {
          env: {},
          runChild: recordingRunChild(
            [
              { payload: userPayload() },
              { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
              { payload: getFieldsResponse([STATUS_FIELD]) },
              {
                payload: issueSideItemsResponse([
                  makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
                ]),
              },
              { payload: updateItemFieldResponse() },
            ],
            calls,
          ),
        },
      );

      const queries = calls.map((c) => c.query).filter(Boolean);
      // No query may reference the non-existent ProjectV2.item field.
      for (const q of queries) {
        assert.ok(!/item:\s*item\(/.test(q), `query must not alias ProjectV2.item: ${q}`);
        assert.ok(!/\bitem\(id:/.test(q), `query must not select ProjectV2.item(id:): ${q}`);
        // A query may only declare $itemId if it actually uses it.
        if (q.includes("$itemId:ID!")) {
          assert.ok(q.includes("itemId:$itemId"), `query declares $itemId but never uses it: ${q}`);
        }
      }

      // The item-resolution query must request __typename so issue/PR is
      // classified correctly (the original query omitted it, so issueNumber
      // was always null).
      const itemListQuery = queries.find((q) => q.includes("issueOrPullRequest"));
      assert.ok(itemListQuery, "expected an item lookup query");
      assert.ok(itemListQuery.includes("__typename"), "item lookup query must request __typename");
    });

    it("item ID lookup resolves by node (no ProjectV2.item query)", async () => {
      const calls = [];
      const result = await main(
        { repo: "mfittko/dev-loops", project: "1", item: "PVTI_target", toColumn: "Next Up" },
        {
          env: {},
          runChild: recordingRunChild(
            [
              { payload: userPayload() },
              { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
              { payload: getFieldsResponse([STATUS_FIELD]) },
              {
                payload: itemNodeResponse(
                  makeItemNode("PVTI_target", makeContent("Issue", 42), "Backlog"),
                ),
              },
              { payload: updateItemFieldResponse() },
            ],
            calls,
          ),
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.itemId, "PVTI_target");
      assert.equal(result.item.issueNumber, 42);
      // The update mutation must target the resolved item id and field.
      const mutationCall = calls.find((c) => c.query && c.query.includes("updateProjectV2ItemFieldValue"));
      assert.ok(mutationCall, "expected an updateProjectV2ItemFieldValue mutation");
      assert.equal(mutationCall.variables.itemId, "PVTI_target");
      assert.equal(mutationCall.variables.fieldId, "PVTSSF_status");
      assert.equal(mutationCall.variables.optionId, "opt2");
    });
  });

  describe("QUEUE-ENQUEUE-REFINEMENT-GATE (pickup-column move #1625)", () => {
    function issueBodyResponse(body) {
      return { body };
    }

    async function withTempCwd(fn) {
      const dir = mkdtempSync(nodePath.join(tmpdir(), "move-queue-gate-"));
      try {
        return await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // Writes a malformed .devloops so loadStateColumnMap returns a non-ENOENT
    // parse error (fail-closed CONFIG_ERROR path) and returns the cwd.
    function writeMalformedDevloops(dir) {
      writeFileSync(nodePath.join(dir, ".devloops"), "tracker:\n  board: [unclosed\n", "utf-8");
      return dir;
    }

    // GH call sequence for a move from Backlog -> Next Up (pickup): owner,
    // projects, fields, items, then (gate) issue view body, then the update.
    function moveResponses(itemBodyResponse, refined) {
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: issueSideItemsResponse([
            makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
          ]),
        },
        { payload: issueBodyResponse(itemBodyResponse) },
      ];
      if (refined) responses.push({ payload: updateItemFieldResponse() });
      return responses;
    }

    it("refuses to move an un-refined issue into the pickup column (throws MISSING_REFINEMENT_ARTIFACT, no mutation)", async () => {
      await withTempCwd(async (cwd) => {
        const call = recordingRunChild(
          moveResponses("Just a raw idea with no acceptance criteria or DoD.", false),
          [],
        );
        await assert.rejects(
          () => main(
            { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
            { env: {}, runChild: call, cwd },
          ),
          (err) => err.code === "MISSING_REFINEMENT_ARTIFACT",
        );
      });
    });

    it("throws GH_API_ERROR when the pickup-gate issue-body fetch fails (no mutation)", async () => {
      await withTempCwd(async (cwd) => {
        const calls = [];
        // Same move sequence as "refuses to move an un-refined issue", but the
        // gate's `gh issue view` (5th call) fails instead of returning a body.
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([STATUS_FIELD]) },
          {
            payload: issueSideItemsResponse([
              makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
            ]),
          },
          { error: "gh: not authenticated" },
        ];
        const call = recordingRunChild(responses, calls);
        await assert.rejects(
          () => main(
            { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
            { env: {}, runChild: call, cwd },
          ),
          (err) => err.code === "GH_API_ERROR",
        );
        const mutationCall = calls.find(
          (c) => c.query && c.query.includes("updateProjectV2ItemFieldValue"),
        );
        assert.equal(
          mutationCall,
          undefined,
          "no update mutation should run when the pickup-gate issue-body fetch fails",
        );
      });
    });

    it("allows moving a refined issue into the pickup column", async () => {
      await withTempCwd(async (cwd) => {
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
          {
            env: {},
            runChild: mockRunChild(moveResponses("## AC / DoD matrix\n| Criterion outcome | Required completion evidence |\n|---|---|\n| the feature works end to end | a focused test proves the feature works |\n\n## Non-goals\n- none", true)),
            cwd,
          },
        );
        assert.equal(result.ok, true);
        assert.equal(result.refinement.refined, true);
        assert.equal(result.item.newColumn, "Next Up");
      });
    });

    it("does not gate a PR moved into the pickup column", async () => {
      await withTempCwd(async (cwd) => {
        // PR item -> Next Up: no issue-body fetch, no gate, straight to update.
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([STATUS_FIELD]) },
          {
            payload: issueSideItemsResponse([
              makeItemNode("PVTI_20", makeContent("PR", 20), "Backlog"),
            ]),
          },
          { payload: updateItemFieldResponse() },
        ];
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: "20", toColumn: "Next Up" },
          { env: {}, runChild: mockRunChild(responses), cwd },
        );
        assert.equal(result.ok, true);
        assert.equal(result.item.newColumn, "Next Up");
        assert.equal("refinement" in result, false);
      });
    });

    it("fails closed with CONFIG_ERROR on a malformed .devloops when cwd is supplied (mirrors queue add)", async () => {
      await withTempCwd(async (cwd) => {
        // A malformed .devloops must not silently bypass the pickup-column gate.
        // The config error surfaces (CONFIG_ERROR) before any mutation when cwd is
        // supplied, exactly mirroring queue add's fail-closed posture.
        await assert.rejects(
          () => main(
            { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "Next Up" },
            { env: {}, runChild: mockRunChild([
              { payload: userPayload() },
              { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
              { payload: getFieldsResponse([STATUS_FIELD]) },
              {
                payload: issueSideItemsResponse([
                  makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
                ]),
              },
            ]), cwd: writeMalformedDevloops(cwd) },
          ),
          (err) => err.code === "CONFIG_ERROR",
        );
      });
    });

    it("does NOT fail on a malformed .devloops for a non-pickup column move (CONFIG_ERROR scoped to the pickup gate)", async () => {
      await withTempCwd(async (cwd) => {
        // A malformed .devloops must only hard-fail (CONFIG_ERROR) when the move
        // actually targets the pickup column and needs the refinement gate. An
        // unrelated column move must not be over-broadened into a hard failure.
        const calls = [];
        const responses = [
          { payload: userPayload() },
          { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
          { payload: getFieldsResponse([STATUS_FIELD]) },
          {
            payload: issueSideItemsResponse([
              makeItemNode("PVTI_1", makeContent("Issue", 10), "Backlog"),
            ]),
          },
          { payload: updateItemFieldResponse() },
        ];
        const call = recordingRunChild(responses, calls);
        const result = await main(
          { repo: "mfittko/dev-loops", project: "1", item: "10", toColumn: "In Progress" },
          { env: {}, runChild: call, cwd: writeMalformedDevloops(cwd) },
        );
        assert.equal(result.ok, true);
        assert.equal(result.item.newColumn, "In Progress");
        const mutationCall = calls.find(
          (c) => c.query && c.query.includes("updateProjectV2ItemFieldValue"),
        );
        assert.ok(mutationCall, "the non-pickup move should still run its update mutation");
      });
    });

    it("skips the gate entirely when cwd is not supplied (headless callers like reconcile stay unaffected)", async () => {
      // No cwd -> pickup column is never derived -> un-refined issue move sails
      // through exactly as before (no issue-body fetch; straight to update).
      const responses = [
        { payload: userPayload() },
        { payload: listUserProjectsResponse([EXISTING_PROJECT]) },
        { payload: getFieldsResponse([STATUS_FIELD]) },
        {
          payload: issueSideItemsResponse([
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
      assert.equal(result.item.newColumn, "Next Up");
      assert.equal("refinement" in result, false);
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
            { payload: issueSideItemsResponse([]) },
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
