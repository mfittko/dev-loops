import assert from "node:assert/strict";
import test from "node:test";
import {
  isGhBinaryMissing,
  restFetchPrView,
  restGetJson,
  restGetPaginatedJson,
  restGraphqlJson,
} from "../../scripts/github/_gh-rest-fallback.mjs";

function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

test("isGhBinaryMissing is true only for an ENOENT-coded error", () => {
  assert.equal(isGhBinaryMissing(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })), true);
  assert.equal(isGhBinaryMissing(new Error("gh command failed: exit code 1")), false);
  assert.equal(isGhBinaryMissing(null), false);
  assert.equal(isGhBinaryMissing(undefined), false);
});

test("restGetJson requires a GH_TOKEN/GITHUB_TOKEN and calls the expected URL", async () => {
  await assert.rejects(
    () => restGetJson("repos/o/r/pulls/1", {}),
    /gh binary not found and no GH_TOKEN\/GITHUB_TOKEN set/,
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ id: 1 });
  };
  const result = await restGetJson("repos/o/r/pulls/1", { GH_TOKEN: "tok" }, { fetchImpl });
  assert.deepEqual(result, { id: 1 });
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/pulls/1");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok");
});

test("restGetJson throws on a non-ok response", async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 404 });
  await assert.rejects(
    () => restGetJson("repos/o/r/pulls/1", { GITHUB_TOKEN: "tok" }, { fetchImpl }),
    /failed: 404/,
  );
});

test("restGetPaginatedJson follows Link: rel=\"next\" and flattens every page", async () => {
  let call = 0;
  const fetchImpl = async (url) => {
    call += 1;
    if (call === 1) {
      assert.equal(url, "https://api.github.com/repos/o/r/issues/1/comments?per_page=100");
      return jsonResponse([{ id: 1 }, { id: 2 }], { headers: { link: '<https://api.github.com/repos/o/r/issues/1/comments?page=2>; rel="next"' } });
    }
    assert.equal(url, "https://api.github.com/repos/o/r/issues/1/comments?page=2");
    return jsonResponse([{ id: 3 }]);
  };
  const result = await restGetPaginatedJson("repos/o/r/issues/1/comments?per_page=100", { GH_TOKEN: "tok" }, { fetchImpl });
  assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(call, 2);
});

test("restGraphqlJson posts the query/variables and returns the raw GraphQL response", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  };
  const result = await restGraphqlJson("query { x }", { owner: "o", name: "r", pr: 1 }, { GH_TOKEN: "tok" }, { fetchImpl });
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: "query { x }", variables: { owner: "o", name: "r", pr: 1 } });
  assert.deepEqual(result.data.repository.pullRequest.reviewThreads.nodes, []);
});

test("restGraphqlJson fails closed on a 200 response carrying GraphQL errors (no false green)", async () => {
  // GraphQL returns HTTP 200 even for query-level failures; returning it as-is would
  // let a gh-less verifier read "0 unresolved threads" where the gh path fails closed.
  const fetchImpl = async () => jsonResponse({ data: null, errors: [{ message: "Bad credentials" }] });
  await assert.rejects(
    () => restGraphqlJson("query { x }", {}, { GH_TOKEN: "tok" }, { fetchImpl }),
    /returned errors: Bad credentials/,
  );
});

test("restGraphqlJson fails closed on a 200 response with no data", async () => {
  const fetchImpl = async () => jsonResponse({ data: null });
  await assert.rejects(
    () => restGraphqlJson("query { x }", {}, { GH_TOKEN: "tok" }, { fetchImpl }),
    /returned no data/,
  );
});

test("restFetchPrView maps head/base sha and labels (string or object shape)", async () => {
  const fetchImpl = async () => jsonResponse({
    head: { sha: "abc1234" },
    base: { sha: "def5678" },
    labels: [{ name: "gate:full" }],
  });
  const result = await restFetchPrView("o/r", 17, { GH_TOKEN: "tok" }, { fetchImpl });
  assert.deepEqual(result, { headRefOid: "abc1234", baseRefOid: "def5678", labels: ["gate:full"] });
});

test("restFetchPrView tolerates a missing head/base/labels shape", async () => {
  const fetchImpl = async () => jsonResponse({});
  const result = await restFetchPrView("o/r", 17, { GH_TOKEN: "tok" }, { fetchImpl });
  assert.deepEqual(result, { headRefOid: null, baseRefOid: null, labels: [] });
});
