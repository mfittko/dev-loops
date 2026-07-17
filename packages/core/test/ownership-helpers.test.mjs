import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNERSHIP_STATE,
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

test("classifyOwnership: viewer co-assigned with another human -> contested (assigned_to_other), foreignLogins excludes the viewer", () => {
  const result = classifyOwnership([{ login: "octocat" }, { login: "someone-else" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_OTHER, foreignLogins: ["someone-else"] });
});

test("classifyOwnership: viewer co-assigned with multiple others -> all others named, viewer excluded", () => {
  const result = classifyOwnership([{ login: "a" }, { login: "octocat" }, { login: "b" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_OTHER, foreignLogins: ["a", "b"] });
});

test("classifyOwnership: login comparison is case-insensitive (assigned_to_me)", () => {
  assert.equal(classifyOwnership([{ login: "OctoCat" }], "octocat").state, OWNERSHIP_STATE.ASSIGNED_TO_ME);
  assert.equal(classifyOwnership([{ login: "octocat" }], "OctoCat").state, OWNERSHIP_STATE.ASSIGNED_TO_ME);
});

test("classifyOwnership: case-insensitive co-assignment is still contested (not sole)", () => {
  const result = classifyOwnership([{ login: "OctoCat" }, { login: "someone-else" }], "octocat");
  assert.deepEqual(result, { state: OWNERSHIP_STATE.ASSIGNED_TO_OTHER, foreignLogins: ["someone-else"] });
});
