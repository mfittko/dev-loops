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

    test("non-zero exit without a label throws 'gh command failed:' + GH_API_ERROR", async () => {
      const runChild = stubRunChild({ code: 1, stdout: "", stderr: "not found\n" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        (error) => {
          assert.equal(error.message, "gh command failed: not found");
          assert.equal(error.code, "GH_API_ERROR");
          return true;
        },
      );
    });

    test("non-zero exit with a label throws '<label> failed:' + GH_API_ERROR", async () => {
      const runChild = stubRunChild({ code: 1, stdout: "", stderr: "not found\n" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild, label: "fetch CI logs" }),
        (error) => {
          assert.equal(error.message, "fetch CI logs failed: not found");
          assert.equal(error.code, "GH_API_ERROR");
          return true;
        },
      );
    });

    test("falls back to 'exit code N' when stderr is empty", async () => {
      const runChild = stubRunChild({ code: 7, stdout: "", stderr: "" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        (error) => {
          assert.equal(error.message, "gh command failed: exit code 7");
          assert.equal(error.code, "GH_API_ERROR");
          return true;
        },
      );
    });

    test("throws the pinned 'Invalid JSON from gh:' shape for malformed non-empty stdout", async () => {
      const runChild = stubRunChild({ code: 0, stdout: "not json", stderr: "" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        /Invalid JSON from gh: not json/,
      );
    });

    test("throws the pinned 'Invalid JSON from gh:' shape with '<empty>' for empty stdout", async () => {
      const runChild = stubRunChild({ code: 0, stdout: "   ", stderr: "" });
      await assert.rejects(
        () => ghJson(["api", "user"], { env: {}, ghCommand: "gh", runChild }),
        /Invalid JSON from gh: <empty>/,
      );
    });

  });

  describe("ghGraphql", () => {
    test("parses a successful GraphQL response", async () => {
      const runChild = stubRunChild({ code: 0, stdout: '{"data":{"user":{"id":"U_1"}}}', stderr: "" });
      const payload = await ghGraphql("query($login:String!){user(login:$login){id}}", { login: "octocat" }, {}, runChild);
      assert.deepEqual(payload, { data: { user: { id: "U_1" } } });
    });

    test("builds the pinned `gh api graphql` argv with a --field per variable", async () => {
      const calls = [];
      const captureRunChild = async (cmd, args, env) => {
        calls.push({ cmd, args, env });
        return { code: 0, stdout: '{"data":{}}', stderr: "" };
      };
      await ghGraphql("query($a:String!,$b:Int!){x}", { a: "one", b: "2" }, { GH_TOKEN: "t" }, captureRunChild);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, "gh");
      assert.deepEqual(calls[0].args, [
        "api", "graphql",
        "--field", "query=query($a:String!,$b:Int!){x}",
        "--field", "a=one",
        "--field", "b=2",
      ]);
      assert.deepEqual(calls[0].env, { GH_TOKEN: "t" });
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
        /Invalid JSON input/,
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
        /GraphQL errors: boom/,
      );
    });
  });

  test("resolves from the @dev-loops/core/github/gh export map entry", async () => {
    const mod = await import("@dev-loops/core/github/gh");
    assert.equal(typeof mod.ghJson, "function");
    assert.equal(typeof mod.ghGraphql, "function");
  });
});
