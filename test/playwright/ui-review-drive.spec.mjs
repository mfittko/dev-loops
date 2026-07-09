import { createServer } from "node:http";
import { mkdtempSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { driveUiReview } from "@dev-loops/core/loop/ui-review-drive";
import {
  attachPageListeners,
  openServerLogTail,
} from "../../scripts/loop/ui-review-drive.mjs";
import { startFixtureServer, stopFixtureServer } from "./harness/webkit-smoke-harness.mjs";

// A tiny fixture app that authenticates via a dev-login button, shows a cookie
// interstitial, and — the point of the test — swallows a 500: the "Save" button
// POSTs to /api/save, which 500s and logs the failure server-side, but the page
// renders "Saved!" regardless, hiding the error from a human reviewer.
function makeFixtureApp(logPath) {
  const page = (title, body) =>
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  return createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    if (route === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("login", `<button id="login" onclick="location.href='/decks'">Sign in (dev)</button>`));
      return;
    }
    if (route === "/decks") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("decks", `
        <div id="dashboard">Decks</div>
        <div id="cookie-banner"><button id="accept-cookies">Accept</button></div>
        <button id="save" onclick="
          fetch('/api/save', { method: 'POST' })
            .catch(() => {})
            .finally(() => { document.getElementById('status').textContent = 'Saved!'; });
        ">Save</button>
        <div id="status"></div>
      `));
      return;
    }
    if (route === "/api/save") {
      // The swallowed non-2xx: the server errors and logs it, the UI hides it.
      appendFileSync(logPath, "ERROR 500 Internal Server Error: NoMethodError in DecksController#save\n");
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
}

test("webkit drive harness captures a swallowed non-2xx via the response listener AND the server-log tail", async ({ page }) => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "ui-drive-spec-"));
  const logPath = path.join(outputDir, "server.log");
  writeFileSync(logPath, "GET /login 200\n"); // history the tail must not re-report

  const { server, url } = await startFixtureServer(() => makeFixtureApp(logPath));
  const { getCapturedEvents } = attachPageListeners(page);
  const logTail = openServerLogTail(logPath);

  try {
    const result = await driveUiReview(
      {
        appUrl: url,
        login: { loginUrl: `${url}/login`, submitSelector: "#login", successSelector: "#dashboard" },
        interstitials: [{ selector: "#accept-cookies", optional: true }],
        flows: [
          {
            name: "decks",
            steps: [
              { name: "open decks", action: "goto", path: "/decks" },
              { name: "save deck", action: "click", selector: "#save" },
            ],
          },
        ],
        serverLogExceptionPattern: "5\\d{2}|Internal Server Error",
      },
      {
        authenticate: async ({ login }) => {
          try {
            await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
            await page.click(login.submitSelector);
            await page.waitForSelector(login.successSelector, { state: "visible", timeout: 10_000 });
            return { ok: true, detail: "signed in" };
          } catch (err) {
            return { ok: false, detail: String(err) };
          }
        },
        dismissInterstitials: async ({ interstitials }) => {
          const dismissed = [];
          for (const it of interstitials) {
            const el = page.locator(it.selector).first();
            if (await el.isVisible().catch(() => false)) {
              await el.click();
              dismissed.push(it.selector);
            }
          }
          return { dismissed };
        },
        runStep: async ({ appUrl, flow, step }) => {
          if (step.action === "goto") {
            await page.goto(new URL(step.path, appUrl).toString(), { waitUntil: "domcontentloaded" });
          } else if (step.action === "click") {
            await page.click(step.selector);
            // Wait for the swallowed request to complete so its response is seen.
            await page.waitForFunction(() => document.getElementById("status")?.textContent === "Saved!");
          }
          const shot = path.join(outputDir, `${flow.name}-${step.name.replace(/\W+/g, "-")}.png`);
          await page.screenshot({ path: shot });
          return { ok: true, screenshotPath: shot, statePath: null };
        },
        getCapturedEvents,
        readServerLogTail: () => logTail.read(),
      },
    );

    // The UI hid the failure ("Saved!"), yet the drive stage recorded it twice.
    const kinds = result.failures.map((f) => f.kind);
    expect(kinds, "response listener must record the swallowed 500").toContain("non-2xx-response");
    expect(kinds, "server-log tail must record the swallowed 500").toContain("server-log-exception");
    expect(result.captures.length).toBe(2);
    expect(existsSync(result.captures[0].screenshotPath)).toBe(true);
  } finally {
    await stopFixtureServer(server);
  }
});
