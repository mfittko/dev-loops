import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseVisualGrillCliArgs,
  parseDescriptor,
  captureDescriptorScreen,
  MAX_DESCRIPTOR_STEPS,
} from "../../scripts/loop/visual-grill-capture.mjs";

const tempFiles = [];
after(() => {
  for (const f of tempFiles) rmSync(f, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(path.join(tmpdir(), "visual-grill-"));
  tempFiles.push(d);
  return d;
}

// A fake page exposing the emitter + action/screenshot surface makeRunStep ->
// captureNamedUiState touches, so the real wiring runs without a browser.
function fakePage({ url = "http://app.test/" } = {}) {
  return {
    on: () => {},
    goto: async () => {},
    click: async () => {},
    fill: async () => {},
    screenshot: async () => {},
    url: () => url,
  };
}

function fakeBrowser(page) {
  return { newContext: async () => ({ newPage: async () => page }), close: async () => {} };
}

// ── CLI parsing ─────────────────────────────────────────────────────────────

test("parseVisualGrillCliArgs: requires --repo-root, --app-url, --output-dir, --descriptor", () => {
  assert.throws(() => parseVisualGrillCliArgs(["--app-url", "http://x", "--output-dir", "/o", "--descriptor", "{}"]), /repo-root/);
  assert.throws(() => parseVisualGrillCliArgs(["--repo-root", "/r", "--output-dir", "/o", "--descriptor", "{}"]), /app-url/);
  assert.throws(() => parseVisualGrillCliArgs(["--repo-root", "/r", "--app-url", "http://x", "--descriptor", "{}"]), /output-dir/);
  assert.throws(() => parseVisualGrillCliArgs(["--repo-root", "/r", "--app-url", "http://x", "--output-dir", "/o"]), /descriptor/);
});

// ── Descriptor parsing (fail-closed) ────────────────────────────────────────

test("parseDescriptor: rejects malformed JSON, missing name, and empty steps", () => {
  assert.throws(() => parseDescriptor("{not json"), /not valid JSON/);
  assert.throws(() => parseDescriptor(JSON.stringify({ steps: [{ action: "goto" }] })), /non-empty string `name`/);
  assert.throws(() => parseDescriptor(JSON.stringify({ name: "s", steps: [] })), /non-empty `steps`/);
});

test("parseDescriptor: accepts a well-formed descriptor", () => {
  const d = parseDescriptor(JSON.stringify({ name: "settings", steps: [{ action: "goto", path: "/settings" }] }));
  assert.equal(d.name, "settings");
  assert.equal(d.steps.length, 1);
});

test("parseDescriptor: rejects an over-cap descriptor (bounded walk)", () => {
  const steps = Array.from({ length: MAX_DESCRIPTOR_STEPS + 1 }, () => ({ action: "goto", path: "/" }));
  assert.throws(() => parseDescriptor(JSON.stringify({ name: "big", steps })), /step cap/);
});

test("parseDescriptor: rejects `upload` (local-file exfiltration) and unknown/missing actions", () => {
  assert.throws(() => parseDescriptor(JSON.stringify({ name: "x", steps: [{ action: "upload", selector: "#f", value: "/etc/passwd" }] })), /unsupported step action "upload"/);
  assert.throws(() => parseDescriptor(JSON.stringify({ name: "x", steps: [{ action: "evil" }] })), /unsupported step action/);
  assert.throws(() => parseDescriptor(JSON.stringify({ name: "x", steps: [{ selector: "#f" }] })), /unsupported step action/);
});

// ── Capture (reuses makeRunStep -> captureNamedUiState) ──────────────────────

test("captureDescriptorScreen: walks the descriptor and returns the final screen's screenshot (no auth recipe)", async () => {
  const outputDir = tempDir();
  const result = await captureDescriptorScreen(
    {
      repoRoot: "/r",
      appUrl: "http://app.test",
      outputDir,
      descriptor: { name: "settings", steps: [{ action: "goto", path: "/settings" }, { action: "click", selector: "text=Edit Profile", name: "edit-profile" }] },
    },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(fakePage()) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, null);
  // The final step (edit-profile) is the target screen the grill uses as context.
  assert.match(result.screenshotPath, /edit-profile/);
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.equal(state.stateName, "edit-profile");
});

test("captureDescriptorScreen: a throwing browser.close() teardown does not reject — the structured envelope is still returned", async () => {
  const outputDir = tempDir();
  const throwingCloseBrowser = () => ({
    newContext: async () => ({ newPage: async () => fakePage() }),
    close: async () => { throw new Error("EPERM: teardown failed"); },
  });
  // Must resolve (not reject) despite the close() throw in the finally.
  const result = await captureDescriptorScreen(
    {
      repoRoot: "/r",
      appUrl: "http://app.test",
      outputDir,
      descriptor: { name: "settings", steps: [{ action: "goto", path: "/settings", name: "settings" }] },
    },
    { loadConfig: async () => ({ config: {} }), launchBrowser: throwingCloseBrowser },
  );
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, null);
});

test("captureDescriptorScreen: self-validates steps (bypassed parseDescriptor) and rejects upload/non-array before any launch", async () => {
  let launched = false;
  const launchBrowser = () => { launched = true; return fakeBrowser(fakePage()); };
  const base = { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir() };
  // A programmatic caller bypassing parseDescriptor passes an `upload` action.
  const uploadResult = await captureDescriptorScreen(
    { ...base, descriptor: { name: "x", steps: [{ action: "upload", selector: "#f", value: "/etc/passwd" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser },
  );
  assert.equal(uploadResult.ok, false);
  assert.match(uploadResult.stopReason, /unsupported step action "upload"/);
  // A non-array steps must also fail closed before launch.
  const badShape = await captureDescriptorScreen(
    { ...base, descriptor: { name: "x", steps: "nope" } },
    { loadConfig: async () => ({ config: {} }), launchBrowser },
  );
  assert.equal(badShape.ok, false);
  assert.match(badShape.stopReason, /non-empty `steps` array/);
  assert.equal(launched, false, "no browser is launched for an unsafe/malformed descriptor");
});

test("captureDescriptorScreen: a fail-closed path clears the WHOLE capture subtree, incl. an untracked partial bundle", async () => {
  const outputDir = tempDir();
  // Simulate a mid-write partial bundle from a prior/off-origin step that `last`
  // does not reference (e.g. captureNamedUiState threw after writing screenshot.png).
  const orphan = path.join(outputDir, "named-states", "orphan-partial");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(orphan, "screenshot.png"), "partial");
  // Trigger a fail-closed path: the walk lands off-origin.
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir, descriptor: { name: "x", steps: [{ action: "goto", path: "/settings", name: "settings" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(fakePage({ url: "http://evil.test/landed" })) },
  );
  assert.equal(result.ok, false);
  // The untracked partial bundle is gone — fail-closed clears the whole subtree,
  // not just the last returned bundle.
  assert.equal(existsSync(orphan), false, "an untracked partial capture must not survive a fail-closed path");
});

test("captureDescriptorScreen: a browser launch failure (runner unavailable) fails closed with a reason", async () => {
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "goto", path: "/" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => { throw new Error("webkit binary not installed"); } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.screenshotPath, null);
  assert.match(result.stopReason, /webkit binary not installed/);
});

test("captureDescriptorScreen: a file:// goto is rejected before any browser launches (scheme allowlist)", async () => {
  let launched = false;
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "goto", path: "file:///etc/passwd" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => { launched = true; return fakeBrowser(fakePage()); } },
  );
  assert.equal(result.ok, false);
  assert.equal(launched, false);
  assert.match(result.stopReason, /not allowed \(http\/https only\)/);
});

test("captureDescriptorScreen: an absolute cross-origin goto override is rejected (no app-base escape)", async () => {
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "goto", path: "http://evil.test/steal" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(fakePage()) },
  );
  assert.equal(result.ok, false);
  assert.match(result.stopReason, /overrides the app base origin/);
});

test("captureDescriptorScreen: a non-http app-url is rejected", async () => {
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "file:///tmp", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "click", selector: "#x" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(fakePage()) },
  );
  assert.equal(result.ok, false);
  assert.match(result.stopReason, /app-url scheme/);
});

test("captureDescriptorScreen: a declared login recipe whose authentication fails, fails closed (unresolved)", async () => {
  // A config carrying a real uiReview.login recipe drives the authenticate branch.
  // The fake page's waitForSelector rejects, so authenticate returns { ok:false }.
  const page = fakePage();
  page.fill = async () => {};
  page.waitForSelector = async () => { throw new Error("login timeout"); };
  const config = { uiReview: { login: { loginUrl: "http://app.test/login", submitSelector: "#submit", successSelector: "#home" } } };
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "goto", path: "/settings" }] } },
    { loadConfig: async () => ({ config }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, false);
  assert.match(result.stopReason, /authentication failed/);
});

test("captureDescriptorScreen: a declared login recipe that authenticates drives the walk to a capture", async () => {
  const page = fakePage();
  page.fill = async () => {};
  page.waitForSelector = async () => {}; // login confirmed
  const config = { uiReview: { login: { loginUrl: "http://app.test/login", submitSelector: "#submit", successSelector: "#home" } } };
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "settings", steps: [{ action: "goto", path: "/settings", name: "settings-page" }] } },
    { loadConfig: async () => ({ config }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, true);
  assert.match(result.screenshotPath, /settings-page/);
});

test("captureDescriptorScreen: a goto that redirects cross-origin at runtime fails closed (no off-origin screenshot)", async () => {
  // Pre-launch validation passes (path is same-origin), but the page ends up on
  // another origin — a server redirect. The runtime guard must catch it.
  const page = fakePage({ url: "http://evil.test/landed" });
  const outputDir = tempDir();
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir, descriptor: { name: "s", steps: [{ action: "goto", path: "/redirector" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.screenshotPath, null);
  assert.match(result.stopReason, /left the app origin/);
  // The off-origin capture bundle runStep wrote must be deleted — nothing persists.
  const statesDir = path.join(outputDir, "named-states");
  assert.equal(existsSync(statesDir) && readdirSync(statesDir).length > 0, false);
});

test("captureDescriptorScreen: a click that navigates to another origin fails closed", async () => {
  const page = fakePage({ url: "http://external.test/oauth" });
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "click", selector: "a.external" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.screenshotPath, null);
  assert.match(result.stopReason, /left the app origin/);
});

test("captureDescriptorScreen: a same-origin walk is not false-tripped by the runtime guard", async () => {
  const page = fakePage({ url: "http://app.test/settings" });
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "settings", steps: [{ action: "goto", path: "/settings", name: "settings-page" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, true);
  assert.match(result.screenshotPath, /settings-page/);
  assert.equal(existsSync(result.statePath), true); // same-origin capture is kept, not deleted
});

test("captureDescriptorScreen: a multi-step walk keeps ONLY the final screen's bundle (intermediates pruned)", async () => {
  const outputDir = tempDir();
  const result = await captureDescriptorScreen(
    {
      repoRoot: "/r",
      appUrl: "http://app.test",
      outputDir,
      descriptor: {
        name: "flow",
        steps: [
          { action: "goto", path: "/login", name: "one" },
          { action: "fill", selector: "#pw", value: "hunter2", name: "two-secret" },
          { action: "click", selector: "#go", name: "three-final" },
        ],
      },
    },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(fakePage({ url: "http://app.test/home" })) },
  );
  assert.equal(result.ok, true);
  assert.match(result.statePath, /three-final/);
  // Exactly one bundle remains on disk — the final screen; the credential-fill
  // intermediate is gone.
  const dirs = readdirSync(path.join(outputDir, "named-states"));
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /three-final/);
});

test("captureDescriptorScreen: a failure mid-walk leaves no intermediate bundle behind", async () => {
  const page = fakePage({ url: "http://app.test/x" });
  page.click = async () => { throw new Error("selector not found"); };
  const outputDir = tempDir();
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir, descriptor: { name: "f", steps: [{ action: "goto", path: "/a", name: "one" }, { action: "click", selector: "#b", name: "two" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, false);
  const statesDir = path.join(outputDir, "named-states");
  assert.equal(existsSync(statesDir) && readdirSync(statesDir).length > 0, false);
});

test("captureDescriptorScreen: a step that throws fails closed rather than fabricating a screen", async () => {
  const page = fakePage();
  page.click = async () => { throw new Error("selector not found"); };
  const result = await captureDescriptorScreen(
    { repoRoot: "/r", appUrl: "http://app.test", outputDir: tempDir(), descriptor: { name: "s", steps: [{ action: "click", selector: "#missing" }] } },
    { loadConfig: async () => ({ config: {} }), launchBrowser: () => fakeBrowser(page) },
  );
  assert.equal(result.ok, false);
  assert.match(result.stopReason, /selector not found/);
});
