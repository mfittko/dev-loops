import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { main, parseCliArgs } from "../../scripts/projects/remove-queue-item.mjs";
import {
  userPayload,
  existingProject,
  issueSideItemsResponse,
} from "./_fixtures.mjs";

function recordingRunChild(responses, calls) {
  let callIndex = 0;
  return async (_cmd, args) => {
    const fields = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--field" && typeof args[i + 1] === "string") {
        const eq = args[i + 1].indexOf("=");
        if (eq !== -1) fields[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
      }
    }
    calls.push(fields);
    if (callIndex >= responses.length) throw new Error(`Unexpected gh call #${callIndex + 1}`);
    return { code: 0, stdout: JSON.stringify(responses[callIndex++]), stderr: "" };
  };
}

const projectsResponse = {
  data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [existingProject()] } } },
};
const itemNode = { id: "PVTI_1", fieldValues: { nodes: [] }, content: { __typename: "Issue", number: 10, repository: { nameWithOwner: "mfittko/dev-loops" } } };
const deleteResponse = { data: { deleteProjectV2Item: { deletedItemId: "PVTI_1" } } };

describe("remove-queue-item", () => {
  it("requires --item and --repo", async () => {
    await assert.rejects(() => main({ project: "1", item: "10" }), /--repo is required/);
    await assert.rejects(() => main({ repo: "mfittko/dev-loops", project: "1" }), /--item is required/);
  });

  it("parses --item/--repo/--project", () => {
    const args = parseCliArgs(["--repo", "mfittko/dev-loops", "--project", "1", "--item", "10"]);
    assert.equal(args.item, "10");
  });

  it("removes the item and proves absence by a direct item lookup", async () => {
    const calls = [];
    const responses = [
      userPayload(),
      projectsResponse,
      issueSideItemsResponse([itemNode]),
      deleteResponse,
      issueSideItemsResponse([]),
    ];
    const result = await main(
      { repo: "mfittko/dev-loops", project: "1", item: "10" },
      { env: {}, runChild: recordingRunChild(responses, calls) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.item.itemId, "PVTI_1");
    assert.equal(result.item.removed, true);
    assert.equal(result.item.verifiedAbsent, true);
    assert.match(calls[3].query, /deleteProjectV2Item/);
    assert.equal(calls[3].itemId, "PVTI_1");
    assert.equal(calls.length, 5);
  });

  it("fails when the item is still present after the delete", async () => {
    const responses = [
      userPayload(),
      projectsResponse,
      issueSideItemsResponse([itemNode]),
      deleteResponse,
      issueSideItemsResponse([itemNode]),
    ];
    await assert.rejects(
      () => main({ repo: "mfittko/dev-loops", project: "1", item: "10" }, { env: {}, runChild: recordingRunChild(responses, []) }),
      /still present/,
    );
  });

  it("reports ITEM_NOT_FOUND when the item is not on the board", async () => {
    const responses = [userPayload(), projectsResponse, issueSideItemsResponse([])];
    await assert.rejects(
      () => main({ repo: "mfittko/dev-loops", project: "1", item: "10" }, { env: {}, runChild: recordingRunChild(responses, []) }),
      (err) => err.code === "ITEM_NOT_FOUND",
    );
  });
});
