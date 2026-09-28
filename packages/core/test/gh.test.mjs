import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { ghJson, ghGraphql, isRateLimitError, resolveOwner, withGraphqlRateLimitWait } from "../src/github/gh.mjs";
import { GRAPHQL_RATE_LIMIT_MAX_WAIT_MS } from "../src/loop/policy-constants.mjs";

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

    test("allowErrors:true returns the errors payload when gh exits 1 with errors JSON on stdout", async () => {
      const errorsPayload = { data: { node: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] };
      const runChild = stubRunChild({ code: 1, stdout: JSON.stringify(errorsPayload), stderr: "gh: Could not resolve" });
      const payload = await ghGraphql("query{viewer{id}}", {}, {}, runChild, { allowErrors: true });
      assert.deepEqual(payload, errorsPayload);
    });

    test("allowErrors:true still throws GH_API_ERROR when gh exits 1 with non-JSON stdout", async () => {
      const runChild = stubRunChild({ code: 1, stdout: "", stderr: "auth error" });
      await assert.rejects(
        () => ghGraphql("query{viewer{id}}", {}, {}, runChild, { allowErrors: true }),
        (error) => {
          assert.equal(error.message, "gh api graphql failed: auth error");
          assert.equal(error.code, "GH_API_ERROR");
          return true;
        },
      );
    });

    test("allowErrors:false throws GH_API_ERROR when gh exits 1 even with errors JSON on stdout", async () => {
      const runChild = stubRunChild({
        code: 1,
        stdout: JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }),
        stderr: "gh: Could not resolve",
      });
      await assert.rejects(
        () => ghGraphql("query{viewer{id}}", {}, {}, runChild),
        (error) => {
          assert.equal(error.code, "GH_API_ERROR");
          return true;
        },
      );
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

  describe("resolveOwner (#1949 org-owned board fallback)", () => {
    function isUserQuery(args) {
      return args.some((arg) => typeof arg === "string" && arg.includes("user(login"));
    }
    function isOrgQuery(args) {
      return args.some((arg) => typeof arg === "string" && arg.includes("organization(login"));
    }

    test("a user login resolves to { id, kind: 'user' } without an org round-trip", async () => {
      const calls = [];
      const runChild = async (cmd, args, env) => {
        calls.push(args);
        if (isUserQuery(args)) {
          return { code: 0, stdout: '{"data":{"user":{"id":"U_1"}}}', stderr: "" };
        }
        if (isOrgQuery(args)) {
          return { code: 0, stdout: '{"data":{"organization":{"id":"O_1"}}}', stderr: "" };
        }
        throw new Error("unexpected query");
      };
      const owner = await resolveOwner("octocat", {}, runChild);
      assert.deepEqual(owner, { id: "U_1", kind: "user" });
      assert.equal(calls.filter(isOrgQuery).length, 0);
    });

    test("an org login whose user probe throws GH_API_ERROR falls back to the org probe", async () => {
      const runChild = async (cmd, args, env) => {
        if (isUserQuery(args)) {
          return {
            code: 1,
            stdout: "",
            stderr: "Could not resolve to a User with the login of 'sofatutor'.",
          };
        }
        if (isOrgQuery(args)) {
          return { code: 0, stdout: '{"data":{"organization":{"id":"O_1"}}}', stderr: "" };
        }
        throw new Error("unexpected query");
      };
      const owner = await resolveOwner("sofatutor", {}, runChild);
      assert.deepEqual(owner, { id: "O_1", kind: "org" });
    });

    test("an unknown owner (both probes fail) throws NO_USER_ID with the pinned message", async () => {
      const runChild = async (cmd, args, env) => {
        if (isUserQuery(args)) {
          return { code: 1, stdout: "", stderr: "Could not resolve to a User with the login of 'nope'." };
        }
        if (isOrgQuery(args)) {
          return { code: 1, stdout: "", stderr: "Could not resolve to an Organization with the login of 'nope'." };
        }
        throw new Error("unexpected query");
      };
      await assert.rejects(
        () => resolveOwner("nope", {}, runChild),
        (error) => {
          assert.equal(error.message, 'Could not resolve owner ID for "nope"');
          assert.equal(error.code, "NO_USER_ID");
          return true;
        },
      );
    });
  });

  test("resolves from the @dev-loops/core/github/gh export map entry", async () => {
    const mod = await import("@dev-loops/core/github/gh");
    assert.equal(typeof mod.ghJson, "function");
    assert.equal(typeof mod.ghGraphql, "function");
    assert.equal(typeof mod.resolveOwner, "function");
  });
});

describe("withGraphqlRateLimitWait", () => {
  const NOW = 1_000_000_000_000;
  const RATE_LIMIT_ERROR = () => Object.assign(new Error("gh command failed: GraphQL: API rate limit exceeded for user ID 1."), { code: "GH_API_ERROR" });

  function harness({ reset, remaining = 0, readResult, outcomes, maxWaitMs = GRAPHQL_RATE_LIMIT_MAX_WAIT_MS }) {
    const calls = { reads: [], sleeps: [], ops: 0 };
    const runChild = async (command, args) => {
      calls.reads.push([command, ...args]);
      return readResult ?? { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining, reset } } }), stderr: "" };
    };
    const operation = async () => {
      const outcome = outcomes[calls.ops];
      calls.ops += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    const run = () => withGraphqlRateLimitWait(operation, {
      maxWaitMs,
      sleep: async (ms) => { calls.sleeps.push(ms); },
      now: () => NOW,
      env: {},
      runChild,
    });
    return { calls, run };
  }

  async function assertRateLimited(run, resetAt) {
    await assert.rejects(run, (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.resetAt, resetAt);
      return true;
    });
  }

  test("isRateLimitError matches gh rate-limit phrasings only", () => {
    assert.equal(isRateLimitError(RATE_LIMIT_ERROR()), true);
    assert.equal(isRateLimitError(new Error("gh command failed: not found")), false);
  });

  test("rate limit then success: one rate_limit read, one sleep of reset - now, one retry", async () => {
    const reset = NOW / 1000 + 120;
    const { calls, run } = harness({ reset, outcomes: [RATE_LIMIT_ERROR(), "ok-result"] });
    assert.equal(await run(), "ok-result");
    assert.deepEqual(calls.reads, [["gh", "api", "rate_limit"]]);
    assert.deepEqual(calls.sleeps, [120_000]);
    assert.equal(calls.ops, 2);
  });

  test("a second rate-limit error after the retry fails closed with one sleep and resetAt null", async () => {
    const reset = NOW / 1000 + 60;
    const { calls, run } = harness({ reset, outcomes: [RATE_LIMIT_ERROR(), RATE_LIMIT_ERROR(), "never"] });
    await assertRateLimited(run, null);
    assert.equal(calls.reads.length, 1);
    assert.equal(calls.sleeps.length, 1);
    assert.equal(calls.ops, 2);
  });

  test("a non-rate-limit error on the retry rethrows unchanged after one sleep", async () => {
    const notFound = Object.assign(new Error("gh command failed: HTTP 404: Not Found"), { code: "GH_API_ERROR" });
    const { calls, run } = harness({ reset: NOW / 1000 + 60, outcomes: [RATE_LIMIT_ERROR(), notFound] });
    await assert.rejects(run, (thrown) => {
      assert.equal(thrown, notFound);
      assert.equal(thrown.message, "gh command failed: HTTP 404: Not Found");
      assert.equal(thrown.code, "GH_API_ERROR");
      return true;
    });
    assert.equal(calls.reads.length, 1);
    assert.equal(calls.sleeps.length, 1);
    assert.equal(calls.ops, 2);
  });

  test("a failed rate_limit read fails closed with resetAt null and no sleep", async () => {
    const { calls, run } = harness({ readResult: { code: 1, stdout: "", stderr: "boom" }, outcomes: [RATE_LIMIT_ERROR()] });
    await assertRateLimited(run, null);
    assert.equal(calls.sleeps.length, 0);
    assert.equal(calls.ops, 1);
  });

  test("a reset in the past fails closed without sleeping", async () => {
    const reset = NOW / 1000 - 5;
    const { calls, run } = harness({ reset, outcomes: [RATE_LIMIT_ERROR()] });
    await assertRateLimited(run, new Date(reset * 1000).toISOString());
    assert.equal(calls.sleeps.length, 0);
    assert.equal(calls.ops, 1);
  });

  test("a reset more than 24 hours ahead fails closed without sleeping", async () => {
    const reset = NOW / 1000 + 25 * 3600;
    const { calls, run } = harness({ reset, outcomes: [RATE_LIMIT_ERROR()], maxWaitMs: Number.POSITIVE_INFINITY });
    await assertRateLimited(run, new Date(reset * 1000).toISOString());
    assert.equal(calls.sleeps.length, 0);
    assert.equal(calls.ops, 1);
  });

  test("a reset beyond maxWaitMs fails closed without sleeping", async () => {
    const reset = NOW / 1000 + 600;
    const { calls, run } = harness({ reset, outcomes: [RATE_LIMIT_ERROR()], maxWaitMs: () => 60_000 });
    await assertRateLimited(run, new Date(reset * 1000).toISOString());
    assert.equal(calls.sleeps.length, 0);
    assert.equal(calls.ops, 1);
  });

  test("a rate-limit error while GraphQL budget remains fails closed with resetAt null and no sleep", async () => {
    const { calls, run } = harness({ reset: NOW / 1000 + 60, remaining: 4321, outcomes: [RATE_LIMIT_ERROR(), "never"] });
    await assert.rejects(run, (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.resetAt, null);
      assert.doesNotMatch(error.message, /GraphQL rate limit exhausted/);
      assert.match(error.message, /non-GraphQL budget/);
      return true;
    });
    assert.equal(calls.reads.length, 1);
    assert.equal(calls.sleeps.length, 0);
    assert.equal(calls.ops, 1);
  });

  test("an absurd finite reset fails closed with RATE_LIMITED instead of a RangeError", async () => {
    const { calls, run } = harness({ reset: 1e13, outcomes: [RATE_LIMIT_ERROR()], maxWaitMs: Number.POSITIVE_INFINITY });
    await assertRateLimited(run, null);
    assert.equal(calls.sleeps.length, 0);
    assert.equal(calls.ops, 1);
  });

  for (const [label, error] of [
    ["auth error", Object.assign(new Error("gh command failed: HTTP 401: Bad credentials"), { code: "GH_API_ERROR" })],
    ["404", Object.assign(new Error("gh command failed: HTTP 404: Not Found"), { code: "GH_API_ERROR" })],
    ["malformed JSON", new Error("Invalid JSON from gh: <html>")],
  ]) {
    test(`a non-rate-limit ${label} rethrows unchanged with no read and no sleep`, async () => {
      const { calls, run } = harness({ reset: NOW / 1000 + 60, outcomes: [error] });
      await assert.rejects(run, (thrown) => {
        assert.equal(thrown, error);
        assert.equal(thrown.message, error.message);
        assert.equal(thrown.code, error.code);
        return true;
      });
      assert.equal(calls.reads.length, 0);
      assert.equal(calls.sleeps.length, 0);
      assert.equal(calls.ops, 1);
    });
  }
});
