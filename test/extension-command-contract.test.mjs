import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import registerExtension, { syncPackagedAgents } from "../extension/index.ts";

function createPiDouble({ commandResults = new Map(), tools = [], commands = [] } = {}) {
  const events = new Map();
  const registeredCommands = new Map();

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
    on(event, handler) {
      events.set(event, handler);
    },
    registerCommand(name, config) {
      registeredCommands.set(name, config);
    },
    events,
    registeredCommands,
  };
}

function createCommandContext() {
  const calls = {
    widgets: [],
    notifications: [],
    statuses: [],
  };

  return {
    ctx: {
      ui: {
        setWidget(key, lines, options) {
          calls.widgets.push({ key, lines, options });
        },
        notify(message, level) {
          calls.notifications.push({ message, level });
        },
        setStatus(key, text) {
          calls.statuses.push({ key, text });
        },
      },
    },
    calls,
  };
}

function readyPi() {
  return createPiDouble({
    commandResults: new Map([
      ["command -v gh >/dev/null 2>&1", 0],
      ["gh auth status >/dev/null 2>&1", 0],
      ["command -v subagent >/dev/null 2>&1", 0],
      ["git rev-parse --is-inside-work-tree >/dev/null 2>&1", 0],
    ]),
    commands: [{ name: "skill:dev-loop" }],
  });
}

test("extension clears stale footer status and syncs packaged agents on session start", async () => {
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dev-loops-session-home-"));
  process.env.HOME = tempHome;

  try {
    const pi = readyPi();
    registerExtension(pi);

    assert.equal(typeof pi.events.get("session_start"), "function");
    assert.equal(typeof pi.registeredCommands.get("dev-loops")?.handler, "function");

    await mkdir(path.join(tempHome, ".agents"), { recursive: true });
    await writeFile(path.join(tempHome, ".agents", "dev-loop.agent.md"), "stale copy\n");
    await writeFile(path.join(tempHome, ".agents", "keep.txt"), "keep me\n");

    const { ctx, calls } = createCommandContext();
    await pi.events.get("session_start")({}, ctx);

    assert.deepEqual(calls.statuses, [{ key: "dev-loops", text: undefined }]);
    assert.equal(
      await readFile(path.join(tempHome, ".agents", "dev-loop.agent.md"), "utf8"),
      await readFile(new URL("../.pi/agents/dev-loop.agent.md", import.meta.url), "utf8"),
    );
    assert.equal(await readFile(path.join(tempHome, ".agents", "keep.txt"), "utf8"), "keep me\n");
    await access(path.join(tempHome, ".agents", "developer.agent.md"));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("syncPackagedAgents creates the target directory and only copies .agent.md files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-agent-sync-"));
  const sourceRoot = path.join(tempDir, "source");
  const targetRoot = path.join(tempDir, "target");

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "developer.agent.md"), "developer\n");
  await writeFile(path.join(sourceRoot, "ignore.txt"), "ignore\n");

  await syncPackagedAgents({ sourceRoot, targetRoot });

  assert.equal(await readFile(path.join(targetRoot, "developer.agent.md"), "utf8"), "developer\n");
  await assert.rejects(access(path.join(targetRoot, "ignore.txt")));
});

test("help is the default action and removed install/update commands fall back to help", async () => {
  const pi = readyPi();
  registerExtension(pi);
  const { ctx, calls } = createCommandContext();

  await pi.registeredCommands.get("dev-loops").handler("", ctx);

  const widget = calls.widgets.at(-1);
  assert.equal(widget.key, "dev-loops.setup");
  assert.match(widget.lines[0], /dev-loops help/);
  assert(widget.lines.some((line) => /\/dev-loops status/i.test(line)));
  assert(widget.lines.some((line) => /pi install git:github.com\/mfittko\/dev-loops/i.test(line)));
  assert(widget.lines.some((line) => /\/skill:dev-loop/i.test(line)), "help should mention /skill:dev-loop as workflow entry");
  assert(widget.lines.some((line) => /single public entry/i.test(line)), "help should describe dev-loop as single public entry");
  assert.equal(widget.lines.some((line) => /copilot-dev-loop|copilot-autopilot/i.test(line)), false, "help should not surface internal seam names");
  assert.doesNotMatch(widget.lines.join("\n"), /\/dev-loops (?:install|update)/i);
  assert.equal(calls.notifications.at(-1).message, "dev-loops help");

  const installContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("install repo", installContext.ctx);
  assert.match(installContext.calls.widgets.at(-1).lines[0], /dev-loops help/);
  assert.equal(installContext.calls.notifications.at(-1).message, "dev-loops help");

  const bareInstallContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("install", bareInstallContext.ctx);
  assert.match(bareInstallContext.calls.widgets.at(-1).lines[0], /dev-loops help/);
  assert.equal(bareInstallContext.calls.notifications.at(-1).message, "dev-loops help");

  const updateContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("update", updateContext.ctx);
  assert.match(updateContext.calls.widgets.at(-1).lines[0], /dev-loops help/);
  assert.equal(updateContext.calls.notifications.at(-1).message, "dev-loops help");

  const bareUpdateContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("update system", bareUpdateContext.ctx);
  assert.match(bareUpdateContext.calls.widgets.at(-1).lines[0], /dev-loops help/);
  assert.equal(bareUpdateContext.calls.notifications.at(-1).message, "dev-loops help");

  const statusWithExtraArgsContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("status extra", statusWithExtraArgsContext.ctx);
  assert.match(statusWithExtraArgsContext.calls.widgets.at(-1).lines[0], /dev-loops status:/);
  assert.equal(statusWithExtraArgsContext.calls.notifications.at(-1).message, "dev-loops status: 4/4 checks passed");
});

test("status and doctor use the reduced readiness surface", async () => {
  const pi = createPiDouble({
    commandResults: new Map([
      ["command -v gh >/dev/null 2>&1", 1],
      ["gh auth status >/dev/null 2>&1", 1],
      ["git rev-parse --is-inside-work-tree >/dev/null 2>&1", 0],
    ]),
    tools: [],
    commands: [{ name: "skill:dev-loop" }],
  });
  registerExtension(pi);

  const doctorContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("doctor", doctorContext.ctx);
  const doctorLines = doctorContext.calls.widgets.at(-1).lines;
  assert(doctorLines.some((line) => /^⚠️ GitHub CLI installed/.test(line)));
  assert(doctorLines.some((line) => /^⚠️ GitHub CLI authenticated/.test(line)));
  assert.equal(doctorLines.some((line) => /Local dev-loop skill discoverable/i.test(line)), false);
  assert.equal(doctorLines.some((line) => /copilot-dev-loop|copilot-autopilot/i.test(line)), false);
  assert(doctorLines.some((line) => /Skills load via `pi install git:github.com\/mfittko\/dev-loops`/i.test(line)));

  const statusContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("status", statusContext.ctx);
  const statusLines = statusContext.calls.widgets.at(-1).lines;
  assert(statusLines.some((line) => /Local loop readiness: needs setup/i.test(line)));
  assert(statusLines.some((line) => /Remote GitHub\/Copilot readiness: needs setup/i.test(line)));
  assert.equal(statusLines.some((line) => /local-dev-loop-skill/i.test(line)), false);
});

test("hide still clears the widget and unknown commands fall back to help", async () => {
  const pi = readyPi();
  registerExtension(pi);

  const hideContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("hide", hideContext.ctx);
  assert.deepEqual(hideContext.calls.widgets.at(-1), {
    key: "dev-loops.setup",
    lines: undefined,
    options: undefined,
  });
  assert.equal(hideContext.calls.notifications.at(-1).message, "dev-loops widget hidden");

  const fallbackContext = createCommandContext();
  await pi.registeredCommands.get("dev-loops").handler("banana", fallbackContext.ctx);
  assert.match(fallbackContext.calls.widgets.at(-1).lines[0], /dev-loops help/);
  assert.equal(fallbackContext.calls.notifications.at(-1).message, "dev-loops help");
});

test("extension dispatches inspect-run open and surfaces browser warnings without failing the launch", async () => {
  const pi = readyPi();
  registerExtension(pi, {
    uiLifecycle: {
      async open({ repoRoot, repo }) {
        assert.equal(repoRoot, '/repo/root');
        assert.equal(repo, 'mfittko/dev-loops');
        return {
          state: 'running',
          url: 'http://127.0.0.1:4311/?scope=mfittko%2Fdev-loops',
          detail: 'Reused the managed inspect-run viewer.',
          warning: 'browser unavailable',
        };
      },
    },
    getRepoRoot: async () => '/repo/root',
  });

  const { ctx, calls } = createCommandContext();
  await pi.registeredCommands.get('dev-loops').handler('inspect open --repo mfittko/dev-loops', ctx);

  const widget = calls.widgets.at(-1);
  assert.equal(widget.key, 'dev-loops.setup');
  assert(widget.lines.some((line) => /inspect open/i.test(line)));
  assert(widget.lines.some((line) => /running/i.test(line)));
  assert(widget.lines.some((line) => /http:\/\/127\.0\.0\.1:4311/i.test(line)));
  assert(widget.lines.some((line) => /browser unavailable/i.test(line)));
  assert.equal(calls.notifications.at(-1).message, 'inspect open: running');
  assert.equal(calls.notifications.at(-1).level, 'info');
});

test("extension surfaces fail-closed resume guidance when no managed viewer is live", async () => {
  const pi = readyPi();
  registerExtension(pi, {
    uiLifecycle: {
      async resume() {
        return {
          state: 'stopped',
          url: null,
          detail: 'No managed inspect-run viewer is running; use `/dev-loops inspect open`.',
          warning: null,
        };
      },
    },
    getRepoRoot: async () => '/repo/root',
  });

  const { ctx, calls } = createCommandContext();
  await pi.registeredCommands.get('dev-loops').handler('inspect resume', ctx);

  const widget = calls.widgets.at(-1);
  assert(widget.lines.some((line) => /inspect resume/i.test(line)));
  assert(widget.lines.some((line) => /stopped/i.test(line)));
  assert(widget.lines.some((line) => /use `\/dev-loops inspect open`/i.test(line)));
  assert.equal(calls.notifications.at(-1).message, 'inspect resume: stopped');
  assert.equal(calls.notifications.at(-1).level, 'error');
});

test('extension treats successful inspect-run stop as an info notification', async () => {
  const pi = readyPi();
  registerExtension(pi, {
    uiLifecycle: {
      async stop() {
        return {
          state: 'stopped',
          url: null,
          detail: 'Stopped the managed inspect-run viewer.',
          warning: null,
        };
      },
    },
    getRepoRoot: async () => '/repo/root',
  });

  const { ctx, calls } = createCommandContext();
  await pi.registeredCommands.get('dev-loops').handler('inspect stop', ctx);

  assert.equal(calls.notifications.at(-1).message, 'inspect stop: stopped');
  assert.equal(calls.notifications.at(-1).level, 'info');
});

test('extension keeps fail-closed stopped inspect-run results on error severity', async () => {
  const pi = readyPi();
  registerExtension(pi, {
    uiLifecycle: {
      async stop() {
        return {
          state: 'stopped',
          url: null,
          detail: 'A different managed inspect-run viewer is running; stop without `--repo` or use `open` to replace it for this repo.',
          warning: null,
        };
      },
    },
    getRepoRoot: async () => '/repo/root',
  });

  const { ctx, calls } = createCommandContext();
  await pi.registeredCommands.get('dev-loops').handler('inspect stop --repo other/repo', ctx);

  assert.equal(calls.notifications.at(-1).message, 'inspect stop: stopped');
  assert.equal(calls.notifications.at(-1).level, 'error');
});

test('extension renders inspect-run status as an info notification when the managed viewer is running', async () => {
  const pi = readyPi();
  registerExtension(pi, {
    uiLifecycle: {
      async status() {
        return {
          state: 'running',
          url: 'http://127.0.0.1:4311',
          detail: 'Managed inspect-run viewer is running.',
          warning: null,
          record: { pid: 1234 },
        };
      },
    },
    getRepoRoot: async () => '/repo/root',
  });

  const { ctx, calls } = createCommandContext();
  await pi.registeredCommands.get('dev-loops').handler('inspect status', ctx);

  assert.equal(calls.notifications.at(-1).message, 'inspect status: running');
  assert.equal(calls.notifications.at(-1).level, 'info');
  assert(calls.widgets.at(-1).lines.some((line) => /Managed inspect-run viewer is running/i.test(line)));
});

test('extension keeps inspect-run restart conflicts on error severity', async () => {
  const pi = readyPi();
  registerExtension(pi, {
    uiLifecycle: {
      async restart() {
        return {
          state: 'conflict_unmanaged_listener',
          url: 'http://127.0.0.1:4311',
          detail: 'Restart refused to stop an unmanaged listener on the inspect-run viewer port.',
          warning: null,
          record: null,
        };
      },
    },
    getRepoRoot: async () => '/repo/root',
  });

  const { ctx, calls } = createCommandContext();
  await pi.registeredCommands.get('dev-loops').handler('inspect restart', ctx);

  assert.equal(calls.notifications.at(-1).message, 'inspect restart: conflict_unmanaged_listener');
  assert.equal(calls.notifications.at(-1).level, 'error');
});
