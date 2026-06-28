import test from "node:test";
import assert from "node:assert/strict";

import { collectDevLoopChecks, executeDevLoopsCommand, parseDevLoopsCommand } from "../lib/dev-loops-core.mjs";

function createRuntime(overrides = {}) {
  return {
    async commandExists(command) {
      return command === "gh";
    },
    async ghAuthOk() {
      return true;
    },
    async insideGitRepo() {
      return true;
    },
    async getSubagentAvailability() {
      return {
        ok: true,
        availableDetail: "`subagent` command is available.",
        unavailableDetail: "missing subagent",
      };
    },
    ...overrides,
  };
}

test("parser maintains extension and CLI parity with the hide exception", () => {
  const sharedInputs = [
    [[], "help"],
    [["help"], "help"],
    [["status"], "status"],
    [["doctor"], "doctor"],
  ];

  for (const [argv, action] of sharedInputs) {
    assert.deepEqual(parseDevLoopsCommand(argv, { surface: "extension" }), parseDevLoopsCommand(argv, { surface: "cli" }));
    assert.equal(parseDevLoopsCommand(argv, { surface: "cli" }).action, action);
  }

  assert.deepEqual(parseDevLoopsCommand(["hide"], { surface: "extension" }), {
    kind: "action",
    action: "hide",
    tokens: ["hide"],
  });
  assert.deepEqual(parseDevLoopsCommand(["hide"], { surface: "cli" }), {
    kind: "unsupported",
    action: "hide",
    message: "`dev-loops hide` is not supported outside the Pi extension; use `/dev-loops hide` inside Pi instead.",
    tokens: ["hide"],
  });
  assert.deepEqual(parseDevLoopsCommand(["install", "moon"], { surface: "extension" }), {
    kind: "action",
    action: "help",
    tokens: ["install", "moon"],
  });
  assert.deepEqual(parseDevLoopsCommand(["update", "system"], { surface: "extension" }), {
    kind: "action",
    action: "help",
    tokens: ["update", "system"],
  });
  assert.deepEqual(parseDevLoopsCommand(["install", "moon"], { surface: "cli" }), {
    kind: "malformed",
    message: "Unrecognized command: install.",
    usageAction: undefined,
    tokens: ["install", "moon"],
  });
  assert.deepEqual(parseDevLoopsCommand(["status", "extra"], { surface: "extension" }), {
    kind: "action",
    action: "status",
    tokens: ["status", "extra"],
  });
  assert.deepEqual(parseDevLoopsCommand(["status", "extra"], { surface: "cli" }), {
    kind: "malformed",
    message: "`status` does not accept additional arguments.",
    usageAction: "status",
    tokens: ["status", "extra"],
  });
  assert.deepEqual(parseDevLoopsCommand(["banana"], { surface: "extension" }), {
    kind: "action",
    action: "help",
    tokens: ["banana"],
  });
  assert.deepEqual(parseDevLoopsCommand(["help", "extra"], { surface: "cli" }), {
    kind: "malformed",
    message: "`help` does not accept additional arguments.",
    usageAction: "help",
    tokens: ["help", "extra"],
  });
});

test("shared executor returns deterministic status and rejects removed install and update commands", async () => {
  const status = await executeDevLoopsCommand({
    input: ["status"],
    surface: "cli",
    runtime: createRuntime(),
  });

  assert.equal(status.kind, "checks");
  assert.equal(status.action, "status");
  assert.equal(status.checks[0].id, "gh-installed");
  assert.equal(status.checks[3].id, "git-repo");

  const removedInstall = await executeDevLoopsCommand({
    input: ["install", "repo"],
    surface: "cli",
    runtime: createRuntime(),
  });

  assert.deepEqual(removedInstall, {
    kind: "malformed",
    message: "Unrecognized command: install.",
    usageAction: undefined,
    tokens: ["install", "repo"],
  });

  const removedUpdate = await executeDevLoopsCommand({
    input: ["update", "system"],
    surface: "cli",
    runtime: createRuntime(),
  });

  assert.deepEqual(removedUpdate, {
    kind: "malformed",
    message: "Unrecognized command: update.",
    usageAction: undefined,
    tokens: ["update", "system"],
  });

  const removedExtensionInstall = await executeDevLoopsCommand({
    input: ["install", "repo"],
    surface: "extension",
    runtime: createRuntime(),
  });

  assert.deepEqual(removedExtensionInstall, { kind: "help" });

  const removedExtensionUpdate = await executeDevLoopsCommand({
    input: ["update", "system"],
    surface: "extension",
    runtime: createRuntime(),
  });

  assert.deepEqual(removedExtensionUpdate, { kind: "help" });
});

test("collectDevLoopChecks no longer reports a dev-loop skill readiness check", async () => {
  const checks = await collectDevLoopChecks(createRuntime());
  assert.equal(checks.some((check) => check.id === "local-dev-loop-skill"), false);
});

test("parser accepts the bounded inspect lifecycle command family only on the extension surface", () => {
  for (const action of ["open", "resume", "status", "stop", "restart"]) {
    const parsed = parseDevLoopsCommand(["inspect", action, "--repo", "mfittko/dev-loops"], { surface: "extension" });
    assert.equal(parsed.kind, "inspect_action");
    assert.equal(parsed.action, action);
    assert.equal(parsed.repo, "mfittko/dev-loops");
  }

  assert.deepEqual(parseDevLoopsCommand(["inspect", "launch"], { surface: "extension" }), {
    kind: "malformed",
    message: "`/dev-loops inspect` only supports: open, resume, status, stop, restart.",
    usageAction: "inspect",
    tokens: ["inspect", "launch"],
  });

  assert.deepEqual(parseDevLoopsCommand(["inspect", "open"], { surface: "cli" }), {
    kind: "malformed",
    message: "Unrecognized command: inspect.",
    usageAction: undefined,
    tokens: ["inspect", "open"],
  });
});

test('executor returns a structured inspect-run UI result when repo-root lookup or lifecycle execution throws', async () => {
  const repoRootFailure = await executeDevLoopsCommand({
    input: ['inspect', 'open'],
    surface: 'extension',
    runtime: {
      async getRepoRoot() {
        throw new Error('not in a git repo');
      },
      uiLifecycle: {
        async open() {
          throw new Error('should not run');
        },
      },
    },
  });

  assert.deepEqual(repoRootFailure, {
    kind: 'inspect_result',
    action: 'open',
    repo: null,
    repoRoot: null,
    state: 'stopped',
    url: null,
    detail: 'not in a git repo',
    warning: null,
  });
});

test('normalizeInput handles non-breaking spaces and other unusual whitespace', () => {
  // parseDevLoopsCommand routes through normalizeInput internally
  const parsed = parseDevLoopsCommand(
    ['inspect', '\u00A0open\u00A0', '--repo', '\u00A0mfittko/dev-loops\u00A0'],
    { surface: 'extension' }
  );
  assert.equal(parsed.kind, 'inspect_action');
  assert.equal(parsed.action, 'open');
  assert.equal(parsed.repo, 'mfittko/dev-loops');
});

test('normalizeInput filters non-primitive array elements', () => {
  const parsed = parseDevLoopsCommand(
    ['inspect', 'open', { _meta: 'should-be-ignored' }, '--repo', 'mfittko/dev-loops'],
    { surface: 'extension' }
  );
  assert.equal(parsed.kind, 'inspect_action');
  assert.equal(parsed.action, 'open');
  assert.equal(parsed.repo, 'mfittko/dev-loops');
});

test('normalizeInput handles mixed whitespace characters', () => {
  // em-space, en-space, thin space, NBSP
  const parsed = parseDevLoopsCommand(
    ['inspect\u2003open\u2002--repo\u2009mfittko/dev-loops'],
    { surface: 'extension' }
  );
  assert.equal(parsed.kind, 'inspect_action');
  assert.equal(parsed.action, 'open');
  assert.equal(parsed.repo, 'mfittko/dev-loops');
});

test('executor preserves repoRoot when the inspect-run lifecycle action throws after repo-root lookup succeeds', async () => {
  const result = await executeDevLoopsCommand({
    input: ['inspect', 'open'],
    surface: 'extension',
    runtime: {
      async getRepoRoot() {
        return '/repo/root';
      },
      uiLifecycle: {
        async open() {
          throw new Error('launch failed');
        },
      },
    },
  });

  assert.deepEqual(result, {
    kind: 'inspect_result',
    action: 'open',
    repo: null,
    repoRoot: '/repo/root',
    state: 'stopped',
    url: null,
    detail: 'launch failed',
    warning: null,
  });
});

test("gates action receives stdout and prints without ReferenceError", async () => {
  const { Writable } = await import("node:stream");

  const chunks = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  const result = await executeDevLoopsCommand({
    input: ["gates"],
    surface: "cli",
    runtime: createRuntime(),
    stdout,
  });

  assert.equal(result.kind, "gates");
  const output = Buffer.concat(chunks).toString("utf8");
  assert.ok(output.includes("draft gate"), "should print draft gate section");
  assert.ok(output.includes("pre-approval gate"), "should print pre-approval gate section");
});

test("direct entrypoints parse to the canonical public intent (#972)", () => {
  for (const [input, intent] of [
    [["start", "112"], "start dev loop on issue 112"],
    [["auto", "112"], "auto dev loop on issue 112"],
    [["continue", "88"], "continue dev loop on PR 88"],
    [["start", "#112"], "start dev loop on issue 112"], // tolerate a leading #
  ]) {
    const parsed = parseDevLoopsCommand(input, { surface: "extension" });
    assert.equal(parsed.kind, "entrypoint");
    assert.equal(parsed.action, input[0]);
    assert.equal(parsed.intent, intent);
    // Parity: same parse on the CLI surface (these are public entrypoints, not Pi-only UX).
    assert.deepEqual(parseDevLoopsCommand(input, { surface: "cli" }), parsed);
  }
});

test("direct entrypoints reject missing or non-numeric targets (#972)", () => {
  assert.equal(parseDevLoopsCommand(["start"], { surface: "extension" }).kind, "malformed");
  assert.equal(parseDevLoopsCommand(["continue", "main"], { surface: "extension" }).kind, "malformed");
  assert.equal(parseDevLoopsCommand(["info", "1", "2"], { surface: "extension" }).kind, "malformed");
});

test("executor surfaces the entrypoint intent for dispatch (#972)", async () => {
  const result = await executeDevLoopsCommand({
    input: ["continue", "88"],
    surface: "extension",
    runtime: createRuntime(),
  });
  assert.equal(result.kind, "entrypoint");
  assert.equal(result.action, "continue");
  assert.equal(result.number, "88");
  assert.equal(result.intent, "continue dev loop on PR 88");
});
