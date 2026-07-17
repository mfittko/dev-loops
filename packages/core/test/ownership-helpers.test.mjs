import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNERSHIP_STATE,
  OwnershipGateFailure,
  classifyOwnership,
  ownershipNeedsViewerLogin,
} from "../src/github/ownership-helpers.mjs";

test("classifyOwnership: no assignees -> unassigned", () => {
  assert.deepEqual(classifyOwnership([], "viewer"), {
    state: OWNERSHIP_STATE.UNASSIGNED,
    foreignLogins: [],
  });
  assert.deepEqual(classifyOwnership(undefined, "viewer"), {
    state: OWNERSHIP_STATE.UNASSIGNED,
    foreignLogins: [],
  });
});

test("classifyOwnership: copilot assignee wins regardless of viewer login", () => {
  const result = classifyOwnership([{ login: "copilot-swe-agent" }], null);
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_COPILOT, foreignLogins: [] });
});

test("classifyOwnership: viewer is an assignee -> assigned_to_me", () => {
  const result = classifyOwnership([{ login: "octocat" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_ME, foreignLogins: [] });
});

test("classifyOwnership: a foreign human assignee -> assigned_to_other, names the login", () => {
  const result = classifyOwnership([{ login: "someone-else" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_OTHER, foreignLogins: ["someone-else"] });
});

test("classifyOwnership: multiple foreign assignees are all named", () => {
  const result = classifyOwnership([{ login: "a" }, { login: "b" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_OTHER, foreignLogins: ["a", "b"] });
});

test("classifyOwnership: null/malformed logins are ignored", () => {
  const result = classifyOwnership([{ login: null }, {}, { login: "" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.UNASSIGNED, foreignLogins: [] });
});

test("ownershipNeedsViewerLogin: false for empty or copilot-only assignees", () => {
  assert.equal(ownershipNeedsViewerLogin([]), false);
  assert.equal(ownershipNeedsViewerLogin([{ login: "copilot-swe-agent" }]), false);
});

test("ownershipNeedsViewerLogin: true when a non-copilot assignee is present", () => {
  assert.equal(ownershipNeedsViewerLogin([{ login: "octocat" }]), true);
});

test("OwnershipGateFailure is a distinguishable Error subclass", () => {
  const err = new OwnershipGateFailure("foreign owner");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OwnershipGateFailure);
  assert.equal(err.message, "foreign owner");
});
