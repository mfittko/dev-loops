import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// In-process replacement for the PATH-installed gh stub (buildGhStubScript /
// writeGhStub). Returns `{ runChild, calls }` where `runChild(command, args, env,
// stdinText)` replays the SAME sequential semantics the PATH stub implements, but
// without spawning a node subprocess per gh call. Inject it via a script's
// `{ env, ghCommand, runChild }` context so the CLI logic runs in-process while
// every gh call is answered from `entries` in order. Assertion failures return the
// SAME non-zero exit codes the PATH stub exits with, so the script's own error path
// fires identically (a gh call past the end of `entries`, without
// repeatLastOnOverflow, returns exit code 97). Only `git` among non-gh commands
// resolves to a hermetic empty success — shadowing the incidental read-only metadata
// reads — while every other non-git/non-gh command throws loudly.
export function makeGhMock(entries = [], {
  command = "gh",
  repeatLastOnOverflow = false,
  defaultStdout = "{}\n",
} = {}) {
  const calls = [];
  let counter = 0;
  const runChild = async (cmd, args = [], _env, stdinText = "") => {
    calls.push({ command: cmd, args: [...args], stdinText: stdinText ?? "" });
    if (cmd !== command) {
      // Safety guard: the mock answers the stubbed command (gh) from `entries`
      // and hermetically resolves `git` to an empty success (the porcelain
      // status/no-conflicts default) so no real working tree is inspected. Any
      // OTHER command reaching runChild is unexpected — throw loudly so a stray
      // subprocess spawn can never pass silently.
      if (cmd === "git") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`makeGhMock: unexpected command through runChild: ${cmd} ${args.join(" ")}`);
    }
    const current = counter;
    if (current >= entries.length && !repeatLastOnOverflow) {
      return { code: 97, stdout: "", stderr: `unexpected extra gh call #${current + 1}: ${args.join(" ")}\n` };
    }
    const index = entries.length === 0 ? -1 : Math.min(current, entries.length - 1);
    const entry = index >= 0 ? (entries[index] ?? { stdout: defaultStdout }) : { stdout: defaultStdout };
    counter = current + 1;
    if (entry.assertArgs) {
      for (const expected of entry.assertArgs) {
        if (!args.includes(expected)) {
          return { code: 98, stdout: "", stderr: `missing expected gh arg: ${expected}${args.length > 0 ? `\nactual: ${args.join(" ")}` : ""}\n` };
        }
      }
    }
    if (entry.assertStdinIncludes) {
      for (const expected of entry.assertStdinIncludes) {
        if (!String(stdinText).includes(expected)) {
          return { code: 96, stdout: "", stderr: `missing expected stdin text: ${expected}\n` };
        }
      }
    }
    if (entry.assertStdinNotIncludes) {
      for (const forbidden of entry.assertStdinNotIncludes) {
        if (String(stdinText).includes(forbidden)) {
          return { code: 95, stdout: "", stderr: `unexpected stdin text: ${forbidden}\n` };
        }
      }
    }
    if (entry.assertArgContains) {
      for (const expected of entry.assertArgContains) {
        if (!args.some((a) => a.includes(expected))) {
          return { code: 94, stdout: "", stderr: `missing expected arg substring: ${expected}\nactual: ${args.join(" ")}\n` };
        }
      }
    }
    if (entry.assertArgNotContains) {
      for (const forbidden of entry.assertArgNotContains) {
        if (args.some((a) => a.includes(forbidden))) {
          return { code: 93, stdout: "", stderr: `unexpected arg substring: ${forbidden}\n` };
        }
      }
    }
    return {
      code: entry.exitCode ?? 0,
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
    };
  };
  return { runChild, calls };
}

// Shared fixture body: minimal issue-less PR-body-as-spec content (no linked
// issue) that satisfies the refinement check, matching an ordinary sanctioned
// draft PR. Tests exercising draft/ready or gate-posting logic downstream of
// the refinement check reuse this instead of the check's own content itself.
export const DEFAULT_TEST_PR_BODY = [
  "## Objective",
  "",
  "Test fixture body.",
  "",
  "## In scope",
  "",
  "- the change under test",
  "",
  "## Explicit non-goals",
  "",
  "- n/a",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] covered by the test",
  "",
  "## Definition of done",
  "",
  "- [ ] tests pass",
  "",
  "## Open questions/risks",
  "",
  "- none",
  "",
].join("\n");

export function runNode(scriptPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.execPath ?? process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(options.stdinText ?? options.stdin ?? "");
  });
}

export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// Standard env for tests that spawn or in-process-call the dev-loop startup
// resolver. The async-start contract (packages/core/src/loop/async-start-contract.mjs)
// requires a recognized run-id marker (see run-context.mjs's RUN_ID_MARKERS)
// for async-dispatch strategies; hand-rolled env objects that omit it are
// green wherever an ambient marker happens to exist (a harness subagent
// session) and red in CI (where none does). Route every resolver-spawning
// test's env through this helper instead of hand-rolling the bypass/run-id
// keys.
//
// Pass `{ DEVLOOPS_RUN_ID: undefined }` to deliberately test the
// absent-marker fail-closed path — an explicit `undefined` override deletes
// the key rather than leaving it present-but-undefined.
export function resolverTestEnv(overrides = {}) {
  const env = {
    DEVLOOPS_WORKTREE_BYPASS: "1",
    DEVLOOPS_OWNERSHIP_BYPASS: "1",
    DEVLOOPS_RUN_ID: "test-run-resolver-env",
    ...overrides,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

function buildGhStubScript() {
  return [
    "#!/usr/bin/env node",
    'const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");',
    'const path = require("node:path");',
    'const sequencePath = process.env.GH_SEQUENCE_PATH;',
    'const counterPath = process.env.GH_COUNTER_PATH;',
    'const claimsDir = process.env.GH_CLAIMS_DIR;',
    'const ghLogPath = process.env.GH_LOG_PATH;',
    'const mode = process.env.GH_STUB_MODE || "sequential";',
    'const repeatLast = process.env.GH_REPEAT_LAST_ON_OVERFLOW === "1";',
    'const defaultStdout = process.env.GH_DEFAULT_STDOUT ?? "{}\\n";',
    'const entries = JSON.parse(readFileSync(sequencePath, "utf8"));',
    'const actual = process.argv.slice(2);',
    'const fail = (code, message) => { process.stderr.write(`${message}\\n`); process.exit(code); };',
    'let entry = null;',
    'if (mode === "claims") {',
    '  for (let index = 0; index < entries.length; index += 1) {',
    '    const candidate = entries[index] ?? { stdout: defaultStdout };',
    '    const expectedArgs = Array.isArray(candidate.assertArgs) ? candidate.assertArgs : [];',
    '    if (!expectedArgs.every((expected) => actual.includes(expected))) continue;',
    '    try {',
    '      mkdirSync(path.join(claimsDir, String(index)));',
    '      entry = candidate;',
    '      break;',
    '    } catch {',
    '      continue;',
    '    }',
    '  }',
    '  if (entry == null) {',
    '    fail(97, `unexpected gh args: ${actual.join(" ")}`);',
    '  }',
    '} else {',
    '  const current = Number(readFileSync(counterPath, "utf8").trim() || "0");',
    '  if (current >= entries.length && !repeatLast) {',
    '    fail(97, `unexpected extra gh call #${current + 1}: ${actual.join(" ")}`);',
    '  }',
    '  const index = entries.length === 0 ? -1 : Math.min(current, entries.length - 1);',
    '  entry = index >= 0 ? (entries[index] ?? { stdout: defaultStdout }) : { stdout: defaultStdout };',
    '  writeFileSync(counterPath, String(current + 1));',
    '}',
    'if (ghLogPath) {',
    '  appendFileSync(ghLogPath, `${JSON.stringify(actual)}\\n`);',
    '}',
    'let stdin = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    '  if (entry.assertArgs) {',
    '    for (const expected of entry.assertArgs) {',
    '      if (!actual.includes(expected)) {',
    '        fail(98, `missing expected gh arg: ${expected}${actual.length > 0 ? `\\nactual: ${actual.join(" ")}` : ""}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertStdinIncludes) {',
    '    for (const expected of entry.assertStdinIncludes) {',
    '      if (!stdin.includes(expected)) {',
    '        fail(96, `missing expected stdin text: ${expected}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertStdinNotIncludes) {',
    '    for (const forbidden of entry.assertStdinNotIncludes) {',
    '      if (stdin.includes(forbidden)) {',
    '        fail(95, `unexpected stdin text: ${forbidden}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertArgContains) {',
    '    for (const expected of entry.assertArgContains) {',
    '      if (!actual.some((a) => a.includes(expected))) {',
    '        fail(94, `missing expected arg substring: ${expected}\\nactual: ${actual.join(" ")}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertArgNotContains) {',
    '    for (const forbidden of entry.assertArgNotContains) {',
    '      if (actual.some((a) => a.includes(forbidden))) {',
    '        fail(93, `unexpected arg substring: ${forbidden}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.stderr) process.stderr.write(entry.stderr);',
    '  if (entry.stdout) process.stdout.write(entry.stdout);',
    '  process.exit(entry.exitCode ?? 0);',
    '});',
    "",
  ].join("\n");
}

export async function writeGhStub(tempDir, entries = [], {
  commandName = "gh",
  matchMode = "sequential",
  repeatLastOnOverflow = false,
  defaultStdout = "{}\n",
  logCalls = false,
} = {}) {
  const sequencePath = path.join(tempDir, `${commandName}-sequence.json`);
  const ghPath = path.join(tempDir, commandName);
  const counterPath = matchMode === "claims" ? null : path.join(tempDir, `${commandName}-counter.txt`);
  const claimsDir = matchMode === "claims" ? path.join(tempDir, `${commandName}-claims`) : null;
  const ghLogPath = logCalls ? path.join(tempDir, `${commandName}-log.jsonl`) : null;

  await writeFile(sequencePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  if (counterPath) {
    await writeFile(counterPath, "0\n", "utf8");
  }
  if (claimsDir) {
    await mkdir(claimsDir, { recursive: true });
  }
  if (ghLogPath) {
    await writeFile(ghLogPath, "", "utf8");
  }
  await writeFile(ghPath, buildGhStubScript(), "utf8");
  await chmod(ghPath, 0o755);

  const env = {
    ...process.env,
    PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    GH_SEQUENCE_PATH: sequencePath,
    GH_STUB_MODE: matchMode,
    GH_REPEAT_LAST_ON_OVERFLOW: repeatLastOnOverflow ? "1" : "0",
    GH_DEFAULT_STDOUT: defaultStdout,
  };

  if (counterPath) {
    env.GH_COUNTER_PATH = counterPath;
  }
  if (claimsDir) {
    env.GH_CLAIMS_DIR = claimsDir;
  }
  if (ghLogPath) {
    env.GH_LOG_PATH = ghLogPath;
  }

  return {
    env,
    ghPath,
    ghLogPath,
    sequencePath,
    counterPath,
    claimsDir,
  };
}
