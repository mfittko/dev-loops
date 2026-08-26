import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";

// Create an mkdtemp'd directory under os.tmpdir(), run `fn(dir)`, and always
// remove it afterward (even on throw/rejection). Shared across suites so a
// per-test temp fixture is one line instead of a hand-rolled mkdtemp/try/
// finally/rm block. Pass `prefix` to keep a suite's directory names
// recognizable (defaults to a generic marker for suites that don't care).
export async function withTempDir(fn, { prefix = "dev-loops-test-" } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Build a test env that strips the ambient async run-id markers from process.env.
//
// The dev-loop async path resolves an active run id from RUN_ID_MARKERS
// (DEVLOOPS_RUN_ID, then the Pi-runtime-injected alias) in precedence order (see
// packages/core/src/loop/run-context.mjs). Under a Pi async-subagent session the
// runtime injects its run-id alias into the child env, so a test env built via
// `{ ...process.env, DEVLOOPS_RUN_ID: "" }` still resolves the Pi marker and the
// suite behaves as if in a production async context — green in CI (no Pi marker),
// failing in a local worktree under Pi. Route gh/run-id test env construction
// through this helper so all ambient run-id markers (any DEVLOOPS marker and the
// Pi-injected alias) are stripped, then apply explicit overrides on top. CI is
// unaffected because it carries neither marker; overriding suites that intend an
// active run id pass `DEVLOOPS_RUN_ID` explicitly in overrides and it wins. Marker
// names come from the shared RUN_ID_MARKERS contract (the adapter boundary owns the
// Pi marker literal), keeping this helper harness-agnostic.
//
// @param {Record<string, string|undefined>} [overrides]
// @returns {Record<string, string|undefined>}
export function runIdFreeEnv(overrides = {}) {
  const base = { ...process.env };
  for (const marker of RUN_ID_MARKERS) delete base[marker];
  const env = { ...base, ...overrides };
  // The adapter boundary owns the marker literals; overrides may also unset a
  // key by passing `undefined` (matching resolverTestEnv's established
  // behavior). Drop undefined values so the env never carries a non-string
  // entry that child_process.spawn would reject.
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

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

// In-memory stdout/stderr sink for CLI-level tests that pass a `{ write, get }`
// stream stand-in instead of process.stdout/stderr. Distinct from makeGhMock/
// writeGhStub (which stub the `gh` command itself): this only captures what a
// script writes to a stream so a test can assert on it.
export function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

// In-memory `run(cmd, args)` stub for scripts/github/*.mjs unit tests that
// inject a two-arg `run` (not makeGhMock's four-arg `runChild`, and without
// makeGhMock's PATH-stub-parity exit-code-on-overflow contract or its
// hermetic `git` passthrough). Two entry shapes:
//   - order-based: entries are plain { code, stdout, stderr } and are
//     consumed one per call, in array order; pass `repeatLastOnOverflow: true`
//     to keep replaying the last entry forever instead of throwing once
//     entries run out (a fixed-response/single-payload stub).
//   - predicate-routed: entries are { match: (args) => boolean, resp: { code,
//     stdout, stderr } }; the first entry whose `match` returns true for a
//     given call answers it, regardless of call order (a same-signature
//     drop-in for the fetch-ci-logs-style command-matcher stub).
// Both throw (not an encoded exit code) when a call goes unanswered, matching
// the throw-based contract every converted local `stubGh` already used.
export function makeGhStub(entries = [], { repeatLastOnOverflow = false } = {}) {
  const calls = [];
  let counter = 0;
  const toResult = (resp) => ({ code: resp.code ?? 0, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" });
  const run = async (_cmd, args) => {
    calls.push(args);
    if (entries.length > 0 && typeof entries[0].match === "function") {
      const found = entries.find((entry) => entry.match(args));
      if (!found) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
      return toResult(found.resp ?? {});
    }
    if (counter >= entries.length) {
      if (repeatLastOnOverflow && entries.length > 0) return toResult(entries[entries.length - 1]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    }
    return toResult(entries[counter++]);
  };
  return { run, calls };
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

// ---------------------------------------------------------------------------
// Real-git fixture for the size-budget check (readyForReview / pre-pr-ready-
// gate wire computeSizeBudget over an ACTUAL local `git diff`, not a gh-stub
// response — see scripts/loop/check-size-budget.mjs's evaluatePrSizeBudget).
// Builds a tiny two-commit repo at `workDir`: a base commit, then a
// `refs/remotes/origin/<baseBranch>` ref pinned to it (the state a real
// `git fetch origin <base>` would leave, without touching the network), then
// one small head commit on top. Returns the real head SHA so the gh-stub PR
// payload's headRefOid can match what git actually computed — required
// because check-size-budget.mjs's diff-capture calls real `git`, not the gh
// stub.
// ---------------------------------------------------------------------------

const GIT_FIXTURE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // Mirror the isolation captureSizeBudgetDiff's gitEnvWithoutDirOverrides
  // applies in production: an ambient GIT_DIR/GIT_WORK_TREE would redirect
  // this fixture's init/add/commit calls into a different repo entirely.
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function runGitFixture(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_FIXTURE_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Common `git init` + identity + optional initial commit + optional remote
 * fixture. Identity comes from GIT_FIXTURE_ENV's author/committer overrides
 * (the same "Test <test@example.com>" every explicit `git config user.*` in
 * these suites already resolves to), so no separate config calls are needed.
 * @param {string} dir — an existing empty directory (e.g. a mkdtemp result)
 * @param {{ remote?: string, branch?: string, commit?: string|null }} [opts]
 *   `commit` is the initial commit message (default "init"); pass `null` to
 *   skip the initial commit (an init-only, or init+remote-only, fixture).
 */
export function initGitFixture(dir, { remote, branch, commit = "init" } = {}) {
  runGitFixture(dir, branch ? ["init", "-q", "-b", branch] : ["init", "-q"]);
  if (commit !== null) runGitFixture(dir, ["commit", "-q", "--allow-empty", "-m", commit]);
  if (remote) runGitFixture(dir, ["remote", "add", "origin", remote]);
}

/**
 * @param {string} workDir — an existing empty directory (e.g. a mkdtemp result)
 * @param {{
 *   baseBranch?: string,
 *   devloopsYaml?: string|null — written into the BASE commit (not the diff)
 *     so a gates.size override never itself counts toward logic LOC,
 *   headFiles?: Array<{ path: string, content: string }> — files the head
 *     commit adds; defaults to one small code file (an under-budget diff),
 * }} [opts]
 * @returns {{ headSha: string, baseBranch: string }}
 */
export async function initSizeBudgetFixtureRepo(workDir, {
  baseBranch = "main",
  devloopsYaml = null,
  headFiles = [{ path: "src/example.mjs", content: "export function example() {\n  return 1;\n}\n" }],
} = {}) {
  runGitFixture(workDir, ["init", "-q", "-b", baseBranch]);
  runGitFixture(workDir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(workDir, "README.md"), "base fixture\n", "utf8");
  if (devloopsYaml) await writeFile(path.join(workDir, ".devloops"), devloopsYaml, "utf8");
  runGitFixture(workDir, ["add", "."]);
  runGitFixture(workDir, ["commit", "-q", "-m", "base"]);
  const baseSha = runGitFixture(workDir, ["rev-parse", "HEAD"]);
  runGitFixture(workDir, ["update-ref", `refs/remotes/origin/${baseBranch}`, baseSha]);

  for (const file of headFiles) {
    await mkdir(path.dirname(path.join(workDir, file.path)), { recursive: true });
    await writeFile(path.join(workDir, file.path), file.content, "utf8");
  }
  runGitFixture(workDir, ["add", "."]);
  runGitFixture(workDir, ["commit", "-q", "-m", "head"]);
  const headSha = runGitFixture(workDir, ["rev-parse", "HEAD"]);
  return { headSha, baseBranch };
}

/** A code-file body whose line count is >= `count` changed (added) lines — for
 * size-budget fixtures that need to cross a specific LOC threshold. */
export function repeatedLinesContent(count, { prefix = "const x" } = {}) {
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(`${prefix}${i} = ${i};`);
  return `${lines.join("\n")}\n`;
}

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
    ...runIdFreeEnv(),
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
