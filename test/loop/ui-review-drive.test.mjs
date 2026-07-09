import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_DRIVE_CAPS,
  resolveCaps,
  selectFlows,
  classifyFailures,
  driveUiReview,
} from "@dev-loops/core/loop/ui-review-drive";
import { resolveUiReviewDriveRecipe, DEFAULT_SERVER_LOG_EXCEPTION_PATTERN } from "@dev-loops/core/config";
import {
  parseUiReviewDriveCliArgs,
  attachPageListeners,
  openServerLogTail,
} from "../../scripts/loop/ui-review-drive.mjs";

const tempFiles = [];
after(() => {
  for (const f of tempFiles) rmSync(f, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(path.join(tmpdir(), "ui-drive-"));
  tempFiles.push(d);
  return d;
}

// A fake page exposing Playwright's emitter interface, so attachPageListeners is
// exercised for real without launching a browser.
function fakePage() {
  const handlers = {};
  return {
    on: (ev, cb) => ((handlers[ev] ??= []).push(cb), undefined),
    emit: (ev, arg) => (handlers[ev] ?? []).forEach((cb) => cb(arg)),
  };
}

// ── CLI parsing ────────────────────────────────────────────────────────────

test("parseUiReviewDriveCliArgs: requires --repo-root, --app-url, --output-dir", () => {
  assert.throws(() => parseUiReviewDriveCliArgs(["--app-url", "http://x", "--output-dir", "/o"]), /repo-root/);
  assert.throws(() => parseUiReviewDriveCliArgs(["--repo-root", "/r", "--output-dir", "/o"]), /app-url/);
  assert.throws(() => parseUiReviewDriveCliArgs(["--repo-root", "/r", "--app-url", "http://x"]), /output-dir/);
});

test("parseUiReviewDriveCliArgs: collects repeatable --changed-path", () => {
  const o = parseUiReviewDriveCliArgs([
    "--repo-root", "/r", "--app-url", "http://x", "--output-dir", "/o",
    "--changed-path", "app/a.rb", "--changed-path", "app/b.rb",
  ]);
  assert.deepEqual(o.changedPaths, ["app/a.rb", "app/b.rb"]);
});

// ── The AC test: a swallowed non-2xx is captured by the listener AND the log ──

test("swallowed non-2xx: the response listener AND the server-log tail both capture a hidden 500", async () => {
  // Fixture: a page that fires a 500 response the UI swallows (no visible error),
  // and a server that logs the 500 during the drive. Uses the real harness
  // listener + real log tail + real classifier — no browser required.
  const page = fakePage();
  const { getCapturedEvents } = attachPageListeners(page);

  const logPath = path.join(tempDir(), "server.log");
  writeFileSync(logPath, "GET / 200 OK\n"); // pre-existing history the tail must NOT re-report
  const tail = openServerLogTail(logPath); // pins the offset at drive start

  // ── drive happens: the app 500s on save but renders a success toast ──
  page.emit("response", { status: () => 500, url: () => "http://app.test/api/save" });
  appendFileSync(logPath, "ERROR 500 Internal Server Error: NoMethodError in SaveController#create\n");

  const events = getCapturedEvents();
  const serverLogTail = await tail.read();

  // The listener saw the wire status even though the UI hid it.
  assert.deepEqual(events.responses, [{ url: "http://app.test/api/save", status: 500 }]);
  // The tail returned only the delta since drive start (not the 200 history line).
  assert.match(serverLogTail, /NoMethodError/);
  assert.doesNotMatch(serverLogTail, /GET \/ 200/);

  const failures = classifyFailures({
    responses: events.responses,
    requestFailures: events.requestFailures,
    pageErrors: events.pageErrors,
    serverLogTail,
    serverLogExceptionPattern: DEFAULT_SERVER_LOG_EXCEPTION_PATTERN,
  });
  const kinds = failures.map((f) => f.kind);
  assert.ok(kinds.includes("non-2xx-response"), "response listener must record the swallowed 500");
  assert.ok(kinds.includes("server-log-exception"), "server-log tail must record the swallowed 500");
});

test("attachPageListeners: captures requestfailed and pageerror", () => {
  const page = fakePage();
  const { getCapturedEvents } = attachPageListeners(page);
  page.emit("response", { status: () => 204, url: () => "http://x/ok" }); // 2xx ignored
  page.emit("requestfailed", { url: () => "http://x/img", failure: () => ({ errorText: "net::ERR" }) });
  page.emit("pageerror", { message: "TypeError: boom" });
  const e = getCapturedEvents();
  assert.equal(e.responses.length, 0, "2xx responses are not retained");
  assert.deepEqual(e.requestFailures, [{ url: "http://x/img", failure: "net::ERR" }]);
  assert.deepEqual(e.pageErrors, [{ message: "TypeError: boom" }]);
});

test("openServerLogTail: absent path is a no-op; missing file reads once created", async () => {
  assert.equal(await openServerLogTail(null).read(), "");
  const p = path.join(tempDir(), "late.log");
  const tail = openServerLogTail(p); // file does not exist yet
  writeFileSync(p, "boot line\n");
  assert.match(await tail.read(), /boot line/);
});

// ── Changed-flow discovery heuristic ─────────────────────────────────────────

test("selectFlows: drives only flows whose pathPatterns match a changed path", () => {
  const flows = [
    { name: "decks", pathPatterns: ["app/decks"], steps: [] },
    { name: "users", pathPatterns: ["app/users"], steps: [] },
  ];
  const { selected, skipped } = selectFlows({ flows, changedPaths: ["app/decks/edit.rb"] });
  assert.deepEqual(selected.map((f) => f.name), ["decks"]);
  assert.equal(skipped[0].name, "users");
});

test("selectFlows: a flow with no pathPatterns is always in scope", () => {
  const flows = [{ name: "always", steps: [] }];
  const { selected } = selectFlows({ flows, changedPaths: ["anything.rb"] });
  assert.deepEqual(selected.map((f) => f.name), ["always"]);
});

test("selectFlows: an unknown diff (no changed paths) drives every allowlisted flow", () => {
  const flows = [{ name: "a", pathPatterns: ["x"], steps: [] }, { name: "b", pathPatterns: ["y"], steps: [] }];
  const { selected } = selectFlows({ flows, changedPaths: [] });
  assert.deepEqual(selected.map((f) => f.name), ["a", "b"]);
});

test("selectFlows: caps the selection at maxFlows and logs the overflow reason", () => {
  const flows = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, steps: [] }));
  const { selected, skipped } = selectFlows({ flows, changedPaths: [], caps: { ...DEFAULT_DRIVE_CAPS, maxFlows: 2 } });
  assert.equal(selected.length, 2);
  assert.ok(skipped.some((s) => /maxFlows cap/.test(s.reason)));
});

test("resolveCaps: clamps to ceilings and pins retries to 0", () => {
  const caps = resolveCaps({ maxScreenshots: 9999, maxFlows: 1, retries: 5 });
  assert.equal(caps.maxScreenshots, DEFAULT_DRIVE_CAPS.maxScreenshots); // clamped down
  assert.equal(caps.maxFlows, 1); // project may tighten
  assert.equal(caps.retries, 0); // no-retry is fixed policy
});

// ── driveUiReview orchestration ──────────────────────────────────────────────

const baseSeams = (over = {}) => ({
  authenticate: async () => ({ ok: true, detail: "ok" }),
  dismissInterstitials: async () => ({ dismissed: [] }),
  runStep: async ({ step }) => ({ ok: true, screenshotPath: `/o/${step.name}.png`, statePath: `/o/${step.name}.json` }),
  getCapturedEvents: () => ({ responses: [], requestFailures: [], pageErrors: [] }),
  readServerLogTail: async () => "",
  ...over,
});

test("driveUiReview: fails closed with a stated reason when auth fails (drives nothing)", async () => {
  const logs = [];
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps: [{ name: "s", action: "goto" }] }] },
    baseSeams({ authenticate: async () => ({ ok: false, detail: "bad password" }), log: (m) => logs.push(m) }),
  );
  assert.equal(r.stopped, true);
  assert.match(r.stopReason, /cannot authenticate: bad password/);
  assert.equal(r.steps.length, 0, "nothing is driven without a session");
  assert.equal(r.failures[0].kind, "auth-failed");
});

test("driveUiReview: no-retry is logged and a thrown step becomes a step-failure (not re-run)", async () => {
  const logs = [];
  let calls = 0;
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps: [{ name: "boom", action: "click" }] }] },
    baseSeams({
      runStep: async () => { calls += 1; throw new Error("selector missing"); },
      log: (m) => logs.push(m),
    }),
  );
  assert.equal(calls, 1, "the failing step is not retried");
  assert.ok(logs.some((m) => /no-retry/.test(m)), "the no-retry cap is logged");
  assert.ok(r.failures.some((f) => f.kind === "step-failure"));
});

test("driveUiReview: enforces maxScreenshots and logs screens skipped", async () => {
  const steps = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, action: "goto" }));
  const logs = [];
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps }], caps: { maxScreenshots: 2 } },
    baseSeams({ log: (m) => logs.push(m) }),
  );
  assert.equal(r.steps.length, 2, "only up to the cap are captured");
  assert.equal(r.screensSkipped, 3);
  assert.ok(logs.some((m) => /screens skipped: 3/.test(m)));
});

test("driveUiReview: collates a swallowed non-2xx from the injected listener + log tail", async () => {
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps: [{ name: "save", action: "click" }] }], serverLogExceptionPattern: DEFAULT_SERVER_LOG_EXCEPTION_PATTERN },
    baseSeams({
      getCapturedEvents: () => ({ responses: [{ url: "http://app/save", status: 500 }], requestFailures: [], pageErrors: [] }),
      readServerLogTail: async () => "ERROR 500 Internal Server Error\n",
    }),
  );
  assert.equal(r.ok, false);
  const kinds = r.failures.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["non-2xx-response", "server-log-exception"]);
});

// ── Config resolver ──────────────────────────────────────────────────────────

test("resolveUiReviewDriveRecipe: null when no login recipe is declared", () => {
  assert.equal(resolveUiReviewDriveRecipe({ uiReview: { run: { command: "x", readyUrl: "http://x" } } }), null);
  assert.equal(resolveUiReviewDriveRecipe({}), null);
});

test("resolveUiReviewDriveRecipe: resolves login + defaults the log-exception pattern", () => {
  const r = resolveUiReviewDriveRecipe({
    uiReview: {
      login: { loginUrl: "http://app/login", submitSelector: "button[type=submit]", successSelector: "#dashboard" },
      serverLogPath: "log/dev.log",
    },
  });
  assert.equal(r.login.loginUrl, "http://app/login");
  assert.equal(r.serverLogPath, "log/dev.log");
  assert.equal(r.serverLogExceptionPattern, DEFAULT_SERVER_LOG_EXCEPTION_PATTERN);
});

test("resolveUiReviewDriveRecipe: honours an explicit log-exception pattern override", () => {
  const r = resolveUiReviewDriveRecipe({
    uiReview: {
      login: { loginUrl: "http://app/login", submitSelector: "b", successSelector: "#ok" },
      serverLogExceptionPattern: "MY_MARKER",
    },
  });
  assert.equal(r.serverLogExceptionPattern, "MY_MARKER");
});
