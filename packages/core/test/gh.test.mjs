import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { ghJson, ghGraphql } from "../src/github/gh.mjs";

function stubRunChild(result) {
  return async () => result;
}

describe("gh.mjs (#1695 shared gh CLI helper extraction)", () => {
  describe("ghJson", () => {
    test("parses JSON from a successful run", async () => {
      const runChild = stubRunChild({ code: 0, stdout: '{"ok":true}', stderr: "" });
      const payload = await ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild });
      assert.deepEqual(payload, { ok: true });
    });

    test("throws 'gh command failed:' with detail on non-zero exit", async () => {
      const runChild = stubRunChild({ code: 1, stdout: "", stderr: "not found\n" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        /^Error: gh command failed: not found$/,
      );
    });

    test("falls back to 'exit code N' when stderr is empty", async () => {
      const runChild = stubRunChild({ code: 7, stdout: "", stderr: "" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        /^Error: gh command failed: exit code 7$/,
      );
    });

    test("throws the pinned 'Invalid JSON from gh:' shape for malformed non-empty stdout", async () => {
      const runChild = stubRunChild({ code: 0, stdout: "not json", stderr: "" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        /^Error: Invalid JSON from gh: not json$/,
      );
    });

    test("throws the pinned 'Invalid JSON from gh:' shape with '<empty>' for empty stdout", async () => {
      const runChild = stubRunChild({ code: 0, stdout: "   ", stderr: "" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        /^Error: Invalid JSON from gh: <empty>$/,
      );
    });

    test("accepts the label knob without altering success or failure behavior", async () => {
      const okRunChild = stubRunChild({ code: 0, stdout: '{"a":1}', stderr: "" });
      const payload = await ghJson(["pr", "view"], { env: {}, ghCommand: "gh", runChild: okRunChild, label: "gh pr view" });
      assert.deepEqual(payload, { a: 1 });

      const failRunChild = stubRunChild({ code: 1, stdout: "", stderr: "boom" });
      await assert.rejects(
        () => ghJson(["pr", "view"], { env: {}, ghCommand: "gh", runChild: failRunChild, label: "gh pr view" }),
        /^Error: gh command failed: boom$/,
      );
    });
  });

  describe("ghGraphql", () => {
    test("parses a successful GraphQL response", async () => {
      const runChild = stubRunChild({ code: 0, stdout: '{"data":{"user":{"id":"U_1"}}}', stderr: "" });
      const payload = await ghGraphql("query($login:String!){user(login:$login){id}}", { login: "octocat" }, {}, runChild);
      assert.deepEqual(payload, { data: { user: { id: "U_1" } } });
    });

    test("throws 'gh api graphql failed' with GH_API_ERROR on non-zero exit", async () => {
      const runChild = stubRunChild({ code: 1, stdout: "", stderr: "auth error" });
      await assert.rejects(
        () => ghGraphql("query{viewer{id}}", {}, {}, runChild),
        (error) => {
          assert.equal(error.message, "gh api graphql failed: auth error");
          assert.equal(error.code, "GH_API_ERROR");
          return true;
        },
      );
    });

    test("throws 'Invalid JSON input' on malformed stdout (via parseJsonText)", async () => {
      const runChild = stubRunChild({ code: 0, stdout: "not json", stderr: "" });
      await assert.rejects(
        () => ghGraphql("query{viewer{id}}", {}, {}, runChild),
        /^Error: Invalid JSON input$/,
      );
    });

    test("allowErrors:false throws 'GraphQL errors:' with GRAPHQL_ERROR when payload.errors is present", async () => {
      const runChild = stubRunChild({
        code: 0,
        stdout: JSON.stringify({ errors: [{ message: "field not found" }, { message: "boom" }] }),
        stderr: "",
      });
      await assert.rejects(
        () => ghGraphql("query{viewer{id}}", {}, {}, runChild, { allowErrors: false }),
        (error) => {
          assert.equal(error.message, "GraphQL errors: field not found; boom");
          assert.equal(error.code, "GRAPHQL_ERROR");
          return true;
        },
      );
    });

    test("allowErrors:true returns the payload including errors instead of throwing", async () => {
      const errorsPayload = { errors: [{ message: "field not found" }] };
      const runChild = stubRunChild({ code: 0, stdout: JSON.stringify(errorsPayload), stderr: "" });
      const payload = await ghGraphql("query{viewer{id}}", {}, {}, runChild, { allowErrors: true });
      assert.deepEqual(payload, errorsPayload);
    });

    test("defaults allowErrors to false when the options object is omitted", async () => {
      const runChild = stubRunChild({
        code: 0,
        stdout: JSON.stringify({ errors: [{ message: "boom" }] }),
        stderr: "",
      });
      await assert.rejects(
        () => ghGraphql("query{viewer{id}}", {}, {}, runChild),
        /^Error: GraphQL errors: boom$/,
      );
    });
  });

  test("resolves from the @dev-loops/core/github/gh export map entry", async () => {
    const mod = await import("@dev-loops/core/github/gh");
    assert.equal(typeof mod.ghJson, "function");
    assert.equal(typeof mod.ghGraphql, "function");
  });
});
