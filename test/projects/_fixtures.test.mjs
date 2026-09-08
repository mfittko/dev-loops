import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { statusField, existingProject, fieldsResponse, itemsByContentResponse } from "./_fixtures.mjs";

// The shared Projects fixtures are tested once here, not once per suite. Only
// the two id-parameterized builders carry a default-vs-override branch worth a
// check; the plain payload builders are asserted structurally through the
// suites that consume them.
describe("projects shared fixtures", () => {
  it("statusField/existingProject default the node id and honor an explicit override", () => {
    assert.equal(statusField().id, "PVTSSF_status");
    assert.equal(statusField("PVTSSF_x").id, "PVTSSF_x");
    // The option set is fixed regardless of id.
    assert.deepEqual(
      statusField("PVTSSF_x").options.map((o) => o.name),
      ["Backlog", "Next Up", "In Progress", "Done"],
    );

    assert.equal(existingProject().id, "PVT_proj1");
    assert.equal(existingProject("PVT_y").id, "PVT_y");
    assert.equal(existingProject("PVT_y").number, 1);
  });

  it("fieldsResponse/itemsByContentResponse wrap nodes in the single-page envelope", () => {
    assert.deepEqual(fieldsResponse([{ id: "f1" }]).data.node.fields, {
      nodes: [{ id: "f1" }],
      pageInfo: { hasNextPage: false },
    });
    assert.deepEqual(itemsByContentResponse([{ id: "i1" }]).data.node.items, {
      nodes: [{ id: "i1" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });
});
