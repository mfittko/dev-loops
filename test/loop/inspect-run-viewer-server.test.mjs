import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import test from "node:test";

import { createInspectRunViewerServer } from "../../scripts/loop/inspect-run-viewer.mjs";
import { makeSnapshot, requestOnce } from "./inspect-run-viewer-test-helpers.mjs";
test("createInspectRunViewerServer serves browser html from adapter snapshot without inline full snapshot dump", async () => {
  let loadCount = 0;
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot() {
      loadCount += 1;
      return makeSnapshot({ sourceMode: "partial", trust: "degraded" });
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/`);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.body, /<a href="https:\/\/github\.com\/owner\/repo\/pull\/55">owner\/repo#55<\/a>/);
    assert.match(response.body, /owner\/repo/);
    assert.match(response.body, /degraded/);
    assert.doesNotMatch(response.body, /manual reload only/i);
    assert.doesNotMatch(response.body, /href="\/snapshot\.json\?repo=owner%2Frepo&amp;pr=55"/);
    assert.doesNotMatch(response.body, /"schemaVersion": 1/);
    assert.equal(loadCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer does not eager-load non-selected sidebar snapshots", async () => {
  const seenTargets = [];
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      seenTargets.push(`${target.repo}#${target.pr}`);
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests() {
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Current PR" },
        ...Array.from({ length: 15 }, (_, index) => ({
          target: { repo: `other/repo-${index + 1}`, pr: index + 1 },
          title: `PR ${index + 1}`,
        })),
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/`);

    assert.equal(response.statusCode, 200);
    assert.equal(seenTargets.length, 1);
    assert.equal(seenTargets[0], "owner/repo#55");
    assert.match(response.body, /PR 15/);
    assert.doesNotMatch(response.body, /Snapshot unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer skips malformed assigned inbox entries instead of blanking the list", async () => {
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests() {
      return [
        { target: { repo: "../../bad", pr: 99 }, title: "Broken" },
        { target: { repo: "other/repo", pr: 77 }, title: "Still visible" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/`);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Still visible/);
    assert.doesNotMatch(response.body, /Broken/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer supports selecting another PR from query params", async () => {
  const seenTargets = [];
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      seenTargets.push(target);
      return makeSnapshot({
        target,
        runId: `pr-${target.pr}`,
      });
    },
    async listAssignedPullRequests() {
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Default" },
        { target: { repo: "owner/repo", pr: 77 }, title: "Selected from inbox" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/?pr=77`);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /aria-label="PR #77"/);
    assert.match(response.body, /<h1>Selected from inbox<\/h1>/);
    assert.match(response.body, /Selected from inbox/);
    assert.doesNotMatch(response.body, /href="\/snapshot\.json\?repo=owner%2Frepo&amp;pr=77"/);
    assert.ok(seenTargets.some((target) => target.repo === "owner/repo" && target.pr === 77));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("createInspectRunViewerServer serves the Mermaid browser asset without loading a snapshot", async () => {
  let loadCount = 0;
  const adapter = {
    async loadSnapshot() {
      loadCount += 1;
      return makeSnapshot();
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/assets/mermaid.min.js`);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/javascript; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.body, /mermaid/i);
    assert.equal(loadCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("createInspectRunViewerServer keeps Mermaid asset failures generic and path-free", async () => {
  let loadCount = 0;
  const loggedErrors = [];
  const adapter = {
    async loadSnapshot() {
      loadCount += 1;
      return makeSnapshot();
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    {
      adapter,
      loadMermaidBrowserScriptImpl: async () => {
        throw new Error("ENOENT: open '/Users/tester/project/node_modules/mermaid/dist/mermaid.min.js'");
      },
      logErrorImpl: (error) => {
        loggedErrors.push(error instanceof Error ? error.message : String(error));
      },
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/assets/mermaid.min.js`);

    assert.equal(response.statusCode, 500);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body, "Mermaid browser asset unavailable");
    assert.doesNotMatch(response.body, /Users\/tester/);
    assert.equal(loadCount, 0);
    assert.deepEqual(loggedErrors, ["ENOENT: open '/Users/tester/project/node_modules/mermaid/dist/mermaid.min.js'"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer serves authoritative snapshot JSON on /snapshot.json", async () => {
  let loadCount = 0;
  const snapshot = makeSnapshot({ sourceMode: "partial", trust: "degraded" });
  const adapter = {
    async loadSnapshot() {
      loadCount += 1;
      return snapshot;
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json`);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(response.body), snapshot);
    assert.equal(loadCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer preserves cached authoritative inbox signals after another PR is selected", async () => {
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      if (target.pr === 55) {
        return makeSnapshot({
          target,
          layers: {
            copilot: {
              currentState: "ready_to_rerequest_review",
              allowedTransitions: [],
              sameHeadCleanConverged: true,
              loopDisposition: "clean_converged",
              terminal: false,
            },
            reviewer: {
              currentState: "waiting_for_review_request",
              scope: { mode: "all_reviewers", reviewerLogin: null },
              allowedTransitions: [],
            },
            steering: { status: "unavailable", reason: "no_steering_locator" },
          },
        });
      }
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests() {
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Ready PR", signal: "waiting", updatedAt: "2026-05-21T00:00:00Z" },
        { target: { repo: "owner/repo", pr: 77 }, title: "Selected later", signal: "waiting", updatedAt: "2026-05-22T00:00:00Z" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const firstResponse = await requestOnce(`http://127.0.0.1:${address.port}/?repo=owner/repo&pr=55`);
    assert.equal(firstResponse.statusCode, 200);
    assert.match(firstResponse.body, /assigned-pr-row-gate/);

    const secondResponse = await requestOnce(`http://127.0.0.1:${address.port}/?repo=owner/repo&pr=77`);
    assert.equal(secondResponse.statusCode, 200);
    assert.match(secondResponse.body, /Ready PR/);
    assert.match(secondResponse.body, /assigned-pr-row-gate/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer honors an explicit inbox page even when a selected PR exists", async () => {
  const seenTargets = [];
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      seenTargets.push(target);
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests() {
      return Array.from({ length: 30 }, (_, index) => ({
        target: { repo: "owner/repo", pr: index + 1 },
        title: `PR ${index + 1}`,
        updatedAt: `2026-05-${String((index % 9) + 10).padStart(2, "0")}T00:00:00Z`,
      }));
    },
  };

  const server = createInspectRunViewerServer(
    { host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/?repo=owner/repo&pr=1&page=2`);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /aria-label="PR #1"/);
    assert.match(response.body, /<h1>PR 1<\/h1>/);
    assert.match(response.body, /class="assigned-pr-page-status">2\/2</);
    assert.match(response.body, /PR 30/);
    assert.doesNotMatch(response.body, /aria-current="page"/);
    assert.ok(seenTargets.some((target) => target.repo === "owner/repo" && target.pr === 1));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer keeps explicit query targets even when they are not in the current inbox page", async () => {
  const seenTargets = [];
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      seenTargets.push(target);
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests() {
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Primary PR", updatedAt: "2026-05-21T00:00:00Z" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const htmlResponse = await requestOnce(`http://127.0.0.1:${address.port}/?repo=owner/repo&pr=77`);
    assert.equal(htmlResponse.statusCode, 200);
    assert.match(htmlResponse.body, /aria-label="PR #77"/);
    assert.match(htmlResponse.body, /<h1>PR #77<\/h1>/);
    assert.doesNotMatch(htmlResponse.body, /href="\/snapshot\.json\?repo=owner%2Frepo&amp;pr=77"/);
    assert.doesNotMatch(htmlResponse.body, /aria-current="page"/);
    assert.doesNotMatch(htmlResponse.body, /#77<\/span>/);

    const jsonResponse = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json?repo=owner/repo&pr=77`);
    assert.equal(jsonResponse.statusCode, 200);
    const payload = JSON.parse(jsonResponse.body);
    assert.equal(payload.target.repo, "owner/repo");
    assert.equal(payload.target.pr, 77);
    assert.ok(seenTargets.some((target) => target.repo === "owner/repo" && target.pr === 77));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer resolves /snapshot.json target from query params", async () => {
  const seenTargets = [];
  const adapter = {
    async loadSnapshot(target) {
      seenTargets.push(target);
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json?pr=77`);

    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.target.repo, "owner/repo");
    assert.equal(payload.target.pr, 77);
    assert.ok(seenTargets.some((target) => target.repo === "owner/repo" && target.pr === 77));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer treats missing JSON snapshots as machine-readable failures", async () => {
  let loadCount = 0;
  const adapter = {
    async loadSnapshot() {
      loadCount += 1;
      return undefined;
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json`);

    assert.equal(response.statusCode, 500);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      target: { repo: "owner/repo", pr: 55 },
      error: { message: "inspection snapshot unavailable" },
    });
    assert.equal(loadCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer keeps JSON failures machine-readable and HTML failures browser-friendly", async () => {
  let loadCount = 0;
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot() {
      loadCount += 1;
      throw new Error("inspection snapshot unavailable");
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();

    const htmlResponse = await requestOnce(`http://127.0.0.1:${address.port}/`);
    assert.equal(htmlResponse.statusCode, 200);
    assert.equal(htmlResponse.headers["content-type"], "text/html; charset=utf-8");
    assert.match(htmlResponse.body, /Snapshot unavailable/);
    assert.match(htmlResponse.body, /inspection snapshot unavailable/);

    const jsonResponse = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json`);
    assert.equal(jsonResponse.statusCode, 500);
    assert.equal(jsonResponse.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(jsonResponse.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(jsonResponse.body), {
      ok: false,
      target: { repo: "owner/repo", pr: 55 },
      error: { message: "inspection snapshot unavailable" },
    });

    assert.equal(loadCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer keeps favicon, unsupported paths, and unsupported methods load-free", async () => {
  let loadCount = 0;
  const adapter = {
    async loadSnapshot() {
      loadCount += 1;
      return makeSnapshot();
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();

    const faviconResponse = await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/favicon.ico`, (response) => {
        response.resume();
        response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers }));
      }).on("error", reject);
    });
    assert.equal(faviconResponse.statusCode, 204);
    assert.equal(loadCount, 0);

    const missingResponse = await requestOnce(`http://127.0.0.1:${address.port}/nope`);
    assert.equal(missingResponse.statusCode, 404);
    assert.equal(missingResponse.headers["cache-control"], "no-store");
    assert.equal(loadCount, 0);

    const postHtmlResponse = await requestOnce(`http://127.0.0.1:${address.port}/`, { method: "POST" });
    assert.equal(postHtmlResponse.statusCode, 405);
    assert.equal(postHtmlResponse.headers.allow, "GET");
    assert.equal(postHtmlResponse.headers["cache-control"], "no-store");
    assert.equal(loadCount, 0);

    const postJsonResponse = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json`, { method: "POST" });
    assert.equal(postJsonResponse.statusCode, 405);
    assert.equal(postJsonResponse.headers.allow, "GET");
    assert.equal(postJsonResponse.headers["cache-control"], "no-store");

    const postMermaidResponse = await requestOnce(`http://127.0.0.1:${address.port}/assets/mermaid.min.js`, { method: "POST" });
    assert.equal(postMermaidResponse.statusCode, 405);
    assert.equal(postMermaidResponse.headers.allow, "GET");
    assert.equal(postMermaidResponse.headers["cache-control"], "no-store");

    const postMissingPathResponse = await requestOnce(`http://127.0.0.1:${address.port}/nope`, { method: "POST" });
    assert.equal(postMissingPathResponse.statusCode, 404);
    assert.equal(postMissingPathResponse.headers["cache-control"], "no-store");
    assert.equal(loadCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("createInspectRunViewerServer treats malformed repo slug query params as bad requests", async () => {
  let loadCount = 0;
  const adapter = {
    async loadSnapshot() {
      loadCount += 1;
      throw new Error("should not load snapshot for malformed targets");
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const htmlResponse = await requestOnce(`http://127.0.0.1:${address.port}/?repo=../../bad&pr=77`);
    assert.equal(htmlResponse.statusCode, 400);
    assert.equal(htmlResponse.body, "Bad Request");

    const jsonResponse = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json?repo=../../bad&pr=77`);
    assert.equal(jsonResponse.statusCode, 400);
    assert.equal(jsonResponse.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(jsonResponse.body), {
      ok: false,
      target: { repo: "owner/repo", pr: 55 },
      error: { message: "target.repo must match <owner/name>" },
    });
    assert.equal(loadCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer reuses the all-repos inbox query for the default unscoped view", async () => {
  const listCalls = [];
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests(options = {}) {
      listCalls.push({
        repo: options.repo,
        updatedWithinDays: options.updatedWithinDays ?? null,
        state: options.state ?? null,
        mode: options.mode ?? null,
        limit: options.limit ?? null,
      });
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Inbox PR", updatedAt: "2026-05-21T00:00:00Z" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/?repo=owner/repo&pr=55`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(listCalls, [
      {
        repo: undefined,
        updatedWithinDays: 7,
        state: "open",
        mode: "assignee",
        limit: 100,
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer normalizes unsupported assigned inbox signals before rendering", async () => {
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async listAssignedPullRequests() {
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Primary PR", updatedAt: "2026-05-21T00:00:00Z" },
        { target: { repo: "owner/repo", pr: 55 }, title: null, updatedAt: null, signal: "mystery-state" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/`);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /assigned-pr-row-unknown/);
    assert.match(response.body, /data-inbox-signal="unknown"/);
    assert.doesNotMatch(response.body, /assigned-pr-row-mystery-state/);
    assert.doesNotMatch(response.body, /data-inbox-signal="mystery-state"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer constrains repo-scoped inbox discovery to the fixed repo", async () => {
  const listCalls = [];
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot(target) {
      return makeSnapshot({ target, runId: `pr-${target.pr}` });
    },
    async listAssignedPullRequests(options = {}) {
      listCalls.push({
        repo: options.repo ?? null,
        updatedWithinDays: options.updatedWithinDays ?? null,
        state: options.state ?? null,
        mode: options.mode ?? null,
        limit: options.limit ?? null,
      });
      return [
        { target: { repo: "owner/repo", pr: 55 }, title: "Scoped PR", updatedAt: "2026-05-21T00:00:00Z" },
      ];
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(listCalls, [
      {
        repo: "owner/repo",
        updatedWithinDays: 7,
        state: "open",
        mode: "assignee",
        limit: 100,
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer returns JSON for malformed /snapshot.json repo/pr query params", async () => {
  const adapter = {
    async loadSnapshot() {
      throw new Error("should not load snapshot for malformed targets");
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/snapshot.json?repo=other/repo&pr=77`);

    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      target: { repo: "owner/repo", pr: 55 },
      error: { message: "repo query param must match the repo-scoped viewer" },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer treats malformed repo/pr query params as bad requests", async () => {
  const adapter = {
    async loadSnapshot() {
      throw new Error("should not load snapshot for malformed targets");
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/?repo=other/repo&pr=77`);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body, "Bad Request");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createInspectRunViewerServer guards malformed request URLs and undefined snapshots", async () => {
  let loadCount = 0;
  const adapter = {
    loadHandoffEnvelope: async () => null,
    async loadSnapshot() {
      loadCount += 1;
      return undefined;
    },
  };

  const server = createInspectRunViewerServer(
    { repo: "owner/repo", pr: "55", host: "127.0.0.1", port: 0 },
    { adapter },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const response = await requestOnce(`http://127.0.0.1:${address.port}/`);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Snapshot unavailable/);
    assert.doesNotMatch(response.body, /href="\/snapshot\.json\?repo=owner%2Frepo&amp;pr=55"/);
    assert.equal(loadCount, 1);

    const malformedResponse = await new Promise((resolve) => {
      const fakeRequest = Object.defineProperty({}, "url", {
        enumerable: true,
        get() {
          throw new Error("URI malformed");
        },
      });
      const result = {
        statusCode: undefined,
        headers: {},
        body: "",
      };
      const fakeResponse = {
        statusCode: undefined,
        setHeader(name, value) {
          result.headers[name] = value;
        },
        end(body = "") {
          result.statusCode = this.statusCode;
          result.body = String(body);
          resolve(result);
        },
      };

      server.emit("request", fakeRequest, fakeResponse);
    });

    assert.equal(malformedResponse.statusCode, 400);
    assert.equal(malformedResponse.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(malformedResponse.headers["cache-control"], "no-store");
    assert.equal(malformedResponse.body, "Bad Request");
    assert.equal(loadCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
