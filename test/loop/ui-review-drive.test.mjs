import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_DRIVE_CAPS,
  resolveCaps,
  selectFlows,
  classifyFailures,
  driveUiReview,
  isErrorResponseStatus,
  PAGE_ERROR_STACK_MAX_CHARS,
} from "@dev-loops/core/loop/ui-review-drive";
import { resolveUiReviewDriveRecipe, DEFAULT_SERVER_LOG_EXCEPTION_PATTERN } from "@dev-loops/core/config";
import {
  parseUiReviewDriveCliArgs,
  attachPageListeners,
  makeRunStep,
  openServerLogTail,
  toPerStateConsolePayload,
} from "../../scripts/loop/ui-review-drive.mjs";

// A fake page for the real makeRunStep wiring: the emitter interface
// (attachPageListeners) + the action/capture methods captureNamedUiState calls.
// `click` fires a swallowed 500 DURING the step, so it lands in the slice
// attributed to that state — exercising the production drain/attribute path.
function fakeDrivePage() {
  const handlers = {};
  const page = {
    on: (ev, cb) => ((handlers[ev] ??= []).push(cb), undefined),
    emit: (ev, arg) => (handlers[ev] ?? []).forEach((cb) => cb(arg)),
    goto: async () => {},
    click: async () => page.emit("response", { status: () => 500, url: () => "http://app/save" }),
    screenshot: async () => {},
  };
  return page;
}

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

// ─ The AC test: a swallowed error response is captured by the listener AND log ─

test("swallowed error response: the response listener AND the server-log tail both capture a hidden 500", async () => {
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
  assert.ok(kinds.includes("error-response"), "response listener must record the swallowed 500");
  assert.ok(kinds.includes("server-log-exception"), "server-log tail must record the swallowed 500");
});

test("classifyFailures: an invalid serverLogExceptionPattern degrades to a surfaced note (no throw)", () => {
  let failures;
  assert.doesNotThrow(() => {
    failures = classifyFailures({
      responses: [{ url: "http://app/save", status: 500 }],
      serverLogTail: "ERROR 500 Internal Server Error\n",
      serverLogExceptionPattern: "[", // not a valid regex
    });
  });
  const byKind = Object.fromEntries(failures.map((f) => [f.kind, f]));
  // The bad pattern is surfaced as a note, server-log classification is skipped,
  // and the wire-level error response is still recorded.
  assert.equal(byKind["server-log-pattern-invalid"].severity, "note");
  assert.ok(byKind["error-response"], "response classification still runs");
  assert.ok(!byKind["server-log-exception"], "server-log line classification is skipped");
});

test("isErrorResponseStatus: one owner flags <200/>=400 and clears 2xx/3xx", () => {
  assert.equal(isErrorResponseStatus(500), true);
  assert.equal(isErrorResponseStatus(199), true);
  assert.equal(isErrorResponseStatus(200), false);
  assert.equal(isErrorResponseStatus(302), false, "3xx redirects are normal navigation");
  assert.equal(isErrorResponseStatus(399), false);
  assert.equal(isErrorResponseStatus(400), true);
  assert.equal(isErrorResponseStatus("500"), false, "non-number is not an error status");
});

test("classifyFailures: server-log-exception carries surrounding traceback frames as context", () => {
  const tail = [
    "I, [ts] INFO -- : Started POST /save",
    "app/controllers/save_controller.rb:17:in `create'",
    "ERROR 500 Internal Server Error: NoMethodError",
    "app/models/deck.rb:42:in `publish'",
    "I, [ts] INFO -- : Completed 500",
  ].join("\n");
  const failures = classifyFailures({ serverLogTail: tail, serverLogExceptionPattern: "ERROR 500" });
  const exc = failures.find((f) => f.kind === "server-log-exception");
  assert.ok(exc, "the matching line is classified");
  // The file:line frames sit on adjacent, non-matching lines; they survive.
  assert.match(exc.context, /save_controller\.rb:17/);
  assert.match(exc.context, /deck\.rb:42/);
});

test("classifyFailures: a requestFailure becomes request-failed and a pageError becomes page-error carrying err.stack", () => {
  const failures = classifyFailures({
    requestFailures: [{ url: "http://x/img", failure: "net::ERR" }],
    pageErrors: [{ message: "TypeError: boom", stack: "TypeError: boom\n    at app.js:42:9" }],
  });
  const byKind = Object.fromEntries(failures.map((f) => [f.kind, f]));
  assert.equal(byKind["request-failed"].severity, "must-fix");
  assert.match(byKind["request-failed"].message, /request failed at http:\/\/x\/img: net::ERR/);
  assert.equal(byKind["page-error"].severity, "must-fix");
  assert.match(byKind["page-error"].message, /uncaught page error: TypeError: boom/);
  // Stage 3 exception -> source-line mapping needs the stack on the feed entry.
  assert.match(byKind["page-error"].stack, /at app\.js:42:9/);
});

test("classifyFailures: page-error stack is null when absent and bounded when huge", () => {
  const huge = "x".repeat(10000);
  const failures = classifyFailures({ pageErrors: [{ message: "no stack" }, { message: "big", stack: huge }] });
  const entries = failures.filter((f) => f.kind === "page-error");
  assert.equal(entries[0].stack, null, "no stack -> null, never undefined");
  assert.ok(entries[1].stack.length < huge.length, "a runaway stack is bounded before it lands on the feed");
});

test("attachPageListeners: captures requestfailed and pageerror (with err.stack for Stage 3)", () => {
  const page = fakePage();
  const { getCapturedEvents } = attachPageListeners(page);
  page.emit("response", { status: () => 204, url: () => "http://x/ok" }); // 2xx ignored
  page.emit("response", { status: () => 302, url: () => "http://x/redir" }); // 3xx ignored (shared predicate)
  page.emit("requestfailed", { url: () => "http://x/img", failure: () => ({ errorText: "net::ERR" }) });
  page.emit("pageerror", { message: "TypeError: boom", stack: "TypeError: boom\n    at app.js:42:9" });
  const e = getCapturedEvents();
  assert.equal(e.responses.length, 0, "2xx/3xx responses are not retained");
  assert.deepEqual(e.requestFailures, [{ url: "http://x/img", failure: "net::ERR" }]);
  // The file:line signal Stage 3 needs is captured off err.stack, not discarded.
  assert.deepEqual(e.pageErrors, [{ message: "TypeError: boom", stack: "TypeError: boom\n    at app.js:42:9" }]);
});

test("sliceCapturedEvents: attributes a per-state window WITHOUT clearing, so the walk-level gate still sees the same classified error (AC2)", () => {
  const page = fakePage();
  const { getCapturedEvents, sliceCapturedEvents } = attachPageListeners(page);
  page.emit("response", { status: () => 500, url: () => "http://app/save" });
  page.emit("pageerror", { message: "TypeError: boom", stack: "TypeError: boom\n    at app.js:1" });

  // The per-state capture slices its window (this becomes the state's console.json).
  const slice = sliceCapturedEvents();
  assert.deepEqual(slice.responses, [{ url: "http://app/save", status: 500 }]);
  assert.equal(slice.pageErrors.length, 1);

  // Slicing does NOT clear the buffer: the walk-level classifier still sees the
  // SAME events, so a captured step-scoped error deterministically fails the drive
  // closed (mechanical gate authoritative), keeping its source-line anchoring.
  const whole = getCapturedEvents();
  assert.deepEqual(whole.responses, [{ url: "http://app/save", status: 500 }]);
  assert.equal(whole.pageErrors.length, 1);
  const failures = classifyFailures(whole);
  assert.ok(failures.some((f) => f.kind === "error-response"), "the sliced 500 still reaches the walk-level gate");
  assert.ok(failures.some((f) => f.kind === "page-error" && /at app\.js:1/.test(f.stack)), "the sliced page error keeps its stack for anchoring");

  // The cursor advances: a later event lands only in the NEXT slice, and the
  // window is exactly the delta since the previous slice (no re-attribution).
  assert.deepEqual(sliceCapturedEvents(), { responses: [], requestFailures: [], pageErrors: [] });
  page.emit("requestfailed", { url: () => "http://app/img", failure: () => ({ errorText: "net::ERR" }) });
  assert.deepEqual(sliceCapturedEvents().requestFailures, [{ url: "http://app/img", failure: "net::ERR" }]);
  // ...and the whole buffer still carries everything for the mechanical gate.
  assert.equal(getCapturedEvents().responses.length, 1);
  assert.equal(getCapturedEvents().requestFailures.length, 1);
});

test("toPerStateConsolePayload: shapes a per-state slice into console/network findings; null when empty", () => {
  assert.equal(toPerStateConsolePayload({ responses: [], requestFailures: [], pageErrors: [] }), null);
  assert.equal(toPerStateConsolePayload({}), null);
  const payload = toPerStateConsolePayload({
    responses: [{ url: "http://app/save", status: 500 }],
    requestFailures: [{ url: "http://app/img", failure: "net::ERR" }],
    pageErrors: [{ message: "boom", stack: "boom\n    at app.js:1" }],
  });
  assert.deepEqual(payload.consoleErrors, [{ message: "boom", stack: "boom\n    at app.js:1" }]);
  assert.deepEqual(payload.failedRequests, [
    { kind: "error-response", url: "http://app/save", status: 500 },
    { kind: "request-failed", url: "http://app/img", failure: "net::ERR" },
  ]);
});

test("toPerStateConsolePayload: clamps a runaway pageerror stack to the SAME bound as the mechanical feed (bounded console.json)", () => {
  const huge = "x".repeat(PAGE_ERROR_STACK_MAX_CHARS + 5000);
  const payload = toPerStateConsolePayload({ pageErrors: [{ message: "boom", stack: huge }] });
  assert.equal(payload.consoleErrors[0].stack.length, PAGE_ERROR_STACK_MAX_CHARS, "stack clamped to the shared classifyFailures bound");
  assert.equal(payload.consoleErrors[0].stack, huge.slice(0, PAGE_ERROR_STACK_MAX_CHARS), "keeps the head — the throwing file:line");
});

test("openServerLogTail: absent path is a no-op; missing file reads once created", async () => {
  assert.equal(await openServerLogTail(null).read(), "");
  const p = path.join(tempDir(), "late.log");
  const tail = openServerLogTail(p); // file does not exist yet
  writeFileSync(p, "boot line\n");
  assert.match(await tail.read(), /boot line/);
});

test("openServerLogTail: a present-but-unreadable log is surfaced as a note, not silent empty", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses file perms
  const p = path.join(tempDir(), "locked.log");
  writeFileSync(p, "ERROR 500 boom\n"); // present, with content a review would want
  chmodSync(p, 0o000); // now unreadable
  const notes = [];
  const out = await openServerLogTail(p, { log: (m) => notes.push(m) }).read();
  chmodSync(p, 0o600); // restore so temp cleanup can remove it
  assert.equal(out, "", "degrades to an empty tail (never throws)");
  assert.ok(notes.some((m) => /unreadable/.test(m)), "a genuinely unreadable log is surfaced, not silently treated as empty");
});

test("openServerLogTail: caps a huge delta to the last maxBytes and logs the truncation", async () => {
  const p = path.join(tempDir(), "big.log");
  writeFileSync(p, ""); // pins offset at 0
  const notes = [];
  const tail = openServerLogTail(p, { maxBytes: 1024, log: (m) => notes.push(m) });
  // Append far more than the cap; the newest bytes carry the marker to keep.
  appendFileSync(p, "x".repeat(4096) + "\nTAIL_MARKER\n");
  const out = await tail.read();
  assert.ok(Buffer.byteLength(out, "utf8") <= 1024, "read is capped to maxBytes");
  assert.match(out, /TAIL_MARKER/, "the newest bytes (where a just-logged 500 lives) are kept");
  assert.ok(notes.some((m) => /truncated/.test(m)), "truncation is logged, not silent");
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
  const caps = resolveCaps({ maxScreenshots: 9999, maxFlows: 1, maxStepsPerFlow: 9999, retries: 5 });
  assert.equal(caps.maxScreenshots, DEFAULT_DRIVE_CAPS.maxScreenshots); // clamped down
  assert.equal(caps.maxFlows, 1); // project may tighten
  assert.equal(caps.maxStepsPerFlow, DEFAULT_DRIVE_CAPS.maxStepsPerFlow); // clamped down
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

test("driveUiReview: caps a flow at maxStepsPerFlow and logs the truncation", async () => {
  const steps = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, action: "goto" }));
  const logs = [];
  let calls = 0;
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps }], caps: { maxStepsPerFlow: 2 } },
    baseSeams({ runStep: async ({ step }) => (calls += 1, { ok: true, screenshotPath: `/o/${step.name}.png` }), log: (m) => logs.push(m) }),
  );
  assert.equal(calls, 2, "only the capped number of steps run");
  assert.equal(r.steps.length, 2);
  assert.ok(logs.some((m) => /maxStepsPerFlow cap \(2\)/.test(m)), "the step truncation is logged");
});

test("driveUiReview: emits a session-stamped row manifest for the mutating steps it drove (goto/fill excluded)", async () => {
  const r = await driveUiReview(
    {
      appUrl: "http://app",
      login: {},
      driveSession: "sess-abc",
      flows: [{
        name: "create widget",
        steps: [
          { name: "open", action: "goto", path: "/widgets/new" },   // navigation — not a mutation
          { name: "name", action: "fill", selector: "#name" },        // typing — not a mutation
          { name: "save", action: "click", selector: "button[type=submit]" }, // create
          { name: "logo", action: "upload", selector: "#logo", value: "/f.png" }, // upload
        ],
      }],
    },
    baseSeams(),
  );
  assert.equal(r.driveSession, "sess-abc");
  // Exactly the two mutating steps are manifested, each stamped with the session.
  assert.deepEqual(r.rowManifest, [
    { session: "sess-abc", flow: "create widget", step: "save", action: "click" },
    { session: "sess-abc", flow: "create widget", step: "logo", action: "upload" },
  ]);
});

test("driveUiReview: no driveSession => driveSession null and an empty manifest (nothing to drop)", async () => {
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps: [{ name: "save", action: "click", selector: "#s" }] }] },
    baseSeams(),
  );
  assert.equal(r.driveSession, null);
  assert.deepEqual(r.rowManifest, []);
});

test("driveUiReview: collates a swallowed error response from the injected listener + log tail", async () => {
  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "f", steps: [{ name: "save", action: "click" }] }], serverLogExceptionPattern: DEFAULT_SERVER_LOG_EXCEPTION_PATTERN },
    baseSeams({
      getCapturedEvents: () => ({ responses: [{ url: "http://app/save", status: 500 }], requestFailures: [], pageErrors: [] }),
      readServerLogTail: async () => "ERROR 500 Internal Server Error\n",
    }),
  );
  assert.equal(r.ok, false);
  const kinds = r.failures.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["error-response", "server-log-exception"]);
});

// ── Production wiring: the REAL makeRunStep (drain/attribute + consolePath) ───
// These substitute nothing for makeRunStep, so they fail if the wiring that
// slices per state + threads consolePath is removed.

test("driveUiReview + real makeRunStep: a step-scoped 500 is attributed to that state's console.json AND still fails the mechanical ok gate closed (AC1 + AC2)", async () => {
  const outputDir = tempDir();
  const page = fakeDrivePage();
  const { getCapturedEvents, sliceCapturedEvents } = attachPageListeners(page);
  const runStep = makeRunStep({ page, outputDir, sliceCapturedEvents });

  const r = await driveUiReview(
    { appUrl: "http://app", login: {}, flows: [{ name: "checkout", steps: [{ name: "save", action: "click" }] }] },
    { authenticate: async () => ({ ok: true, detail: "ok" }), runStep, getCapturedEvents },
  );

  // AC2: the captured step-scoped 500 deterministically fails the drive closed
  // through the mechanical gate — independent of any review mode or LLM.
  assert.equal(r.ok, false, "a captured step-scoped 500 must fail the drive closed via the mechanical gate");
  assert.ok(r.failures.some((f) => f.kind === "error-response"), "the classified error reaches drive.failures");

  // AC1: the same 500 is ALSO attributed into THAT state's console.json (the slice
  // did not remove it from the walk-level gate — two views of one classified error).
  const state = JSON.parse(readFileSync(r.steps[0].statePath, "utf8"));
  const consoleJson = JSON.parse(readFileSync(state.artifacts.console.path, "utf8"));
  assert.deepEqual(consoleJson.failedRequests, [{ kind: "error-response", url: "http://app/save", status: 500 }]);
});

test("makeRunStep: threads consolePath into the runStep result and points state.json at it", async () => {
  const outputDir = tempDir();
  const page = fakeDrivePage();
  const { sliceCapturedEvents } = attachPageListeners(page);
  const runStep = makeRunStep({ page, outputDir, sliceCapturedEvents });

  const outcome = await runStep({ appUrl: "http://app", flow: { name: "checkout" }, step: { name: "save", action: "click" }, index: 0 });

  // The runStep result carries consolePath (the field a bundle assembler threads
  // into the review contract's namedStates) — deleting it fails here.
  assert.ok(typeof outcome.consolePath === "string" && outcome.consolePath.endsWith("console.json"), "consolePath is threaded into the runStep result");
  const state = JSON.parse(readFileSync(outcome.statePath, "utf8"));
  assert.equal(state.artifacts.console.path, outcome.consolePath, "state.json back-references the same console.json");
});

test("makeRunStep: a declared step viewport resizes the page and slugs the capture into a distinct directory (same state name, different viewport)", async () => {
  const outputDir = tempDir();
  const resized = [];
  const page = {
    on: () => {},
    goto: async () => {},
    setViewportSize: async (v) => resized.push(v),
    screenshot: async () => {},
  };
  const runStep = makeRunStep({ page, outputDir });

  const desktop = await runStep({ appUrl: "http://app", flow: { name: "decks" }, step: { name: "Hero", action: "goto", path: "/" }, index: 0 });
  const mobile = await runStep({ appUrl: "http://app", flow: { name: "decks" }, step: { name: "Hero", action: "goto", path: "/", viewport: { width: 390, height: 844 } }, index: 1 });

  // The declared viewport is applied to the page (honest pixels, not a mislabeled slug).
  assert.deepEqual(resized, [{ width: 390, height: 844 }]);
  // Same state name, different viewport → distinct on-disk directories (no collision).
  assert.notEqual(desktop.statePath, mobile.statePath);
  assert.match(path.dirname(desktop.statePath), /hero-default-none$/);
  assert.match(path.dirname(mobile.statePath), /hero-w390h844-none$/);
  const mobileState = JSON.parse(readFileSync(mobile.statePath, "utf8"));
  assert.equal(mobileState.viewport, "w390h844");
});

test("makeRunStep: a viewport set by an earlier step carries into a later undeclared step's slug (the page stays resized — no stale `default`)", async () => {
  const outputDir = tempDir();
  const page = { on: () => {}, goto: async () => {}, setViewportSize: async () => {}, screenshot: async () => {} };
  const runStep = makeRunStep({ page, outputDir });

  // Step 1 resizes to mobile; step 2 declares NO viewport but the page is STILL at 390.
  await runStep({ appUrl: "http://app", flow: { name: "decks" }, step: { name: "Hero", action: "goto", path: "/", viewport: { width: 390, height: 844 } }, index: 0 });
  const later = await runStep({ appUrl: "http://app", flow: { name: "decks" }, step: { name: "Detail", action: "goto", path: "/d" }, index: 1 });

  // The slug + state.json must name the viewport the page is ACTUALLY at, not `default`.
  assert.match(path.dirname(later.statePath), /detail-w390h844-none$/);
  assert.equal(JSON.parse(readFileSync(later.statePath, "utf8")).viewport, "w390h844");
});

test("makeRunStep: a declared interactionState slugs the capture (route names it — the drive never enumerates)", async () => {
  const outputDir = tempDir();
  const page = { on: () => {}, goto: async () => {}, click: async () => {}, screenshot: async () => {} };
  const runStep = makeRunStep({ page, outputDir });

  const errored = await runStep({ appUrl: "http://app", flow: { name: "form" }, step: { name: "Email", action: "click", selector: "#submit", interactionState: "error" }, index: 0 });
  assert.match(path.dirname(errored.statePath), /email-default-error$/);
  assert.equal(JSON.parse(readFileSync(errored.statePath, "utf8")).interactionState, "error");
});

test("makeRunStep: a capture failure still advances the attribution cursor — the next step's console.json does not inherit the prior step's events (no misattribution)", async () => {
  const outputDir = tempDir();
  const handlers = {};
  let failScreenshot = false;
  const page = {
    on: (ev, cb) => ((handlers[ev] ??= []).push(cb), undefined),
    emit: (ev, arg) => (handlers[ev] ?? []).forEach((cb) => cb(arg)),
    goto: async () => {},
    click: async () => page.emit("pageerror", { message: "boom", stack: "boom\n    at app.js:1" }),
    screenshot: async () => { if (failScreenshot) throw new Error("screenshot failed"); },
  };
  const { getCapturedEvents, sliceCapturedEvents } = attachPageListeners(page);
  const runStep = makeRunStep({ page, outputDir, sliceCapturedEvents });

  // Step 1: fires a pageerror DURING the action, then its artifact capture throws.
  failScreenshot = true;
  await assert.rejects(
    runStep({ appUrl: "http://app", flow: { name: "checkout" }, step: { name: "s1", action: "click" }, index: 0 }),
    /screenshot failed/,
  );

  // Step 2: a clean action (no events); its console.json MUST be null. If the
  // cursor had not advanced past step 1 (capture threw), step 1's pageerror would
  // misattribute forward into step 2 — this asserts it does not.
  failScreenshot = false;
  const out2 = await runStep({ appUrl: "http://app", flow: { name: "checkout" }, step: { name: "s2", action: "goto", path: "/next" }, index: 1 });
  const console2 = JSON.parse(readFileSync(out2.consolePath, "utf8"));
  assert.equal(console2, null, "step 2 console.json is null — step 1's error was not misattributed forward");

  // Slicing never clears: the walk-level mechanical fail-closed gate still sees step 1's error.
  assert.equal(getCapturedEvents().pageErrors.length, 1, "the buffer retains step 1's error for the mechanical gate");
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
