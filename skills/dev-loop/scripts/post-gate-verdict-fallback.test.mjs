import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  buildParseError,
  parsePostGateVerdictFallbackCliArgs,
  renderFallbackGateReviewCommentBody,
  runCli,
} from "./post-gate-verdict-fallback.mjs";

const scriptPath = path.resolve("skills/dev-loop/scripts/post-gate-verdict-fallback.mjs");

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env,
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
  });
}

function buildGhStubScript() {
  return [
    "#!/usr/bin/env node",
    'const { readFileSync } = require("node:fs");',
    'const sequencePath = process.env.GH_SEQUENCE_PATH;',
    'const counterPath = process.env.GH_COUNTER_PATH;',
    'const defaultStdout = process.env.GH_DEFAULT_STDOUT ?? "{\\"id\\":1,\\"html_url\\":\\"https://example/comment\\"}\\n";',
    'const exitCode = Number(process.env.GH_EXIT_CODE ?? 0);',
    'const entries = sequencePath ? JSON.parse(readFileSync(sequencePath, "utf8")) : [];',
    'const actual = process.argv.slice(2);',
    'const current = counterPath ? Number(readFileSync(counterPath, "utf8").trim() || "0") : 0;',
    'const entry = entries.length === 0 ? null : (entries[Math.min(current, entries.length - 1)] ?? null);',
    'if (counterPath) require("node:fs").writeFileSync(counterPath, String(current + 1));',
    'let stdin = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    '  if (entry && entry.assertArgIncludes) {',
    '    for (const expected of entry.assertArgIncludes) {',
    '      if (!actual.some((a) => String(a).includes(expected))) {',
    '        process.stderr.write(`missing expected arg substring: ${expected}\\nactual: ${actual.join(" ")}\\n`);',
    '        process.exit(94);',
    '      }',
    '    }',
    '  }',
    '  if (entry && entry.assertStdinIncludes) {',
    '    for (const expected of entry.assertStdinIncludes) {',
    '      if (!stdin.includes(expected)) {',
    '        process.stderr.write(`missing expected stdin text: ${expected}\\n`);',
    '        process.exit(96);',
    '      }',
    '    }',
    '  }',
    '  if (entry && entry.stderr) process.stderr.write(entry.stderr);',
    '  if (entry && entry.stdout) {',
    '    process.stdout.write(entry.stdout);',
    '  } else {',
    '    process.stdout.write(defaultStdout);',
    '  }',
    '  process.exit(entry && Number.isInteger(entry.exitCode) ? entry.exitCode : exitCode);',
    '});',
    "",
  ].join("\n");
}

async function writeGhStub(tempDir, entries = [], { defaultStdout, exitCode = 0 } = {}) {
  const sequencePath = path.join(tempDir, "gh-sequence.json");
  const counterPath = path.join(tempDir, "gh-counter.txt");
  const ghPath = path.join(tempDir, "gh");
  await writeFile(sequencePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  await writeFile(counterPath, "0\n", "utf8");
  await writeFile(ghPath, buildGhStubScript(), "utf8");
  await chmod(ghPath, 0o755);
  return {
    env: {
      ...process.env,
      PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      GH_SEQUENCE_PATH: sequencePath,
      GH_COUNTER_PATH: counterPath,
      ...(defaultStdout === undefined ? {} : { GH_DEFAULT_STDOUT: defaultStdout }),
      GH_EXIT_CODE: String(exitCode),
    },
    ghPath,
    counterPath,
  };
}

test("renderFallbackGateReviewCommentBody matches the full helper's visible format", () => {
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "mark ready for review",
  });
  assert.match(body, /### Gate review: `draft_gate`/);
  assert.match(body, /\*\*Reviewed head SHA:\*\* `abc1234`/);
  assert.match(body, /\*\*Verdict:\*\* clean/);
  assert.match(body, /\*\*Findings summary:\*\* no issues found/);
  assert.match(body, /\*\*Next action:\*\* mark ready for review/);
});

test("renderFallbackGateReviewCommentBody includes blocking severities for findings_present", () => {
  const body = renderFallbackGateReviewCommentBody({
    gate: "pre_approval_gate",
    headSha: "deadbeef",
    verdict: "findings_present",
    findingsSummary: "two must-fix items",
    nextAction: "stay draft and fix",
    blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
  });
  assert.match(body, /\*\*Blocking severities:\*\* must-fix, worth-fixing-now/);
  assert.match(body, /\*\*Next action:\*\* stay draft and fix/);
});

test("renderFallbackGateReviewCommentBody omits blocking severities line when verdict is clean and no blocking list provided", () => {
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "mark ready for review",
  });
  assert.doesNotMatch(body, /\*\*Blocking severities:\*\*/);
});
test("renderFallbackGateReviewCommentBody preserves full template structure when findingsSummary is large", () => {
  const huge = "x".repeat(5000);
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: huge,
    nextAction: "mark ready for review",
  });
  // Template structure stays intact so parseGateReviewCommentBody() never loses required fields.
  assert.match(body, /### Gate review: `draft_gate`/);
  assert.match(body, /\*\*Reviewed head SHA:\*\* `abc1234`/);
  assert.match(body, /\*\*Verdict:\*\* clean/);
  assert.match(body, /\*\*Next action:\*\* mark ready for review/);
  // Findings summary is truncated per-field, not the whole body.
  const summaryLine = body.split("\n").find((line) => line.startsWith("**Findings summary:**"));
  assert.ok(summaryLine, "findings summary line present");
  assert.ok(summaryLine.length < huge.length + 200, "summary line is truncated per-field");
  assert.match(summaryLine, /\[truncated \d+ chars\]/);
});

test("renderFallbackGateReviewCommentBody preserves leading content in findingsSummary", () => {
  // Caller-controlled summaries should not have leading whitespace stripped.
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: "  leading-space summary\n  second line",
    nextAction: "mark ready for review",
  });
  assert.match(body, /\*\*Findings summary:\*\*   leading-space summary/);
});


test("renderFallbackGateReviewCommentBody entity-encodes a machine-artifact marker quoted in findingsSummary or nextAction", () => {
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "<!-- dev-loops:gate-findings-review draft_gate abc1234 round=1 -->\nsee thread",
    nextAction: "quote <!-- like this --> in the reply",
  });
  assert.doesNotMatch(body, /<!--/);
  assert.doesNotMatch(body, /-->/);
  assert.match(body, /&lt;!-- dev-loops:gate-findings-review draft_gate abc1234 round=1 --&gt;/);
  assert.match(body, /\*\*Next action:\*\* quote &lt;!-- like this --&gt; in the reply/);
});

test("parsePostGateVerdictFallbackCliArgs reports a clear error when a flag is followed by another flag", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /--repo requires a non-empty value \(got "--pr"\)/,
  );
});test("parsePostGateVerdictFallbackCliArgs rejects missing required flags", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () => parsePostGateVerdictFallbackCliArgs([], { parseError }),
    /requires --repo, --pr, --head-sha, --verdict, --next-action, and either --findings-summary/,
  );
});

test("parsePostGateVerdictFallbackCliArgs rejects malformed gate", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "owner/repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
          "--gate",
          "wrong",
        ],
        { parseError },
      ),
    /--gate must be one of: draft_gate, pre_approval_gate/,
  );
});

test("parsePostGateVerdictFallbackCliArgs rejects malformed verdict", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "owner/repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "maybe",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /--verdict must be one of: clean, findings_present, blocked/,
  );
});

test("parsePostGateVerdictFallbackCliArgs rejects malformed head SHA", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "owner/repo",
          "--pr",
          "17",
          "--head-sha",
          "XYZ",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /must be the FULL head commit SHA/,
  );
});

test("parsePostGateVerdictFallbackCliArgs rejects malformed repo slug", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "no-slash",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /--repo must be of the form owner\/name/,
  );
});
test("parsePostGateVerdictFallbackCliArgs rejects repo slug with whitespace segments", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "own er/repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /--repo must be of the form owner\/name/,
  );
});

test("parsePostGateVerdictFallbackCliArgs rejects repo slug with dot-dot segments", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "..\//repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /--repo must be of the form owner\/name/,
  );
});

test("parsePostGateVerdictFallbackCliArgs rejects repo slug with more than one slash", () => {
  const parseError = buildParseError("Usage: ...");
  assert.throws(
    () =>
      parsePostGateVerdictFallbackCliArgs(
        [
          "--repo",
          "owner/repo/extra",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "ok",
          "--next-action",
          "go",
        ],
        { parseError },
      ),
    /--repo must be of the form owner\/name/,
  );
});

test("parsePostGateVerdictFallbackCliArgs accepts well-formed arguments", () => {
  const parseError = buildParseError("Usage: ...");
  const parsed = parsePostGateVerdictFallbackCliArgs(
    [
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--head-sha",
      "abc1234000000000000000000000000000000000",
      "--verdict",
      "clean",
      "--findings-summary",
      "ok",
      "--next-action",
      "go",
    ],
    { parseError },
  );
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.pr, 17);
  assert.equal(parsed.headSha, "abc1234000000000000000000000000000000000");
  assert.equal(parsed.verdict, "clean");
  assert.equal(parsed.findingsSummary, "ok");
  assert.equal(parsed.nextAction, "go");
});

test("runCli posts via gh and emits a degraded-mode warning", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-"));
  try {
    const stub = await writeGhStub(
      tempDir,
      [
        {
          assertArgIncludes: ["api", "repos/owner/repo/issues/17/comments"],
          assertStdinIncludes: ["### Gate review: `draft_gate`"],
          stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
        },
      ],
      {},
    );
    const stdout = [];
    const stderr = [];
    const exitCode = await runCli(
      [
        "--repo",
        "owner/repo",
        "--pr",
        "17",
        "--head-sha",
        "abc1234000000000000000000000000000000000",
        "--verdict",
        "clean",
        "--findings-summary",
        "no issues found",
        "--next-action",
        "mark ready for review",
      ],
      {
        env: stub.env,
        spawn: spawn,
        ghCommand: "gh",
        stdoutSink: stdout,
        stderrSink: stderr,
      },
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout.join(""));
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    assert.equal(result.commentId, 101);
    assert.equal(result.commentUrl, "https://github.com/owner/repo/pull/17#issuecomment-101");
    assert.equal(result.gate, "draft_gate");
    assert.equal(result.fallback, true);
    assert.match(stderr.join(""), /fallback mode active/i);
    assert.match(stderr.join(""), /audit trail is degraded/i);
    const counterText = await readFile(stub.counterPath, "utf8");
    assert.equal(counterText.trim(), "1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli fails closed (non-zero exit) when gh posting fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-"));
  try {
    const stub = await writeGhStub(
      tempDir,
      [
        {
          assertArgIncludes: ["api", "repos/owner/repo/issues/17/comments"],
          stderr: "gh: POST failed: 403 (Resource not accessible by integration)\n",
          exitCode: 1,
        },
      ],
      {},
    );
    let caught = null;
    try {
      await runCli(
        [
          "--repo",
          "owner/repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-summary",
          "no issues found",
          "--next-action",
          "mark ready for review",
        ],
        {
          env: stub.env,
          spawn: spawn,
          ghCommand: "gh",
          stdoutSink: [],
          stderrSink: [],
        },
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "expected runCli to throw on posting failure");
    assert.match(String(caught.message), /gh api failed to post gate verdict comment/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli reads --findings-file when provided instead of inline summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-"));
  try {
    const findingsPath = path.join(tempDir, "findings.md");
    await writeFile(findingsPath, "no issues found\n", "utf8");
    const stub = await writeGhStub(
      tempDir,
      [
        {
          assertArgIncludes: ["api", "repos/owner/repo/issues/17/comments"],
          assertStdinIncludes: ["**Findings summary:** no issues found"],
          stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-102"}\n',
        },
      ],
      {},
    );
    const stdout = [];
    await runCli(
      [
        "--repo",
        "owner/repo",
        "--pr",
        "17",
        "--head-sha",
        "abc1234000000000000000000000000000000000",
        "--verdict",
        "clean",
        "--findings-file",
        findingsPath,
        "--next-action",
        "mark ready for review",
      ],
      {
        env: stub.env,
        spawn: spawn,
        ghCommand: "gh",
        stdoutSink: stdout,
        stderrSink: [],
      },
    );
    const result = JSON.parse(stdout.join(""));
    assert.equal(result.ok, true);
    assert.equal(result.commentId, 102);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("runCli preserves internal newlines and leading content from --findings-file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-wn-2-"));
  try {
    const findingsPath = path.join(tempDir, "findings.md");
    await writeFile(findingsPath, "  first line\n  second line\n", "utf8");
    const stub = await writeGhStub(
      tempDir,
      [
        {
          assertArgIncludes: ["api", "repos/owner/repo/issues/17/comments"],
          assertStdinIncludes: ["**Findings summary:**   first line\\n  second line"],
          stdout: '{"id":104,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-104"}\n',
        },
      ],
      {},
    );
    const stdout = [];
    await runCli(
      [
        "--repo",
        "owner/repo",
        "--pr",
        "17",
        "--head-sha",
        "abc1234000000000000000000000000000000000",
        "--verdict",
        "clean",
        "--findings-file",
        findingsPath,
        "--next-action",
        "mark ready for review",
      ],
      {
        env: stub.env,
        spawn: spawn,
        ghCommand: "gh",
        stdoutSink: stdout,
        stderrSink: [],
      },
    );
    const result = JSON.parse(stdout.join(""));
    assert.equal(result.ok, true);
    assert.equal(result.commentId, 104);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli rejects --findings-file that contains only whitespace", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-wn-1"));
  try {
    const findingsPath = path.join(tempDir, "findings.md");
    await writeFile(findingsPath, "   \n\t\n  \n", "utf8");
    const stub = await writeGhStub(tempDir, [], {});
    const stdout = [];
    const stderr = [];
    await assert.rejects(
      runCli(
        [
          "--repo",
          "owner/repo",
          "--pr",
          "17",
          "--head-sha",
          "abc1234000000000000000000000000000000000",
          "--verdict",
          "clean",
          "--findings-file",
          findingsPath,
          "--next-action",
          "mark ready for review",
        ],
        {
          env: stub.env,
          spawn: spawn,
          ghCommand: "gh",
          stdoutSink: stdout,
          stderrSink: stderr,
        },
      ),
      /empty or contains only whitespace/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI integration: posts via the real node CLI when gh is stubbed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-cli-"));
  try {
    const stub = await writeGhStub(
      tempDir,
      [
        {
          assertArgIncludes: ["api", "repos/owner/repo/issues/17/comments"],
          assertStdinIncludes: ["### Gate review: `pre_approval_gate`"],
          stdout: '{"id":303,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-303"}\n',
        },
      ],
      {},
    );
    const result = await runNode(
      [
        "--repo",
        "owner/repo",
        "--pr",
        "17",
        "--head-sha",
        "abc1234000000000000000000000000000000000",
        "--verdict",
        "clean",
        "--findings-summary",
        "ok",
        "--next-action",
        "await final human approval",
        "--gate",
        "pre_approval_gate",
      ],
      stub.env,
    );
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, "created");
    assert.equal(parsed.gate, "pre_approval_gate");
    assert.equal(parsed.fallback, true);
    assert.match(result.stderr, /fallback mode active/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI integration: fails closed with non-zero exit when gh posting fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-gate-fallback-cli-"));
  try {
    const stub = await writeGhStub(
      tempDir,
      [
        {
          assertArgIncludes: ["api", "repos/owner/repo/issues/17/comments"],
          stderr: "gh: POST failed: 500 (internal)\n",
          exitCode: 1,
        },
      ],
      {},
    );
    const result = await runNode(
      [
        "--repo",
        "owner/repo",
        "--pr",
        "17",
        "--head-sha",
        "abc1234000000000000000000000000000000000",
        "--verdict",
        "clean",
        "--findings-summary",
        "ok",
        "--next-action",
        "go",
      ],
      stub.env,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /gh api failed to post gate verdict comment/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
