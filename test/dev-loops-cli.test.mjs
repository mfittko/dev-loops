import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { compareSemver, createCliRuntime, fetchLatestPublishedVersion, isPlausibleDistTagVersion, runCli } from "../cli/index.mjs";
import { EventEmitter } from "node:events";
import { SETUP_GUIDANCE } from "../lib/dev-loops-core.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function createBufferStream() {
  let output = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    read() {
      return output;
    },
  };
}

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

test("package CLI entrypoint prints help and rejects hide as unsupported", () => {
  const help = spawnSync("node", ["./cli/index.mjs", "help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /dev-loops help/);
  assert.match(help.stdout, /dev-loops status/);
  assert.equal(help.stderr, "");

  const hide = spawnSync("node", ["./cli/index.mjs", "hide"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(hide.status, 1);
  assert.match(hide.stderr, /not supported outside the Pi extension/i);
  assert.equal(hide.stdout, "");
});

test("CLI renderer keeps shared status behavior and shell-friendly argument errors", async () => {
  const statusStdout = createBufferStream();
  const statusStderr = createBufferStream();
  const statusExitCode = await runCli({
    argv: ["status"],
    runtime: createRuntime(),
    stdout: statusStdout.stream,
    stderr: statusStderr.stream,
  });

  assert.equal(statusExitCode, 0);
  assert.match(statusStdout.read(), /Local loop readiness: ready/);
  assert.match(statusStdout.read(), /Remote GitHub\/Copilot readiness: ready/);
  assert.match(statusStdout.read(), /Suggested next steps:/);
  assert.equal(statusStderr.read(), "");

  const removedStdout = createBufferStream();
  const removedStderr = createBufferStream();
  const removedExitCode = await runCli({
    argv: ["install", "moon"],
    runtime: createRuntime(),
    stdout: removedStdout.stream,
    stderr: removedStderr.stream,
  });

  assert.equal(removedExitCode, 1);
  assert.equal(removedStdout.read(), "");
  assert.match(removedStderr.read(), /Unrecognized command: install\./);
  assert.match(removedStderr.read(), /dev-loops help/);

  const malformedStdout = createBufferStream();
  const malformedStderr = createBufferStream();
  const malformedExitCode = await runCli({
    argv: ["status", "extra"],
    runtime: createRuntime(),
    stdout: malformedStdout.stream,
    stderr: malformedStderr.stream,
  });

  assert.equal(malformedExitCode, 1);
  assert.equal(malformedStdout.read(), "");
  assert.match(malformedStderr.read(), /`status` does not accept additional arguments\./);
  assert.match(malformedStderr.read(), /Usage:\n- dev-loops status/);
});

test("CLI setup guidance for failing checks is the shared core map (#1421)", async () => {
  const failingRuntime = createRuntime({
    async commandExists() {
      return false;
    },
    async ghAuthOk() {
      return false;
    },
    async insideGitRepo() {
      return false;
    },
    async getSubagentAvailability() {
      return { ok: false, availableDetail: "n/a", unavailableDetail: "missing subagent" };
    },
  });

  const statusStdout = createBufferStream();
  const statusExitCode = await runCli({
    argv: ["status"],
    runtime: failingRuntime,
    stdout: statusStdout.stream,
    stderr: createBufferStream().stream,
  });

  assert.equal(statusExitCode, 0);
  const output = statusStdout.read();
  assert(output.includes(`1. ${SETUP_GUIDANCE["gh-installed"]}`));
  assert(output.includes(`2. ${SETUP_GUIDANCE["gh-auth"]}`));
  assert(output.includes(`3. ${SETUP_GUIDANCE["subagent-command"]}`));
  assert(output.includes(`4. ${SETUP_GUIDANCE["git-repo"]}`));
});

test("CLI help leads with dev-loop as the primary workflow entry", async () => {
  const helpStdout = createBufferStream();
  const helpStderr = createBufferStream();
  const helpExitCode = await runCli({
    argv: ["help"],
    runtime: createRuntime(),
    stdout: helpStdout.stream,
    stderr: helpStderr.stream,
  });

  assert.equal(helpExitCode, 0);
  assert.match(helpStdout.read(), /\/skill:dev-loop/, "CLI help should mention /skill:dev-loop as workflow entry");
  assert.match(helpStdout.read(), /single public entry/, "CLI help should describe dev-loop as single public entry");
  assert.doesNotMatch(helpStdout.read(), /dev-loops (?:install|update)/);
  assert.doesNotMatch(helpStdout.read(), /copilot-dev-loop|copilot-autopilot/i, "CLI help should not surface internal seam names");
  assert.equal(helpStderr.read(), "");
});


test("loop category exposes every running-app stage subcommand (five ui-review stages + visual-grill capture)", async () => {
  const helpStdout = createBufferStream();
  const categoryStdout = createBufferStream();

  const helpExitCode = await runCli({
    argv: ["help"],
    runtime: createRuntime(),
    stdout: helpStdout.stream,
    stderr: createBufferStream().stream,
  });
  const categoryExitCode = await runCli({
    argv: ["loop", "--help"],
    runtime: createRuntime(),
    stdout: categoryStdout.stream,
    stderr: createBufferStream().stream,
  });

  assert.equal(helpExitCode, 0);
  assert.equal(categoryExitCode, 0);
  const topLevelHelp = helpStdout.read();
  const categoryHelp = categoryStdout.read();
  const uiReviewSubcommands = [
    "ui-review-provision",
    "ui-review-drive",
    "ui-review-diagnose",
    "ui-review-report",
    "ui-review-teardown",
    // The visual-grill capture is the sixth running-app stage: it ships in the
    // same tree and is routed the same way, so it belongs to the same contract.
    "visual-grill-capture",
  ];
  for (const sub of uiReviewSubcommands) {
    assert.match(topLevelHelp, new RegExp(`\\b${sub}\\b`), `top-level help should list ${sub}`);
    assert.match(categoryHelp, new RegExp(`\\b${sub}\\b`), `loop --help should list ${sub}`);
    // A route registered without a matching description renders as a bare name,
    // which reads as a rendering glitch rather than a missing entry — so require
    // the listing line to carry description text, not just the subcommand.
    assert.match(
      categoryHelp,
      new RegExp(`^\\s*${sub}\\s+\\S.*$`, "m"),
      `loop --help should give ${sub} a one-line description`,
    );

    const helpRun = spawnSync("node", ["./cli/index.mjs", "loop", sub, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(helpRun.status, 0, `dev-loops loop ${sub} --help should exit 0: ${helpRun.stderr}`);
  }
});

test("CLI help exposes project queue wrapper surface", async () => {
  const helpStdout = createBufferStream();
  const helpStderr = createBufferStream();
  const categoryStdout = createBufferStream();
  const categoryStderr = createBufferStream();

  const helpExitCode = await runCli({
    argv: ["help"],
    runtime: createRuntime(),
    stdout: helpStdout.stream,
    stderr: helpStderr.stream,
  });
  const categoryExitCode = await runCli({
    argv: ["project", "--help"],
    runtime: createRuntime(),
    stdout: categoryStdout.stream,
    stderr: categoryStderr.stream,
  });

  assert.equal(helpExitCode, 0);
  assert.equal(categoryExitCode, 0);
  assert.match(helpStdout.read(), /dev-loops project <sub>/);
  assert.match(helpStdout.read(), /GitHub Projects queue helpers/);
  const categoryHelp = categoryStdout.read();
  assert.match(categoryHelp, /dev-loops project <subcommand>/);
  assert.match(categoryHelp, /list\s+List queue board items/);
  assert.match(categoryHelp, /ensure\s+Create\/repair queue board bootstrap surface/);
  assert.equal(helpStderr.read(), "");
  assert.equal(categoryStderr.read(), "");
});


test("queue category help lists run plus management subcommands (issue #912)", async () => {
  const stdout = createBufferStream();
  const stderr = createBufferStream();
  const exitCode = await runCli({
    argv: ["queue", "--help"],
    runtime: createRuntime(),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  const help = stdout.read();
  assert.match(help, /dev-loops queue <subcommand>/);
  for (const sub of ["run", "add", "list", "reorder", "move", "sync-status", "archive-done"]) {
    assert.match(help, new RegExp(`\\b${sub.replace("-", "\\-")}\\b`), `queue --help should list ${sub}`);
  }
  assert.match(help, /add\s+Add issue\/PR to queue board/);
  assert.equal(stderr.read(), "");
});

test("project routes are exactly queue routes minus run (issue #1090)", async () => {
  const readSubcommands = async (category) => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const exitCode = await runCli({
      argv: [category, "--help"],
      runtime: createRuntime(),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    return stdout.read()
      .split("\n")
      .map((line) => line.match(/^ {4}(\S+)/)?.[1])
      .filter(Boolean);
  };

  const queueSubs = await readSubcommands("queue");
  const projectSubs = await readSubcommands("project");

  assert.ok(queueSubs.includes("run"), "queue must expose run");
  assert.ok(!projectSubs.includes("run"), "project help must omit run");
  assert.deepEqual(projectSubs, queueSubs.filter((sub) => sub !== "run"));
});

test("queue add/list route to the same project scripts via --help usage (issue #912)", () => {
  const add = spawnSync("node", ["./cli/index.mjs", "queue", "add", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /Add an existing issue or PR to a GitHub Projects V2 board/);
  assert.match(add.stdout, /--column <name>/);
  assert.match(add.stdout, /--status <name>\s+Back-compat alias for --column/);

  const list = spawnSync("node", ["./cli/index.mjs", "queue", "list", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /List GitHub Projects V2 items filtered by Status column/);
});

test("CLI status next steps lead with dev-loop when all checks pass", async () => {
  const statusStdout = createBufferStream();
  const statusStderr = createBufferStream();
  const statusExitCode = await runCli({
    argv: ["status"],
    runtime: createRuntime(),
    stdout: statusStdout.stream,
    stderr: statusStderr.stream,
  });

  assert.equal(statusExitCode, 0);
  assert.match(statusStdout.read(), /\/skill:dev-loop/, "CLI status should suggest /skill:dev-loop when all checks pass");
  assert.match(statusStdout.read(), /single public entry/, "CLI status should describe dev-loop as single public entry when ready");
  assert.doesNotMatch(statusStdout.read(), /copilot-dev-loop|copilot-autopilot/i, "CLI status should not surface internal seam names");
  assert.equal(statusStderr.read(), "");
});


test("createCliRuntime rejects path-like command probes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cli-path-guard-"));
  const binDir = path.join(tempRoot, "bin");
  const nestedDir = path.join(binDir, "foo");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(path.join(nestedDir, "bar"), `#!/bin/sh
exit 0
`);
  await chmod(path.join(nestedDir, "bar"), 0o755);

  try {
    const runtime = createCliRuntime({
      cwd: tempRoot,
      searchPath: binDir,
    });

    assert.equal(await runtime.commandExists("foo/bar"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});


test("createCliRuntime probes PATH commands and git repositories without a login shell", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cli-runtime-"));
  const binDir = path.join(tempRoot, "bin");
  const repoDir = path.join(tempRoot, "repo");
  await mkdir(binDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/bin/sh
exit 0
`);
  await writeFile(path.join(binDir, "subagent"), `#!/bin/sh
exit 0
`);
  await chmod(path.join(binDir, "gh"), 0o755);
  await chmod(path.join(binDir, "subagent"), 0o755);

  const init = spawnSync("git", ["init", "-q"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);

  const previousPath = process.env.PATH;

  try {
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    const runtime = createCliRuntime({ cwd: repoDir });
    assert.equal(await runtime.commandExists("subagent"), true);
    assert.equal(await runtime.ghAuthOk(), true);
    assert.equal(await runtime.insideGitRepo(), true);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});


test("createCliRuntime honors PATHEXT lookups when simulating Windows PATH resolution", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cli-win-runtime-"));
  const binDir = path.join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh.EXE"), "");
  await writeFile(path.join(binDir, "subagent.CMD"), "");
  await writeFile(path.join(binDir, "git"), "");

  try {
    const runtime = createCliRuntime({
      cwd: tempRoot,
      searchPath: binDir,
      platform: "win32",
      pathExt: ".EXE;.CMD",
    });

    assert.equal(await runtime.commandExists("gh"), true);
    assert.equal(await runtime.commandExists("subagent"), true);
    assert.equal(await runtime.commandExists("git"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI rejects removed update command", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-cli-update-"));
  const stdout = createBufferStream();
  const stderr = createBufferStream();

  try {
    const exitCode = await runCli({
      argv: ["update", "system"],
      runtime: createRuntime(),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), "");
    assert.match(stderr.read(), /Unrecognized command: update\./);
    assert.match(stderr.read(), /dev-loops help/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});


test("project wrappers pass through helper stdout and exit codes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-project-cli-"));
  const binDir = path.join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const ghImplPath = path.join(binDir, "gh-impl.mjs");
  const ghPath = path.join(binDir, process.platform === "win32" ? "gh.cmd" : "gh");
  const ghImpl = `const queryArg = process.argv.find((arg) => arg.startsWith("query=")) ?? "";
const query = queryArg.slice("query=".length);
function write(payload) {
  process.stdout.write(JSON.stringify(payload));
}
if (query.includes("user(login:$login) { id }")) {
  write({ data: { user: { id: "U_1" } } });
} else if (query.includes("projectsV2(first:50, after:$after)")) {
  write({ data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PVT_proj1", number: 1, title: "Dev Loop Queue", url: "https://github.com/users/mfittko/projects/1" }] } } } });
} else if (query.includes("fields(first:50, after:$after)")) {
  write({ data: { node: { fields: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PVTSSF_1", name: "Status", options: [{ id: "opt1", name: "Backlog" }, { id: "opt2", name: "Next Up" }] }] } } } });
} else if (query.includes("items(first:100, after:$after)")) {
  write({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PVTI_1", fieldValues: { nodes: [{ field: { id: "PVTSSF_1", name: "Status" }, name: "Next Up" }] }, content: { number: 748, title: "Public CLI surface", url: "https://github.com/mfittko/dev-loops/issues/748", id: "I_748" } }] } } } });
} else {
  process.stderr.write(JSON.stringify({ ok: false, error: "Unhandled query: " + query }));
  process.exit(1);
}
`;
  const ghLauncher = process.platform === "win32"
    ? `@echo off
node "%~dp0\gh-impl.mjs" %*
`
    : `#!/bin/sh
node "$(dirname "$0")/gh-impl.mjs" "$@"
`;
  await writeFile(ghImplPath, ghImpl);
  await writeFile(ghPath, ghLauncher);
  await chmod(ghPath, 0o755);

  try {
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    const success = spawnSync("node", ["./cli/index.mjs", "project", "list", "--repo", "mfittko/dev-loops", "--project", "1", "--column", "Next Up"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, "");
    const payload = JSON.parse(success.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].issueNumber, 748);
    assert.equal(payload.items[0].status, "Next Up");

    const failure = spawnSync("node", ["./cli/index.mjs", "project", "list"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /--repo is required/);
    assert.match(failure.stderr, /"code":"INVALID_REPO"/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// compareSemver: direct unit coverage of the SemVer 2.0.0 precedence rules
// `doctor`'s freshness check depends on (build metadata ignored, prerelease <
// release, numeric prerelease-identifier ordering).
test("compareSemver: a stable release outranks any prerelease of the same core", () => {
  assert.equal(compareSemver("1.0.0-rc.3", "1.0.0") < 0, true);
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.3") > 0, true);
});

test("compareSemver: numeric prerelease identifiers order numerically, not lexically (rc.3 < rc.10)", () => {
  assert.equal(compareSemver("1.0.0-rc.3", "1.0.0-rc.10") < 0, true);
  assert.equal(compareSemver("1.0.0-rc.10", "1.0.0-rc.3") > 0, true);
});

test("compareSemver: equal versions (including build metadata, which is ignored) compare equal", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("1.2.3+build1", "1.2.3+build2"), 0);
  assert.equal(compareSemver("1.0.0-rc.3", "1.0.0-rc.3"), 0);
});

test("compareSemver: malformed input degrades to a 0.0.0-shaped core rather than throwing", () => {
  assert.doesNotThrow(() => compareSemver("bogus", "alsobogus"));
  assert.equal(compareSemver("bogus", "alsobogus"), 0);
  assert.equal(compareSemver("1.2.3", "bogus") > 0, true);
});

// `doctor` self-diagnoses a stale install (#1481): a dangling scripts/
// reference or an unexplained tooling failure is often really an old
// global/local `dev-loops` shadowing a newer checkout. These exercise the
// injected `fetchLatestVersion` seam so the registry call never actually
// leaves the process in tests.
const runningVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

test("doctor warns when the running install is behind the latest published version", async () => {
  const doctorStdout = createBufferStream();
  const exitCode = await runCli({
    argv: ["doctor"],
    runtime: createRuntime(),
    stdout: doctorStdout.stream,
    stderr: createBufferStream().stream,
    fetchLatestVersion: async () => "9999.0.0",
  });

  assert.equal(exitCode, 0);
  const out = doctorStdout.read();
  assert.match(out, new RegExp(`Running dev-loops@${runningVersion.replace(/[.+]/g, "\\$&")} from `));
  assert.match(out, /⚠️ Install freshness/);
  assert.match(out, /latest published is 9999\.0\.0/);
  assert.match(out, /npx dev-loops@latest/);
});

test("doctor does not warn when the running install matches the latest published version", async () => {
  const doctorStdout = createBufferStream();
  const exitCode = await runCli({
    argv: ["doctor"],
    runtime: createRuntime(),
    stdout: doctorStdout.stream,
    stderr: createBufferStream().stream,
    fetchLatestVersion: async () => runningVersion,
  });

  assert.equal(exitCode, 0);
  const out = doctorStdout.read();
  assert.match(out, /✅ Install freshness/);
  assert.match(out, /Running the latest published version/);
});

test("doctor degrades gracefully (no crash, no warning) when the registry is unreachable", async () => {
  const doctorStdout = createBufferStream();
  const exitCode = await runCli({
    argv: ["doctor"],
    runtime: createRuntime(),
    stdout: doctorStdout.stream,
    stderr: createBufferStream().stream,
    fetchLatestVersion: async () => { throw new Error("ETIMEDOUT"); },
  });

  assert.equal(exitCode, 0);
  const out = doctorStdout.read();
  assert.match(out, /✅ Install freshness/);
  assert.match(out, /latest-version check skipped \(registry unreachable\)/);
});

// ---------------------------------------------------------------------------
// fetchLatestPublishedVersion: drive the status/size-cap/dist-tag paths via
// the injectable getImpl seam (no network). The fake mimics https.get's
// (url, opts, cb) shape: cb receives a response emitter; the returned request
// emitter records destroy().
// ---------------------------------------------------------------------------

function fakeGet(handler) {
  return (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    const res = new EventEmitter();
    res.resume = () => {};
    queueMicrotask(() => handler({ req, res, cb }));
    return req;
  };
}

test("fetchLatestPublishedVersion: max across dist-tags wins, implausible tag values filtered", async () => {
  const body = JSON.stringify({
    "dist-tags": {
      latest: "0.9.0",
      rc: "1.0.0-rc.3",
      weird: "not-a-version",
      huge: `1.0.${"9".repeat(80)}`,
      empty: "",
    },
  });
  const version = await fetchLatestPublishedVersion("dev-loops", {
    getImpl: fakeGet(({ res, cb }) => {
      res.statusCode = 200;
      cb(res);
      res.emit("data", body);
      res.emit("end");
    }),
  });
  assert.equal(version, "1.0.0-rc.3");
});

test("fetchLatestPublishedVersion: non-200 resolves null", async () => {
  const version = await fetchLatestPublishedVersion("dev-loops", {
    getImpl: fakeGet(({ res, cb }) => {
      res.statusCode = 404;
      cb(res);
    }),
  });
  assert.equal(version, null);
});

test("fetchLatestPublishedVersion: response-size cap aborts and resolves null", async () => {
  const version = await fetchLatestPublishedVersion("dev-loops", {
    getImpl: fakeGet(({ res, cb }) => {
      res.statusCode = 200;
      cb(res);
      const chunk = "x".repeat(1024 * 1024);
      res.emit("data", chunk);
      res.emit("data", chunk);
      res.emit("data", chunk); // > 2MB cap
    }),
  });
  assert.equal(version, null);
});

test("fetchLatestPublishedVersion: wall-clock deadline settles null on a silent request", async () => {
  const version = await fetchLatestPublishedVersion("dev-loops", {
    timeoutMs: 20,
    getImpl: fakeGet(() => { /* never calls back — deadline must fire */ }),
  });
  assert.equal(version, null);
});

test("isPlausibleDistTagVersion: accepts x.y.z (with prerelease), rejects junk", () => {
  assert.equal(isPlausibleDistTagVersion("1.0.0"), true);
  assert.equal(isPlausibleDistTagVersion("1.0.0-rc.3"), true);
  assert.equal(isPlausibleDistTagVersion(""), false);
  assert.equal(isPlausibleDistTagVersion("latest"), false);
  assert.equal(isPlausibleDistTagVersion("1.0"), false);
  assert.equal(isPlausibleDistTagVersion(`1.0.0-${"a".repeat(80)}`), false);
});
