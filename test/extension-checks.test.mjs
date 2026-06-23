import test from "node:test";
import assert from "node:assert/strict";

import { collectDevLoopChecks } from "../extension/checks.ts";
import { createPiExtensionAdapter } from "../extension/pi-extension-adapter.ts";
import { renderCheckLines, summarizeChecks } from "../lib/dev-loops-core.mjs";

function createFakePi({ commandResults = new Map(), tools = [], commands = [] } = {}) {
  return {
    async exec(_tool, args) {
      const command = args[1];
      const result = commandResults.get(command);

      if (typeof result === "number") {
        return { code: result, stdout: "", stderr: "" };
      }

      return result ?? { code: 1, stdout: "", stderr: "" };
    },
    getAllTools() {
      return tools;
    },
    getCommands() {
      return commands;
    },
  };
}

// collectDevLoopChecks now consumes the neutral extension adapter; wrap the Pi double
// through the Pi adapter so the de-facto command->result mapping is exercised end to end.
function createFakeAdapter(options) {
  return createPiExtensionAdapter(createFakePi(options));
}

test("collectDevLoopChecks returns stable ordering and pass/fail detail", async () => {
  const checks = await collectDevLoopChecks(
    createFakeAdapter({
      commandResults: new Map([
        ["command -v gh >/dev/null 2>&1", 0],
        ["gh auth status >/dev/null 2>&1", 0],
        ["command -v subagent >/dev/null 2>&1", 0],
        ["git rev-parse --is-inside-work-tree >/dev/null 2>&1", 0],
      ]),
    }),
  );

  assert.deepEqual(
    checks.map((check) => check.id),
    [
      "gh-installed",
      "gh-auth",
      "subagent-command",
      "git-repo",
    ],
  );
  assert.equal(checks.every((check) => check.ok), true);
  assert.equal(checks[1].detail, "`gh auth status` succeeded.");
});

test("collectDevLoopChecks distinguishes missing gh from missing gh auth", async () => {
  const missingGhChecks = await collectDevLoopChecks(
    createFakeAdapter());
  assert.equal(missingGhChecks[0].ok, false);
  assert.match(missingGhChecks[0].detail, /Install GitHub CLI/);
  assert.equal(missingGhChecks[1].ok, false);
  assert.equal(missingGhChecks[1].detail, "GitHub CLI is not installed yet.");

  const missingAuthChecks = await collectDevLoopChecks(
    createFakeAdapter({
      commandResults: new Map([
        ["command -v gh >/dev/null 2>&1", 0],
        ["gh auth status >/dev/null 2>&1", 1],
      ]),
    }),
  );
  assert.equal(missingAuthChecks[0].ok, true);
  assert.equal(missingAuthChecks[1].ok, false);
  assert.match(missingAuthChecks[1].detail, /gh auth login/);
});

test("collectDevLoopChecks uses subagent command availability for discoverability checks", async () => {
  const checks = await collectDevLoopChecks(
    createFakeAdapter({
      commandResults: new Map([["command -v subagent >/dev/null 2>&1", 0]]),
    }),
  );

  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId["subagent-command"].ok, true);
  assert.equal(checks.length, 4);
});

test("summarizeChecks and renderCheckLines return stable human-readable output", () => {
  const checks = [
    { id: "ok", label: "Everything good", ok: true, detail: "Looks fine." },
    { id: "warn", label: "Needs setup", ok: false, detail: "Do the thing." },
  ];

  assert.deepEqual(summarizeChecks(checks), { ok: 1, total: 2 });
  assert.deepEqual(renderCheckLines(checks), [
    "✅ Everything good",
    "   Looks fine.",
    "⚠️ Needs setup",
    "   Do the thing.",
  ]);
});
